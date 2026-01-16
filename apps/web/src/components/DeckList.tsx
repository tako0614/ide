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
    <section className="panel deck-list">
      <div className="panel-header">
        <div>
          <div className="panel-title">{LABEL_DECK}</div>
          <div className="panel-subtitle">{LABEL_MULTI}</div>
        </div>
        <button type="button" className="chip" onClick={onCreate}>
          {LABEL_CREATE}
        </button>
      </div>
      <div className="panel-body">
        {decks.length === 0 ? (
          <div className="empty-state">{LABEL_EMPTY}</div>
        ) : (
          decks.map((deck) => (
            <button
              key={deck.id}
              type="button"
              className={`deck-item ${
                deck.id === activeDeckId ? 'is-active' : ''
              }`}
              onClick={() => onSelect(deck.id)}
            >
              <div className="deck-name">{deck.name}</div>
              <div className="deck-root">{deck.path}</div>
            </button>
          ))
        )}
      </div>
    </section>
  );
}
