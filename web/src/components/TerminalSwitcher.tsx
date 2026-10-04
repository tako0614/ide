import { useCallback, useState } from 'react';

interface TerminalSwitcherProps {
  terminals: { id: string; title: string }[];
  // Live OSC titles (terminalId -> title) that agents update continuously.
  liveTitles: Record<string, string | null>;
  value: string;
  onChange: (terminalId: string) => void;
}

/**
 * Terminal picker that stays usable while an agent is streaming title updates.
 *
 * A native <select>'s open dropdown closes whenever its <option> text changes.
 * Agents update terminal titles many times per second via OSC 0/2, so on mobile
 * the picker flickers shut before you can tap an item. We freeze the option
 * labels to a snapshot taken when the picker opens (pointer/focus/keydown) and
 * resume live titles once it closes (change/blur) — so the text never mutates
 * while the dropdown is open.
 */
export function TerminalSwitcher({ terminals, liveTitles, value, onChange }: TerminalSwitcherProps) {
  const [frozen, setFrozen] = useState<Record<string, string> | null>(null);

  const freeze = useCallback(() => {
    const snapshot: Record<string, string> = {};
    for (const terminal of terminals) {
      snapshot[terminal.id] = liveTitles[terminal.id] || terminal.title;
    }
    setFrozen(snapshot);
  }, [terminals, liveTitles]);

  const labelFor = (terminal: { id: string; title: string }): string =>
    (frozen ? frozen[terminal.id] : liveTitles[terminal.id] || terminal.title) || terminal.title;

  return (
    <select
      className="terminal-switcher"
      value={value}
      // Capture a stable snapshot before the native picker opens.
      onPointerDown={freeze}
      onFocus={freeze}
      onKeyDown={freeze}
      onChange={(e) => {
        onChange(e.target.value);
        setFrozen(null);
      }}
      onBlur={() => setFrozen(null)}
      aria-label="ターミナルを切り替え"
    >
      {terminals.map((terminal) => (
        <option key={terminal.id} value={terminal.id}>
          {labelFor(terminal)}
        </option>
      ))}
    </select>
  );
}
