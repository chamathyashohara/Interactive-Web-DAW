import { useEffect, useRef, useState } from "react";
import { createTrack, MAX_TRACKS, TRACK_COLORS, type InstrumentKind, type Project, type TrackFields } from "@daw/shared";
import { Meter } from "./Meter";

interface Props {
  project: Project;
  selectedId: string;
  onSelect: (trackId: string) => void;
}

const update = (trackId: string, changes: Partial<TrackFields>, group?: string) => void window.daw.dispatch({ type: "updateTrack", trackId, changes }, group);
const small = "flex h-6 w-6 items-center justify-center rounded text-[11px] font-bold transition-colors";

function NameField({ trackId, name }: { trackId: string; name: string }) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(name);
  const ref = useRef<HTMLInputElement>(null);
  useEffect(() => setDraft(name), [name]);
  useEffect(() => {
    if (editing) ref.current?.select();
  }, [editing]);
  const commit = () => {
    setEditing(false);
    const v = draft.trim();
    if (v && v !== name && v.length <= 40) update(trackId, { name: v });
    else setDraft(name);
  };
  if (!editing)
    return (
      <span className="min-w-0 flex-1 truncate text-xs font-medium text-slate-200" onDoubleClick={() => setEditing(true)} title="Double-click to rename" data-testid="track-name">
        {name}
      </span>
    );
  return (
    <input
      ref={ref}
      value={draft}
      maxLength={40}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === "Enter") commit();
        if (e.key === "Escape") (setDraft(name), setEditing(false));
      }}
      onPointerDown={(e) => e.stopPropagation()}
      className="min-w-0 flex-1 rounded bg-black/40 px-1 text-xs text-slate-100 outline-none ring-1 ring-cyan-400/50"
      aria-label="Track name"
    />
  );
}

export function TrackList({ project, selectedId, onSelect }: Props) {
  const [menu, setMenu] = useState(false);
  const full = project.trackOrder.length >= MAX_TRACKS;

  const add = (instrument: InstrumentKind) => {
    setMenu(false);
    const label = instrument === "drums" ? "Drums" : "Synth";
    const same = project.trackOrder.filter((id) => project.tracks[id]!.instrument === instrument).length;
    const id = `track-${crypto.randomUUID()}`;
    const color = TRACK_COLORS[project.trackOrder.length % TRACK_COLORS.length]!;
    void window.daw.dispatch({ type: "addTrack", track: createTrack(id, same ? `${label} ${same + 1}` : label, instrument, color, `clip-${crypto.randomUUID()}`) });
    onSelect(id);
  };

  return (
    <aside className="flex w-[17rem] shrink-0 flex-col border-r border-white/10 bg-[#12151c]" data-testid="track-list">
      <div className="flex items-center justify-between border-b border-white/10 px-3 py-2 text-[11px] tracking-wide text-slate-400 uppercase">
        <span>Tracks</span>
        <span className="text-slate-600">{project.trackOrder.length}/{MAX_TRACKS}</span>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto">
        {project.trackOrder.map((id, i) => {
          const t = project.tracks[id]!;
          const selected = id === selectedId;
          return (
            <div
              key={id}
              data-testid="track-row"
              data-track-id={id}
              data-selected={selected ? "true" : undefined}
              onPointerDown={() => onSelect(id)}
              className={`border-b border-white/5 px-2 py-1.5 ${selected ? "bg-white/[0.06]" : "hover:bg-white/[0.03]"}`}
              style={{ boxShadow: selected ? `inset 3px 0 0 ${t.color}` : undefined }}
            >
              <div className="flex items-center gap-1.5">
                <label className="relative h-4 w-4 shrink-0 cursor-pointer overflow-hidden rounded" style={{ background: t.color }} title="Track colour">
                  <input type="color" value={t.color} onChange={(e) => update(id, { color: e.target.value }, `color-${id}`)} className="absolute inset-0 h-full w-full cursor-pointer opacity-0" aria-label={`Colour of ${t.name}`} />
                </label>
                <span className="w-4 text-center text-[10px] text-slate-500">{i + 1}</span>
                <NameField trackId={id} name={t.name} />
                <span className="rounded bg-white/5 px-1 text-[9px] text-slate-400">{t.instrument === "drums" ? "DRM" : "SYN"}</span>
                <button className={`${small} ${t.mute ? "bg-amber-400 text-slate-900" : "bg-white/5 text-slate-400 hover:bg-white/10"}`} onClick={() => update(id, { mute: !t.mute })} aria-label={`Mute ${t.name}`} aria-pressed={t.mute} title="Mute">M</button>
                <button className={`${small} ${t.solo ? "bg-cyan-400 text-slate-900" : "bg-white/5 text-slate-400 hover:bg-white/10"}`} onClick={() => update(id, { solo: !t.solo })} aria-label={`Solo ${t.name}`} aria-pressed={t.solo} title="Solo">S</button>
                <button
                  className={`${small} bg-white/5 text-slate-500 hover:bg-rose-500/30 hover:text-rose-200 disabled:opacity-30 disabled:hover:bg-white/5 disabled:hover:text-slate-500`}
                  disabled={project.trackOrder.length <= 1}
                  onClick={() => void window.daw.dispatch({ type: "deleteTrack", trackId: id })}
                  aria-label={`Delete ${t.name}`}
                  title="Delete track (undoable)"
                >
                  ×
                </button>
              </div>
              <div className="mt-1 flex items-center gap-2 pl-[1.6rem]">
                <input type="range" min={0} max={100} value={t.volume} onChange={(e) => update(id, { volume: Number(e.target.value) }, `vol-${id}`)} className="h-1 min-w-0 flex-1 cursor-pointer" style={{ accentColor: t.color }} aria-label={`Volume of ${t.name}`} />
                <Meter orientation="horizontal" className="w-14" color={t.color} testId={`meter-list-${id}`} read={(s) => s?.levels[id] ?? 0} />
              </div>
            </div>
          );
        })}
      </div>
      <div className="relative border-t border-white/10 p-2">
        <button
          className="w-full rounded-md border border-dashed border-white/20 py-1.5 text-xs text-slate-300 hover:border-cyan-400/50 hover:bg-cyan-400/5 disabled:opacity-40"
          disabled={full}
          onClick={() => setMenu(!menu)}
          data-testid="add-track"
        >
          + Add track
        </button>
        {menu && (
          <div className="absolute right-2 bottom-12 left-2 z-50 overflow-hidden rounded-md border border-white/15 bg-[#1b1f29] shadow-xl">
            <button className="block w-full px-3 py-2 text-left text-xs text-slate-200 hover:bg-white/10" onClick={() => add("synth")} data-testid="add-synth">
              Synth <span className="text-slate-500">— melodies, chords, bass</span>
            </button>
            <button className="block w-full px-3 py-2 text-left text-xs text-slate-200 hover:bg-white/10" onClick={() => add("drums")} data-testid="add-drums">
              Drums <span className="text-slate-500">— kick, snare, hats…</span>
            </button>
          </div>
        )}
      </div>
    </aside>
  );
}
