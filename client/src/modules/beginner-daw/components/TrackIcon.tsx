import type { TrackKind } from "../types/daw";

interface TrackIconProps {
  kind: TrackKind;
  color: string;
}

export function TrackIcon({ kind, color }: TrackIconProps) {
  const common = "h-4 w-4";

  if (kind === "drums") {
    return (
      <svg viewBox="0 0 16 16" className={common} aria-hidden="true">
        <circle cx="8" cy="8" r="5.5" fill="none" stroke={color} strokeWidth="1.6" />
        <circle cx="8" cy="8" r="1.4" fill={color} />
      </svg>
    );
  }

  if (kind === "bass") {
    return (
      <svg viewBox="0 0 16 16" className={common} aria-hidden="true">
        <path d="M3 11c2-6 8-6 10 0" fill="none" stroke={color} strokeWidth="1.6" />
        <path d="M3 8c2 4 8 4 10 0" fill="none" stroke={color} strokeWidth="1.6" />
      </svg>
    );
  }

  if (kind === "chords") {
    return (
      <svg viewBox="0 0 16 16" className={common} aria-hidden="true">
        <rect x="3" y="9" width="2.2" height="5" rx="0.5" fill={color} />
        <rect x="7" y="5" width="2.2" height="9" rx="0.5" fill={color} />
        <rect x="11" y="3" width="2.2" height="11" rx="0.5" fill={color} />
      </svg>
    );
  }

  if (kind === "lead") {
    return (
      <svg viewBox="0 0 16 16" className={common} aria-hidden="true">
        <path
          d="M2 10h2l1.5-4 2 8 2-10 2 7 1.5-3H14"
          fill="none"
          stroke={color}
          strokeWidth="1.5"
          strokeLinecap="round"
        />
      </svg>
    );
  }

  if (kind === "vocal") {
    return (
      <svg viewBox="0 0 16 16" className={common} aria-hidden="true">
        <rect x="6" y="2" width="4" height="7" rx="2" fill={color} />
        <path d="M4 8a4 4 0 0 0 8 0" fill="none" stroke={color} strokeWidth="1.5" />
        <path d="M8 12v2M6 14h4" stroke={color} strokeWidth="1.5" />
      </svg>
    );
  }

  return (
    <svg viewBox="0 0 16 16" className={common} aria-hidden="true">
      <path d="M3 13 L8 3 L13 13" fill="none" stroke={color} strokeWidth="1.6" />
      <path d="M5 9h6" stroke={color} strokeWidth="1.6" />
    </svg>
  );
}
