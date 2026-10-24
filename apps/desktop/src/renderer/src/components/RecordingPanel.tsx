import { useEffect, useRef, useState, useSyncExternalStore, type ReactNode } from "react";
import { dropSampleOps, lockReason } from "@daw/shared";
import { LinkState, SessionState, readyItemLabel, sessionStatusText, takeStatusName } from "@daw/recording";
import { CATEGORY_COLORS } from "../samples/sampleColors";
import { canNow } from "../unlock/useUnlock";
import { collabShares, collabStore, liveStore, progressStore, projectStore, recordingStore, useStore } from "../store";
import { liveAudio, type DeviceList } from "../recording/liveAudio";
import type { NetIface } from "../../../preload/index";

const uuid = () => crypto.randomUUID();
const kb = (bytes: number) => (bytes >= 1048576 ? `${(bytes / 1048576).toFixed(1)} MB` : `${Math.max(1, Math.round(bytes / 1024))} KB`);
const mmss = (s: number) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, "0")}`;
const copy = (text: string) => void navigator.clipboard?.writeText(text).catch(() => {});

/** What the Producer hands to the Singers: where the session is and the pairing code. */
interface RoomLink {
  host: string;
  port: number;
  code: string;
}
const isLink = (v: unknown): v is RoomLink => !!v && typeof v === "object" && typeof (v as RoomLink).host === "string" && typeof (v as RoomLink).port === "number" && typeof (v as RoomLink).code === "string";

/** One numbered step of the guided flow. */
function Step({ n, title, status, ok, children }: { n: number; title: string; status?: string; ok?: boolean; children: ReactNode }) {
  return (
    <section className="mb-2 rounded bg-white/5 p-2" data-testid={`rec-step-${n}`}>
      <div className="mb-1.5 flex items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <span className={`flex h-5 w-5 items-center justify-center rounded-full text-[11px] font-bold ${ok ? "bg-emerald-500/80 text-black" : "bg-white/15 text-slate-200"}`}>{ok ? "✓" : n}</span>
          <span className="text-[13px] font-semibold text-slate-100">{title}</span>
        </div>
        {status && <span className={`text-[11px] ${ok ? "text-emerald-300" : "text-slate-400"}`} data-testid={`rec-step-${n}-status`}>{status}</span>}
      </div>
      {children}
    </section>
  );
}

const Tick = ({ ok }: { ok: boolean }) => <span className={ok ? "text-emerald-300" : "text-rose-300"}>{ok ? "✓" : "✗"}</span>;

/** Keeps the Producer's address and pairing code in the collaboration room (same network only), so Singers can join with one click. Always mounted. */
function useRoomShare() {
  const live = useStore(liveStore);
  const session = useStore(collabStore);
  const snap = live?.snapshot;
  const code = live?.role === "producer" && snap && snap.link !== LinkState.Disconnected ? snap.pairingCode : "";
  const host = snap?.bindAddress ?? "";
  const port = snap?.port ?? 0;
  const sharing = useRef(false);
  const shareable = session.active && !!session.lan;
  useEffect(() => {
    if (shareable && code && host && host !== "127.0.0.1") {
      sharing.current = true;
      void window.daw.collab.share("recording", { host, port, code } satisfies RoomLink);
    } else if (sharing.current) {
      sharing.current = false;
      void window.daw.collab.share("recording", null);
    }
  }, [shareable, code, host, port]);
}

/**
 * Remote recording, inside the DAW (Component 4). One panel walks through four steps: microphone, connect, record, takes.
 * Nothing here decides timing or writes files: the main process owns the session, the sockets and the master recordings.
 */
export function RecordingPanel() {
  useRoomShare();
  const live = useStore(liveStore);
  const rec = useStore(recordingStore);
  const session = useStore(collabStore);
  const shares = useStore(collabShares);
  const mic = useSyncExternalStore(liveAudio.subscribe, liveAudio.getSnapshot);
  const [open, setOpen] = useState(false);
  const [choice, setChoice] = useState<"producer" | "performer" | null>(null);
  const [devices, setDevices] = useState<DeviceList>({ inputs: [], outputs: [] });
  const [inputId, setInputId] = useState("");
  const [ifaces, setIfaces] = useState<NetIface[]>([]);
  const [bind, setBind] = useState("");
  const [port, setPort] = useState("52000");
  const [name, setName] = useState("");
  const [host, setHost] = useState("");
  const [code, setCode] = useState("");
  const [talk, setTalk] = useState(false);
  const [muted, setMuted] = useState(false);
  const [busy, setBusy] = useState("");
  const [message, setMessage] = useState("");
  const ref = useRef<HTMLDivElement>(null);
  const recStarted = useRef(0);

  const snap = live?.snapshot ?? null;
  const role = live?.role ?? null;
  const connected = snap?.link === LinkState.Connected;
  const state = snap?.session ?? SessionState.NotReady;
  const recording = state === SessionState.Recording;
  const takeBusy = state === SessionState.Armed || state === SessionState.Scheduled || state === SessionState.Recording || state === SessionState.Stopping || state === SessionState.Finalising;

  useEffect(() => {
    if (recording && !recStarted.current) recStarted.current = Date.now();
    if (!recording) recStarted.current = 0;
  }, [recording]);
  const [, tick] = useState(0);
  useEffect(() => {
    if (!recording) return;
    const t = setInterval(() => tick((n) => n + 1), 250);
    return () => clearInterval(t);
  }, [recording]);

  useEffect(() => {
    if (!open) return;
    void window.daw.recording.getState().then((s) => recordingStore.set(s));
    void liveAudio.devices().then(setDevices);
    void window.daw.live.interfaces().then((list) => {
      setIfaces(list);
      setBind((cur) => cur || (session.active && session.lan && session.lanIp && list.some((i) => i.address === session.lanIp) ? session.lanIp : (list[0]?.address ?? "")));
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

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

  // When the session ends, talkback goes back to off.
  useEffect(() => {
    if (!role && talk) {
      setTalk(false);
      liveAudio.setTalkback(false, false);
    }
  }, [role, talk]);

  const turnMicOn = async () => {
    setMessage("");
    setBusy("mic");
    const err = await liveAudio.startMic(inputId || undefined);
    setBusy("");
    if (err) setMessage(err);
    void liveAudio.devices().then(setDevices);
  };

  const createSession = async () => {
    setMessage("");
    setBusy("create");
    const r = await window.daw.live.createSession({ bind, port: Number(port), name: name.trim() || undefined });
    setBusy("");
    if (!r.ok) setMessage(r.reason ?? "The session could not be created.");
  };
  const join = async (h = host, p = port, c = code) => {
    setMessage("");
    setBusy("join");
    const r = await window.daw.live.join({ host: h.trim(), port: Number(p), code: c.trim(), name: name.trim() || undefined });
    setBusy("");
    if (!r.ok) setMessage(r.reason ?? "Could not join.");
  };
  const leave = async () => {
    setMessage("");
    await window.daw.live.leave();
    setChoice(null);
  };
  const doRecord = async () => {
    setMessage("");
    const r = await window.daw.live.record();
    if (!r.ok) setMessage(r.reason ?? "Cannot record yet.");
  };
  const doStop = async () => {
    const r = await window.daw.live.stop();
    if (!r.ok) setMessage(r.reason ?? "");
  };
  const toggleTalk = (on: boolean) => {
    setTalk(on);
    liveAudio.setTalkback(on, on);
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

  // ---- the room (same network) ----
  const note = shares["recording"];
  const roomLink = note && isLink(note.data) ? note.data : null;
  const roomOwner = note && session.active ? (session.users.find((u) => u.id === note.id)?.name ?? "The producer") : "The producer";
  const iAmSharing = !!note && session.active && note.id === session.me;

  // ---- step 1: microphone ----
  const micStep = (
    <Step n={1} title="Your microphone" ok={mic.open} status={mic.open ? "On" : "Off"}>
      {mic.open ? (
        <>
          <div className="mb-1 flex items-center gap-2">
            <div className="h-2 flex-1 overflow-hidden rounded bg-black/40" data-testid="rec-level">
              <div className="h-full bg-emerald-400 transition-[width] duration-75" style={{ width: `${Math.min(100, Math.round(Math.sqrt(mic.level) * 100))}%` }} />
            </div>
            <button className="hw-btn px-2 py-0.5 text-[11px]" disabled={takeBusy} onClick={() => void liveAudio.stopMic()} data-testid="rec-mic-off" title={takeBusy ? "Not while a take is running" : "Turn the microphone off"}>
              Turn off
            </button>
          </div>
          <div className="text-[11px] text-slate-400" data-testid="rec-mic-name">{mic.deviceName} · 48 kHz · recorded in full quality on this PC</div>
        </>
      ) : (
        <>
          <div className="flex gap-1.5">
            <select className="hw-field min-w-0 flex-1 px-1 py-1 text-[12px]" value={inputId} onChange={(e) => setInputId(e.target.value)} data-testid="rec-input">
              <option value="">Default microphone</option>
              {devices.inputs.filter((d) => d.id && d.id !== "default").map((d) => (
                <option key={d.id} value={d.id}>{d.label}</option>
              ))}
            </select>
            <button className="hw-btn hw-go px-3 py-1 text-xs" disabled={busy === "mic" || mic.starting} onClick={() => void turnMicOn()} data-testid="rec-mic-on">
              Turn on
            </button>
          </div>
          <p className="mt-1 text-[11px] text-slate-500">Use headphones when you can: the other person's voice must not leak into your microphone.</p>
        </>
      )}
      {mic.error && <div className="mt-1 text-[11px] text-amber-200" data-testid="rec-mic-error">{mic.error}</div>}
    </Step>
  );

  // ---- step 2: connect ----
  const connectStep = (() => {
    if (role && snap) {
      const waiting = snap.link === LinkState.Listening;
      const status = connected ? "Connected" : waiting ? "Waiting for the singer" : snap.link === LinkState.LinkLost ? "Connection lost, retrying" : "Connecting…";
      return (
        <Step n={2} title="Connect" ok={connected} status={status}>
          {role === "producer" ? (
            <div data-testid="rec-session">
              <div className="mb-1 text-[11px] text-slate-400">
                You are the <b className="text-slate-200">Producer</b>. Tell the singer:
              </div>
              {([["Address", snap.bindAddress, "host"], ["Port", String(snap.port), "port"], ["Pairing code", snap.pairingCode, "code"]] as const).map(([label, value, id]) => (
                <div key={label} className="flex items-center justify-between gap-2 py-0.5">
                  <span className="text-slate-400">{label}</span>
                  <button className="hw-field px-2 py-0.5 font-mono text-[13px]" onClick={() => copy(value)} title="Copy" data-testid={`rec-${id}`}>
                    {value}
                  </button>
                </div>
              ))}
              <div className="mt-1 flex items-center justify-between text-[11px] text-slate-500">
                <span>{session.active && session.lan && snap.bindAddress !== "127.0.0.1" ? "Also shared with everyone in this collaboration room." : "A code works once and lasts 10 minutes."}</span>
                <button className="underline hover:text-slate-300" onClick={() => void window.daw.live.newCode()} data-testid="rec-new-code">
                  New code
                </button>
              </div>
            </div>
          ) : (
            <div className="text-[11px] text-slate-400" data-testid="rec-session">
              You are the <b className="text-slate-200">Singer</b>, joined to {snap.bindAddress}:{snap.port}
            </div>
          )}
          {connected && (
            <div className="mt-1 text-[12px] text-emerald-300" data-testid="rec-peer">
              {snap.peerName || "The other person"} is connected ({snap.peerAddress})
            </div>
          )}
          <button className="hw-btn mt-2 w-full py-1 text-xs" disabled={takeBusy} onClick={() => void leave()} data-testid="rec-leave" title={takeBusy ? "Stop the take first" : "End the session"}>
            Leave the session
          </button>
        </Step>
      );
    }
    return (
      <Step n={2} title="Connect" status="Choose your role">
        <div className="mb-2 flex gap-1.5">
          <button className={`hw-btn flex-1 py-2 text-xs ${choice === "producer" ? "hw-go" : ""}`} aria-pressed={choice === "producer"} onClick={() => setChoice("producer")} data-testid="rec-open-producer">
            <span className="block text-[13px] font-semibold">I'm the Producer</span>
            <span className="block text-[10px] opacity-80">Start the session, press Record</span>
          </button>
          <button className={`hw-btn flex-1 py-2 text-xs ${choice === "performer" ? "hw-go" : ""}`} aria-pressed={choice === "performer"} onClick={() => setChoice("performer")} data-testid="rec-open-performer">
            <span className="block text-[13px] font-semibold">I'm the Singer</span>
            <span className="block text-[10px] opacity-80">Join the Producer's session</span>
          </button>
        </div>
        {choice && <input value={name} onChange={(e) => setName(e.target.value)} placeholder="Your name (shown to the other person)" className="hw-field mb-1.5 w-full px-2 py-1 text-[12px]" data-testid="rec-name" />}
        {choice === "producer" && (
          <>
            <div className="mb-1 flex gap-1.5">
              <select className="hw-field min-w-0 flex-1 px-1 py-1 text-[12px]" value={bind} onChange={(e) => setBind(e.target.value)} data-testid="rec-network">
                {ifaces.map((i) => (
                  <option key={i.address} value={i.address}>{i.address} · {i.label}</option>
                ))}
              </select>
              <input value={port} onChange={(e) => setPort(e.target.value.replace(/\D/g, "").slice(0, 5))} className="hw-field w-[64px] px-2 py-1 text-[12px]" aria-label="Port" data-testid="rec-port-in" />
            </div>
            <button className="hw-btn hw-go w-full py-1.5 text-xs" disabled={!bind || busy === "create"} onClick={() => void createSession()} data-testid="rec-create">
              Create session
            </button>
            <p className="mt-1 text-[11px] text-slate-500">Everyone must be on the same network. Ports {port}, {Number(port) + 1} and {Number(port) + 2} are used.</p>
          </>
        )}
        {choice === "performer" && (
          <>
            {roomLink && !iAmSharing && (
              <div className="mb-2 rounded bg-emerald-500/10 p-2" data-testid="rec-room-link">
                <div className="mb-1 text-[12px] text-slate-200">{roomOwner} is recording in this room.</div>
                <button className="hw-btn hw-go w-full py-1.5 text-xs" disabled={busy === "join"} onClick={() => void join(roomLink.host, String(roomLink.port), roomLink.code)} data-testid="rec-room-join">
                  Join {roomOwner}'s session
                </button>
              </div>
            )}
            <input value={host} onChange={(e) => setHost(e.target.value)} placeholder="Producer address (e.g. 192.168.1.5)" className="hw-field mb-1 w-full px-2 py-1 text-[12px]" data-testid="rec-host-in" />
            <div className="mb-1 flex gap-1.5">
              <input value={port} onChange={(e) => setPort(e.target.value.replace(/\D/g, "").slice(0, 5))} className="hw-field w-[64px] px-2 py-1 text-[12px]" aria-label="Port" data-testid="rec-port-join" />
              <input value={code} onChange={(e) => setCode(e.target.value.replace(/\D/g, "").slice(0, 6))} inputMode="numeric" placeholder="6-digit pairing code" className="hw-field min-w-0 flex-1 px-2 py-1 font-mono text-[12px]" data-testid="rec-code-in" />
            </div>
            <button className="hw-btn hw-go w-full py-1.5 text-xs" disabled={!host.trim() || code.length !== 6 || busy === "join"} onClick={() => void join()} data-testid="rec-join">
              Join
            </button>
          </>
        )}
      </Step>
    );
  })();

  // ---- step 3: record ----
  const recordStep = (() => {
    if (!role || !snap) {
      return (
        <Step n={3} title="Record" status="Connect first">
          <p className="text-[11px] text-slate-500">Each person records their own microphone on their own PC, so the recordings are not affected by the network.</p>
        </Step>
      );
    }
    const secs = recording && recStarted.current ? (Date.now() - recStarted.current) / 1000 : 0;
    const ready = state === SessionState.Ready;
    const statusText = recording ? `Recording ${mmss(secs)}` : sessionStatusText(state, []);
    return (
      <Step n={3} title="Record" ok={ready || recording} status={statusText}>
        <label className="mb-1 flex items-center gap-2 text-[12px] text-slate-200">
          <input type="checkbox" checked={snap.localConsent} onChange={(e) => void window.daw.live.setConsent(e.target.checked)} data-testid="rec-consent" />
          I agree to be recorded in this session
        </label>
        {role === "performer" && (
          <label className="mb-1 flex items-center gap-2 text-[12px] text-slate-200" title="After a take, the producer may receive a verified copy of your original file. Your original always stays on your PC.">
            <input type="checkbox" checked={snap.deliveryConsent} onChange={(e) => void window.daw.live.setDeliveryConsent(e.target.checked)} data-testid="rec-delivery" />
            Let the producer receive a copy of my takes
          </label>
        )}
        <div className="mb-1.5 grid grid-cols-2 gap-x-2 text-[11px]" data-testid="rec-checks">
          <div>
            <div className="hw-legend !text-[9px]">YOU</div>
            {snap.localChecks.map((c) => (
              <div key={c.item} className="flex items-start gap-1" title={c.detail}>
                <Tick ok={c.ok} /> <span className={c.ok ? "text-slate-300" : "text-slate-100"}>{readyItemLabel(c.item)}</span>
              </div>
            ))}
          </div>
          <div>
            <div className="hw-legend !text-[9px]">{role === "producer" ? "THE SINGER" : "THE PRODUCER"}</div>
            {connected && snap.peerChecks.length > 0 ? (
              snap.peerChecks.map((c) => (
                <div key={c.item} className="flex items-start gap-1">
                  <Tick ok={c.ok} /> <span className={c.ok ? "text-slate-300" : "text-slate-100"}>{readyItemLabel(c.item)}</span>
                </div>
              ))
            ) : (
              <div className="text-slate-500">{connected ? "waiting for their status…" : "not connected"}</div>
            )}
          </div>
        </div>
        {!ready && !takeBusy && snap.notReadyReasons.length > 0 && (
          <div className="mb-1.5 text-[11px] text-amber-200" data-testid="rec-reasons">
            Not ready yet: {snap.notReadyReasons.join("; ")}
          </div>
        )}
        {role === "producer" ? (
          <div className="flex gap-1.5">
            <button className="hw-btn hw-go flex-1 py-2 text-sm" disabled={!ready} onClick={() => void doRecord()} data-testid="rec-record" title={ready ? "Both PCs start recording at the same planned moment" : "Not ready yet (see above)"}>
              ● Record
            </button>
            <button className="hw-btn flex-1 py-2 text-sm" disabled={!takeBusy} onClick={() => void doStop()} data-testid="rec-stop">
              ■ Stop
            </button>
          </div>
        ) : (
          <button className="hw-btn w-full py-2 text-sm" disabled={!recording} onClick={() => void doStop()} data-testid="rec-stop">
            ■ Stop &amp; save
          </button>
        )}
        {role === "producer" && (
          <div className="mt-1 text-[11px] text-slate-500" data-testid="rec-lead">
            Starts about {(snap.effectiveStartLeadMs / 1000).toFixed(2)} s after you press Record (the shortest safe time for this connection is {snap.minStartLeadMs} ms).
          </div>
        )}
        {(state === SessionState.Armed || state === SessionState.Scheduled) && <div className="mt-1 text-[11px] text-slate-400">Both PCs are getting ready…</div>}
        {snap.take.takeId > 0 && (
          <div className="mt-1.5 text-[11px] text-slate-400" data-testid="rec-take-status">
            Take {snap.take.takeId}:{" "}
            {snap.take.cancelled
              ? `cancelled (${snap.take.cancelReason})`
              : [
                  snap.take.localFinalised ? `yours ${takeStatusName(snap.take.localStatus)}, ${mmss(snap.take.localFrames / 48000)}` : snap.take.localStarted ? "yours recording" : "yours waiting",
                  role === "producer" ? (snap.take.peerFinalised ? `singer's ${takeStatusName(snap.take.peerStatus)}, ${mmss(snap.take.peerFrames / 48000)}` : snap.take.peerStarted ? "singer's recording" : "singer's waiting") : "",
                ]
                  .filter(Boolean)
                  .join(" · ")}
          </div>
        )}
      </Step>
    );
  })();

  // ---- talkback ----
  const talkbackBlock = role && connected && (
    <section className="mb-2 rounded bg-white/5 p-2" data-testid="rec-talkback">
      <div className="mb-1 flex items-center justify-between">
        <span className="text-[13px] font-semibold text-slate-100">Talkback</span>
        <span className="text-[11px] text-slate-500">live voice both ways, separate from the recordings</span>
      </div>
      {!mic.talkSupported ? (
        <p className="text-[11px] text-amber-200">Talkback needs the audio codec built into this app, which is not available here. Recording still works.</p>
      ) : !mic.open ? (
        <p className="text-[11px] text-slate-500">Turn your microphone on (step 1) to talk.</p>
      ) : (
        <>
          <div className="flex items-center gap-2">
            <label className="flex items-center gap-1.5 text-[12px] text-slate-200">
              <input type="checkbox" checked={talk} onChange={(e) => toggleTalk(e.target.checked)} data-testid="rec-talk" />
              Talk and listen (use headphones)
            </label>
            <button
              className="hw-btn ml-auto px-2 py-0.5 text-[11px]"
              aria-pressed={muted}
              disabled={!talk}
              onClick={() => {
                setMuted(!muted);
                liveAudio.setMuted(!muted);
              }}
              data-testid="rec-mute"
            >
              {muted ? "Unmute me" : "Mute me"}
            </button>
          </div>
          {talk && live?.media && (
            <div className="mt-1 text-[11px] text-slate-500" data-testid="rec-talk-stats" data-played={mic.played} data-out-level={mic.outLevel.toFixed(3)}>
              {live.media.peerReachable ? "Voice link open" : "Voice link waiting"} · heard {live.media.audioReceived} packets
              {live.media.hasRemoteReport ? ` · they lost ${live.media.remoteReport.lostEstimate}, jitter ${(live.media.remoteReport.jitterUs / 1000).toFixed(1)} ms` : ""}
              {live.media.invalidTotal > 0 ? ` · ${live.media.invalidTotal} bad packets dropped` : ""}
            </div>
          )}
        </>
      )}
    </section>
  );

  // ---- step 4: takes ----
  const transferRows = snap?.transfers ?? [];
  const takes = live?.takes ?? [];
  const pendingCopies = role === "producer" && snap ? [snap.take].filter((t) => t.peerFinalised && !transferRows.some((x) => x.takeId === t.takeId) && (t.peerStatus === 0 || t.peerStatus === 1)) : [];
  const takesStep = (
    <Step n={4} title="Takes" ok={takes.length > 0} status={takes.length ? `${takes.length} ready` : "none yet"}>
      {takes.length > 0 && (
        <ul className="mb-1.5 space-y-1" data-testid="rec-session-takes">
          {takes.map((t) => (
            <li key={t.key} className="flex items-center justify-between gap-2 rounded bg-black/20 px-1.5 py-1">
              <span className="min-w-0">
                <span className="block truncate text-slate-200" title={t.file}>{t.label}</span>
                <span className="text-[10px] text-slate-500">
                  {mmss(t.seconds)}
                  {t.kind === "singer-copy" ? " · verified copy" : " · recorded on this PC"}
                </span>
              </span>
              <button className="hw-btn hw-teal shrink-0 px-2 py-0.5 text-[11px]" disabled={busy === t.file} onClick={() => void addTake(t.file)} data-testid="rec-add-take">
                Add to project
              </button>
            </li>
          ))}
        </ul>
      )}
      {transferRows.map((x) => (
        <div key={x.takeId} className="mb-1 rounded bg-black/20 px-1.5 py-1 text-[11px]" data-testid="rec-transfer">
          <div className="flex items-center justify-between">
            <span className="text-slate-200">{role === "producer" ? `Singer's take ${x.takeId}` : `Take ${x.takeId} sent to the producer`}</span>
            <span className={x.state === "verified" ? "text-emerald-300" : x.state === "failed" ? "text-rose-300" : "text-amber-200"}>{x.state.toUpperCase()}</span>
          </div>
          {(x.state === "transferring" || x.state === "verifying" || x.state === "retrying" || x.state === "queued") && (
            <div className="mt-0.5 h-1.5 overflow-hidden rounded bg-black/40">
              <div className="h-full bg-sky-400" style={{ width: `${x.bytesTotal ? Math.round((x.bytesDone / x.bytesTotal) * 100) : 0}%` }} />
            </div>
          )}
          <div className="text-slate-500">
            {x.detail}
            {x.state === "verified" && role === "performer" && x.sourceUnchanged ? " Your original is unchanged." : ""}
          </div>
          {role === "producer" && (x.state === "queued" || x.state === "retrying" || x.state === "transferring") && (
            <button className="text-slate-400 underline hover:text-slate-200" onClick={() => void window.daw.live.cancelTransfer(x.takeId)}>
              Cancel
            </button>
          )}
        </div>
      ))}
      {pendingCopies.map((t) => (
        <button
          key={t.takeId}
          className="hw-btn mb-1 w-full py-1 text-xs"
          disabled={!snap?.peerDeliveryConsent}
          onClick={async () => {
            const r = await window.daw.live.requestTransfer(t.takeId);
            if (!r.ok) setMessage(r.reason ?? "");
          }}
          data-testid="rec-get-copy"
          title={snap?.peerDeliveryConsent ? "" : "The singer has not allowed copies yet"}
        >
          Get the singer's take {t.takeId}
        </button>
      ))}
      {role === "producer" && snap && (
        <label className="mb-1 flex items-center gap-2 text-[11px] text-slate-400">
          <input type="checkbox" checked={snap.autoTransfer} onChange={(e) => void window.daw.live.setAutoTransfer(e.target.checked)} data-testid="rec-auto-copy" />
          Get the singer's take automatically after each recording (needs their permission)
        </label>
      )}
      {takes.length === 0 && transferRows.length === 0 && <p className="mb-1 text-[11px] text-slate-500">Your recordings appear here when a take ends.</p>}
      <div className="hw-legend mt-1 mb-1 !text-[9px]">OTHER RECORDINGS IN THE FOLDER</div>
      {rec && rec.takes.length > 0 ? (
        <ul className="mb-1.5 max-h-[110px] space-y-1 overflow-auto" data-testid="rec-takes">
          {rec.takes.map((t) => (
            <li key={t.file} className="flex items-center justify-between gap-2 rounded bg-white/5 px-1.5 py-1">
              <span className="min-w-0">
                <span className="block truncate text-slate-200" title={t.file}>{t.name}</span>
                <span className="text-[10px] text-slate-500">{kb(t.bytes)}</span>
              </span>
              <button className="hw-btn shrink-0 px-2 py-0.5 text-[11px]" disabled={busy === t.file} onClick={() => void addTake(t.file)} data-testid="rec-add-folder-take">
                Add to project
              </button>
            </li>
          ))}
        </ul>
      ) : (
        <p className="mb-1 text-[11px] text-slate-500" data-testid="rec-empty">New WAV files saved in the recordings folder appear here.</p>
      )}
      <button className="hw-btn mb-1.5 w-full py-1 text-xs" disabled={busy === "pick"} onClick={() => void addTake()} data-testid="rec-add-file">
        Add a recording file…
      </button>
      <div className="flex items-center justify-between gap-2 text-[11px] text-slate-500">
        <span className="truncate" title={rec?.watchDir} data-testid="rec-folder">Saved in: {rec?.watchDir ?? "…"}</span>
        <span className="flex shrink-0 gap-2">
          <button className="underline hover:text-slate-300" onClick={() => void window.daw.recording.chooseFolder()}>Change…</button>
          <button className="underline hover:text-slate-300" onClick={() => void window.daw.recording.openFolder()}>Open</button>
        </span>
      </div>
    </Step>
  );

  const details = snap && (
    <details className="mb-2 rounded bg-white/5 p-2 text-[11px] text-slate-400" data-testid="rec-details">
      <summary className="cursor-pointer text-slate-300">Connection details</summary>
      <div className="mt-1 space-y-0.5">
        <div>
          Control round trip: {snap.linkStats.controlRttNs >= 0 ? `${(snap.linkStats.controlRttNs / 1e6).toFixed(2)} ms` : "n/a"} (best {snap.linkStats.controlRttBestNs >= 0 ? `${(snap.linkStats.controlRttBestNs / 1e6).toFixed(2)} ms` : "n/a"})
        </div>
        <div>
          Clock offset to the other PC:{" "}
          {snap.linkStats.offsetSamples ? `${(snap.linkStats.thetaNs / 1e6).toFixed(3)} ms ± ${(snap.linkStats.thetaUncertaintyNs / 1e6).toFixed(3)} ms (${snap.linkStats.offsetSamples} samples)` : "measuring…"}
        </div>
        {snap.take.hasStartOffset && (
          <div>
            Estimated difference between the two recording starts: {snap.take.startOffsetMs.toFixed(2)} ms ± {snap.take.startOffsetUncMs.toFixed(2)} ms (this does not include the sound cards' own delay)
          </div>
        )}
        <div>
          Control protocol 1.{snap.protocolMinor || "?"} · refused {snap.refusedMessages} · duplicates {snap.duplicateMessages}
        </div>
        <div className="mt-1 max-h-[120px] overflow-auto font-mono text-[10px] leading-snug" data-testid="rec-history">
          {live?.history.slice(-14).map((l, i) => <div key={i}>{l}</div>)}
        </div>
      </div>
    </details>
  );

  const problem = message || live?.error || "";

  return (
    <div className="relative" ref={ref}>
      <button className="hw-btn px-2.5 py-1 text-xs" aria-pressed={open} onClick={() => setOpen(!open)} title="Record a singer or instrument over the network" data-testid="rec-button">
        <span className={recording ? "text-rose-400" : ""}>●</span> Remote recording
        {recording && <span className="ml-1 text-rose-300">REC</span>}
      </button>

      {open && (
        <div className="hw-popover absolute top-full left-0 z-[65] mt-1.5 max-h-[calc(100vh-70px)] w-[470px] overflow-y-auto p-3 text-[12px]" data-testid="rec-popover">
          <div className="hw-legend mb-2 !text-[10px]">RECORD TOGETHER OVER THE NETWORK</div>
          {micStep}
          {connectStep}
          {recordStep}
          {talkbackBlock}
          {takesStep}
          {details}
          {problem && (
            <div className="mt-1 text-[11px] text-amber-200" data-testid="rec-message">
              {problem}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
