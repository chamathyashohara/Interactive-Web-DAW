import { useEffect, useState } from "react";
import { MAX_GAIN_DB, MIN_GAIN_DB, PPQ, type Clip, type ClipAudio } from "@daw/shared";

const field = "hw-field w-12 px-1 py-0.5 text-right text-[11px] disabled:opacity-40";

/** A number box that applies its value when you leave it or press Enter, and puts the old value back if it is not valid. */
function NumberBox({ value, onCommit, label, testId, disabled, title, step }: { value: number; onCommit: (v: number) => void; label: string; testId: string; disabled?: boolean; title?: string; step: number }) {
  const [draft, setDraft] = useState(String(value));
  useEffect(() => setDraft(String(value)), [value]);
  const commit = () => {
    const v = Number(draft);
    if (draft.trim() !== "" && Number.isFinite(v)) onCommit(v);
    else setDraft(String(value));
  };
  return (
    <input
      className={field}
      value={draft}
      disabled={disabled}
      title={title}
      inputMode="decimal"
      step={step}
      aria-label={label}
      data-testid={testId}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => e.key === "Enter" && (e.target as HTMLInputElement).blur()}
    />
  );
}

const round = (v: number, places: number) => Math.round(v * 10 ** places) / 10 ** places;

/**
 * Level and fades of the selected sound clip, for exact values (the fades can also be dragged on the clip).
 * Gain in dB; fades in beats. Every change is one undo step (edits in a row on the same clip merge).
 */
export function ClipAudioFields({ trackId, clip, disabled, lockTitle }: { trackId: string; clip: Clip; disabled: boolean; lockTitle: string | null }) {
  const a = clip.audio ?? {};
  const apply = (changes: Partial<ClipAudio>) => {
    const next: ClipAudio = { ...a, ...changes };
    // the two fades together never exceed the clip: the one being edited keeps what it asked for within that limit
    const fi = next.fadeInTicks ?? 0, fo = next.fadeOutTicks ?? 0;
    if (fi + fo > clip.lengthTicks) {
      if (changes.fadeInTicks !== undefined) next.fadeInTicks = Math.max(0, clip.lengthTicks - fo);
      else next.fadeOutTicks = Math.max(0, clip.lengthTicks - fi);
    }
    if (next.fadeOutTicks) next.cut = true; // a fade out only makes sense if the sound ends where the clip ends
    void window.daw.dispatch({ type: "updateClip", trackId, clipId: clip.id, changes: { audio: next } }, `audio-${clip.id}`);
  };
  const title = lockTitle ?? undefined;
  return (
    <span className="flex items-center gap-1.5 text-[11px] text-slate-400" data-testid="clip-audio" title={title}>
      <label className="flex items-center gap-1">
        Gain
        <NumberBox value={a.gainDb ?? 0} step={0.5} disabled={disabled} label="Clip gain in dB" testId="clip-gain" onCommit={(v) => apply({ gainDb: Math.max(MIN_GAIN_DB, Math.min(MAX_GAIN_DB, round(v, 1))) })} />
        <span className="text-slate-500">dB</span>
      </label>
      <label className="flex items-center gap-1">
        Fade in
        <NumberBox value={round((a.fadeInTicks ?? 0) / PPQ, 2)} step={0.25} disabled={disabled} label="Fade in length in beats" testId="clip-fade-in" onCommit={(v) => apply({ fadeInTicks: Math.max(0, Math.round(v * PPQ)) })} />
      </label>
      <label className="flex items-center gap-1">
        out
        <NumberBox value={round((a.fadeOutTicks ?? 0) / PPQ, 2)} step={0.25} disabled={disabled} label="Fade out length in beats" testId="clip-fade-out" onCommit={(v) => apply({ fadeOutTicks: Math.max(0, Math.round(v * PPQ)) })} />
        <span className="text-slate-500">beats</span>
      </label>
    </span>
  );
}
