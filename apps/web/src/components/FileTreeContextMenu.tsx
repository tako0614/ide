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
      className="fixed z-[1000] min-w-[160px] py-1 bg-panel border border-border rounded-[6px] shadow-[0_4px_12px_rgba(0,0,0,0.15)]"
      style={{ left: contextMenu.x, top: contextMenu.y }}
      onClick={(e) => e.stopPropagation()}
    >
      {(contextMenu.isRoot || contextMenu.node?.type === 'dir') && (
        <>
          <button
            type="button"
            className="block w-full px-3 py-1.5 text-[13px] text-left bg-transparent border-0 text-ink cursor-pointer hover:bg-list-hover"
            onClick={() => onNewFile(contextMenu.node?.path || '', contextMenu.node ? 1 : 0)}
          >
            新規ファイル
          </button>
          <button
            type="button"
            className="block w-full px-3 py-1.5 text-[13px] text-left bg-transparent border-0 text-ink cursor-pointer hover:bg-list-hover"
            onClick={() => onNewFolder(contextMenu.node?.path || '', contextMenu.node ? 1 : 0)}
          >
            新規フォルダ
          </button>
        </>
      )}
      {contextMenu.node && !contextMenu.isRoot && (
        <>
          {contextMenu.node.type === 'dir' && <div className="h-px my-1 bg-border" />}
          <button
            type="button"
            className="block w-full px-3 py-1.5 text-[13px] text-left bg-transparent border-0 text-[#f14c4c] cursor-pointer hover:bg-[rgba(241,76,76,0.1)]"
            onClick={() => onDelete(contextMenu.node!)}
          >
            削除
          </button>
        </>
      )}
    </div>
  );
}
