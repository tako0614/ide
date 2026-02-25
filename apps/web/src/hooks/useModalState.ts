import { useCallback, useState } from 'react';

export function useModalState() {
  const [isWorkspaceModalOpen, setIsWorkspaceModalOpen] = useState(false);
  const [isDeckModalOpen, setIsDeckModalOpen] = useState(false);
  const [isSettingsModalOpen, setIsSettingsModalOpen] = useState(false);

  const openWorkspaceModal = useCallback(() => setIsWorkspaceModalOpen(true), []);
  const closeWorkspaceModal = useCallback(() => setIsWorkspaceModalOpen(false), []);

  const openDeckModal = useCallback(() => setIsDeckModalOpen(true), []);
  const closeDeckModal = useCallback(() => setIsDeckModalOpen(false), []);

  const openSettingsModal = useCallback(() => setIsSettingsModalOpen(true), []);
  const closeSettingsModal = useCallback(() => setIsSettingsModalOpen(false), []);

  return {
    isWorkspaceModalOpen,
    openWorkspaceModal,
    closeWorkspaceModal,
    isDeckModalOpen,
    openDeckModal,
    closeDeckModal,
    isSettingsModalOpen,
    openSettingsModal,
    closeSettingsModal
  };
}
