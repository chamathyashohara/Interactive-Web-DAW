import { useEffect, useRef, useState } from "react";
import { createTrack, MAX_BPM, MAX_TRACKS, MIN_BPM, SYNTH_PRESETS, TRACK_COLORS, type InstrumentKind, type Project, type SampleRef, type TrackFields } from "@daw/shared";
import { useUnlock } from "../unlock/useUnlock";
import { Fader } from "../controls/Fader";
import { Meter } from "./Meter";

export const TRACK_ROW_H = 60;
export const HEADER_W = 272;

const update = (trackId: string, changes: Partial<TrackFields>, group?: string) => void window.daw.dispatch({ type: "updateTrack", trackId, changes }, group);
const small = "hw-btn h-6 w-6 text-[11px] font-bold";

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

interface HeaderProps {
  /** The automation lane under this track is open (and how to toggle it). */
  autoOpen?: boolean;
  onToggleAuto?: () => void;
  project: Project;
  trackId: string;
  index: number;
  selected: boolean;
  onSelect: () => void;
}

/** Loop tracks: the loop's own tempo and whether it follows the project tempo (time-stretched, pitch unchanged). */
function SampleFit({ trackId, sample, projectTempo }: { trackId: string; sample: SampleRef; projectTempo: number }) {
  const [draft, setDraft] = useState(sample.bpm ? String(sample.bpm) : "");
  useEffect(() => setDraft(sample.bpm ? String(sample.bpm) : ""), [sample.bpm]);
  const commit = () => {
    const v = Math.round(Number(draft) * 100) / 100;
    if (draft === "" && sample.bpm) void window.daw.dispatch({ type: "updateSample", trackId, changes: { bpm: null, fit: false } });
    else if (Number.isFinite(v) && v >= MIN_BPM && v <= MAX_BPM && v !== sample.bpm) void window.daw.dispatch({ type: "updateSample", trackId, changes: { bpm: v, fit: sample.bpm ? sample.fit : true } }, `fit-${trackId}`);
    else setDraft(sample.bpm ? String(sample.bpm) : "");
  };
  const fitting = !!sample.fit && !!sample.bpm;
  return (
    <span className="flex shrink-0 items-center gap-1" data-testid="sample-fit">
      <input
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => e.key === "Enter" && (e.target as HTMLInputElement).blur()}
        placeholder="BPM"
        inputMode="decimal"
        className="hw-field w-10 px-1 py-0.5 text-right text-[10px] placeholder:text-amber-900"
        title="The tempo this loop was made at. Type it if it is not known."
        aria-label={`Original tempo of ${trackId}`}
        data-testid="sample-bpm"
      />
      <button
        className="hw-btn hw-teal px-1.5 py-0.5 text-[10px]"
        disabled={!sample.bpm}
        aria-pressed={fitting}
        onClick={() => void window.daw.dispatch({ type: "updateSample", trackId, changes: { fit: !sample.fit } })}
        title={!sample.bpm ? "Type the loop's tempo first" : fitting ? `Stretched from ${sample.bpm} to ${projectTempo} BPM, pitch unchanged. Click to play it as recorded.` : `Plays as recorded (${sample.bpm} BPM). Click to stretch it to the project tempo (${projectTempo} BPM).`}
        data-testid="sample-fit-toggle"
      >
        {fitting && sample.bpm !== projectTempo ? `${sample.bpm}→${projectTempo}` : "Fit"}
      </button>
    </span>
  );
}

/** One track's controls: colour, name, instrument, mute, solo, delete, volume and level meter. */
export function TrackHeader({ project, trackId: id, index, selected, onSelect, autoOpen, onToggleAuto }: HeaderProps) {
  const t = project.tracks[id]!;
  const unlock = useUnlock();
  return (
    <div
      data-testid="track-row"
      data-track-id={id}
      data-selected={selected ? "true" : undefined}
      onPointerDown={onSelect}
      className="hw-strip flex shrink-0 flex-col justify-center border-r border-b border-black px-2"
      style={{ height: TRACK_ROW_H, width: HEADER_W, boxShadow: selected ? `inset 3px 0 0 ${t.color}` : undefined }}
    >
      <div className="flex items-center gap-1.5">
        <label className="relative h-4 w-4 shrink-0 cursor-pointer overflow-hidden rounded" style={{ background: t.color }} title="Track colour">
          <input type="color" value={t.color} onChange={(e) => update(id, { color: e.target.value }, `color-${id}`)} className="absolute inset-0 h-full w-full cursor-pointer opacity-0" aria-label={`Colour of ${t.name}`} />
        </label>
        <span className="w-4 text-center text-[10px] text-slate-500">{index + 1}</span>
        <NameField trackId={id} name={t.name} />
        <span className="rounded bg-white/5 px-1 text-[9px] text-slate-400">{t.instrument === "drums" ? "DRM" : t.instrument === "sample" ? "SMP" : "SYN"}</span>
        {onToggleAuto && (
          <button
            className={`${small} hw-teal`}
            onClick={onToggleAuto}
            disabled={!unlock.can("automation.lanes")}
            aria-pressed={!!autoOpen}
            title={unlock.reason("automation.lanes") ?? "Automation: draw volume or filter curves for this track over time"}
            data-testid={`auto-toggle-${id}`}
          >
            ∿
          </button>
        )}
        <button className={`${small}`} onClick={() => update(id, { mute: !t.mute })} aria-label={`Mute ${t.name}`} aria-pressed={t.mute} disabled={!unlock.can("mixer.muteSolo")} title={unlock.reason("mixer.muteSolo") ?? "Mute"}>M</button>
        <button className={`${small} hw-teal`} onClick={() => update(id, { solo: !t.solo })} aria-label={`Solo ${t.name}`} aria-pressed={t.solo} disabled={!unlock.can("mixer.muteSolo")} title={unlock.reason("mixer.muteSolo") ?? "Solo"}>S</button>
        <button
          className={`${small} hw-danger`}
          disabled={project.trackOrder.length <= 1 || !unlock.can("tracks.multiple")}
          onClick={() => void window.daw.dispatch({ type: "deleteTrack", trackId: id })}
          aria-label={`Delete ${t.name}`}
          title={unlock.reason("tracks.multiple") ?? "Delete track (undoable)"}
        >
          ×
        </button>
      </div>
      <div className="mt-1 flex items-center gap-2 pl-[1.6rem]">
        {t.instrument === "synth" && (
          <select
            value={t.synthPreset ?? "classic"}
            onChange={(e) => void window.daw.dispatch({ type: "setSynthPreset", trackId: id, preset: e.target.value })}
            className="hw-lcd shrink-0 px-1 py-0.5 text-[10px] outline-none"
            aria-label={`Sound of ${t.name}`}
            title="The built-in synth sound (preset)"
            data-testid={`synth-preset-${id}`}
          >
            {SYNTH_PRESETS.map((p) => (
              <option key={p.id} value={p.id} className="bg-[#12151c]">{p.name}</option>
            ))}
          </select>
        )}
        {t.instrument === "sample" && t.sample?.gate && <SampleFit trackId={id} sample={t.sample} projectTempo={project.tempo} />}
        <Fader orientation="horizontal" value={t.volume} min={0} max={100} color={t.color} className="!min-w-0 !flex-1" disabled={!unlock.can("mixer.panel")} title={unlock.reason("mixer.panel") ?? undefined} onChange={(v) => update(id, { volume: v }, `vol-${id}`)} label={`Volume of ${t.name}`} />
        <Meter orientation="horizontal" className="w-14" color={t.color} testId={`meter-list-${id}`} read={(s) => s?.levels[id] ?? 0} />
      </div>
    </div>
  );
}

/** The "+ Add track" button and its instrument menu. `onAdded` receives the new track's id so the caller can select it. */
export function AddTrackRow({ project, onAdded }: { project: Project; onAdded: (trackId: string) => void }) {
  const [menu, setMenu] = useState(false);
  const unlock = useUnlock();
  const full = project.trackOrder.length >= MAX_TRACKS;
  const multipleLocked = !unlock.can("tracks.multiple");

  const add = (instrument: InstrumentKind) => {
    setMenu(false);
    const label = instrument === "drums" ? "Drums" : "Synth";
    const same = project.trackOrder.filter((id) => project.tracks[id]!.instrument === instrument).length;
    const id = `track-${crypto.randomUUID()}`;
    const color = TRACK_COLORS[project.trackOrder.length % TRACK_COLORS.length]!;
    void window.daw.dispatch({ type: "addTrack", track: createTrack(id, same ? `${label} ${same + 1}` : label, instrument, color, `clip-${crypto.randomUUID()}`) });
    onAdded(id);
  };

  return (
    <div className="hw-strip relative shrink-0 border-r border-b border-black p-2" style={{ width: HEADER_W }}>
      <button
        className="hw-btn w-full py-1.5 text-xs"
        disabled={full || multipleLocked}
        title={unlock.reason("tracks.multiple") ?? undefined}
        onClick={() => setMenu(!menu)}
        data-testid="add-track"
      >
        + Add track <span className="text-slate-600">({project.trackOrder.length}/{MAX_TRACKS})</span>
      </button>
      {menu && (
        <div className="absolute right-2 bottom-12 left-2 z-50 overflow-hidden rounded-md border border-white/15 bg-[#1b1f29] shadow-xl">
          <button className="block w-full px-3 py-2 text-left text-xs text-slate-200 hover:bg-white/10" onClick={() => add("synth")} data-testid="add-synth">
            Synth <span className="text-slate-500">— melodies, chords, bass</span>
          </button>
          <button className="block w-full px-3 py-2 text-left text-xs text-slate-200 hover:bg-white/10 disabled:cursor-not-allowed disabled:opacity-40" disabled={!unlock.can("tracks.drums")} title={unlock.reason("tracks.drums") ?? undefined} onClick={() => add("drums")} data-testid="add-drums">
            Drums <span className="text-slate-500">— kick, snare, hats…</span>
          </button>
        </div>
      )}
    </div>
  );
}
