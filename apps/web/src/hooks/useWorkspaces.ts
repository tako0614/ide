import { useCallback, useEffect, useState } from 'react';
import type { Workspace } from '../types';
import { listWorkspaces, createWorkspace as apiCreateWorkspace } from '../api';
import { getErrorMessage, normalizeWorkspacePath, createEmptyWorkspaceState } from '../utils';

interface UseWorkspacesProps {
  setStatusMessage: (message: string) => void;
  defaultRoot: string;
  initializeWorkspaceStates: (workspaceIds: string[]) => void;
  setWorkspaceStates: React.Dispatch<React.SetStateAction<Record<string, import('../types').WorkspaceState>>>;
}

export const useWorkspaces = ({
  setStatusMessage,
  defaultRoot,
  initializeWorkspaceStates,
  setWorkspaceStates
}: UseWorkspacesProps) => {
  const [workspaces, setWorkspaces] = useState<Workspace[]>([]);
  const [editorWorkspaceId, setEditorWorkspaceId] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    listWorkspaces()
      .then((data) => {
        if (!alive) return;
        setWorkspaces(data);
        setEditorWorkspaceId((prev) => {
          if (prev && data.some((workspace) => workspace.id === prev)) {
            return prev;
          }
          return null;
        });
        initializeWorkspaceStates(data.map((workspace) => workspace.id));
      })
      .catch((error: unknown) => {
        if (!alive) return;
        setStatusMessage(
          `\u30ef\u30fc\u30af\u30b9\u30da\u30fc\u30b9\u3092\u53d6\u5f97\u3067\u304d\u307e\u305b\u3093\u3067\u3057\u305f: ${getErrorMessage(error)}`
        );
      });

    return () => {
      alive = false;
    };
  }, [setStatusMessage, initializeWorkspaceStates]);

  const handleCreateWorkspace = useCallback(
    async (path: string) => {
      const trimmedPath = path.trim();
      const resolvedPath = trimmedPath || defaultRoot;
      if (!resolvedPath) {
        setStatusMessage(
          '\u30d1\u30b9\u3092\u5165\u529b\u3057\u3066\u304f\u3060\u3055\u3044\u3002'
        );
        return null;
      }
      const normalized = normalizeWorkspacePath(resolvedPath);
      const exists = workspaces.some(
        (workspace) => normalizeWorkspacePath(workspace.path) === normalized
      );
      if (exists) {
        setStatusMessage(
          '\u540c\u3058\u30d1\u30b9\u306e\u30ef\u30fc\u30af\u30b9\u30da\u30fc\u30b9\u306f\u8ffd\u52a0\u3067\u304d\u307e\u305b\u3093\u3002'
        );
        return null;
      }
      try {
        const workspace = await apiCreateWorkspace(resolvedPath);
        setWorkspaces((prev) => [...prev, workspace]);
        setEditorWorkspaceId(workspace.id);
        setWorkspaceStates((prev) => ({
          ...prev,
          [workspace.id]: createEmptyWorkspaceState()
        }));
        return workspace;
      } catch (error: unknown) {
        setStatusMessage(
          `\u30ef\u30fc\u30af\u30b9\u30da\u30fc\u30b9\u3092\u8ffd\u52a0\u3067\u304d\u307e\u305b\u3093\u3067\u3057\u305f: ${getErrorMessage(error)}`
        );
        return null;
      }
    },
    [workspaces, defaultRoot, setStatusMessage, setWorkspaceStates]
  );

  return {
    workspaces,
    editorWorkspaceId,
    setEditorWorkspaceId,
    handleCreateWorkspace
  };
};
