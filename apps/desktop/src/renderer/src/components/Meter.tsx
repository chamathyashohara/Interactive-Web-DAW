import { statusStore, useStore } from "../store";
import type { StatusPayload } from "../../../preload/index";

/** Maps a linear peak (0..1) to 0..100 on a -60 dB .. 0 dB scale. */
export function levelToPct(level: number): number {
  const db = 20 * Math.log10(Math.max(level, 1e-4));
  return Math.min(100, Math.max(0, ((db + 60) / 60) * 100));
}

export function volumeToDb(volume: number): string {
  if (volume <= 0) return "-∞";
  const db = 40 * Math.log10(volume / 100); // gain = (v/100)^2
  return `${db >= 0 ? "+" : ""}${db.toFixed(1)}`;
}

interface Props {
  read: (s: StatusPayload | null) => number;
  orientation?: "vertical" | "horizontal";
  color?: string;
  testId?: string;
  className?: string;
}

/** Subscribes to the ~30 Hz engine status on its own, so only meters re-render. */
export function Meter({ read, orientation = "vertical", color = "#34d399", testId, className = "" }: Props) {
  const level = read(useStore(statusStore));
  const pct = levelToPct(level);
  void color; // the LEDs are green, amber and red like a real console; the track colour is not used here
  return (
    <div data-testid={testId} data-level={level.toFixed(4)} className={`hw-meter ${orientation === "vertical" ? "hw-meter-v" : "hw-meter-h"} ${className}`}>
      <div className="hw-led hw-led-dim" />
      <div className="hw-led hw-led-lit" style={{ clipPath: orientation === "vertical" ? `inset(${100 - pct}% 0 0 0)` : `inset(0 ${100 - pct}% 0 0)` }} />
    </div>
  );
}
