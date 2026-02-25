import type { FileTreeNode } from '../types';

export interface ContextMenu {
  x: number;
  y: number;
  node: FileTreeNode | null;
  isRoot: boolean;
}

interface FileTreeContextMenuProps {
  contextMenu: ContextMenu;
  onNewFile: (parentPath: string, depth: number) => void;
  onNewFolder: (parentPath: string, depth: number) => void;
  onDelete: (node: FileTreeNode) => void;
}

export function FileTreeContextMenu({
  contextMenu,
  onNewFile,
  onNewFolder,
  onDelete
}: FileTreeContextMenuProps) {
  return (
    <div
      className="context-menu"
      style={{ left: contextMenu.x, top: contextMenu.y }}
      onClick={(e) => e.stopPropagation()}
    >
      {(contextMenu.isRoot || contextMenu.node?.type === 'dir') && (
        <>
          <button
            type="button"
            className="context-menu-item"
            onClick={() => onNewFile(contextMenu.node?.path || '', contextMenu.node ? 1 : 0)}
          >
            新規ファイル
          </button>
          <button
            type="button"
            className="context-menu-item"
            onClick={() => onNewFolder(contextMenu.node?.path || '', contextMenu.node ? 1 : 0)}
          >
            新規フォルダ
          </button>
        </>
      )}
      {contextMenu.node && !contextMenu.isRoot && (
        <>
          {contextMenu.node.type === 'dir' && <div className="context-menu-separator" />}
          <button
            type="button"
            className="context-menu-item delete"
            onClick={() => onDelete(contextMenu.node!)}
          >
            削除
          </button>
        </>
      )}
    </div>
  );
}
