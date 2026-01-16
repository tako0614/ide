type AppView = 'workspace' | 'terminal';

interface SideNavProps {
  activeView: AppView;
  onSelect: (view: AppView) => void;
}

const LABEL_PROJECT = '\u30d7\u30ed\u30b8\u30a7\u30af\u30c8';
const LABEL_TERMINAL = '\u30bf\u30fc\u30df\u30ca\u30eb';

export function SideNav({ activeView, onSelect }: SideNavProps) {
  return (
    <nav className="side-nav">
      <button
        type="button"
        className={activeView === 'workspace' ? 'is-active' : ''}
        onClick={() => onSelect('workspace')}
        aria-label={LABEL_PROJECT}
        title={LABEL_PROJECT}
      >
        <svg viewBox="0 0 24 24" aria-hidden="true">
          <rect x="3" y="4" width="18" height="4" rx="1.5" />
          <rect x="3" y="10" width="18" height="10" rx="2" />
        </svg>
      </button>
      <button
        type="button"
        className={activeView === 'terminal' ? 'is-active' : ''}
        onClick={() => onSelect('terminal')}
        aria-label={LABEL_TERMINAL}
        title={LABEL_TERMINAL}
      >
        <svg viewBox="0 0 24 24" aria-hidden="true">
          <rect x="3" y="4" width="18" height="16" rx="2" />
          <path
            d="M7 9l3 3-3 3"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.6"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
          <line
            x1="12"
            y1="15"
            x2="17"
            y2="15"
            stroke="currentColor"
            strokeWidth="1.6"
            strokeLinecap="round"
          />
        </svg>
      </button>
    </nav>
  );
}
