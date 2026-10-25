import { useState } from "react";
import { MAX_AUTO_POINTS, TICKS_PER_BAR, songTicks, type AutoParam, type AutoPoint, type Clip, type OpBody, type Project, type Track } from "@daw/shared";
import { statusStore, useStore } from "../../../store";
import { arpOps, chopOps, copyClipToTrackOps, separateDrumsOps, shiftOps, STEP_CHOICES, type ArpPattern } from "./lessonTools";
import { toDb, usePeaks } from "./meters";
import { curveAt, valueToHz } from "./songChecks";
import type { Tool } from "./types";

/**
 * The extra panels of the lesson workspace for the Make a Song lessons: an automation lane under a track, a tools bar for
 * the selected clip (octave, chop, arp, copy to another track, one track per drum) and a small mixer with meters.
 */

const uuid = () => crypto.randomUUID();
const small = "rounded-lg px-2.5 py-1 text-xs font-medium transition-colors disabled:opacity-40 bg-white/5 text-slate-200 hover:bg-white/10";
const select = "rounded-lg bg-white/5 px-1.5 py-1 text-xs text-slate-100";
export const AUTO_H = 64;

const valueText = (param: AutoParam, v: number) => {
  if (param === "volume") return `${Math.round(v * 100)}%`;
  const hz = valueToHz(v);
  return hz >= 1000 ? `${(hz / 1000).toFixed(hz >= 10000 ? 0 : 1)} kHz` : `${Math.round(hz)} Hz`;
};

/** A curve under a track: click to add a point, drag a point, double-click it to remove it. Filter shows Hz while dragging. */
export function AutomationLane({ track, project, width, pxPerBar, grid, snap, readOnly }: { track: Track; project: Project; width: number; pxPerBar: number; grid: number; snap: boolean; readOnly: boolean }) {
  const status = useStore(statusStore);
  const [param, setParam] = useState<AutoParam>("filter");
  const [drag, setDrag] = useState<{ index: number; points: AutoPoint[] } | null>(null);
  const saved = track.automation?.[param] ?? [];
  const points = drag?.points ?? saved;
  const songLen = songTicks(project);
  const x = (t: number) => (t / TICKS_PER_BAR) * pxPerBar;
  const y = (v: number) => (1 - v) * (AUTO_H - 8) + 4;
  const pos = (e: React.PointerEvent | React.MouseEvent, el: Element) => {
    const r = el.getBoundingClientRect();
    const raw = ((e.clientX - r.left) / pxPerBar) * TICKS_PER_BAR;
    const tick = Math.max(0, Math.min(songLen, snap ? Math.round(raw / grid) * grid : Math.round(raw)));
    const value = Math.max(0, Math.min(1, 1 - (e.clientY - r.top - 4) / (AUTO_H - 8)));
    return { tick, value: Math.round(value * 1000) / 1000 };
  };
  const save = (pts: AutoPoint[]) => {
    const sorted = [...pts].sort((a, b) => a.tick - b.tick).filter((p, i, a) => i === 0 || p.tick !== a[i - 1]!.tick);
    void window.daw.dispatch({ type: "setAutomation", trackId: track.id, param, points: sorted.length ? sorted.slice(0, MAX_AUTO_POINTS) : null });
  };
  const down = (e: React.PointerEvent<SVGSVGElement>) => {
    if (readOnly || e.button !== 0) return;
    const el = e.currentTarget;
    const hit = (e.target as Element).closest<SVGCircleElement>("[data-point]");
    try {
      el.setPointerCapture(e.pointerId);
    } catch {
      // synthetic pointer
    }
    if (hit) return setDrag({ index: Number(hit.dataset.point), points: saved });
    const p = pos(e, el);
    const next = [...saved.filter((q) => q.tick !== p.tick), p].sort((a, b) => a.tick - b.tick);
    setDrag({ index: next.findIndex((q) => q.tick === p.tick), points: next });
  };
  const move = (e: React.PointerEvent<SVGSVGElement>) => {
    if (!drag) return;
    const p = pos(e, e.currentTarget);
    setDrag({ ...drag, points: drag.points.map((q, i) => (i === drag.index ? p : q)) });
  };
  const up = () => {
    if (!drag) return;
    save(drag.points);
    setDrag(null);
  };
  const dbl = (e: React.MouseEvent<SVGSVGElement>) => {
    const hit = (e.target as Element).closest<SVGCircleElement>("[data-point]");
    if (!hit || readOnly) return;
    save(saved.filter((_, i) => i !== Number(hit.dataset.point)));
  };
  const line = points.length ? [{ tick: 0, value: points[0]!.value }, ...points, { tick: songLen, value: points[points.length - 1]!.value }].map((p) => `${x(p.tick)},${y(p.value)}`).join(" ") : "";
  const label = drag ? drag.points[drag.index] : null;
  return (
    <div className="flex border-b border-white/5 bg-black/20" style={{ height: AUTO_H }} data-testid={`kauto-${track.id}`}>
      <div className="sticky left-0 z-10 flex shrink-0 flex-col justify-center gap-1 border-r border-white/10 bg-[#11151d] px-2" style={{ width: 176 }}>
        <span className="truncate text-[10px] text-slate-400">∿ {track.name}</span>
        <div className="flex items-center gap-1">
          <select value={param} onChange={(e) => setParam(e.target.value as AutoParam)} className={select} aria-label={`Automation of ${track.name}`} data-testid={`kauto-param-${track.id}`}>
            <option value="filter">Filter (low-pass)</option>
            <option value="volume">Volume</option>
          </select>
          {saved.length > 0 && !readOnly && (
            <button className="text-[10px] text-slate-500 hover:text-rose-300" onClick={() => save([])} title="Remove this curve">
              Clear
            </button>
          )}
        </div>
      </div>
      <div className="relative" style={{ width }}>
        <svg width={width} height={AUTO_H} className="absolute inset-0 cursor-crosshair" onPointerDown={down} onPointerMove={move} onPointerUp={up} onDoubleClick={dbl} data-testid={`kauto-svg-${track.id}`}>
          {!points.length && (
            <text x={8} y={AUTO_H / 2 + 4} className="fill-slate-500 text-[11px]">
              {readOnly ? "" : param === "filter" ? "Click to add a filter point (top = open, lower = darker)" : "Click to add a volume point"}
            </text>
          )}
          {line && <polyline points={line} fill="none" stroke={param === "filter" ? "#38bdf8" : "#fbbf24"} strokeWidth={2} />}
          {points.map((p, i) => (
            <circle key={`${i}-${p.tick}`} data-point={i} cx={x(p.tick)} cy={y(p.value)} r={5} fill={param === "filter" ? "#38bdf8" : "#fbbf24"} stroke="#0b0d13" strokeWidth={1.5} className="cursor-grab" data-testid="kpoint" data-tick={p.tick} data-value={p.value} />
          ))}
        </svg>
        {label && (
          <span className="pointer-events-none absolute top-1 rounded bg-black/70 px-1.5 py-0.5 text-[10px] text-white" style={{ left: Math.min(width - 90, x(label.tick) + 8) }} data-testid="kauto-readout">
            bar {Math.floor(label.tick / TICKS_PER_BAR) + 1} · {valueText(param, label.value)}
          </span>
        )}
        {!label && points.length > 0 && (
          <span className="pointer-events-none absolute right-2 bottom-1 text-[10px] text-slate-500">now {valueText(param, curveAt(points, status?.tick ?? 0))}</span>
        )}
      </div>
    </div>
  );
}

/** Tools for the selected clip, as the exercise allows them. */
export function ClipTools({ project, tracks, track, clip, tools, run }: { project: Project; tracks: Track[]; track?: Track; clip?: Clip; tools: Tool[]; run: (ops: OpBody[] | null, refused: string) => void }) {
  const [chop, setChop] = useState<number>(STEP_CHOICES[1].ticks);
  const [arp, setArp] = useState<ArpPattern>("up");
  const [arpStep, setArpStep] = useState<number>(STEP_CHOICES[2].ticks);
  const targets = tracks.filter((t) => t.id !== track?.id && t.instrument !== "sample");
  const [target, setTarget] = useState("");
  const show = (t: Tool) => tools.includes(t);
  if (!["octave", "chop", "arp", "copyToTrack", "separateDrums"].some((t) => show(t as Tool))) return null;
  const off = !track || !clip;
  return (
    <div className="flex flex-wrap items-center gap-2 border-t border-white/10 bg-[#0f121a] px-4 py-2" data-testid="kclip-tools">
      <span className="text-[11px] text-slate-400">{off ? "Select a clip to use these tools:" : `${track!.name} · ${clip!.name ?? "clip"}:`}</span>
      {show("octave") && (
        <>
          <button className={small} disabled={off} onClick={() => run(shiftOps(track!.id, clip!, -12), "Some notes would leave the keyboard.")} data-testid="koct-down">
            Octave ↓
          </button>
          <button className={small} disabled={off} onClick={() => run(shiftOps(track!.id, clip!, 12), "Some notes would leave the keyboard.")} data-testid="koct-up">
            Octave ↑
          </button>
        </>
      )}
      {show("chop") && (
        <span className="flex items-center gap-1" title="The chopper: cut every long note into shorter notes">
          <select value={chop} onChange={(e) => setChop(Number(e.target.value))} className={select} aria-label="Chop into" data-testid="kchop-step">
            {STEP_CHOICES.map((s) => (
              <option key={s.label} value={s.ticks}>
                {s.label}
              </option>
            ))}
          </select>
          <button className={small} disabled={off} onClick={() => run(chopOps(track!.id, clip!, chop, uuid), "")} data-testid="kchop">
            Chop
          </button>
        </span>
      )}
      {show("arp") && (
        <span className="flex items-center gap-1" title="Arpeggiator preset: play each chord's notes one after another">
          <select value={arp} onChange={(e) => setArp(e.target.value as ArpPattern)} className={select} aria-label="Arp pattern" data-testid="karp-pattern">
            <option value="up">Arp Up</option>
            <option value="down">Arp Down</option>
            <option value="updown">Arp Up-down</option>
          </select>
          <select value={arpStep} onChange={(e) => setArpStep(Number(e.target.value))} className={select} aria-label="Arp speed" data-testid="karp-step">
            {STEP_CHOICES.map((s) => (
              <option key={s.label} value={s.ticks}>
                {s.label}
              </option>
            ))}
          </select>
          <button className={small} disabled={off} onClick={() => run(arpOps(track!.id, clip!, arp, arpStep, uuid), "")} data-testid="karp">
            Apply arp
          </button>
        </span>
      )}
      {show("copyToTrack") && (
        <span className="flex items-center gap-1" title="Copy the selected clip onto another track, same bars">
          <select value={target} onChange={(e) => setTarget(e.target.value)} className={select} aria-label="Copy to track" data-testid="kcopy-target">
            <option value="">Copy to track…</option>
            {targets.map((t) => (
              <option key={t.id} value={t.id}>
                {t.name}
              </option>
            ))}
          </select>
          <button className={small} disabled={off || !target} onClick={() => run(copyClipToTrackOps(project, clip!, target, uuid), "That track already has a clip in those bars. Move or delete it first.")} data-testid="kcopy">
            Copy
          </button>
        </span>
      )}
      {show("separateDrums") && track?.instrument === "drums" && (
        <button className={small} onClick={() => run(separateDrumsOps(project, track.id, () => `lesson-k-${uuid()}`, uuid), "This track has only one drum sound.")} data-testid="kseparate">
          One track per drum
        </button>
      )}
    </div>
  );
}

/** A small mixer for the lesson's tracks: level, pan, live meter and the peak measured while playing. */
export function LessonMixer({ project, tracks }: { project: Project; tracks: Track[] }) {
  const status = useStore(statusStore);
  const peaks = usePeaks();
  const meter = (v: number) => Math.max(0, Math.min(100, ((toDb(v) + 48) / 48) * 100));
  const zone = (db: number) => (db > -3 ? "text-rose-300" : db > -6 ? "text-amber-200" : db > -99 ? "text-emerald-200" : "text-slate-500");
  return (
    <div className="border-t border-white/10 bg-[#0f121a] px-4 py-3" data-testid="kmixer">
      <div className="mb-2 flex items-center justify-between text-[11px] text-slate-400">
        <span className="font-semibold tracking-widest uppercase">Mixer</span>
        <span>Peaks are measured while the song plays; a new Play or a level change starts again.</span>
      </div>
      <div className="flex flex-col gap-1.5">
        {tracks.map((t) => {
          const db = toDb(peaks.tracks[t.id] ?? 0);
          return (
            <div key={t.id} className="grid grid-cols-[120px_1fr_150px_120px_64px] items-center gap-3 text-xs">
              <span className="flex items-center gap-1.5 truncate text-slate-200">
                <span className="h-2 w-2 rounded-sm" style={{ background: t.color }} />
                {t.name}
              </span>
              <label className="flex items-center gap-2 text-slate-400">
                Level
                <input type="range" min={0} max={100} value={t.volume} onChange={(e) => void window.daw.dispatch({ type: "updateTrack", trackId: t.id, changes: { volume: Number(e.target.value) } }, `vol-${t.id}`)} className="flex-1 accent-emerald-400" aria-label={`${t.name} level`} data-testid={`kvol-${t.id}`} />
                <span className="w-7 text-right text-slate-300">{t.volume}</span>
              </label>
              <label className="flex items-center gap-2 text-slate-400">
                Pan
                <input type="range" min={-100} max={100} value={t.pan} onChange={(e) => void window.daw.dispatch({ type: "updateTrack", trackId: t.id, changes: { pan: Number(e.target.value) } }, `pan-${t.id}`)} className="flex-1 accent-sky-400" aria-label={`${t.name} pan`} data-testid={`kpan-${t.id}`} />
                <span className="w-8 text-right text-slate-300">{t.pan === 0 ? "C" : t.pan < 0 ? `L${-t.pan}` : `R${t.pan}`}</span>
              </label>
              <span className="h-2 overflow-hidden rounded bg-white/10">
                <span className="block h-full bg-emerald-400" style={{ width: `${meter(status?.levels?.[t.id] ?? 0)}%` }} />
              </span>
              <span className={`text-right font-mono ${zone(db)}`} data-testid={`kpeak-${t.id}`}>
                {db > -99 ? `${db.toFixed(1)} dB` : "–"}
              </span>
            </div>
          );
        })}
        <div className="mt-1 grid grid-cols-[120px_1fr_150px_120px_64px] items-center gap-3 border-t border-white/10 pt-2 text-xs">
          <span className="font-semibold text-white">Master</span>
          <span className="text-slate-400">Master fader {project.masterVolume}: leave it, mix with the levels above.</span>
          <span className="relative h-3 rounded bg-white/5" title="Stereo field: where each track sits from left to right" data-testid="kstereo">
            {tracks.map((t) => (
              <span key={t.id} className="absolute top-0.5 h-2 w-2 rounded-full" style={{ left: `calc(${(t.pan + 100) / 2}% - 4px)`, background: t.color }} title={t.name} />
            ))}
          </span>
          <span className="h-2 overflow-hidden rounded bg-white/10">
            <span className="block h-full bg-sky-400" style={{ width: `${meter(Math.max(status?.masterL ?? 0, status?.masterR ?? 0))}%` }} />
          </span>
          <span className={`text-right font-mono ${zone(toDb(peaks.master))}`} data-testid="kmaster-peak">
            {peaks.master > 0 ? `${toDb(peaks.master).toFixed(1)} dB` : "–"}
          </span>
        </div>
      </div>
    </div>
  );
}
