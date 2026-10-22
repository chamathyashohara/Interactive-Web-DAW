import { useEffect, useRef, useState } from "react";
import type { Note } from "@daw/shared";
import type { NoteClip } from "./editing";
import { velocityRampOps, type RampCurve } from "./ramp";

const PRESETS: { label: string; from: number; to: number; curve: RampCurve; hint: string }[] = [
  { label: "Build up", from: 30, to: 120, curve: "ease-in", hint: "Quiet at first, then louder and louder" },
  { label: "Fade out", from: 120, to: 30, curve: "ease-out", hint: "Loud, then dropping away" },
];

const num = (v: string, fallback: number) => {
  const n = Math.round(Number(v));
  return Number.isFinite(n) ? Math.min(127, Math.max(1, n)) : fallback;
};

/**
 * Velocity ramp: sets the loudness of a group of notes so it climbs (or falls) smoothly from the first note to the last.
 * One undo step. `scope` says in words which notes it will change.
 */
export function VelocityRamp({ clip, notes, scope, disabled, lockTitle, className }: { clip: NoteClip; notes: Note[]; scope: string; disabled: boolean; lockTitle: string | null; className: string }) {
  const [open, setOpen] = useState(false);
  const [from, setFrom] = useState("40");
  const [to, setTo] = useState("110");
  const [curve, setCurve] = useState<RampCurve>("linear");
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const away = (e: PointerEvent) => !ref.current?.contains(e.target as Node) && setOpen(false);
    const esc = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    window.addEventListener("pointerdown", away);
    window.addEventListener("keydown", esc);
    return () => {
      window.removeEventListener("pointerdown", away);
      window.removeEventListener("keydown", esc);
    };
  }, [open]);

  const f = num(from, 40), t = num(to, 110);
  const changes = velocityRampOps(clip, notes, f, t, curve).length;
  const apply = () => {
    const ops = velocityRampOps(clip, notes, f, t, curve);
    if (ops.length) {
      window.daw.telemetry.event("ui.ramp", { notes: ops.length });
      void window.daw.dispatchBatch(ops, `ramp-${clip.clipId}`);
    }
    setOpen(false);
  };
  const field = "hw-field w-12 px-1 py-0.5 text-right text-[11px]";
  return (
    <div className="relative" ref={ref}>
      <button className={className} disabled={disabled || notes.length < 2} aria-pressed={open} onClick={() => setOpen(!open)} title={lockTitle ?? "Velocity ramp: make a group of notes get louder or softer from the first to the last"} data-testid="ramp-toggle">
        Ramp
      </button>
      {open && (
        <div className="hw-popover absolute top-full left-0 z-[60] mt-1.5 w-[260px] p-3 text-[11px] text-slate-300" data-testid="ramp-popover">
          <div className="hw-legend mb-2 !text-[10px]">VELOCITY RAMP</div>
          <p className="mb-2 text-slate-400">Changes the loudness of {scope}, from the first note to the last.</p>
          <div className="mb-2 flex gap-1.5">
            {PRESETS.map((p) => (
              <button key={p.label} className="hw-btn flex-1 px-2 py-1" title={p.hint} onClick={() => (setFrom(String(p.from)), setTo(String(p.to)), setCurve(p.curve))}>
                {p.label}
              </button>
            ))}
          </div>
          <div className="mb-2 flex items-center gap-2">
            <label className="flex items-center gap-1">
              Start
              <input className={field} value={from} onChange={(e) => setFrom(e.target.value)} inputMode="numeric" aria-label="Ramp start loudness" data-testid="ramp-from" />
            </label>
            <label className="flex items-center gap-1">
              End
              <input className={field} value={to} onChange={(e) => setTo(e.target.value)} inputMode="numeric" aria-label="Ramp end loudness" data-testid="ramp-to" />
            </label>
          </div>
          <label className="mb-3 flex items-center gap-2">
            Shape
            <select value={curve} onChange={(e) => setCurve(e.target.value as RampCurve)} className="hw-lcd min-w-0 flex-1 px-1.5 py-1 text-[11px] outline-none" aria-label="Ramp shape" data-testid="ramp-curve">
              <option value="linear">Even</option>
              <option value="ease-in">Slow start, then faster</option>
              <option value="ease-out">Fast start, then slower</option>
            </select>
          </label>
          <div className="flex items-center justify-between">
            <span className="text-slate-500">{changes ? `${changes} note${changes === 1 ? "" : "s"} will change` : "nothing would change"}</span>
            <button className="hw-btn hw-go px-3 py-1" disabled={!changes} onClick={apply} data-testid="ramp-apply">
              Apply
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
