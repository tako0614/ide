import { useCallback, useState } from 'react';
import type { EditorFile, FileTreeNode, WorkspaceState } from '../types';
import { listFiles, readFile, writeFile } from '../api';
import { getErrorMessage, getLanguageFromPath, toTreeNodes, SAVED_MESSAGE } from '../utils';

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
    listFiles(editorWorkspaceId, '')
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
      listFiles(editorWorkspaceId, node.path)
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
      readFile(editorWorkspaceId, entry.path)
        .then((data) => {
          const file: EditorFile = {
            id: crypto.randomUUID(),
            name: entry.name,
            path: entry.path,
            language: getLanguageFromPath(entry.path),
            contents: data.contents,
            dirty: false
          };
          updateWorkspaceState(editorWorkspaceId, (state) => ({
            ...state,
            files: [...state.files, file],
            activeFileId: file.id
          }));
        })
        .catch((error: unknown) => {
          setStatusMessage(
            `\u30d5\u30a1\u30a4\u30eb\u3092\u958b\u3051\u307e\u305b\u3093\u3067\u3057\u305f: ${getErrorMessage(error)}`
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
        await writeFile(editorWorkspaceId, file.path, file.contents);
        updateWorkspaceState(editorWorkspaceId, (state) => ({
          ...state,
          files: state.files.map((item) =>
            item.id === fileId ? { ...item, dirty: false } : item
          )
        }));
        setStatusMessage(SAVED_MESSAGE);
      } catch (error: unknown) {
        setStatusMessage(
          `\u4fdd\u5b58\u306b\u5931\u6557\u3057\u307e\u3057\u305f: ${getErrorMessage(error)}`
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

  return {
    savingFileId,
    handleRefreshTree,
    handleToggleDir,
    handleOpenFile,
    handleFileChange,
    handleSaveFile,
    handleCloseFile
  };
};
