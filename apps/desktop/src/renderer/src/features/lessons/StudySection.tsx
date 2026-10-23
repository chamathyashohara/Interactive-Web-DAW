import { useState } from "react";
import { studyLog } from "./studyLog";

const btn = "rounded-md px-2.5 py-1 text-xs font-medium transition-colors disabled:opacity-40 bg-white/5 text-slate-300 hover:bg-white/10";

function download(name: string, text: string, type: string) {
  const url = URL.createObjectURL(new Blob([text], { type }));
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/** Researcher-only controls for the user study: start/end a session, export, delete a participant's records. */
export function StudySection() {
  const [code, setCode] = useState("");
  const [msg, setMsg] = useState("");
  const [, rerender] = useState(0);
  const refresh = () => rerender((n) => n + 1);
  const session = studyLog.session();
  const count = studyLog.records().length;
  const stamp = () => new Date().toISOString().slice(0, 16).replace(/[:T]/g, "-");

  return (
    <details className="rounded-xl border border-white/5 bg-white/[0.02] px-4 py-2 text-xs text-slate-500" data-testid="study-section">
      <summary className="cursor-pointer select-none">
        Researcher: study session {session ? <span className="text-emerald-300">· {session.participant} recording</span> : "· off"}
      </summary>
      <div className="mt-2 flex flex-col gap-2 text-slate-400">
        {session ? (
          <button className={`${btn} self-start`} onClick={() => (studyLog.endSession(), setMsg(""), refresh())}>
            End session {session.participant}
          </button>
        ) : (
          <div className="flex max-w-sm gap-1">
            <input value={code} onChange={(e) => setCode(e.target.value)} placeholder="Participant code, e.g. P07" className="min-w-0 flex-1 rounded bg-white/5 px-2 py-1 text-slate-200 outline-none" aria-label="Participant code" />
            <button
              className={btn}
              onClick={() => {
                const r = studyLog.startSession(code);
                setMsg(r.ok ? "" : r.reason);
                if (r.ok) setCode("");
                refresh();
              }}
            >
              Start
            </button>
          </div>
        )}
        <div className="flex flex-wrap items-center gap-1">
          <span>{count} records stored on this computer.</span>
          <button className={btn} disabled={!count} onClick={() => download(`lessons-study-${stamp()}.json`, studyLog.exportJson(), "application/json")}>
            Export JSON
          </button>
          <button className={btn} disabled={!count} onClick={() => download(`lessons-study-${stamp()}.csv`, studyLog.exportCsv(), "text/csv")}>
            Export CSV
          </button>
          <button
            className={btn}
            disabled={!count}
            onClick={() => {
              const who = window.prompt("Delete all records for which participant code?")?.trim();
              if (!who) return;
              if (!window.confirm(`Permanently delete every record for ${who}?`)) return;
              setMsg(`Deleted ${studyLog.deleteParticipant(who)} records for ${who}.`);
              refresh();
            }}
          >
            Delete a participant…
          </button>
        </div>
        {msg && <div className="text-amber-300">{msg}</div>}
        <p className="text-[10px] text-slate-500">
          Only exercise times, Check/Hint/Reset counts and scores are recorded, and only while a session is on. Personal notes are never part of it. Nothing leaves this
          computer unless you export it.
        </p>
      </div>
    </details>
  );
}
