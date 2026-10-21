import { useEffect, useRef, useState } from "react";
import { FEATURE_LIST, LESSON_TITLES, isUnlocked, unlockedByLesson, type FeatureGroup } from "@daw/shared";
import { devStore, progressStore, useStore } from "../store";
import { LockIcon } from "./LockIcon";

const GROUPS: FeatureGroup[] = ["Piano roll", "Tracks", "Arrangement", "Mixing", "Output"];
const ALL = FEATURE_LIST;
const LESSONS_WITH_UNLOCKS: string[] = [...new Set(ALL.map((f) => f.unlockedBy).filter((l): l is string => l !== null))];

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
    <div ref={ref} className="absolute top-12 right-3 z-[60] w-[400px] rounded-lg border border-white/15 bg-[#161a23] p-3 shadow-2xl" data-testid="features-panel">
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

      {dev && (
        <div className="mt-3 rounded-md border border-dashed border-amber-400/30 p-2" data-testid="dev-tools">
          <div className="mb-1 text-[10px] tracking-wide text-amber-300/80 uppercase">Developer tools (hidden in the installed app)</div>
          <div className="flex items-center gap-1.5">
            <select value={lesson} onChange={(e) => setLesson(e.target.value)} className="min-w-0 flex-1 rounded bg-white/5 px-1.5 py-1 text-[11px] text-slate-200 outline-none" aria-label="Lesson to complete" data-testid="dev-lesson-select">
              {LESSONS_WITH_UNLOCKS.map((l) => (
                <option key={l} value={l} className="bg-[#12151c]">
                  {l} · {LESSON_TITLES[l] ?? ""} ({unlockedByLesson(l).length} feature{unlockedByLesson(l).length === 1 ? "" : "s"})
                </option>
              ))}
            </select>
            <button className="rounded bg-white/5 px-2 py-1 text-[11px] text-slate-200 hover:bg-white/10" onClick={() => void window.daw.completeLesson(lesson)} data-testid="dev-complete">Complete</button>
            <button className="rounded bg-white/5 px-2 py-1 text-[11px] text-slate-200 hover:bg-white/10" onClick={() => void window.daw.resetProgress()} data-testid="dev-reset">Reset</button>
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
