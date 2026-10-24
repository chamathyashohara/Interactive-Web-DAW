import { useEffect, useRef, useState } from "react";
import { dropSampleOps } from "@daw/shared";
import { CATEGORY_COLORS } from "../samples/sampleColors";
import { canNow } from "../unlock/useUnlock";
import { lockReason } from "@daw/shared";
import { progressStore, projectStore, recordingStore, useStore } from "../store";

const uuid = () => crypto.randomUUID();
const kb = (bytes: number) => (bytes >= 1048576 ? `${(bytes / 1048576).toFixed(1)} MB` : `${Math.max(1, Math.round(bytes / 1024))} KB`);

type Role = "producer" | "performer";

/**
 * The "Live recording" lab. Remote recording (Component 4) is two separate programs, so this does not embed them:
 * it opens the right one for the role you pick, then puts the recordings they save into your project.
 */
export function RecordingPanel() {
  const state = useStore(recordingStore);
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState("");
  const [message, setMessage] = useState("");
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const away = (e: PointerEvent) => !ref.current?.contains(e.target as Node) && setOpen(false);
    const esc = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    window.addEventListener("pointerdown", away);
    window.addEventListener("keydown", esc);
    return () => {
      window.removeEventListener("pointerdown", away);
      window.removeEventListener("keydown", esc);
    };
  }, [open]);

  const launch = async (role: Role) => {
    setBusy(role);
    setMessage("");
    const r = await window.daw.recording.launch(role);
    setBusy("");
    if (!r.ok) setMessage(r.reason ?? "Could not open it.");
  };
  const locate = async (role: Role) => {
    const r = await window.daw.recording.locate(role);
    if (r.ok) setMessage("");
  };

  /** Copies a recording into the sound library and puts it on a new track at the start of the song. */
  const addTake = async (file?: string) => {
    setMessage("");
    if (!canNow("browser.samples")) return setMessage(lockReason(progressStore.get(), "browser.samples") ?? "Adding sounds is locked until its lesson is done.");
    setBusy(file ?? "pick");
    const r = await window.daw.recording.addTake(file);
    setBusy("");
    if (!r.ok) return r.canceled ? undefined : setMessage(r.reason ?? "The recording could not be added.");
    const entry = r.entry!;
    const project = projectStore.get().project;
    if (!project) return;
    const ids = { trackId: `track-${uuid()}`, clipId: `clip-${uuid()}`, noteId: `note-${uuid()}` };
    const plan = dropSampleOps(project, { id: entry.id, name: entry.name, category: entry.category, durationSec: entry.durationSec, meta: entry.meta }, 0, null, ids, CATEGORY_COLORS[entry.category]);
    if (!plan.ok) return setMessage(plan.reason);
    await window.daw.dispatchBatch(plan.ops, `take-${ids.clipId}`);
    setMessage(`Added "${entry.name}" on a new track.`);
  };

  const roleButton = (role: Role, title: string, hint: string) => {
    const app = state?.apps[role];
    return (
      <div className="mb-2">
        <button className="hw-btn hw-go w-full py-2 text-left text-xs" disabled={busy === role} onClick={() => void launch(role)} data-testid={`rec-open-${role}`}>
          <span className="block text-[13px] font-semibold">{title}</span>
          <span className="block text-[11px] opacity-80">{hint}</span>
        </button>
        <div className="mt-0.5 flex items-center justify-between text-[11px] text-slate-500">
          <span data-testid={`rec-found-${role}`}>{app?.found ? "Program found" : "Program not found"}</span>
          <button className="underline hover:text-slate-300" onClick={() => void locate(role)} data-testid={`rec-locate-${role}`}>
            Locate…
          </button>
        </div>
      </div>
    );
  };

  return (
    <div className="relative" ref={ref}>
      <button className="hw-btn px-2.5 py-1 text-xs" aria-pressed={open} onClick={() => setOpen(!open)} title="Record a singer or instrument over the network" data-testid="rec-button">
        ● Live recording
      </button>

      {open && (
        <div className="hw-popover absolute top-full left-0 z-[65] mt-1.5 w-[330px] p-3 text-[12px]" data-testid="rec-popover">
          <div className="hw-legend mb-2 !text-[10px]">WHO ARE YOU IN THIS RECORDING?</div>
          {roleButton("producer", "I'm the Producer", "Opens Producer Studio. You start the session and press Record.")}
          {roleButton("performer", "I'm the Singer", "Opens Performer Client. You join the Producer's session.")}
          <p className="mb-2 text-[11px] text-slate-500">These open as their own windows. Everyone must be on the same network.</p>

          <div className="hw-legend mt-3 mb-1 !text-[10px]">RECORDINGS</div>
          {state && state.takes.length > 0 ? (
            <ul className="mb-2 max-h-[150px] space-y-1 overflow-auto" data-testid="rec-takes">
              {state.takes.map((t) => (
                <li key={t.file} className="flex items-center justify-between gap-2 rounded bg-white/5 px-1.5 py-1">
                  <span className="min-w-0">
                    <span className="block truncate text-slate-200" title={t.file}>{t.name}</span>
                    <span className="text-[10px] text-slate-500">{kb(t.bytes)}</span>
                  </span>
                  <button className="hw-btn hw-teal shrink-0 px-2 py-0.5 text-[11px]" disabled={busy === t.file} onClick={() => void addTake(t.file)} data-testid="rec-add-take">
                    Add to project
                  </button>
                </li>
              ))}
            </ul>
          ) : (
            <p className="mb-2 text-[11px] text-slate-500" data-testid="rec-empty">New recordings appear here when the recorder saves them.</p>
          )}
          <button className="hw-btn mb-2 w-full py-1 text-xs" disabled={busy === "pick"} onClick={() => void addTake()} data-testid="rec-add-file">
            Add a recording file…
          </button>
          <div className="flex items-center justify-between gap-2 text-[11px] text-slate-500">
            <span className="truncate" title={state?.watchDir} data-testid="rec-folder">Watching: {state?.watchDir ?? "…"}</span>
            <span className="flex shrink-0 gap-2">
              <button className="underline hover:text-slate-300" onClick={() => void window.daw.recording.chooseFolder()}>Change…</button>
              <button className="underline hover:text-slate-300" onClick={() => void window.daw.recording.openFolder()}>Open</button>
            </span>
          </div>
          {message && <div className="mt-2 text-[11px] text-amber-200" data-testid="rec-message">{message}</div>}
        </div>
      )}
    </div>
  );
}
