import { useEffect, useState } from "react";
import { songTicks, type Project } from "@daw/shared";
import { exportStore, useStore } from "../store";

const TAILS = [
  { label: "2 seconds (recommended)", seconds: 2 },
  { label: "None (stop at the end)", seconds: 0 },
  { label: "4 seconds (long reverb tails)", seconds: 4 },
];

/** mm:ss for the rendered length (song + tail) at the project tempo. */
function songSeconds(project: Project): number {
  const bars = songTicks(project) / (project.ppq * 4);
  return (bars * 4 * 60) / project.tempo;
}
const mmss = (s: number) => `${Math.floor(s / 60)}:${String(Math.round(s % 60)).padStart(2, "0")}`;

/**
 * The export ("render") settings window. Shows the fixed WAV quality the engine renders at, lets the learner choose how
 * much tail to leave, and renders to a file they pick. Live progress is shown by the export chip in the status bar.
 */
export function ExportDialog({ project, onClose }: { project: Project; onClose: () => void }) {
  const [tail, setTail] = useState(2);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const ex = useStore(exportStore);

  useEffect(() => {
    const esc = (e: KeyboardEvent) => e.key === "Escape" && !busy && onClose();
    window.addEventListener("keydown", esc);
    return () => window.removeEventListener("keydown", esc);
  }, [busy, onClose]);

  // Close automatically once a render that we started has finished.
  useEffect(() => {
    if (busy && ex?.state === "done") {
      setMessage("");
      onClose();
    } else if (busy && ex?.state === "error") {
      setBusy(false);
      setMessage(ex.message ?? "Export failed.");
    }
  }, [ex, busy, onClose]);

  const total = songSeconds(project) + tail;
  const render = async () => {
    setMessage("");
    setBusy(true);
    const r = await window.daw.exportWav(undefined, { tailSeconds: tail });
    if (!r.ok) {
      setBusy(false);
      if (!r.canceled) setMessage(r.reason ?? "Export failed.");
    }
  };
  const info = "flex items-center justify-between text-[12px]";

  return (
    <div className="fixed inset-0 z-[80] flex items-center justify-center bg-black/50" data-testid="export-dialog" onPointerDown={(e) => e.target === e.currentTarget && !busy && onClose()}>
      <div className="hw-panel w-[420px] rounded-lg border border-black p-4 shadow-2xl">
        <div className="mb-3 flex items-center justify-between">
          <div className="text-sm font-semibold text-amber-300">Export audio</div>
          <button className="rounded px-1.5 text-slate-400 hover:text-slate-100" onClick={() => !busy && onClose()} aria-label="Close" data-testid="export-close">✕</button>
        </div>

        <div className="hw-lcd mb-3 space-y-1 px-3 py-2">
          <div className={info}><span className="text-slate-400">Format</span><span className="font-mono text-[#ffbf5a]">WAV · 48 kHz · 24-bit · stereo</span></div>
          <div className={info}><span className="text-slate-400">Song length</span><span className="font-mono text-[#ffbf5a]">{project.songBars} bars · {mmss(songSeconds(project))}</span></div>
          <div className={info}><span className="text-slate-400">Rendered length</span><span className="font-mono text-[#ffbf5a]">{mmss(total)}</span></div>
        </div>

        <div className="mb-4">
          <div className="hw-legend mb-1.5 !text-[10px]">TAIL AFTER THE SONG</div>
          <select value={tail} onChange={(e) => setTail(Number(e.target.value))} disabled={busy} className="hw-lcd w-full px-2 py-1.5 text-[12px] outline-none" aria-label="Tail length" data-testid="export-tail">
            {TAILS.map((t) => (
              <option key={t.seconds} value={t.seconds} className="bg-[#12151c]">{t.label}</option>
            ))}
          </select>
          <p className="mt-1.5 text-[11px] text-slate-500">The whole song is rendered the same whether you are playing or looping a part. The metronome is never included.</p>
        </div>

        {message && <div className="mb-2 text-[11px] text-rose-300" data-testid="export-message">{message}</div>}

        <div className="flex items-center justify-end gap-2">
          <button className="hw-btn px-3 py-1.5 text-xs" onClick={() => !busy && onClose()} disabled={busy}>Cancel</button>
          <button className="hw-btn hw-go px-4 py-1.5 text-xs" onClick={() => void render()} disabled={busy} data-testid="export-render">
            {busy ? (ex?.state === "running" ? `Rendering… ${Math.round((ex.fraction ?? 0) * 100)}%` : "Choose a file…") : "Choose a file & render"}
          </button>
        </div>
      </div>
    </div>
  );
}
