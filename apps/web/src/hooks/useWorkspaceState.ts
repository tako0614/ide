import { useCallback, useState } from 'react';
import type { WorkspaceState } from '../types';
import { createEmptyWorkspaceState } from '../utils';

export const useWorkspaceState = () => {
  const [workspaceStates, setWorkspaceStates] = useState<
    Record<string, WorkspaceState>
  >({});

  const updateWorkspaceState = useCallback(
    (workspaceId: string, updater: (state: WorkspaceState) => WorkspaceState) => {
      setWorkspaceStates((prev) => {
        const current = prev[workspaceId] || createEmptyWorkspaceState();
        return { ...prev, [workspaceId]: updater(current) };
      });
    },
    []
  );

  const initializeWorkspaceStates = useCallback((workspaceIds: string[]) => {
    setWorkspaceStates((prev) => {
      const next = { ...prev };
      workspaceIds.forEach((id) => {
        if (!next[id]) {
          next[id] = createEmptyWorkspaceState();
        }
      });
      return next;
    });
  }, []);

  return {
    workspaceStates,
    setWorkspaceStates,
    updateWorkspaceState,
    initializeWorkspaceStates
  };
};
