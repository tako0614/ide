import { useCallback, useState, useRef } from 'react';
import type { EditorFile, FileTreeNode, WorkspaceState } from '../types';
import { listFiles, readFile, writeFile, createFile, deleteFile, createDirectory, deleteDirectory } from '../api';
import { getErrorMessage, getLanguageFromPath, toTreeNodes, SAVED_MESSAGE } from '../utils';

// API timeout wrapper
const withTimeout = <T>(promise: Promise<T>, timeoutMs = 15000): Promise<T> => {
  return Promise.race([
    promise,
    new Promise<T>((_, reject) =>
      setTimeout(() => reject(new Error('Request timeout')), timeoutMs)
    )
  ]);
};

interface UseFileOperationsProps {
  editorWorkspaceId: string | null;
  activeWorkspaceState: WorkspaceState;
  updateWorkspaceState: (workspaceId: string, updater: (state: WorkspaceState) => WorkspaceState) => void;
  setStatusMessage: (message: string) => void;
}

export const useFileOperations = ({
  editorWorkspaceId,
  activeWorkspaceState,
  updateWorkspaceState,
  setStatusMessage
}: UseFileOperationsProps) => {
  const [savingFileId, setSavingFileId] = useState<string | null>(null);

  const updateTreeNode = useCallback(
    (
      nodes: FileTreeNode[],
      targetPath: string,
      updater: (node: FileTreeNode) => FileTreeNode
    ): FileTreeNode[] =>
      nodes.map((node) => {
        if (node.path === targetPath) {
          return updater(node);
        }
        if (node.children) {
          return {
            ...node,
            children: updateTreeNode(node.children, targetPath, updater)
          };
        }
        return node;
      }),
    []
  );

  const handleRefreshTree = useCallback(() => {
    if (!editorWorkspaceId) return;
    updateWorkspaceState(editorWorkspaceId, (state) => ({
      ...state,
      treeLoading: true,
      treeError: null
    }));
    withTimeout(listFiles(editorWorkspaceId, ''))
      .then((entries) => {
        updateWorkspaceState(editorWorkspaceId, (state) => ({
          ...state,
          tree: toTreeNodes(entries),
          treeLoading: false
        }));
      })
      .catch((error: unknown) => {
        updateWorkspaceState(editorWorkspaceId, (state) => ({
          ...state,
          treeLoading: false,
          treeError: getErrorMessage(error)
        }));
      });
  }, [editorWorkspaceId, updateWorkspaceState]);

  const handleToggleDir = useCallback(
    (node: FileTreeNode) => {
      if (!editorWorkspaceId || node.type !== 'dir') return;
      if (node.expanded) {
        updateWorkspaceState(editorWorkspaceId, (state) => ({
          ...state,
          tree: updateTreeNode(state.tree, node.path, (item) => ({
            ...item,
            expanded: false
          }))
        }));
        return;
      }
      if (node.children && node.children.length > 0) {
        updateWorkspaceState(editorWorkspaceId, (state) => ({
          ...state,
          tree: updateTreeNode(state.tree, node.path, (item) => ({
            ...item,
            expanded: true
          }))
        }));
        return;
      }

      updateWorkspaceState(editorWorkspaceId, (state) => ({
        ...state,
        tree: updateTreeNode(state.tree, node.path, (item) => ({
          ...item,
          loading: true
        }))
      }));
      withTimeout(listFiles(editorWorkspaceId, node.path))
        .then((entries) => {
          updateWorkspaceState(editorWorkspaceId, (state) => ({
            ...state,
            tree: updateTreeNode(state.tree, node.path, (item) => ({
              ...item,
              expanded: true,
              loading: false,
              children: toTreeNodes(entries)
            }))
          }));
        })
        .catch((error: unknown) => {
          updateWorkspaceState(editorWorkspaceId, (state) => ({
            ...state,
            treeError: getErrorMessage(error),
            tree: updateTreeNode(state.tree, node.path, (item) => ({
              ...item,
              loading: false
            }))
          }));
        });
    },
    [editorWorkspaceId, updateWorkspaceState, updateTreeNode]
  );

  const handleOpenFile = useCallback(
    (entry: FileTreeNode) => {
      if (!editorWorkspaceId || entry.type !== 'file') return;
      const existing = activeWorkspaceState.files.find(
        (file) => file.path === entry.path
      );
      if (existing) {
        updateWorkspaceState(editorWorkspaceId, (state) => ({
          ...state,
          activeFileId: existing.id
        }));
        return;
      }

      // Show loading state by setting a temporary file
      const tempFileId = crypto.randomUUID();
      const tempFile: EditorFile = {
        id: tempFileId,
        name: entry.name,
        path: entry.path,
        language: getLanguageFromPath(entry.path),
        contents: '',
        dirty: false
      };
      updateWorkspaceState(editorWorkspaceId, (state) => ({
        ...state,
        files: [...state.files, { ...tempFile, contents: '読み込み中...' }],
        activeFileId: tempFileId
      }));

      withTimeout(readFile(editorWorkspaceId, entry.path))
        .then((data) => {
          updateWorkspaceState(editorWorkspaceId, (state) => ({
            ...state,
            files: state.files.map((f) =>
              f.id === tempFileId
                ? { ...f, contents: data.contents }
                : f
            )
          }));
        })
        .catch((error: unknown) => {
          // Remove the temp file on error
          updateWorkspaceState(editorWorkspaceId, (state) => ({
            ...state,
            files: state.files.filter((f) => f.id !== tempFileId),
            activeFileId: state.files.length > 1 ? state.files[0].id : null
          }));
          setStatusMessage(
            `ファイルを開けませんでした: ${getErrorMessage(error)}`
          );
        });
    },
    [editorWorkspaceId, activeWorkspaceState.files, updateWorkspaceState, setStatusMessage]
  );

  const handleFileChange = useCallback(
    (fileId: string, contents: string) => {
      if (!editorWorkspaceId) return;
      updateWorkspaceState(editorWorkspaceId, (state) => ({
        ...state,
        files: state.files.map((file) =>
          file.id === fileId ? { ...file, contents, dirty: true } : file
        )
      }));
    },
    [editorWorkspaceId, updateWorkspaceState]
  );

  const handleSaveFile = useCallback(
    async (fileId: string) => {
      if (!editorWorkspaceId) return;
      const file = activeWorkspaceState.files.find((item) => item.id === fileId);
      if (!file) return;
      setSavingFileId(fileId);
      try {
        await withTimeout(writeFile(editorWorkspaceId, file.path, file.contents));
        updateWorkspaceState(editorWorkspaceId, (state) => ({
          ...state,
          files: state.files.map((item) =>
            item.id === fileId ? { ...item, dirty: false } : item
          )
        }));
        setStatusMessage(SAVED_MESSAGE);
      } catch (error: unknown) {
        setStatusMessage(
          `保存に失敗しました: ${getErrorMessage(error)}`
        );
      } finally {
        setSavingFileId(null);
      }
    },
    [editorWorkspaceId, activeWorkspaceState.files, updateWorkspaceState, setStatusMessage]
  );

  const handleCloseFile = useCallback(
    (fileId: string) => {
      if (!editorWorkspaceId) return;
      updateWorkspaceState(editorWorkspaceId, (state) => {
        const fileIndex = state.files.findIndex((f) => f.id === fileId);
        const newFiles = state.files.filter((f) => f.id !== fileId);
        let newActiveFileId = state.activeFileId;

        // If closing the active file, select adjacent tab
        if (state.activeFileId === fileId) {
          if (newFiles.length === 0) {
            newActiveFileId = null;
          } else if (fileIndex >= newFiles.length) {
            newActiveFileId = newFiles[newFiles.length - 1].id;
          } else {
            newActiveFileId = newFiles[fileIndex].id;
          }
        }

        return {
          ...state,
          files: newFiles,
          activeFileId: newActiveFileId
        };
      });
    },
    [editorWorkspaceId, updateWorkspaceState]
  );

  // Helper to remove a node from tree
  const removeTreeNode = useCallback(
    (nodes: FileTreeNode[], targetPath: string): FileTreeNode[] =>
      nodes.filter((node) => {
        if (node.path === targetPath) {
          return false;
        }
        if (node.children) {
          node.children = removeTreeNode(node.children, targetPath);
        }
        return true;
      }),
    []
  );

  // Helper to add a node to tree
  const addTreeNode = useCallback(
    (nodes: FileTreeNode[], parentPath: string, newNode: FileTreeNode): FileTreeNode[] => {
      // If parent is root (empty string), add to root level
      if (!parentPath) {
        const updated = [...nodes, newNode];
        return updated.sort((a, b) => {
          if (a.type !== b.type) return a.type === 'dir' ? -1 : 1;
          return a.name.localeCompare(b.name);
        });
      }
      return nodes.map((node) => {
        if (node.path === parentPath && node.type === 'dir') {
          const children = node.children || [];
          const updated = [...children, newNode].sort((a, b) => {
            if (a.type !== b.type) return a.type === 'dir' ? -1 : 1;
            return a.name.localeCompare(b.name);
          });
          return { ...node, children: updated, expanded: true };
        }
        if (node.children) {
          return { ...node, children: addTreeNode(node.children, parentPath, newNode) };
        }
        return node;
      });
    },
    []
  );

  const handleCreateFile = useCallback(
    async (parentPath: string, fileName: string) => {
      if (!editorWorkspaceId) return;
      const filePath = parentPath ? `${parentPath}/${fileName}` : fileName;
      try {
        await withTimeout(createFile(editorWorkspaceId, filePath));
        const newNode: FileTreeNode = {
          name: fileName,
          path: filePath,
          type: 'file',
          expanded: false,
          loading: false
        };
        updateWorkspaceState(editorWorkspaceId, (state) => ({
          ...state,
          tree: addTreeNode(state.tree, parentPath, newNode)
        }));
        setStatusMessage(`ファイルを作成しました: ${fileName}`);
      } catch (error: unknown) {
        setStatusMessage(`ファイル作成に失敗しました: ${getErrorMessage(error)}`);
      }
    },
    [editorWorkspaceId, updateWorkspaceState, setStatusMessage, addTreeNode]
  );

  const handleCreateDirectory = useCallback(
    async (parentPath: string, dirName: string) => {
      if (!editorWorkspaceId) return;
      const dirPath = parentPath ? `${parentPath}/${dirName}` : dirName;
      try {
        await withTimeout(createDirectory(editorWorkspaceId, dirPath));
        const newNode: FileTreeNode = {
          name: dirName,
          path: dirPath,
          type: 'dir',
          expanded: false,
          loading: false,
          children: []
        };
        updateWorkspaceState(editorWorkspaceId, (state) => ({
          ...state,
          tree: addTreeNode(state.tree, parentPath, newNode)
        }));
        setStatusMessage(`フォルダを作成しました: ${dirName}`);
      } catch (error: unknown) {
        setStatusMessage(`フォルダ作成に失敗しました: ${getErrorMessage(error)}`);
      }
    },
    [editorWorkspaceId, updateWorkspaceState, setStatusMessage, addTreeNode]
  );

  const handleDeleteFile = useCallback(
    async (filePath: string) => {
      if (!editorWorkspaceId) return;
      try {
        await withTimeout(deleteFile(editorWorkspaceId, filePath));
        updateWorkspaceState(editorWorkspaceId, (state) => {
          // Close the file if it's open
          const newFiles = state.files.filter((f) => f.path !== filePath);
          let newActiveFileId = state.activeFileId;
          const deletedFile = state.files.find((f) => f.path === filePath);
          if (deletedFile && state.activeFileId === deletedFile.id) {
            newActiveFileId = newFiles.length > 0 ? newFiles[0].id : null;
          }
          return {
            ...state,
            files: newFiles,
            activeFileId: newActiveFileId,
            tree: removeTreeNode(state.tree, filePath)
          };
        });
        setStatusMessage(`ファイルを削除しました`);
      } catch (error: unknown) {
        setStatusMessage(`ファイル削除に失敗しました: ${getErrorMessage(error)}`);
      }
    },
    [editorWorkspaceId, updateWorkspaceState, setStatusMessage, removeTreeNode]
  );

  const handleDeleteDirectory = useCallback(
    async (dirPath: string) => {
      if (!editorWorkspaceId) return;
      try {
        await withTimeout(deleteDirectory(editorWorkspaceId, dirPath));
        updateWorkspaceState(editorWorkspaceId, (state) => {
          // Close any files that were in this directory
          const newFiles = state.files.filter((f) => !f.path.startsWith(dirPath + '/') && f.path !== dirPath);
          let newActiveFileId = state.activeFileId;
          const activeFile = state.files.find((f) => f.id === state.activeFileId);
          if (activeFile && (activeFile.path.startsWith(dirPath + '/') || activeFile.path === dirPath)) {
            newActiveFileId = newFiles.length > 0 ? newFiles[0].id : null;
          }
          return {
            ...state,
            files: newFiles,
            activeFileId: newActiveFileId,
            tree: removeTreeNode(state.tree, dirPath)
          };
        });
        setStatusMessage(`フォルダを削除しました`);
      } catch (error: unknown) {
        setStatusMessage(`フォルダ削除に失敗しました: ${getErrorMessage(error)}`);
      }
    },
    [editorWorkspaceId, updateWorkspaceState, setStatusMessage, removeTreeNode]
  );

  return {
    savingFileId,
    handleRefreshTree,
    handleToggleDir,
    handleOpenFile,
    handleFileChange,
    handleSaveFile,
    handleCloseFile,
    handleCreateFile,
    handleCreateDirectory,
    handleDeleteFile,
    handleDeleteDirectory
  };
};
