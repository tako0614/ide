import clsx from 'clsx';

interface DeckListItem {
  id: string;
  name: string;
  path: string;
}

interface DeckListProps {
  decks: DeckListItem[];
  activeDeckId: string | null;
  onSelect: (deckId: string) => void;
  onCreate: () => void;
}

const LABEL_DECK = '\u30c7\u30c3\u30ad';
const LABEL_MULTI = '\u8907\u6570\u4f5c\u6210\u53ef\u80fd';
const LABEL_CREATE = '\u30c7\u30c3\u30ad\u4f5c\u6210';
const LABEL_EMPTY = '\u30c7\u30c3\u30ad\u304c\u3042\u308a\u307e\u305b\u3093\u3002';

export function DeckList({
  decks,
  activeDeckId,
  onSelect,
  onCreate
}: DeckListProps) {
  return (
    <section className="panel">
      <div className="panel-header">
        <div>
          <div className="panel-title">{LABEL_DECK}</div>
          <div className="panel-subtitle">{LABEL_MULTI}</div>
        </div>
        <div className="flex gap-2 items-center">
          <button
            type="button"
            className="border border-border bg-transparent text-ink px-2.5 py-1 text-xs rounded-[2px] cursor-pointer hover:bg-list-hover disabled:opacity-50 disabled:cursor-not-allowed"
            onClick={onCreate}
          >
            {LABEL_CREATE}
          </button>
        </div>
      </div>
      <div className="panel-body flex flex-col gap-2 p-3">
        {decks.length === 0 ? (
          <div className="flex items-center justify-center h-full text-muted text-[13px] p-5">{LABEL_EMPTY}</div>
        ) : (
          decks.map((deck) => (
            <button
              key={deck.id}
              type="button"
              className={clsx(
                'w-full text-left p-3 border border-border bg-panel text-ink cursor-pointer grid gap-1 transition-colors hover:bg-list-hover',
                deck.id === activeDeckId && 'bg-list-active border-accent'
              )}
              onClick={() => onSelect(deck.id)}
            >
              <div className="font-semibold">{deck.name}</div>
              <div className="font-mono text-xs text-muted">{deck.path}</div>
            </button>
          ))
        )}
      </div>
    </section>
  );
}
