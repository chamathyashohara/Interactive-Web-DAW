import { useEffect, useRef, useState } from "react";
import { FEATURE_LIST, LESSON_TITLES, isUnlocked, unlockedByLesson, type FeatureGroup } from "@daw/shared";
import { devStore, progressStore, telemetryStore, useStore } from "../store";
import { LockIcon } from "./LockIcon";

const GROUPS: FeatureGroup[] = ["Piano roll", "Tracks", "Arrangement", "Mixing", "Output"];
const ALL = FEATURE_LIST;
const LESSONS_WITH_UNLOCKS: string[] = [...new Set(ALL.map((f) => f.unlockedBy).filter((l): l is string => l !== null))];

/** Study recording: consent, the participant code, and export. Nothing is recorded before the participant agrees. */
function ResearchSection() {
  const state = useStore(telemetryStore);
  const [code, setCode] = useState("");
  const [agree, setAgree] = useState(false);
  const [message, setMessage] = useState("");
  const [confirmWithdraw, setConfirmWithdraw] = useState(false);

  const start = async () => {
    const r = await window.daw.telemetry.consent(code.trim());
    setMessage(r.ok ? "" : (r.reason ?? "Could not start."));
    if (r.ok) setAgree(false);
  };
  const doExport = async (kind: "json" | "csv") => {
    const r = await window.daw.telemetry.export(kind);
    setMessage(r.ok ? `Saved ${r.files!.length} file${r.files!.length === 1 ? "" : "s"}.` : r.canceled ? "" : (r.reason ?? "Export failed."));
  };

  return (
    <div className="mt-3 rounded-md border border-white/10 p-2" data-testid="research">
      <div className="hw-legend mb-1 !text-[10px]">STUDY DATA</div>
      {!state.consented ? (
        <>
          <p className="mb-2 text-[11px] leading-4 text-slate-400">
            Draft wording, to be replaced by the ethics-approved consent text. If you agree, this app records how you use it (which tools you use, whether notes
            are in the key, how long you take to fix them, which lessons you finish). It never records your name, your music or any file. It stays on this
            computer until you export it, and you can stop and delete it at any time.
          </p>
          <label className="mb-2 flex items-start gap-2 text-[11px] text-slate-300">
            <input type="checkbox" checked={agree} onChange={(e) => setAgree(e.target.checked)} className="mt-0.5" data-testid="research-agree" />
            I have read this and agree to take part.
          </label>
          <div className="flex items-center gap-1.5">
            <input value={code} onChange={(e) => setCode(e.target.value)} placeholder="Participant code (e.g. P07)" maxLength={24} className="hw-field min-w-0 flex-1 px-2 py-1 text-[11px] placeholder:text-amber-900" aria-label="Participant code" data-testid="research-code" />
            <button className="hw-btn hw-go px-3 py-1 text-[11px]" disabled={!agree || code.trim().length < 2} onClick={() => void start()} data-testid="research-start">
              Start recording
            </button>
          </div>
        </>
      ) : (
        <>
          <div className="mb-2 flex items-center gap-2 text-[11px] text-slate-300" data-testid="research-state">
            <span className="h-2 w-2 rounded-full bg-rose-400 shadow-[0_0_6px_#fb7185]" />
            Recording as <b className="text-amber-300">{state.participantCode}</b>
            <span className="ml-auto text-slate-500">{state.events} events</span>
          </div>
          <div className="flex flex-wrap gap-1.5">
            <button className="hw-btn px-2 py-1 text-[11px]" onClick={() => void doExport("json")} data-testid="research-export-json" title="One file with every event and the computed numbers">Export JSON</button>
            <button className="hw-btn px-2 py-1 text-[11px]" onClick={() => void doExport("csv")} data-testid="research-export-csv" title="Two spreadsheet files: every event, and the headline numbers">Export CSV</button>
            {confirmWithdraw ? (
              <>
                <button className="hw-btn hw-red px-2 py-1 text-[11px]" onClick={() => (void window.daw.telemetry.withdraw(true), setConfirmWithdraw(false), setMessage("Stopped. Everything recorded was deleted."))} data-testid="research-delete">Stop and delete everything</button>
                <button className="hw-btn px-2 py-1 text-[11px]" onClick={() => setConfirmWithdraw(false)}>Cancel</button>
              </>
            ) : (
              <button className="hw-btn hw-danger ml-auto px-2 py-1 text-[11px]" onClick={() => setConfirmWithdraw(true)} data-testid="research-withdraw">Stop recording</button>
            )}
          </div>
        </>
      )}
      {message && <div className="mt-1.5 text-[11px] text-amber-300" data-testid="research-message">{message}</div>}
    </div>
  );
}

/** The "Features" popover: shows what is locked, the lesson that unlocks it, and the Beginner-mode switch. */
export function FeaturesPanel({ onClose }: { onClose: () => void }) {
  const progress = useStore(progressStore);
  const dev = useStore(devStore);
  const [lesson, setLesson] = useState<string>(LESSONS_WITH_UNLOCKS[0]!);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const onDown = (e: PointerEvent) => {
      const target = e.target as HTMLElement;
      if (ref.current && !ref.current.contains(target) && !target.closest("[data-testid=features-toggle]")) onClose();
    };
    window.addEventListener("pointerdown", onDown);
    return () => window.removeEventListener("pointerdown", onDown);
  }, [onClose]);

  const beginner = progress.mode === "beginner";
  const locked = ALL.filter((f) => !isUnlocked(progress, f.id)).length;

  return (
    <div ref={ref} className="absolute top-12 right-3 z-[60] w-[400px] rounded-lg border border-black hw-panel p-3 shadow-2xl" data-testid="features-panel">
      <div className="flex items-start justify-between gap-3">
        <div>
          <div className="text-sm font-semibold text-slate-100">Features</div>
          <div className="text-[11px] text-slate-400">{beginner ? `${locked} locked. Complete lessons to unlock them.` : "Everything is available."}</div>
        </div>
        <label className="flex cursor-pointer items-center gap-2 text-[11px] text-slate-300">
          Beginner mode
          <button
            role="switch"
            aria-checked={beginner}
            aria-label="Beginner mode"
            data-testid="mode-switch"
            onClick={() => void window.daw.setProgressMode(beginner ? "all" : "beginner")}
            className={`relative h-5 w-9 rounded-full transition-colors ${beginner ? "bg-cyan-500" : "bg-white/15"}`}
          >
            <span className="absolute top-0.5 h-4 w-4 rounded-full bg-white transition-all" style={{ left: beginner ? 18 : 2 }} />
          </button>
        </label>
      </div>

      <div className="mt-3 max-h-[52vh] space-y-3 overflow-y-auto pr-1">
        {GROUPS.map((group) => (
          <div key={group}>
            <div className="mb-1 text-[10px] tracking-wide text-slate-500 uppercase">{group}</div>
            {ALL.filter((f) => f.group === group).map((f) => {
              const open = isUnlocked(progress, f.id);
              return (
                <div key={f.id} data-testid="feature-row" data-feature-id={f.id} data-unlocked={open ? "true" : "false"} className="flex items-center gap-2 py-0.5 text-xs">
                  <span className={`flex h-4 w-4 items-center justify-center rounded-full text-[9px] ${open ? "bg-emerald-500/20 text-emerald-300" : "bg-white/10 text-slate-400"}`}>{open ? "✓" : <LockIcon />}</span>
                  <span className={open ? "text-slate-200" : "text-slate-400"}>{f.label}</span>
                  {!open && f.unlockedBy && <span className="ml-auto text-[10px] text-slate-500">{f.unlockedBy} · {LESSON_TITLES[f.unlockedBy] ?? ""}</span>}
                </div>
              );
            })}
          </div>
        ))}
      </div>

      <ResearchSection />

      {dev && (
        <div className="mt-3 rounded-md border border-dashed border-amber-400/30 p-2" data-testid="dev-tools">
          <div className="mb-1 text-[10px] tracking-wide text-amber-300/80 uppercase">Developer tools (hidden in the installed app)</div>
          <div className="flex items-center gap-1.5">
            <select value={lesson} onChange={(e) => setLesson(e.target.value)} className="hw-lcd min-w-0 flex-1 px-1.5 py-1 text-[11px] outline-none" aria-label="Lesson to complete" data-testid="dev-lesson-select">
              {LESSONS_WITH_UNLOCKS.map((l) => (
                <option key={l} value={l} className="bg-[#12151c]">
                  {l} · {LESSON_TITLES[l] ?? ""} ({unlockedByLesson(l).length} feature{unlockedByLesson(l).length === 1 ? "" : "s"})
                </option>
              ))}
            </select>
            <button className="hw-btn px-2 py-1 text-[11px]" onClick={() => void window.daw.completeLesson(lesson)} data-testid="dev-complete">Complete</button>
            <button className="hw-btn px-2 py-1 text-[11px]" onClick={() => void window.daw.resetProgress()} data-testid="dev-reset">Reset</button>
          </div>
        </div>
      )}
    </div>
  );
}

/** Pops up for a few seconds when completing a lesson unlocks something. */
export function UnlockToast() {
  const progress = useStore(progressStore);
  const seen = useRef<string[] | null>(null);
  const [message, setMessage] = useState<string | null>(null);

  useEffect(() => {
    const done = progress.completedLessons;
    if (seen.current !== null && progress.mode === "beginner") {
      const added = done.filter((l) => !seen.current!.includes(l));
      const features = added.flatMap((l) => unlockedByLesson(l));
      if (features.length) setMessage(`Unlocked: ${features.map((f) => f.label).join(", ")}`);
    }
    seen.current = done;
  }, [progress]);

  useEffect(() => {
    if (!message) return;
    const t = setTimeout(() => setMessage(null), 6000);
    return () => clearTimeout(t);
  }, [message]);

  if (!message) return null;
  return (
    <div className="fixed right-4 bottom-12 z-[70] flex max-w-sm items-center gap-3 rounded-lg border border-emerald-400/30 bg-[#12201c] px-3 py-2 text-xs text-emerald-200 shadow-xl" data-testid="unlock-toast">
      <span aria-hidden>🔓</span>
      <span>{message}</span>
      <button className="ml-auto text-emerald-300/70 hover:text-emerald-100" onClick={() => setMessage(null)} aria-label="Dismiss">×</button>
    </div>
  );
}
