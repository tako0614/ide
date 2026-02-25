import { useState, useCallback } from 'react';
import clsx from 'clsx';
import type { Workspace, WorkspaceState, SidebarPanel, FileTreeNode, GitFileStatus } from '../types';
import type { GitState } from '../hooks/useGitState';
import { FileTree } from './FileTree';
import { SourceControl } from './SourceControl';
import { EditorPane } from './EditorPane';
import { DiffViewer } from './DiffViewer';
import type { ThemeMode } from '../utils/themeUtils';

interface WorkspaceEditorProps {
  activeWorkspace: Workspace | null;
  defaultRoot: string;
  activeWorkspaceState: WorkspaceState;
  editorWorkspaceId: string | null;
  gitState: GitState;
  theme: ThemeMode;
  savingFileId: string | null;
  onCloseWorkspaceEditor: () => void;
  onToggleDir: (node: FileTreeNode) => void;
  onOpenFile: (node: FileTreeNode) => void;
  onRefreshTree: () => void;
  onCreateFile: (parentPath: string, fileName: string) => void;
  onCreateDirectory: (parentPath: string, dirName: string) => void;
  onDeleteFile: (filePath: string) => void;
  onDeleteDirectory: (dirPath: string) => void;
  onRefreshGit: () => void;
  onSelectRepo: (repoPath: string) => void;
  onStageFile: (path: string) => void;
  onUnstageFile: (path: string) => void;
  onStageAll: () => void;
  onUnstageAll: () => void;
  onCommit: (message: string) => void;
  onDiscardFile: (path: string) => void;
  onShowDiff: (file: GitFileStatus) => void;
  onCloseDiff: () => void;
  onPush: () => void;
  onPull: () => void;
  onLoadBranches: () => void;
  onCheckoutBranch: (branchName: string) => void;
  onCreateBranch: (branchName: string) => void;
  onLoadLogs: () => void;
  onSelectFile: (fileId: string) => void;
  onCloseFile: (fileId: string) => void;
  onChangeFile: (fileId: string, contents: string) => void;
  onSaveFile: (fileId: string) => void;
}

export function WorkspaceEditor({
  activeWorkspace,
  defaultRoot,
  activeWorkspaceState,
  editorWorkspaceId,
  gitState,
  theme,
  savingFileId,
  onCloseWorkspaceEditor,
  onToggleDir,
  onOpenFile,
  onRefreshTree,
  onCreateFile,
  onCreateDirectory,
  onDeleteFile,
  onDeleteDirectory,
  onRefreshGit,
  onSelectRepo,
  onStageFile,
  onUnstageFile,
  onStageAll,
  onUnstageAll,
  onCommit,
  onDiscardFile,
  onShowDiff,
  onCloseDiff,
  onPush,
  onPull,
  onLoadBranches,
  onCheckoutBranch,
  onCreateBranch,
  onLoadLogs,
  onSelectFile,
  onCloseFile,
  onChangeFile,
  onSaveFile
}: WorkspaceEditorProps) {
  const [isSidebarOpen, setIsSidebarOpen] = useState(false);
  const [sidebarPanel, setSidebarPanel] = useState<SidebarPanel>('files');

  const handleOpenFileMobile = useCallback((node: FileTreeNode) => {
    onOpenFile(node);
    setIsSidebarOpen(false);
  }, [onOpenFile]);

  const gitChangeCount = gitState.status?.files.length ?? 0;

  return (
    <div className={clsx('workspace-editor-overlay', isSidebarOpen && 'drawer-open')}>
      <div className="workspace-editor-header">
        <button
          type="button"
          className="ghost-button"
          onClick={onCloseWorkspaceEditor}
        >
          {'\u4e00\u89a7\u306b\u623b\u308b'}
        </button>
        <button
          type="button"
          className="sidebar-toggle-btn ghost-button"
          onClick={() => setIsSidebarOpen((v) => !v)}
          aria-label="\u30b5\u30a4\u30c9\u30d0\u30fc"
        >
          <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true">
            <path d="M3 12h18M3 6h18M3 18h18" stroke="currentColor" strokeWidth="2" strokeLinecap="round"/>
          </svg>
        </button>
        <div className="workspace-meta">
          {activeWorkspace ? (
            <span className="workspace-path">{activeWorkspace.path}</span>
          ) : null}
        </div>
      </div>
      <div className="workspace-editor-grid">
        <div className="activity-bar">
          <button
            type="button"
            className={clsx('activity-bar-item', sidebarPanel === 'files' && 'active')}
            onClick={() => setSidebarPanel('files')}
            title="エクスプローラー"
          >
            <svg viewBox="0 0 24 24" aria-hidden="true">
              <path d="M3 7v10a2 2 0 002 2h14a2 2 0 002-2V9a2 2 0 00-2-2h-6l-2-2H5a2 2 0 00-2 2z" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
          </button>
          <button
            type="button"
            className={clsx('activity-bar-item', sidebarPanel === 'git' && 'active')}
            onClick={() => {
              setSidebarPanel('git');
              onRefreshGit();
            }}
            title="ソースコントロール"
          >
            <svg viewBox="0 0 24 24" aria-hidden="true">
              <path d="M6 3v12M18 9a3 3 0 110 6 3 3 0 010-6zM6 21a3 3 0 110-6 3 3 0 010 6z" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
              <path d="M18 12c0 3-3 4-6 4s-6-1-6-4" fill="none" stroke="currentColor" strokeWidth="1.5" />
            </svg>
            {gitChangeCount > 0 && (
              <span className="activity-bar-badge">{gitChangeCount}</span>
            )}
          </button>
        </div>
        <div className="sidebar-panel">
          <div className="sidebar-content">
            {sidebarPanel === 'files' ? (
              <FileTree
                root={activeWorkspace?.path || defaultRoot || ''}
                entries={activeWorkspaceState.tree}
                loading={activeWorkspaceState.treeLoading}
                error={activeWorkspaceState.treeError}
                onToggleDir={onToggleDir}
                onOpenFile={handleOpenFileMobile}
                onRefresh={onRefreshTree}
                onCreateFile={onCreateFile}
                onCreateDirectory={onCreateDirectory}
                onDeleteFile={onDeleteFile}
                onDeleteDirectory={onDeleteDirectory}
                gitFiles={gitState.status?.files}
              />
            ) : (
              <SourceControl
                status={gitState.status}
                loading={gitState.loading}
                error={gitState.error}
                workspaceId={editorWorkspaceId}
                branchStatus={gitState.branchStatus}
                hasRemote={gitState.hasRemote}
                pushing={gitState.pushing}
                pulling={gitState.pulling}
                branches={gitState.branches}
                branchesLoading={gitState.branchesLoading}
                logs={gitState.logs}
                logsLoading={gitState.logsLoading}
                repos={gitState.repos}
                selectedRepoPath={gitState.selectedRepoPath}
                onSelectRepo={onSelectRepo}
                onRefresh={onRefreshGit}
                onStageFile={onStageFile}
                onUnstageFile={onUnstageFile}
                onStageAll={onStageAll}
                onUnstageAll={onUnstageAll}
                onCommit={onCommit}
                onDiscardFile={onDiscardFile}
                onShowDiff={onShowDiff}
                onPush={onPush}
                onPull={onPull}
                onLoadBranches={onLoadBranches}
                onCheckoutBranch={onCheckoutBranch}
                onCreateBranch={onCreateBranch}
                onLoadLogs={onLoadLogs}
              />
            )}
          </div>
        </div>
        <EditorPane
          files={activeWorkspaceState.files}
          activeFileId={activeWorkspaceState.activeFileId}
          onSelectFile={onSelectFile}
          onCloseFile={onCloseFile}
          onChangeFile={onChangeFile}
          onSaveFile={onSaveFile}
          savingFileId={savingFileId}
          theme={theme}
        />
      </div>
      <div
        className="sidebar-overlay"
        onClick={() => setIsSidebarOpen(false)}
        aria-hidden="true"
      />
      {gitState.diffPath && (
        <DiffViewer
          diff={gitState.diff}
          loading={gitState.diffLoading}
          theme={theme}
          onClose={onCloseDiff}
        />
      )}
    </div>
  );
}
