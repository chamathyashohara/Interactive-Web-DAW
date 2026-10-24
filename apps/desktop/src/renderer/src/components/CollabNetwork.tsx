import { useEffect, useRef, useState } from "react";
import { collabNetOpen, collabStore, useStore } from "../store";
import type { NetSnapshot } from "../../../preload/index";

const ms = (v: number | null | undefined) => (v === null || v === undefined ? "-" : `${v.toFixed(0)} ms`);
const rate = (bytesPerSec: number) => (bytesPerSec >= 1024 ? `${(bytesPerSec / 1024).toFixed(1)} KB/s` : `${Math.max(0, bytesPerSec).toFixed(0)} B/s`);
const QUALITY_STYLE: Record<string, string> = {
  good: "bg-emerald-500/25 text-emerald-300",
  fair: "bg-amber-500/25 text-amber-300",
  poor: "bg-rose-500/25 text-rose-300",
  unknown: "bg-white/10 text-slate-400",
};

/** The Network panel: how good the connection is (ping, jitter, lost pings), how fast updates reach you, and traffic. */
export function CollabNetwork() {
  const open = useStore(collabNetOpen);
  const session = useStore(collabStore);
  const [snap, setSnap] = useState<NetSnapshot | null>(null);
  const [perSec, setPerSec] = useState({ down: 0, up: 0 });
  const [note, setNote] = useState("");
  const prev = useRef<NetSnapshot | null>(null);
  const live = open && session.active;

  useEffect(() => {
    if (!live) {
      prev.current = null;
      setSnap(null);
      return;
    }
    let stopped = false;
    const poll = async () => {
      const s = await window.daw.collab.net();
      if (stopped || !s) return;
      const p = prev.current;
      if (p && s.at > p.at) setPerSec({ down: ((s.rx - p.rx) * 1000) / (s.at - p.at), up: ((s.tx - p.tx) * 1000) / (s.at - p.at) });
      prev.current = s;
      setSnap(s);
    };
    void poll();
    const timer = window.setInterval(() => void poll(), 1000);
    return () => {
      stopped = true;
      window.clearInterval(timer);
    };
  }, [live]);

  // The panel closes with the session.
  useEffect(() => {
    if (!session.active) collabNetOpen.set(false);
  }, [session.active]);

  if (!live) return null;

  const exportCsv = async () => {
    const r = await window.daw.collab.exportNet();
    setNote(r.ok ? "Saved." : r.canceled ? "" : `Could not save: ${r.reason ?? "unknown problem"}`);
  };

  const pts = snap?.recentPings ?? [];
  const max = Math.max(...pts, 1);
  const line = pts.length > 1 ? pts.map((v, i) => `${((i / 39) * 244).toFixed(1)},${(34 - (v / max) * 32).toFixed(1)}`).join(" ") : "";
  const q = snap?.quality ?? "unknown";
  const row = (label: string, value: string, id: string) => (
    <tr>
      <td className="py-0.5 pr-3 text-slate-400">{label}</td>
      <td className="py-0.5 text-right font-mono text-slate-200" data-testid={id}>{value}</td>
    </tr>
  );

  return (
    <div className="hw-popover fixed bottom-4 right-4 z-[85] w-[290px] p-3 text-[12px]" data-testid="collab-network">
      <div className="mb-2 flex items-center justify-between">
        <span className="hw-legend !text-[10px]">NETWORK</span>
        <span className="flex items-center gap-2">
          <span className={`rounded px-1.5 py-0.5 text-[10px] uppercase ${QUALITY_STYLE[q]}`} data-testid="net-quality">{q === "unknown" ? "measuring…" : q}</span>
          <button className="hw-btn px-1.5 py-0 text-xs" onClick={() => collabNetOpen.set(false)} title="Close" aria-label="Close the Network panel">×</button>
        </span>
      </div>
      {snap ? (
        <table className="w-full">
          <tbody>
            {row("Connection", snap.status, "net-status")}
            {row("People", String(snap.users), "net-users")}
            {row("Ping now / avg", snap.ping ? `${ms(snap.pingLast)} / ${ms(snap.ping.avg)}` : "-", "net-ping")}
            {row("Ping min / max", snap.ping ? `${ms(snap.ping.min)} / ${ms(snap.ping.max)}` : "-", "net-minmax")}
            {row("Jitter", snap.ping ? ms(snap.ping.jitter) : "-", "net-jitter")}
            {row("Lost pings", `${snap.pingsLost} of ${snap.pingsSent} (${snap.lossPercent.toFixed(0)}%)`, "net-loss")}
            {row("Sync delay last / avg", snap.sync ? `${ms(snap.syncLast)} / ${ms(snap.sync.avg)}` : snap.users > 1 ? "measuring…" : "needs another person", "net-sync")}
            {row("Sync delay (95th pct)", snap.sync ? ms(snap.sync.p95) : "-", "net-sync95")}
            {row("Download / upload", `${rate(perSec.down)} / ${rate(perSec.up)}`, "net-rate")}
            {row("Reconnects", String(snap.reconnects), "net-reconnects")}
          </tbody>
        </table>
      ) : (
        <div className="text-slate-500">measuring…</div>
      )}
      <svg width="244" height="36" className="mt-2" aria-hidden>
        {line && <polyline points={line} fill="none" stroke="#4cc9f0" strokeWidth="1.5" />}
      </svg>
      <p className="mt-1 text-[10px] text-slate-500">Ping = round trip to the server. Sync delay = time for another person's change to reach you.</p>
      <div className="mt-2 flex items-center gap-2">
        <button className="hw-btn px-2 py-1 text-xs" onClick={() => void exportCsv()} disabled={!snap} data-testid="net-export">Export CSV</button>
        {note && <span className="text-[11px] text-slate-400">{note}</span>}
      </div>
    </div>
  );
}
