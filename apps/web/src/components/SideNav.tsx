type AppView = 'workspace' | 'terminal';
type ThemeMode = 'light' | 'dark';

interface SideNavProps {
  activeView: AppView;
  onSelect: (view: AppView) => void;
  theme: ThemeMode;
  onToggleTheme: () => void;
}

const LABEL_PROJECT = '\u30ef\u30fc\u30af\u30b9\u30da\u30fc\u30b9';
const LABEL_TERMINAL = '\u30bf\u30fc\u30df\u30ca\u30eb';
const LABEL_THEME = '\u30c6\u30fc\u30de\u5207\u66ff';
const LABEL_TO_LIGHT = '\u30e9\u30a4\u30c8\u306b\u5207\u66ff';
const LABEL_TO_DARK = '\u30c0\u30fc\u30af\u306b\u5207\u66ff';

export function SideNav({
  activeView,
  onSelect,
  theme,
  onToggleTheme
}: SideNavProps) {
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
      <div className="nav-spacer" aria-hidden="true" />
      <button
        type="button"
        className="theme-toggle"
        onClick={onToggleTheme}
        aria-label={LABEL_THEME}
        title={theme === 'dark' ? LABEL_TO_LIGHT : LABEL_TO_DARK}
      >
        {theme === 'dark' ? (
          <svg viewBox="0 0 24 24" aria-hidden="true" className="theme-icon">
            <circle cx="12" cy="12" r="4.5" fill="none" strokeWidth="1.6" />
            <line x1="12" y1="3" x2="12" y2="5.5" strokeWidth="1.6" />
            <line x1="12" y1="18.5" x2="12" y2="21" strokeWidth="1.6" />
            <line x1="3" y1="12" x2="5.5" y2="12" strokeWidth="1.6" />
            <line x1="18.5" y1="12" x2="21" y2="12" strokeWidth="1.6" />
            <line x1="5.7" y1="5.7" x2="7.5" y2="7.5" strokeWidth="1.6" />
            <line x1="16.5" y1="16.5" x2="18.3" y2="18.3" strokeWidth="1.6" />
            <line x1="16.5" y1="7.5" x2="18.3" y2="5.7" strokeWidth="1.6" />
            <line x1="5.7" y1="18.3" x2="7.5" y2="16.5" strokeWidth="1.6" />
          </svg>
        ) : (
          <svg viewBox="0 0 24 24" aria-hidden="true" className="theme-icon">
            <path
              d="M15.5 4.5a7 7 0 1 0 4 12.7 7.6 7.6 0 0 1-4-12.7z"
              fill="none"
              strokeWidth="1.6"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          </svg>
        )}
      </button>
    </nav>
  );
}
