import { useEffect, useRef, useState } from "react";
import { collabStore, useStore } from "../store";

/** The Collaborate button and its popover: host a session, join one by code, or see who is in the live session. */
export function CollabPanel() {
  const state = useStore(collabStore);
  const [open, setOpen] = useState(false);
  const [mode, setMode] = useState<"menu" | "join">("menu");
  const [addr, setAddr] = useState("");
  const [code, setCode] = useState("");
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const away = (e: PointerEvent) => !ref.current?.contains(e.target as Node) && close();
    const esc = (e: KeyboardEvent) => e.key === "Escape" && close();
    window.addEventListener("pointerdown", away);
    window.addEventListener("keydown", esc);
    return () => {
      window.removeEventListener("pointerdown", away);
      window.removeEventListener("keydown", esc);
    };
  }, [open]);

  const close = () => (setOpen(false), setMode("menu"), setMessage(""));
  const host = async () => {
    setBusy(true);
    setMessage("");
    const r = await window.daw.collab.host(name.trim() || undefined);
    setBusy(false);
    if (!r.ok) setMessage(r.reason ?? "Could not start a session.");
  };
  const join = async () => {
    setBusy(true);
    setMessage("");
    const r = await window.daw.collab.join(addr.trim(), code.trim(), name.trim() || undefined);
    setBusy(false);
    if (!r.ok) setMessage(r.reason ?? "Could not join.");
    else setMode("menu");
  };
  const copy = (text: string) => void navigator.clipboard?.writeText(text).catch(() => {});

  const active = state.active;
  const field = "hw-field w-full px-2 py-1.5 text-[12px]";

  return (
    <div className="relative" ref={ref}>
      <button
        className={`hw-btn px-2.5 py-1 text-xs ${active ? "hw-teal" : ""}`}
        aria-pressed={open || active}
        onClick={() => (open ? close() : setOpen(true))}
        title={active ? "You are in a live session" : "Collaborate: host or join a live session"}
        data-testid="collab-button"
      >
        {active ? (
          <span className="flex items-center gap-1.5">
            <span className="h-2 w-2 rounded-full bg-emerald-400 shadow-[0_0_6px_#34d399]" />
            Live · {state.users.length}
          </span>
        ) : (
          "⧉ Collaborate"
        )}
      </button>

      {open && (
        <div className="hw-popover absolute top-full left-0 z-[65] mt-1.5 w-[300px] p-3 text-[12px]" data-testid="collab-popover">
          {active ? (
            <>
              <div className="hw-legend mb-1.5 !text-[10px]">{state.hosting ? "YOU ARE HOSTING" : "IN A SESSION"}</div>
              <div className="mb-2 flex items-center justify-between gap-2">
                <span className="text-slate-400">Join code</span>
                <button className="hw-lcd px-2 py-0.5 font-mono text-[14px] tracking-widest text-[#ffbf5a]" onClick={() => copy(state.code)} title="Copy the code" data-testid="collab-code">{state.code}</button>
              </div>
              {state.hosting && (
                <div className="mb-2 flex items-center justify-between gap-2">
                  <span className="text-slate-400">Host address</span>
                  <button className="hw-field max-w-[170px] truncate px-2 py-0.5 font-mono text-[11px]" onClick={() => copy(state.address)} title="Copy the address" data-testid="collab-address">{state.address}</button>
                </div>
              )}
              <div className="hw-legend mt-3 mb-1 !text-[10px]">IN THE ROOM ({state.users.length})</div>
              <div className="mb-3 flex flex-wrap gap-1.5" data-testid="collab-users">
                {state.users.map((u) => (
                  <span key={u.id} className="flex items-center gap-1.5 rounded bg-white/5 px-1.5 py-0.5 text-[11px]" title={u.name}>
                    <span className="h-2.5 w-2.5 rounded-full" style={{ background: u.color }} />
                    <span className="max-w-[90px] truncate text-slate-200">{u.name}{u.id === state.me ? " (you)" : ""}</span>
                  </span>
                ))}
                {state.users.length === 0 && <span className="text-slate-500">connecting…</span>}
              </div>
              <p className="mb-2 text-[11px] text-slate-500">Everyone edits together. Undo is off in a session — use the history to go back.</p>
              <button className="hw-btn hw-red w-full py-1.5 text-xs" onClick={() => void window.daw.collab.leave().then(close)} data-testid="collab-leave">
                {state.hosting ? "End session" : "Leave session"}
              </button>
            </>
          ) : mode === "menu" ? (
            <>
              <div className="hw-legend mb-2 !text-[10px]">COLLABORATE LIVE</div>
              <label className="mb-2 block">
                <span className="text-slate-400">Your name</span>
                <input value={name} onChange={(e) => setName(e.target.value)} maxLength={24} placeholder="Producer" className={`${field} mt-1`} data-testid="collab-name" />
              </label>
              <button className="hw-btn hw-go mb-1.5 w-full py-1.5 text-xs" disabled={busy} onClick={() => void host()} data-testid="collab-host">
                Host a new session
              </button>
              <button className="hw-btn w-full py-1.5 text-xs" disabled={busy} onClick={() => setMode("join")} data-testid="collab-join-open">
                Join with a code…
              </button>
              <p className="mt-2 text-[11px] text-slate-500">Hosting shares your current project. Everyone needs to be on the same network (or a shared link).</p>
              {message && <div className="mt-2 text-[11px] text-rose-300" data-testid="collab-message">{message}</div>}
            </>
          ) : (
            <>
              <div className="hw-legend mb-2 !text-[10px]">JOIN A SESSION</div>
              <label className="mb-2 block">
                <span className="text-slate-400">Host address (e.g. 192.168.1.5:4000)</span>
                <input value={addr} onChange={(e) => setAddr(e.target.value)} placeholder="192.168.1.5:4000" className={`${field} mt-1`} data-testid="collab-addr" />
              </label>
              <label className="mb-3 block">
                <span className="text-slate-400">6-digit code</span>
                <input value={code} onChange={(e) => setCode(e.target.value.replace(/\D/g, "").slice(0, 6))} inputMode="numeric" placeholder="123456" className={`${field} mt-1 font-mono tracking-widest`} data-testid="collab-code-input" />
              </label>
              <div className="flex gap-1.5">
                <button className="hw-btn px-2 py-1.5 text-xs" onClick={() => setMode("menu")}>Back</button>
                <button className="hw-btn hw-go flex-1 py-1.5 text-xs" disabled={busy || addr.trim().length < 3 || code.trim().length !== 6} onClick={() => void join()} data-testid="collab-join">
                  Join
                </button>
              </div>
              {message && <div className="mt-2 text-[11px] text-rose-300" data-testid="collab-message">{message}</div>}
            </>
          )}
        </div>
      )}
    </div>
  );
}
