import { useRef, useState } from "react";
import { MAX_AUTO_POINTS, filterHz, type AutoParam, type AutoPoint } from "@daw/shared";

export const AUTO_ROW_H = 72;
const PAD = 8;
const HIT = 9;

/** "63%" for a volume point, "1.2 kHz" for a filter point. */
export function formatAutoValue(param: AutoParam, value: number): string {
  if (param === "volume") return `${Math.round(value * value * 100)}%`; // the curve acts on the gain like the fader: value squared
  const hz = filterHz(value);
  return hz >= 1000 ? `${(hz / 1000).toFixed(hz >= 10000 ? 0 : 1)} kHz` : `${Math.round(hz)} Hz`;
}

interface Props {
  trackId: string;
  param: AutoParam;
  points: AutoPoint[];
  width: number;
  pxPerTick: number;
  songLen: number;
  snap: boolean;
  gridTicks: number;
  color: string;
  disabled: boolean;
  /** Shows the value being dragged (the owner prints it in the lane header). */
  onReadout: (text: string) => void;
}

/**
 * One automation curve. Click empty space to add a point, drag a point to move it, double-click (or right-click) a point to delete it.
 * While dragging, the curve is drawn live; the project changes once, on release (one undo step).
 */
export function AutomationLane({ trackId, param, points, width, pxPerTick, songLen, snap, gridTicks, color, disabled, onReadout }: Props) {
  const [live, setLive] = useState<AutoPoint[] | null>(null);
  const liveRef = useRef<AutoPoint[] | null>(null);
  const dragIndex = useRef<number | null>(null);
  const ref = useRef<SVGSVGElement>(null);
  const pts = live ?? points;

  const yOf = (v: number) => PAD + (1 - v) * (AUTO_ROW_H - 2 * PAD);
  const xOf = (tick: number) => tick * pxPerTick;
  const setLiveBoth = (next: AutoPoint[] | null) => {
    liveRef.current = next;
    setLive(next);
  };
  const local = (e: React.PointerEvent | React.MouseEvent) => {
    const r = ref.current!.getBoundingClientRect();
    const rawTick = (e.clientX - r.left) / pxPerTick;
    const tick = Math.max(0, Math.min(songLen, snap ? Math.round(rawTick / gridTicks) * gridTicks : Math.round(rawTick)));
    const value = Math.max(0, Math.min(1, 1 - (e.clientY - r.top - PAD) / (AUTO_ROW_H - 2 * PAD)));
    return { tick, value: Math.round(value * 1000) / 1000, px: e.clientX - r.left, py: e.clientY - r.top };
  };
  const nearest = (px: number, py: number, list: AutoPoint[]) => {
    let best = -1, bestD = HIT;
    list.forEach((p, i) => {
      const d = Math.hypot(xOf(p.tick) - px, yOf(p.value) - py);
      if (d <= bestD) (best = i, (bestD = d));
    });
    return best;
  };
  const commit = (next: AutoPoint[]) => void window.daw.dispatch({ type: "setAutomation", trackId, param, points: next.length ? next : null }, `auto-${trackId}-${param}`);

  const onPointerDown = (e: React.PointerEvent<SVGSVGElement>) => {
    if (disabled || e.button !== 0) return;
    const { tick, value, px, py } = local(e);
    let list = points.map((p) => ({ ...p }));
    let i = nearest(px, py, list);
    if (i < 0) {
      if (list.length >= MAX_AUTO_POINTS) return;
      const existing = list.findIndex((p) => p.tick === tick);
      if (existing >= 0) i = existing; // one point per moment: grab it instead of adding a second
      else {
        list.push({ tick, value });
        list.sort((a, b) => a.tick - b.tick);
        i = list.findIndex((p) => p.tick === tick);
      }
    }
    e.currentTarget.setPointerCapture(e.pointerId);
    dragIndex.current = i;
    setLiveBoth(list);
    onReadout(formatAutoValue(param, list[i]!.value));
  };
  const onPointerMove = (e: React.PointerEvent<SVGSVGElement>) => {
    const i = dragIndex.current, cur = liveRef.current;
    if (i === null || !cur) return;
    const { tick, value } = local(e);
    const lo = i > 0 ? cur[i - 1]!.tick + 1 : 0;
    const hi = i < cur.length - 1 ? cur[i + 1]!.tick - 1 : songLen;
    const next = cur.map((p, k) => (k === i ? { tick: Math.max(lo, Math.min(hi, tick)), value } : p));
    setLiveBoth(next);
    onReadout(formatAutoValue(param, value));
  };
  const onPointerUp = () => {
    const cur = liveRef.current;
    dragIndex.current = null;
    setLiveBoth(null);
    onReadout("");
    if (cur && JSON.stringify(cur) !== JSON.stringify(points)) commit(cur);
  };
  const remove = (e: React.MouseEvent<SVGSVGElement>) => {
    if (disabled) return;
    const { px, py } = local(e);
    const i = nearest(px, py, points);
    if (i < 0) return;
    e.preventDefault();
    commit(points.filter((_, k) => k !== i));
  };

  const line = pts.length
    ? [`0,${yOf(pts[0]!.value)}`, ...pts.map((p) => `${xOf(p.tick)},${yOf(p.value)}`), `${width},${yOf(pts[pts.length - 1]!.value)}`].join(" ")
    : `0,${yOf(1)} ${width},${yOf(1)}`;
  return (
    <svg
      ref={ref}
      width={width}
      height={AUTO_ROW_H}
      className={disabled ? "cursor-not-allowed" : "cursor-crosshair"}
      style={{ touchAction: "none", display: "block" }}
      data-testid="auto-lane"
      data-param={param}
      data-track-id={trackId}
      data-points={pts.length}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerUp}
      onDoubleClick={remove}
      onContextMenu={remove}
    >
      <rect x={0} y={0} width={width} height={AUTO_ROW_H} fill="rgba(255,255,255,0.02)" />
      {[0.25, 0.5, 0.75].map((v) => (
        <line key={v} x1={0} x2={width} y1={yOf(v)} y2={yOf(v)} stroke="rgba(255,255,255,0.06)" />
      ))}
      <polyline points={line} fill="none" stroke={color} strokeWidth={pts.length ? 2 : 1} strokeDasharray={pts.length ? undefined : "4 4"} opacity={pts.length ? 1 : 0.5} />
      {pts.length > 0 && <polygon points={`${line} ${width},${AUTO_ROW_H} 0,${AUTO_ROW_H}`} fill={color} opacity={0.12} />}
      {pts.map((p, i) => (
        <circle key={`${i}-${p.tick}`} cx={xOf(p.tick)} cy={yOf(p.value)} r={4.5} fill={color} stroke="#0e1118" strokeWidth={1.5} data-testid="auto-point" data-index={i} data-tick={p.tick} data-value={p.value} />
      ))}
      {pts.length === 0 && !disabled && (
        <text x={12} y={AUTO_ROW_H / 2 + 4} fill="rgba(148,163,184,0.7)" fontSize={11}>
          Click to add points, drag to shape the curve, double-click a point to remove it
        </text>
      )}
    </svg>
  );
}
