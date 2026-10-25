import { useEffect, useMemo, useState } from "react";
import { DEFAULT_MIX_REFERENCE, MIX_REFERENCE_LIMITS, analyzeMix, referenceOf, restoreIsClean, type MixFinding, type MixReport, type MixSuggestion, type Project } from "@daw/shared";
import { mixAppliedStore, mixFocusStore, mixJobStore, mixPreviewStore, mixStore, useStore } from "../store";

/** The current measurement turned into readings and findings (recomputed whenever the project or the measurement changes). */
export function useMixReport(project: Project): MixReport {
  const snap = useStore(mixStore);
  const preview = useStore(mixPreviewStore);
  // while a fix is being auditioned the measurement describes the changed mix, so it is read against that mix
  const against = preview?.project ?? project;
  return useMemo(() => analyzeMix(against, snap), [against, snap]);
}

export const dbText = (db: number, digits = 1): string => (Number.isFinite(db) ? (Math.abs(db) < 0.05 ? 0 : db).toFixed(digits) : "-∞");
const SEVERITY = {
  problem: { dot: "bg-red-500", text: "text-red-300", label: "Problem" },
  target: { dot: "bg-amber-400", text: "text-amber-300", label: "Over target" },
  note: { dot: "bg-sky-400", text: "text-sky-300", label: "Note" },
} as const;

/** The small mark on a channel strip when the assistant has something to say about it. */
export function MixBadge({ finding }: { finding: MixFinding | undefined }) {
  if (!finding) return null;
  const sev = SEVERITY[finding.severity];
  return (
    <button
      className={`h-2.5 w-2.5 shrink-0 rounded-full ${sev.dot} ring-1 ring-black/60`}
      title={`${finding.headline}. Click to read why and review the suggestion.`}
      aria-label={`Mix check: ${finding.headline}`}
      data-testid={`mix-badge-${finding.trackId ?? "master"}`}
      data-severity={finding.severity}
      onPointerDown={(e) => e.stopPropagation()}
      onClick={(e) => (e.stopPropagation(), mixFocusStore.set(finding.id))}
    />
  );
}

function NumberField({ label, value, min, max, onCommit, testId, placeholder }: { label: string; value: number | null; min: number; max: number; onCommit: (v: number | null) => void; testId: string; placeholder?: string }) {
  const [draft, setDraft] = useState(value === null ? "" : String(value));
  useEffect(() => setDraft(value === null ? "" : String(value)), [value]);
  const commit = () => {
    if (draft.trim() === "") return value === null ? undefined : onCommit(null);
    const v = Math.round(Number(draft) * 10) / 10;
    if (Number.isFinite(v) && v >= min && v <= max) {
      if (v !== value) onCommit(v);
    } else setDraft(value === null ? "" : String(value));
  };
  return (
    <label className="flex items-center justify-between gap-2 text-[10px] text-slate-400">
      <span className="truncate">{label}</span>
      <input
        value={draft}
        placeholder={placeholder}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => e.key === "Enter" && (e.target as HTMLInputElement).blur()}
        inputMode="decimal"
        className="hw-field w-14 px-1 py-0.5 text-right text-[10px]"
        aria-label={label}
        title={`${min} to ${max} dBFS`}
        data-testid={testId}
      />
    </label>
  );
}

/** Where the user's reference levels are set; they are saved with the project and shared in a session. */
function Targets({ project, selectedId }: { project: Project; selectedId: string }) {
  const ref = referenceOf(project);
  const set = (changes: Partial<typeof ref>) => void window.daw.dispatch({ type: "setMixReference", reference: { ...ref, ...changes } }, "mixref");
  const track = project.tracks[selectedId];
  const own = ref.channels?.[selectedId] ?? null;
  const setOwn = (v: number | null) => {
    const channels = { ...(ref.channels ?? {}) };
    if (v === null) delete channels[selectedId];
    else channels[selectedId] = v;
    const { channels: _old, ...rest } = ref;
    void window.daw.dispatch({ type: "setMixReference", reference: Object.keys(channels).length ? { ...rest, channels } : rest }, "mixref");
  };
  return (
    <div className="flex flex-col gap-1 rounded border border-white/10 bg-black/20 p-1.5" data-testid="mix-targets">
      <div className="text-[10px] text-slate-500">Your reference levels (sample peak, dBFS). They are your choice, not rules.</div>
      <NumberField label="Master peak target" value={ref.masterPeakDb} min={MIX_REFERENCE_LIMITS.masterPeakDb[0]} max={MIX_REFERENCE_LIMITS.masterPeakDb[1]} onCommit={(v) => v !== null && set({ masterPeakDb: v })} testId="mix-target-master" />
      <NumberField label="Channel peak target" value={ref.channelPeakDb} min={MIX_REFERENCE_LIMITS.channelPeakDb[0]} max={MIX_REFERENCE_LIMITS.channelPeakDb[1]} onCommit={(v) => v !== null && set({ channelPeakDb: v })} testId="mix-target-channel" />
      <NumberField label="Warn when master passes" value={ref.safetyDb} min={MIX_REFERENCE_LIMITS.safetyDb[0]} max={MIX_REFERENCE_LIMITS.safetyDb[1]} onCommit={(v) => v !== null && set({ safetyDb: v })} testId="mix-target-warning" />
      {track && <NumberField label={`${track.name} own target`} value={own} placeholder={dbText(ref.channelPeakDb)} min={MIX_REFERENCE_LIMITS.channelPeakDb[0]} max={MIX_REFERENCE_LIMITS.channelPeakDb[1]} onCommit={setOwn} testId="mix-target-own" />}
      <button className="hw-btn self-start px-1.5 py-0.5 text-[10px]" onClick={() => void window.daw.dispatch({ type: "setMixReference", reference: null })} disabled={!project.mixReference} data-testid="mix-target-reset" title={`Back to the defaults (${DEFAULT_MIX_REFERENCE.masterPeakDb} / ${DEFAULT_MIX_REFERENCE.channelPeakDb} / ${DEFAULT_MIX_REFERENCE.safetyDb} dBFS)`}>
        Reset targets
      </button>
    </div>
  );
}

function FindingCard({ finding, project, pass, onDismiss }: { finding: MixFinding; project: Project; pass: number; onDismiss: () => void }) {
  const [busy, setBusy] = useState<string | null>(null);
  const apply = async (s: MixSuggestion) => {
    setBusy(s.id);
    // one batch = one undo step (Ctrl+Z also takes it back)
    const r = await window.daw.dispatchBatch(s.ops, `mixfix-${Date.now()}`);
    setBusy(null);
    if (r.ok) {
      mixAppliedStore.set([{ key: `${finding.id}/${s.id}/${Date.now()}`, label: s.summary, applied: s.ops, restore: s.restore, atPass: pass }, ...mixAppliedStore.get()].slice(0, 6));
      mixFocusStore.set(null);
    }
  };
  const sev = SEVERITY[finding.severity];
  return (
    <div className="flex flex-col gap-1.5 text-[11px] leading-snug text-slate-300" data-testid="mix-card" data-finding={finding.id}>
      <div className="flex items-center gap-2">
        <span className={`h-2 w-2 shrink-0 rounded-full ${sev.dot}`} />
        <span className={`min-w-0 flex-1 text-xs font-semibold ${sev.text}`}>{finding.headline}</span>
        <button className="hw-btn h-5 w-5 text-[11px]" onClick={() => mixFocusStore.set(null)} aria-label="Close the explanation" data-testid="mix-card-close">×</button>
      </div>
      <p data-testid="mix-detected"><b className="text-slate-100">What was measured. </b>{finding.detected}</p>
      <p data-testid="mix-change"><b className="text-slate-100">What would change. </b>{finding.change}</p>
      <p data-testid="mix-why"><b className="text-slate-100">Why it may help. </b>{finding.why}</p>
      <p data-testid="mix-listen"><b className="text-slate-100">What to listen for. </b>{finding.listen}</p>
      {finding.limits && <p className="text-slate-400" data-testid="mix-limits"><b className="text-slate-300">Keep in mind. </b>{finding.limits}</p>}
      <div className="flex flex-wrap gap-1.5">
        {finding.suggestions.map((s) => (
          <span key={s.id} className="flex gap-1">
            <button className="hw-btn px-2 py-1 text-[10px]" disabled={busy !== null} onClick={() => void window.daw.mix.previewStart(s.ops, s.summary).then(() => mixFocusStore.set(null))} data-testid={`mix-preview-${s.id}`} title="Hear this change on your computer first. Nothing in the project changes until you keep it.">
              Preview
            </button>
            <button className="hw-btn hw-teal px-2 py-1 text-[10px]" disabled={busy !== null} onClick={() => void apply(s)} data-testid={`mix-apply-${s.id}`} title={s.summary}>
              Apply: {s.label}
            </button>
          </span>
        ))}
        <button className="hw-btn px-2 py-1 text-[10px]" onClick={onDismiss} data-testid="mix-dismiss">Dismiss</button>
      </div>
    </div>
  );
}

/** The assistant's side of the mixer: readings, findings with explanations, applied fixes that can be taken back, and the targets. */
export function MixAssist({ project, report, selectedId }: { project: Project; report: MixReport; selectedId: string }) {
  const snap = useStore(mixStore);
  const focus = useStore(mixFocusStore);
  const applied = useStore(mixAppliedStore);
  const job = useStore(mixJobStore);
  const preview = useStore(mixPreviewStore);
  const [showTargets, setShowTargets] = useState(false);
  const [dismissed, setDismissed] = useState<Set<string>>(new Set());
  const pass = snap?.pass ?? 0;

  // a dismissed suggestion comes back with the next measurement pass
  useEffect(() => setDismissed(new Set()), [pass]);
  const visible = report.findings.filter((f) => !dismissed.has(f.id));
  const open = visible.find((f) => f.id === focus) ?? null;
  const m = report.master;

  const keepPreview = async () => {
    const p = mixPreviewStore.get();
    if (!p) return;
    // Applying the same fader moves for real ends the preview by itself, and a measurement made during it stays valid (the volumes are the same).
    const before = project;
    const restoreOps = p.ops.map((op) => (op.type === "updateTrack" ? { type: "updateTrack" as const, trackId: op.trackId, changes: { volume: before.tracks[op.trackId]?.volume ?? 80 } } : { type: "setMasterVolume" as const, volume: before.masterVolume }));
    const r = await window.daw.dispatchBatch(p.ops, `mixfix-${Date.now()}`);
    mixJobStore.set({ ...mixJobStore.get(), message: null }); // "the project changed" is what Keep itself caused
    if (r.ok) mixAppliedStore.set([{ key: `preview/${Date.now()}`, label: p.label, applied: p.ops, restore: restoreOps, atPass: pass }, ...mixAppliedStore.get()].slice(0, 6));
  };

  // a fix whose faders are already back at their original values (undone with Ctrl+Z, or set back by hand) has nothing left to restore
  const shownApplied = applied.filter((a) => !restoreIsClean(project, a.restore));

  const restore = async (key: string) => {
    const fix = applied.find((a) => a.key === key);
    if (!fix) return;
    const r = await window.daw.dispatchBatch(fix.restore, `mixrestore-${Date.now()}`);
    if (r.ok) mixAppliedStore.set(mixAppliedStore.get().filter((a) => a.key !== key));
  };

  const masterColour = !m ? "text-slate-400" : m.state === "clipping" ? "text-red-300" : m.state === "above-warning" ? "text-red-300" : m.state === "above-target" ? "text-amber-300" : "text-emerald-300";

  return (
    <>
    {open && (
      <div className="absolute right-0 bottom-full z-40 mb-1 max-h-[62vh] w-[400px] max-w-[96vw] overflow-y-auto rounded-md border border-white/20 bg-[#1b1f29] p-2.5 shadow-2xl" data-testid="mix-popover">
        <FindingCard finding={open} project={project} pass={pass} onDismiss={() => (setDismissed(new Set([...dismissed, open.id])), mixFocusStore.set(null))} />
      </div>
    )}
    <aside className="hw-strip flex w-[318px] shrink-0 flex-col gap-1.5 overflow-y-auto border-l border-black px-2 pt-1.5 pb-2" data-testid="mix-panel">
      <div className="flex items-center gap-1.5">
        <div className="hw-legend !text-[10px] font-semibold !text-slate-300">MIX CHECK</div>
        <span className="min-w-0 flex-1 truncate text-[10px] text-slate-500" data-testid="mix-status" data-state={report.status}>
          {job.running ? `analysing the song… ${Math.round(job.fraction * 100)}%`
            : report.status === "no-data" ? (snap?.playing ? "measuring…" : "play the song, or analyse it")
            : report.status === "stale" ? "the mix changed: measure again"
            : report.status === "silent" ? "nothing audible was measured"
            : snap?.source === "song" ? `whole song, ${dbText(snap.seconds)} s`
            : `${snap?.playing ? "measuring" : "measured"} ${dbText(snap?.seconds ?? 0)} s`}
        </span>
        <button className="hw-btn hw-teal px-1.5 py-0.5 text-[10px]" disabled={job.running} onClick={() => void window.daw.mix.analyzeSong().then((r) => !r.ok && mixJobStore.set({ running: false, fraction: 0, message: r.reason ?? "Could not start the analysis." }))} title="Render the whole song without playing it and measure every channel and the master, including an estimated true peak" data-testid="mix-analyse">
          {job.running ? "…" : "Analyse song"}
        </button>
        <button className="hw-btn px-1.5 py-0.5 text-[10px]" onClick={() => void window.daw.mix.reset()} title="Forget the measurement and start again on the next playback" data-testid="mix-reset">Reset</button>
        <button className="hw-btn px-1.5 py-0.5 text-[10px]" aria-pressed={showTargets} onClick={() => setShowTargets(!showTargets)} title="Set your reference levels" data-testid="mix-targets-toggle">Targets</button>
      </div>

      {preview && (
        <div className="rounded border border-sky-400/40 bg-sky-950/30 px-2 py-1.5 text-[10px] text-sky-100" data-testid="mix-preview-banner">
          <div>Previewing: {preview.label}. Press play to hear it; the meters show this version. Your project is unchanged until you keep it.</div>
          <div className="mt-1 flex gap-1.5">
            <button className="hw-btn hw-teal px-1.5 py-0.5 text-[10px]" data-testid="mix-preview-keep" onClick={() => void keepPreview()}>Keep this</button>
            <button className="hw-btn px-1.5 py-0.5 text-[10px]" data-testid="mix-preview-stop" onClick={() => void window.daw.mix.previewStop()}>Stop preview</button>
          </div>
        </div>
      )}
      {job.message && <div className="rounded border border-amber-500/30 bg-amber-950/20 px-2 py-1 text-[10px] text-amber-200" data-testid="mix-job-message">{job.message}</div>}
      {showTargets && <Targets project={project} selectedId={selectedId} />}

      {shownApplied.length > 0 && (
        <div className="flex flex-col gap-1" data-testid="mix-applied">
          {shownApplied.map((a) => {
            const clean = restoreIsClean(project, a.applied);
            return (
              <div key={a.key} className="flex items-center gap-1.5 rounded border border-emerald-500/20 bg-emerald-950/20 px-2 py-1 text-[10px] text-slate-300" data-testid="mix-applied-item" title={`${snap && snap.pass === a.atPass ? "Play the song again to measure the result. " : ""}Ctrl+Z also undoes it.`}>
                <span className="min-w-0 flex-1 truncate">Applied: {a.label}</span>
                <button className="hw-btn shrink-0 px-1.5 py-0.5 text-[10px]" onClick={() => void restore(a.key)} data-testid="mix-restore" title={clean ? "Put the fader(s) back exactly where they were" : "A fader was moved since; this sets it back to the value before the fix anyway"}>
                  Restore
                </button>
              </div>
            );
          })}
        </div>
      )}

      {m && (
        <div className="rounded border border-white/10 bg-black/20 px-2 py-1 text-[11px]" data-testid="mix-master" data-state={m.state}>
          <div className="flex items-baseline justify-between">
            <span className="text-slate-400">Master sample peak</span>
            <span className={`font-mono ${masterColour}`} data-testid="mix-master-peak" data-db={Number.isFinite(m.prePeakDb) ? m.prePeakDb.toFixed(2) : "-inf"}>{dbText(m.prePeakDb)} dBFS</span>
          </div>
          {m.truePeakDb !== null && (
            <div className="flex items-baseline justify-between text-slate-400" title="Estimated highest value between the samples (4x oversampling). A converter can reconstruct peaks above the sample peak.">
              <span>true peak (estimated)</span>
              <span className="font-mono" data-testid="mix-master-truepeak" data-db={Number.isFinite(m.truePeakDb) ? m.truePeakDb.toFixed(2) : "-inf"}>{dbText(m.truePeakDb)} dBFS</span>
            </div>
          )}
          <div className="flex items-baseline justify-between text-slate-500">
            <span>headroom to 0 dBFS</span>
            <span className="font-mono" data-testid="mix-master-headroom">{dbText(m.headroomDb)} dB</span>
          </div>
          <div className="flex items-baseline justify-between text-slate-500">
            <span>your target</span>
            <span className="font-mono">{dbText(m.targetDb)} dBFS</span>
          </div>
          {m.state === "clipping" && <div className="mt-0.5 text-red-300" data-testid="mix-clip-warning">Clipping: the signal passed full scale ({dbText(m.overSeconds * 1000, 0)} ms).</div>}
          {m.state === "above-warning" && <div className="mt-0.5 text-red-300" data-testid="mix-clip-warning">Close to clipping{m.softClipSeconds > 0 ? `: the soft clip shaped the sound for ${dbText(m.softClipSeconds * 1000, 0)} ms` : ""}.</div>}
          <div className="mt-0.5 text-[9px] text-slate-600">{m.truePeakDb === null ? "Sample peak before the soft clip. The true peak between samples can be a little higher; Analyse song estimates it." : "Peaks are measured before the soft clip."}</div>
        </div>
      )}

      {visible.length > 0 ? (
        <div className="flex flex-col gap-1" data-testid="mix-findings">
          {visible.map((f) => (
            <button key={f.id} className="flex items-center gap-1.5 rounded border px-2 py-1 text-left text-[11px] text-slate-200 hover:bg-white/5" style={{ borderColor: f.id === open?.id ? "rgba(255,255,255,0.4)" : "rgba(255,255,255,0.1)", background: "rgba(0,0,0,0.2)" }} onClick={() => mixFocusStore.set(f.id === focus ? null : f.id)} data-testid={`mix-finding-${f.id}`} data-severity={f.severity}>
              <span className={`h-2 w-2 shrink-0 rounded-full ${SEVERITY[f.severity].dot}`} />
              <span className="min-w-0 flex-1 truncate">{f.headline}</span>
              <span className="text-[9px] text-slate-500">{SEVERITY[f.severity].label}</span>
            </button>
          ))}
        </div>
      ) : (
        report.status === "measured" && <div className="text-[11px] text-slate-400" data-testid="mix-clear">Nothing to flag against your reference levels. That does not mean the mix is finished: listen for balance.</div>
      )}

      <p className="mt-auto text-[9px] leading-tight text-slate-600" data-testid="mix-perspective">{report.perspective}</p>
    </aside>
    </>
  );
}
