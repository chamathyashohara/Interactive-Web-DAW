import { useRef, useState } from "react";
import { MAX_MARKERS, MAX_MARKER_NAME, PPQ, type LoopRegion, type Marker, type Project } from "@daw/shared";
import { HEADER_W } from "./TrackHeader";

export const MARKERS_H = 18;
export const LOOP_H = 12;
export const SECTION_H = MARKERS_H + LOOP_H;
const MARKER_COLORS = ["#fbbf24", "#22d3ee", "#f472b6", "#34d399", "#a78bfa", "#fb923c"];

interface Props {
  project: Project;
  pxPerTick: number;
  songLen: number;
  songW: number;
  /** Ticks a drag snaps to. */
  unit: number;
  loopLocked: boolean;
  loopLockTitle: string | null;
  markersLocked: boolean;
  markersLockTitle: string | null;
}

type LoopDrag = { mode: "create" | "move" | "start" | "end"; anchor: number; grab: number; orig: LoopRegion | null; live: LoopRegion };
type MarkerDrag = { id: string; startX: number; moved: boolean; tick: number };

const setMarkers = (markers: Marker[]) => void window.daw.dispatch({ type: "setMarkers", markers });

/**
 * Two thin strips above the bar ruler: song sections (named markers) and the loop region.
 * Markers: double-click empty space to add one, drag to move, click to jump there, double-click its name to rename, right-click to delete.
 * Loop: drag in the strip to set the region, drag its middle to move it or its ends to resize it, double-click it to clear it.
 */
export function SectionRuler({ project, pxPerTick, songLen, songW, unit, loopLocked, loopLockTitle, markersLocked, markersLockTitle }: Props) {
  const markers = project.markers ?? [];
  const loop = project.loop && project.loop.endTick <= songLen ? project.loop : null;
  const [loopDrag, setLoopDrag] = useState<LoopDrag | null>(null);
  const loopRef = useRef<LoopDrag | null>(null);
  const [mDrag, setMDragState] = useState<MarkerDrag | null>(null);
  const mRef = useRef<MarkerDrag | null>(null);
  const [editing, setEditing] = useState<string | null>(null);
  const [draft, setDraft] = useState("");

  const snapTick = (x: number) => Math.max(0, Math.min(songLen, Math.round(x / pxPerTick / unit) * unit));
  const localX = (e: React.PointerEvent | React.MouseEvent) => e.clientX - e.currentTarget.getBoundingClientRect().left;
  const setLoopBoth = (d: LoopDrag | null) => {
    loopRef.current = d;
    setLoopDrag(d);
  };
  const setMBoth = (d: MarkerDrag | null) => {
    mRef.current = d;
    setMDragState(d);
  };

  // ---- loop strip ----
  const shownLoop = loopDrag?.live ?? loop;
  const onLoopDown = (e: React.PointerEvent<HTMLDivElement>) => {
    if (loopLocked || e.button !== 0) return;
    const x = localX(e);
    const t = snapTick(x);
    const handle = (e.target as HTMLElement).dataset.handle as "start" | "end" | undefined;
    e.currentTarget.setPointerCapture(e.pointerId);
    if (loop && handle) setLoopBoth({ mode: handle, anchor: handle === "start" ? loop.endTick : loop.startTick, grab: 0, orig: loop, live: loop });
    else if (loop && x / pxPerTick >= loop.startTick && x / pxPerTick <= loop.endTick) setLoopBoth({ mode: "move", anchor: 0, grab: x / pxPerTick - loop.startTick, orig: loop, live: loop });
    else setLoopBoth({ mode: "create", anchor: t, grab: 0, orig: loop, live: { startTick: t, endTick: t } });
  };
  const onLoopMove = (e: React.PointerEvent<HTMLDivElement>) => {
    const d = loopRef.current;
    if (!d) return;
    const x = localX(e);
    const t = snapTick(x);
    let live: LoopRegion;
    if (d.mode === "move") {
      const len = d.orig!.endTick - d.orig!.startTick;
      const start = Math.max(0, Math.min(songLen - len, Math.round((x / pxPerTick - d.grab) / unit) * unit));
      live = { startTick: start, endTick: start + len };
    } else live = { startTick: Math.min(d.anchor, t), endTick: Math.max(d.anchor, t) };
    setLoopBoth({ ...d, live });
  };
  const onLoopUp = () => {
    const d = loopRef.current;
    setLoopBoth(null);
    if (!d) return;
    const { startTick, endTick } = d.live;
    if (endTick - startTick < PPQ) return; // a click or a sliver: leave things as they were
    if (d.orig && d.orig.startTick === startTick && d.orig.endTick === endTick) return;
    void window.daw.dispatch({ type: "setLoop", loop: { startTick, endTick } });
  };

  // ---- markers ----
  const markerTick = (m: Marker) => (mDrag?.id === m.id ? mDrag.tick : m.tick);
  const onMarkerDown = (e: React.PointerEvent<HTMLDivElement>, m: Marker) => {
    if (e.button !== 0 || markersLocked || editing === m.id) return;
    e.stopPropagation();
    e.currentTarget.setPointerCapture(e.pointerId);
    setMBoth({ id: m.id, startX: e.clientX, moved: false, tick: m.tick });
  };
  const onMarkerMove = (e: React.PointerEvent<HTMLDivElement>, m: Marker) => {
    const d = mRef.current;
    if (!d || d.id !== m.id) return;
    const moved = d.moved || Math.abs(e.clientX - d.startX) > 3;
    if (!moved) return;
    const row = e.currentTarget.parentElement!.getBoundingClientRect();
    setMBoth({ ...d, moved: true, tick: snapTick(e.clientX - row.left) });
  };
  const onMarkerUp = (m: Marker) => {
    const d = mRef.current;
    setMBoth(null);
    if (!d || d.id !== m.id) return;
    if (!d.moved) window.daw.seek(m.tick);
    else if (d.tick !== m.tick) setMarkers(markers.map((x) => (x.id === m.id ? { ...x, tick: d.tick } : x)));
  };
  const addMarker = (e: React.MouseEvent<HTMLDivElement>) => {
    if (e.target !== e.currentTarget || markersLocked || markers.length >= MAX_MARKERS) return;
    const tick = snapTick(localX(e));
    const color = MARKER_COLORS[markers.length % MARKER_COLORS.length]!;
    const id = `marker-${crypto.randomUUID()}`;
    setMarkers([...markers, { id, tick, name: `Section ${markers.length + 1}`, color }]);
    setEditing(id);
    setDraft(`Section ${markers.length + 1}`);
  };
  const commitName = (m: Marker) => {
    setEditing(null);
    const name = draft.trim();
    if (name && name !== m.name && name.length <= MAX_MARKER_NAME) setMarkers(markers.map((x) => (x.id === m.id ? { ...x, name } : x)));
  };

  return (
    <div className="flex" style={{ height: SECTION_H }} data-testid="section-ruler">
      <div className="hw-strip sticky left-0 z-40 shrink-0 border-r border-b border-black" style={{ width: HEADER_W, height: SECTION_H }}>
        <div className="hw-legend flex items-center px-2" style={{ height: MARKERS_H }}>SECTIONS</div>
        <div className="hw-legend flex items-center px-2" style={{ height: LOOP_H }}>LOOP</div>
      </div>
      <div className="relative border-b border-black bg-[#0d1016]" style={{ width: songW, height: SECTION_H }}>
        {/* markers */}
        <div
          className={`absolute top-0 left-0 ${markersLocked ? "cursor-not-allowed" : ""}`}
          style={{ width: songW, height: MARKERS_H }}
          data-testid="marker-row"
          title={markersLockTitle ?? "Double-click to add a section marker"}
          onDoubleClick={addMarker}
        >
          {markers.map((m) => {
            const color = m.color ?? "#fbbf24";
            const left = markerTick(m) * pxPerTick;
            return (
              <div
                key={m.id}
                data-testid="marker"
                data-marker-id={m.id}
                data-tick={markerTick(m)}
                className="absolute top-0 flex h-full cursor-grab items-center"
                style={{ left, borderLeft: `2px solid ${color}`, paddingLeft: 3, color, touchAction: "none" }}
                onPointerDown={(e) => onMarkerDown(e, m)}
                onPointerMove={(e) => onMarkerMove(e, m)}
                onPointerUp={() => onMarkerUp(m)}
                onPointerCancel={() => setMBoth(null)}
                onDoubleClick={(e) => {
                  if (markersLocked) return;
                  e.stopPropagation();
                  setEditing(m.id);
                  setDraft(m.name);
                }}
                onContextMenu={(e) => {
                  e.preventDefault();
                  if (!markersLocked) setMarkers(markers.filter((x) => x.id !== m.id));
                }}
                title={`${m.name}: click to jump here, drag to move, double-click to rename, right-click to delete`}
              >
                {editing === m.id ? (
                  <input
                    autoFocus
                    value={draft}
                    maxLength={MAX_MARKER_NAME}
                    onChange={(e) => setDraft(e.target.value)}
                    onBlur={() => commitName(m)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") commitName(m);
                      if (e.key === "Escape") setEditing(null);
                      e.stopPropagation();
                    }}
                    onPointerDown={(e) => e.stopPropagation()}
                    className="hw-field w-24 px-1 text-[10px]"
                    aria-label="Marker name"
                    data-testid="marker-input"
                  />
                ) : (
                  <span className="whitespace-nowrap text-[10px] font-semibold tracking-wide" data-testid="marker-name">{m.name}</span>
                )}
              </div>
            );
          })}
        </div>
        {/* loop region */}
        <div
          className={`absolute left-0 ${loopLocked ? "cursor-not-allowed" : "cursor-crosshair"}`}
          style={{ top: MARKERS_H, width: songW, height: LOOP_H, touchAction: "none" }}
          data-testid="loop-row"
          title={loopLockTitle ?? "Drag to set the loop region; double-click the region to clear it"}
          onPointerDown={onLoopDown}
          onPointerMove={onLoopMove}
          onPointerUp={onLoopUp}
          onPointerCancel={() => setLoopBoth(null)}
          onDoubleClick={() => !loopLocked && loop && void window.daw.dispatch({ type: "setLoop", loop: null })}
        >
          {shownLoop && shownLoop.endTick > shownLoop.startTick && (
            <div
              data-testid="loop-region"
              data-start={shownLoop.startTick}
              data-end={shownLoop.endTick}
              className="absolute top-[1px] h-[10px] rounded-sm"
              style={{ left: shownLoop.startTick * pxPerTick, width: Math.max(2, (shownLoop.endTick - shownLoop.startTick) * pxPerTick), background: "linear-gradient(180deg,#ffd98a,#e9a63a)", boxShadow: "0 0 8px rgba(255,190,80,.55)" }}
            >
              <span data-handle="start" className="absolute top-0 left-0 h-full w-1.5 cursor-ew-resize rounded-l-sm bg-black/30" />
              <span data-handle="end" className="absolute top-0 right-0 h-full w-1.5 cursor-ew-resize rounded-r-sm bg-black/30" />
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

/** Lines at the section markers and a tint over the loop region, drawn behind the tracks (does not catch the mouse). */
export function SectionOverlay({ project, pxPerTick, songLen, top }: { project: Project; pxPerTick: number; songLen: number; top: number }) {
  const loop = project.loop && project.loop.endTick <= songLen ? project.loop : null;
  const markers = project.markers ?? [];
  if (!loop && !markers.length) return null;
  return (
    <div className="pointer-events-none absolute z-[5]" style={{ left: HEADER_W, top, bottom: 0, width: songLen * pxPerTick }} aria-hidden>
      {loop && <div className="absolute top-0 bottom-0" data-testid="loop-tint" style={{ left: loop.startTick * pxPerTick, width: (loop.endTick - loop.startTick) * pxPerTick, background: "rgba(255,190,80,0.07)", borderLeft: "1px solid rgba(255,190,80,0.5)", borderRight: "1px solid rgba(255,190,80,0.5)" }} />}
      {markers.map((m) => (
        <div key={m.id} className="absolute top-0 bottom-0 w-px" style={{ left: m.tick * pxPerTick, background: m.color ?? "#fbbf24", opacity: 0.35 }} />
      ))}
    </div>
  );
}
