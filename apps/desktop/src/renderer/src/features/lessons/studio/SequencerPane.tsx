import { useEffect, useState } from "react";
import { MAX_BPM, MIN_BPM, TICKS_PER_BAR, songTicks, type Project } from "@daw/shared";
import { SectionRuler } from "../../../components/SectionRuler";
import { HEADER_W } from "../../../components/TrackHeader";
import { BarBeatReadout, TapTempoButton } from "../../../components/TransportExtras";
import { DRUM_NAMES } from "../../../pianoRoll/geometry";
import { StepSequencer } from "../../../pianoRoll/StepSequencer";
import { statusStore, useStore } from "../../../store";
import { playLesson } from "../lessonPlay";
import { lessonView } from "./checks";
import { SEQ_TRACK } from "./exampleSong";
import type { PadDemo } from "./types";

/**
 * The Drum sequencer lessons' workspace: the DAW's own step sequencer on the lesson's drum track, with the transport
 * tools the lessons teach (Play, Click, TAP, the position readout, BPM, Loop and the LOOP strip). In Hook and Watch it
 * shows a demonstration pattern instead, lighting the pads as they play.
 */

export interface SequencerGuide {
  /** Hook / Watch: show this pattern on demonstration pads instead of the editable sequencer. */
  demo?: PadDemo[] | null;
  /** The demonstration step playing now (0-15), or -1. */
  demoStep?: number;
}

const DEMO_ROWS = [36, 38, 42];
const BAR_W = 140;

/** Sixteen pads per row, lit where the demonstration has a hit (the same pads as the real sequencer). */
function DemoPads({ demo, step }: { demo: PadDemo[]; step: number }) {
  const rows = [...new Set([...DEMO_ROWS, ...demo.map((d) => d.pitch)])];
  const hit = (pitch: number, pad: number) => demo.find((d) => d.pitch === pitch && d.pads.includes(pad));
  return (
    <div className="hw-panel-deep flex min-h-0 flex-1 flex-col px-3 pt-2 pb-3" data-testid="seq-demo">
      <div className="mb-2 text-[11px] text-slate-400">Demonstration: watch the pads light up as they play.</div>
      <div className="mb-1.5 flex items-center" style={{ paddingLeft: 104 }}>
        <div className="flex flex-1 items-center gap-[3px] pr-3">
          {Array.from({ length: 16 }, (_, s) => (
            <div key={s} className="flex flex-1 items-center" style={{ minWidth: 18, marginLeft: s > 0 && s % 4 === 0 ? 8 : 0 }}>
              <div className="hw-led-dot" data-lit={s === step ? "true" : undefined} />
            </div>
          ))}
        </div>
      </div>
      <div className="flex flex-col gap-1.5">
        {rows.map((pitch) => (
          <div key={pitch} className="flex items-center" data-testid="demo-row" data-pitch={pitch}>
            <span className="mr-2 w-24 truncate px-2 text-[11px] text-slate-300">{DRUM_NAMES[pitch] ?? `Drum ${pitch}`}</span>
            <div className="flex min-w-0 flex-1 items-center gap-[3px] pr-3">
              {Array.from({ length: 16 }, (_, s) => {
                const h = hit(pitch, s + 1);
                const v = h ? (h.velocity ?? 100) : null;
                return (
                  <div
                    key={s}
                    className="hw-pad"
                    data-on={v !== null ? "true" : undefined}
                    data-accent={v !== null && v >= 122 ? "true" : undefined}
                    data-beat={Math.floor(s / 4) % 2 === 1 ? "odd" : "even"}
                    data-demo-pad={s + 1}
                    style={{ marginLeft: s > 0 && s % 4 === 0 ? 8 : 0, opacity: v !== null ? 0.4 + 0.6 * (v / 127) : undefined, outline: s === step && v !== null ? "2px solid #fcd34d" : undefined }}
                  />
                );
              })}
            </div>
          </div>
        ))}
      </div>
      <div className="mt-3 text-xs text-slate-500">Pads 1, 5, 9 and 13 are the four beats.</div>
    </div>
  );
}

export function SequencerPane({ project, guide, ready = true }: { project: Project; guide: SequencerGuide; ready?: boolean }) {
  const view = lessonView(project);
  const status = useStore(statusStore);
  const playing = status?.playing ?? false;
  const track = ready ? view.tracks[SEQ_TRACK] : undefined;
  const clip = track ? Object.values(track.clips).sort((a, b) => a.startTick - b.startTick)[0] : undefined;
  const [click, setClick] = useState(false);
  const [bpm, setBpm] = useState(String(project.tempo));
  useEffect(() => setBpm(String(project.tempo)), [project.tempo]);
  // The click is a lesson tool here: it is switched off again when the lesson closes.
  useEffect(() => () => window.daw.setMetronome(false), []);
  const toggleClick = () => {
    window.daw.setMetronome(!click);
    setClick(!click);
  };
  const commitBpm = () => {
    const v = Math.round(Number(bpm));
    if (Number.isFinite(v) && v >= MIN_BPM && v <= MAX_BPM && v !== project.tempo) void window.daw.dispatch({ type: "setTempo", bpm: v });
    else setBpm(String(project.tempo));
  };
  // Loop on: the first bar (drag in the LOOP strip to change it). Loop off: back to looping the whole song.
  const toggleLoop = () => void window.daw.dispatch({ type: "setLoop", loop: project.loop ? null : { startTick: 0, endTick: TICKS_PER_BAR } });

  const songLen = songTicks(project);
  const bars = Math.max(4, Math.ceil((clip ? clip.startTick + clip.lengthTicks : TICKS_PER_BAR) / TICKS_PER_BAR));
  const shownLen = Math.min(songLen, bars * TICKS_PER_BAR);
  const pxPerTick = BAR_W / TICKS_PER_BAR;
  const btn = "hw-btn px-2.5 py-1 text-xs";
  const demo = guide.demo !== undefined;

  return (
    <section className="flex min-w-0 flex-1 flex-col overflow-hidden rounded-2xl border border-white/10 bg-[#11141c]" data-testid="sequencer-pane">
      <div className="flex flex-wrap items-center gap-2.5 border-b border-white/10 px-4 py-2.5">
        <button onClick={() => (playing ? window.daw.stop() : void playLesson())} className="flex h-10 w-10 items-center justify-center rounded-full bg-white/10 text-white hover:bg-white/15" aria-label={playing ? "Stop" : "Play"} data-testid="kplay">
          {playing ? "■" : "▶"}
        </button>
        <BarBeatReadout ppq={project.ppq} />
        <button className={`${btn} hw-teal`} aria-pressed={click} onClick={toggleClick} title="Metronome: a click on every beat while playing (higher on beat 1)" data-testid="seq-click">
          Click
        </button>
        <TapTempoButton />
        <label className="flex items-center gap-1.5 text-xs text-slate-400">
          BPM
          <input value={bpm} onChange={(e) => setBpm(e.target.value)} onBlur={commitBpm} onKeyDown={(e) => e.key === "Enter" && commitBpm()} className="w-14 rounded-lg bg-white/5 px-2 py-1 text-slate-100 ring-1 ring-white/10" aria-label="Tempo in BPM" data-testid="kbpm" />
        </label>
        <button className={`${btn} hw-teal`} aria-pressed={Boolean(project.loop)} onClick={toggleLoop} title="Loop: play the same part over and over. Drag in the LOOP strip to choose where." data-testid="seq-loop">
          Loop
        </button>
      </div>

      {!demo && (
        <div className="overflow-x-auto border-b border-white/10" data-testid="seq-timeline">
          <div className="relative" style={{ width: HEADER_W + shownLen * pxPerTick }}>
            <SectionRuler project={{ ...project, markers: [] }} pxPerTick={pxPerTick} songLen={shownLen} songW={shownLen * pxPerTick} unit={TICKS_PER_BAR / 4} loopLocked={false} loopLockTitle={null} markersLocked markersLockTitle="Section markers are not part of this lesson" />
            <div className="flex h-6 items-center text-[11px] text-slate-400">
              <span className="shrink-0 px-2 text-[10px] tracking-widest text-slate-500 uppercase" style={{ width: HEADER_W }}>
                Bars
              </span>
              {Array.from({ length: bars }, (_, b) => (
                <span key={b} className="shrink-0 border-l border-white/10 pl-1" style={{ width: BAR_W }}>
                  {b + 1}
                </span>
              ))}
            </div>
          </div>
        </div>
      )}

      <div className="flex min-h-[340px] flex-1 flex-col">
        {demo ? (
          <DemoPads demo={guide.demo ?? []} step={guide.demoStep ?? -1} />
        ) : track && clip ? (
          <StepSequencer key={clip.id} track={track} clip={clip} rampLocked={false} rampLockTitle={null} />
        ) : (
          <div className="flex flex-1 items-center justify-center text-sm text-slate-400" data-testid="seq-preparing">
            Preparing your drum track…
          </div>
        )}
      </div>
    </section>
  );
}
