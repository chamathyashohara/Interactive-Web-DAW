import { memo, useMemo, useRef, useState } from "react";
import { TICKS_PER_BAR, type Note, type OpBody, type Track, type Clip } from "@daw/shared";
import { statusStore, useStore } from "../store";
import type { NoteClip } from "./editing";
import { DRUM_NAMES } from "./geometry";
import { ACCENT_VELOCITY, NORMAL_VELOCITY, STEPS_PER_BAR, STEP_TICKS, barCount, clearBarOps, copyBarToAllOps, setStepOps, stepTick, stepVelocity, stepsInBar } from "./steps";
import { VelocityRamp } from "./VelocityRamp";

/** Drums in the order of a drum machine: kicks, snares, clap, hats, toms. */
const ROW_ORDER = [36, 35, 38, 40, 37, 39, 42, 44, 46, 41, 43, 45, 47];
const LABEL_W = 104;

interface Props {
  track: Track;
  clip: Clip;
  rampLocked: boolean;
  rampLockTitle: string | null;
}

type Paint = { velocity: number | null; cells: Map<string, { pitch: number; tick: number }> };

/** The sixteen LEDs over the pads: the one at the playhead is lit. */
const StepLeds = memo(function StepLeds({ clipStart, bar, steps }: { clipStart: number; bar: number; steps: number }) {
  const status = useStore(statusStore);
  const rel = (status?.tick ?? 0) - clipStart - bar * TICKS_PER_BAR;
  const now = status?.playing && rel >= 0 && rel < TICKS_PER_BAR ? Math.floor(rel / STEP_TICKS) : -1;
  return (
    <div className="flex items-center gap-[3px] pr-3" data-testid="step-leds" data-now={now}>
      {Array.from({ length: STEPS_PER_BAR }, (_, s) => (
        <div key={s} className="flex flex-1 items-center" style={{ minWidth: 18, marginLeft: s > 0 && s % 4 === 0 ? 8 : 0, opacity: s < steps ? 1 : 0.2 }}>
          <div className="hw-led-dot" data-lit={s === now ? "true" : undefined} />
        </div>
      ))}
    </div>
  );
});

/**
 * Drum step sequencer: a grid of pads, one row per drum and sixteen steps per bar (one bar at a time).
 * Click a pad to place a hit, click it again to remove it, Shift+click for an accent (louder), drag across a row to paint.
 * It edits the same notes as the piano roll, so the two views always agree.
 */
export function StepSequencer({ track, clip, rampLocked, rampLockTitle }: Props) {
  const [bar, setBar] = useState(0);
  const [activeRow, setActiveRow] = useState<number | null>(null);
  const [paint, setPaint] = useState<Paint | null>(null);
  const paintRef = useRef<Paint | null>(null);
  const notes = useMemo(() => Object.values(clip.notes), [clip.notes]);
  const noteClip: NoteClip = { trackId: track.id, clipId: clip.id, lengthTicks: clip.lengthTicks };
  const bars = barCount(clip.lengthTicks);
  const barNow = Math.min(bar, bars - 1);
  const steps = stepsInBar(clip.lengthTicks, barNow);
  const rows = useMemo(() => [...ROW_ORDER, ...[...new Set(notes.map((n) => n.pitch))].filter((p) => !ROW_ORDER.includes(p)).sort((a, b) => a - b)], [notes]);
  const rowName = (p: number) => DRUM_NAMES[p] ?? `Drum ${p}`;

  const setPaintBoth = (p: Paint | null) => {
    paintRef.current = p;
    setPaint(p);
  };
  const velocityShown = (pitch: number, tick: number): number | null => {
    const key = `${pitch}:${tick}`;
    if (paint?.cells.has(key)) return paint.velocity;
    return stepVelocity(notes, pitch, tick);
  };
  const padOf = (el: Element | null) => el?.closest<HTMLElement>("[data-pad]") ?? null;

  const onPadDown = (e: React.PointerEvent<HTMLDivElement>) => {
    const pad = padOf(e.target as Element);
    if (!pad || e.button !== 0 || pad.dataset.disabled === "true") return;
    const pitch = Number(pad.dataset.pitch), tick = Number(pad.dataset.tick);
    const current = stepVelocity(notes, pitch, tick);
    // Shift: toggle the accent. Otherwise: an empty pad is switched on, a lit pad off, and dragging paints the same thing.
    const velocity = e.shiftKey ? (current === ACCENT_VELOCITY ? NORMAL_VELOCITY : ACCENT_VELOCITY) : current === null ? NORMAL_VELOCITY : null;
    e.currentTarget.setPointerCapture(e.pointerId);
    setActiveRow(pitch);
    if (velocity !== null) {
      window.daw.preview(track.id, pitch, velocity, true);
      setTimeout(() => window.daw.preview(track.id, pitch, velocity, false), 150);
    }
    setPaintBoth({ velocity, cells: new Map([[`${pitch}:${tick}`, { pitch, tick }]]) });
  };
  const onPadMove = (e: React.PointerEvent<HTMLDivElement>) => {
    const p = paintRef.current;
    if (!p) return;
    const pad = padOf(document.elementFromPoint(e.clientX, e.clientY));
    if (!pad || pad.dataset.disabled === "true") return;
    const pitch = Number(pad.dataset.pitch), tick = Number(pad.dataset.tick);
    const key = `${pitch}:${tick}`;
    if (p.cells.has(key)) return;
    setPaintBoth({ ...p, cells: new Map(p.cells).set(key, { pitch, tick }) });
  };
  const onPadUp = () => {
    const p = paintRef.current;
    setPaintBoth(null);
    if (!p) return;
    const ops: OpBody[] = [];
    for (const c of p.cells.values()) ops.push(...setStepOps(noteClip, notes, c.pitch, c.tick, p.velocity, () => crypto.randomUUID()));
    if (ops.length) void window.daw.dispatchBatch(ops);
  };

  const rampNotes: Note[] = activeRow === null ? notes : notes.filter((n) => n.pitch === activeRow);
  const rampScope = activeRow === null ? "all the drums in this clip" : `the ${rowName(activeRow)} hits in this clip`;
  const btn = "hw-btn px-2 py-0.5 text-[11px]";

  return (
    <div className="hw-panel-deep flex min-h-0 flex-1 flex-col" data-testid="step-sequencer" data-bar={barNow}>
      <div className="flex flex-wrap items-center gap-1.5 border-b border-black px-3 py-1.5">
        <span className="hw-legend mr-1">BAR</span>
        {Array.from({ length: bars }, (_, b) => (
          <button key={b} className={`${btn} hw-teal min-w-7`} aria-pressed={b === barNow} onClick={() => setBar(b)} data-testid={`step-bar-${b + 1}`}>
            {b + 1}
          </button>
        ))}
        <span className="mx-1 h-4 w-px bg-white/10" />
        <button className={btn} onClick={() => void window.daw.dispatchBatch(clearBarOps(noteClip, notes, barNow, activeRow ?? undefined))} disabled={!notes.length} title={activeRow === null ? "Clear every drum in this bar" : `Clear the ${rowName(activeRow)} in this bar`} data-testid="step-clear">
          Clear bar
        </button>
        <button className={btn} onClick={() => void window.daw.dispatchBatch(copyBarToAllOps(noteClip, notes, barNow, () => crypto.randomUUID()))} disabled={bars < 2} title="Make every other bar of this clip a copy of this one" data-testid="step-copy-all">
          Copy to all bars
        </button>
        <VelocityRamp clip={noteClip} notes={rampNotes} scope={rampScope} disabled={rampLocked} lockTitle={rampLockTitle} className={btn} />
        <span className="ml-auto truncate text-[11px] text-slate-500">Click a pad to place a hit · Shift+click = accent · drag to paint · click a name to hear it</span>
      </div>

      <div className="min-h-0 flex-1 overflow-auto px-3 pt-2 pb-3">
        <div className="mb-1.5 flex items-center" style={{ paddingLeft: LABEL_W }}>
          <div className="min-w-0 flex-1">
            <StepLeds clipStart={clip.startTick} bar={barNow} steps={steps} />
          </div>
        </div>
        <div className="flex flex-col gap-1.5">
          {rows.map((pitch) => (
            <div key={pitch} className="flex items-center" data-testid="step-row" data-pitch={pitch}>
              <button
                className={`hw-btn hw-flat mr-2 justify-start px-2 py-1 text-[11px] ${activeRow === pitch ? "!text-amber-300" : ""}`}
                style={{ width: LABEL_W - 8 }}
                aria-pressed={activeRow === pitch}
                onPointerDown={() => {
                  setActiveRow(activeRow === pitch ? null : pitch);
                  window.daw.preview(track.id, pitch, 100, true);
                  setTimeout(() => window.daw.preview(track.id, pitch, 100, false), 200);
                }}
                title={`${rowName(pitch)}: click to hear it and select the row (Clear bar and Ramp then work on this drum only)`}
              >
                {rowName(pitch)}
              </button>
              <div className="flex min-w-0 flex-1 items-center gap-[3px] pr-3" onPointerDown={onPadDown} onPointerMove={onPadMove} onPointerUp={onPadUp} onPointerCancel={onPadUp}>
                {Array.from({ length: STEPS_PER_BAR }, (_, s) => {
                  const tick = stepTick(barNow, s);
                  const v = velocityShown(pitch, tick);
                  const disabled = s >= steps;
                  return (
                    <div
                      key={s}
                      data-pad
                      data-pitch={pitch}
                      data-tick={tick}
                      data-step={s}
                      data-beat={Math.floor(s / 4) % 2 === 1 ? "odd" : "even"}
                      data-on={v !== null ? "true" : undefined}
                      data-accent={v !== null && v >= ACCENT_VELOCITY - 5 ? "true" : undefined}
                      data-velocity={v ?? undefined}
                      data-disabled={disabled ? "true" : undefined}
                      className="hw-pad"
                      style={{ marginLeft: s > 0 && s % 4 === 0 ? 8 : 0, opacity: v !== null ? 0.55 + 0.45 * (v / 127) : undefined }}
                    />
                  );
                })}
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
