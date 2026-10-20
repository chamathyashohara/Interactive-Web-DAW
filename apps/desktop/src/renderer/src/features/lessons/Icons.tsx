import type { ReactNode } from "react";
import type { Concept } from "./types";

/** Small inline line icons (no icon package), 24×24 viewBox, drawn with currentColor. */
function Svg({ children, size = 18, className = "" }: { children: ReactNode; size?: number; className?: string }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round" className={className} aria-hidden="true">
      {children}
    </svg>
  );
}

type P = { size?: number; className?: string };

export const BookIcon = (p: P) => (
  <Svg {...p}>
    <path d="M3 5.5C3 4.7 3.7 4 4.5 4H10a2 2 0 0 1 2 2v14a2 2 0 0 0-2-2H3z" />
    <path d="M21 5.5c0-.8-.7-1.5-1.5-1.5H14a2 2 0 0 0-2 2v14a2 2 0 0 1 2-2h7z" />
  </Svg>
);
export const NotesIcon = (p: P) => (
  <Svg {...p}>
    <rect x="4" y="3" width="16" height="18" rx="2" />
    <path d="M8 8h8M8 12h8M8 16h5" />
  </Svg>
);
export const PracticeIcon = (p: P) => (
  <Svg {...p}>
    <path d="m14 4 6 6-9.5 9.5H4.5v-6z" />
    <path d="m12 6 6 6" />
  </Svg>
);
export const SummaryIcon = (p: P) => (
  <Svg {...p}>
    <rect x="4" y="4" width="16" height="16" rx="2" />
    <path d="m8.5 12 2.5 2.5 4.5-5" />
  </Svg>
);
export const SpeakerIcon = (p: P) => (
  <Svg {...p}>
    <path d="M4 9v6h4l5 4V5L8 9z" />
    <path d="M16.5 8.5a5 5 0 0 1 0 7M19 6a8.5 8.5 0 0 1 0 12" />
  </Svg>
);
export const BulbIcon = (p: P) => (
  <Svg {...p}>
    <path d="M9 18h6M10 21h4" />
    <path d="M12 3a6 6 0 0 0-3.5 10.9c.6.5 1 1.2 1 2.1h5c0-.9.4-1.6 1-2.1A6 6 0 0 0 12 3z" />
  </Svg>
);
export const SearchIcon = (p: P) => (
  <Svg {...p}>
    <circle cx="11" cy="11" r="7" />
    <path d="m20 20-3.5-3.5" />
  </Svg>
);
export const ArrowLeft = (p: P) => (
  <Svg {...p}>
    <path d="M19 12H5M11 6l-6 6 6 6" />
  </Svg>
);
export const ArrowRight = (p: P) => (
  <Svg {...p}>
    <path d="M5 12h14M13 6l6 6-6 6" />
  </Svg>
);
export const PlayIcon = (p: P) => (
  <svg width={p.size ?? 18} height={p.size ?? 18} viewBox="0 0 24 24" className={p.className} aria-hidden="true">
    <path d="M8 5.5v13l10.5-6.5z" fill="currentColor" />
  </svg>
);
export const StopIcon = (p: P) => (
  <svg width={p.size ?? 18} height={p.size ?? 18} viewBox="0 0 24 24" className={p.className} aria-hidden="true">
    <rect x="6.5" y="6.5" width="11" height="11" rx="1.5" fill="currentColor" />
  </svg>
);
export const CheckIcon = (p: P) => (
  <Svg {...p}>
    <path d="m5 12.5 4.5 4.5L19 7.5" />
  </Svg>
);
export const HelpIcon = (p: P) => (
  <Svg {...p}>
    <circle cx="12" cy="12" r="9" />
    <path d="M9.5 9.5a2.5 2.5 0 1 1 3.5 2.3c-.6.3-1 .9-1 1.6V14M12 17.5v.01" />
  </Svg>
);
export const CursorIcon = (p: P) => (
  <Svg {...p}>
    <path d="m5 3 14 7-6 2-2 6z" />
  </Svg>
);
export const PencilIcon = (p: P) => (
  <Svg {...p}>
    <path d="m4 20 1-5L16 4l4 4L9 19z" />
    <path d="m14 6 4 4" />
  </Svg>
);
export const BrushIcon = (p: P) => (
  <Svg {...p}>
    <path d="M14 4h6v6M20 4 10 14" />
    <path d="M10 14c-3 0-5 2-5 5v1h1c3 0 5-2 5-5" />
  </Svg>
);
export const EraserIcon = (p: P) => (
  <Svg {...p}>
    <path d="m7 20-3.5-3.5a2 2 0 0 1 0-2.8L13 4.2a2 2 0 0 1 2.8 0l4 4a2 2 0 0 1 0 2.8L11 20z" />
    <path d="M7 20h13M9.5 8.5l6 6" />
  </Svg>
);
export const MuteIcon = (p: P) => (
  <Svg {...p}>
    <path d="M4 9v6h4l5 4V5L8 9z" />
    <path d="m17 9 4 6M21 9l-4 6" />
  </Svg>
);
export const ScissorsIcon = (p: P) => (
  <Svg {...p}>
    <circle cx="6" cy="7" r="2.5" />
    <circle cx="6" cy="17" r="2.5" />
    <path d="M8 8.5 20 18M8 15.5 20 6" />
  </Svg>
);

/** One picture per concept for the lesson header tile. */
export function ConceptIcon({ concept, size = 30 }: { concept: Concept; size?: number }) {
  switch (concept) {
    case "chords":
      return (
        <Svg size={size}>
          <rect x="3" y="4" width="18" height="16" rx="2" />
          <path d="M8 4v16M12 4v16M16 4v16" />
          <path d="M6.5 4v8h3V4M14.5 4v8h3V4" fill="currentColor" />
        </Svg>
      );
    case "melody":
      return (
        <Svg size={size}>
          <path d="M9 18V6l10-2v12" />
          <circle cx="6.5" cy="18" r="2.5" />
          <circle cx="16.5" cy="16" r="2.5" />
        </Svg>
      );
    case "rhythm":
      return (
        <Svg size={size}>
          <ellipse cx="12" cy="9" rx="8" ry="3" />
          <path d="M4 9v7c0 1.7 3.6 3 8 3s8-1.3 8-3V9" />
          <path d="m5 3 5 5M19 3l-5 5" />
        </Svg>
      );
    case "midi-editing":
      return (
        <Svg size={size}>
          <path d="M6 4v16M12 4v16M18 4v16" />
          <rect x="4" y="13" width="4" height="3" rx="1" fill="currentColor" />
          <rect x="10" y="7" width="4" height="3" rx="1" fill="currentColor" />
          <rect x="16" y="11" width="4" height="3" rx="1" fill="currentColor" />
        </Svg>
      );
  }
}
