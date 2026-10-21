interface Props {
  maximized: boolean;
  onToggleMaximize: () => void;
  onClose: () => void;
}

const base = "flex h-6 w-7 items-center justify-center rounded text-slate-400 transition-colors";

/** Maximize / restore and close for the piano roll panel, drawn like window controls. */
export function WindowButtons({ maximized, onToggleMaximize, onClose }: Props) {
  return (
    <span className="ml-2 flex items-center gap-0.5">
      <button
        className={`${base} hover:bg-white/10 hover:text-slate-100`}
        onClick={onToggleMaximize}
        aria-label={maximized ? "Restore piano roll" : "Maximize piano roll"}
        title={maximized ? "Restore (Esc)" : "Maximize: use the full window"}
        data-testid="pr-maximize"
      >
        {maximized ? (
          <svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.2">
            <rect x="3.5" y="1" width="7.5" height="7.5" />
            <path d="M1 3.5v7.5h7.5" />
          </svg>
        ) : (
          <svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.2">
            <rect x="1.5" y="1.5" width="9" height="9" />
          </svg>
        )}
      </button>
      <button
        className={`${base} hover:bg-rose-500/80 hover:text-white`}
        onClick={onClose}
        aria-label="Close piano roll"
        title="Close the piano roll (reopen with the Piano roll button or by double-clicking a clip)"
        data-testid="pr-close"
      >
        <svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round">
          <path d="M2 2l8 8M10 2l-8 8" />
        </svg>
      </button>
    </span>
  );
}
