import { useMemo, useState } from "react";
import type { EditorTab, MidiNote } from "../types/daw";
import { PIANO_HIGH_PITCH, PIANO_LOW_PITCH } from "../data/mockDaw";

interface PianoRollProps {
  notes: MidiNote[];
  playheadBar: number;
}

const TABS: { id: EditorTab; label: string }[] = [
  { id: "piano", label: "Piano Roll" },
  { id: "score", label: "Score" },
  { id: "steps", label: "Step Sequencer" },
  { id: "automation", label: "Automation" },
];

const NOTE_NAMES = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"];
const TOTAL_BEATS = 16;
const STEPS_PER_BEAT = 4;

function pitchLabel(pitch: number) {
  const name = NOTE_NAMES[pitch % 12];
  const octave = Math.floor(pitch / 12) - 1;
  return `${name}${octave}`;
}

function isBlackKey(pitch: number) {
  return NOTE_NAMES[pitch % 12].includes("#");
}

export function PianoRoll({ notes, playheadBar }: PianoRollProps) {
  const [tab, setTab] = useState<EditorTab>("piano");
  const pitches = useMemo(() => {
    const list: number[] = [];
    for (let pitch = PIANO_HIGH_PITCH; pitch >= PIANO_LOW_PITCH; pitch -= 1) {
      list.push(pitch);
    }
    return list;
  }, []);

  const columns = TOTAL_BEATS * STEPS_PER_BEAT;
  const playheadPercent = ((playheadBar - 1) / (TOTAL_BEATS / 4)) * 100;

  return (
    <section className="flex min-h-0 flex-col overflow-hidden rounded-xl border border-white/8 bg-[#12151c]">
      <div className="flex items-center gap-1 overflow-x-auto border-b border-white/8 px-2 py-1.5">
        {TABS.map((item) => (
          <button
            key={item.id}
            type="button"
            onClick={() => setTab(item.id)}
            className={`rounded-md px-2.5 py-1 text-[11px] font-medium ${
              tab === item.id
                ? "bg-cyan-400/15 text-cyan-200"
                : "text-slate-400 hover:bg-white/5 hover:text-slate-200"
            }`}
          >
            {item.label}
          </button>
        ))}
        <p className="ml-auto hidden pr-2 text-[10px] text-slate-500 sm:block">
          Draw notes for the Lead
        </p>
      </div>

      {tab !== "piano" ? (
        <div className="flex flex-1 items-center justify-center p-6 text-center">
          <div>
            <p className="text-sm text-slate-200">{TABS.find((item) => item.id === tab)?.label}</p>
            <p className="mt-1 text-xs text-slate-500">
              This editor will open in a later milestone. Piano Roll is ready to explore first.
            </p>
          </div>
        </div>
      ) : (
        <div className="flex min-h-0 flex-1 flex-col">
          <div className="min-h-0 flex-1 overflow-auto">
            <div className="flex min-w-[42rem]">
              <div className="w-12 shrink-0 border-r border-white/8">
                {pitches.map((pitch) => (
                  <div
                    key={pitch}
                    className={`flex h-5 items-center justify-end pr-1 text-[9px] ${
                      isBlackKey(pitch)
                        ? "bg-[#151821] text-slate-500"
                        : "bg-[#1c212c] text-slate-300"
                    }`}
                  >
                    {pitchLabel(pitch).includes("C") && !isBlackKey(pitch)
                      ? pitchLabel(pitch)
                      : ""}
                  </div>
                ))}
              </div>

              <div className="relative min-w-0 flex-1">
                <div
                  className="grid"
                  style={{
                    gridTemplateColumns: `repeat(${columns}, minmax(0.6rem, 1fr))`,
                    gridTemplateRows: `repeat(${pitches.length}, 1.25rem)`,
                  }}
                >
                  {pitches.flatMap((pitch) =>
                    Array.from({ length: columns }, (_, col) => (
                      <div
                        key={`${pitch}-${col}`}
                        className={`border-r border-b ${
                          col % 16 === 0
                            ? "border-r-white/16"
                            : col % 4 === 0
                              ? "border-r-white/10"
                              : "border-r-white/5"
                        } ${isBlackKey(pitch) ? "bg-[#10131a]" : "bg-[#161a22]"}`}
                      />
                    )),
                  )}
                </div>

                {notes.map((note) => {
                  const row = PIANO_HIGH_PITCH - note.pitch;
                  const left = (note.startBeat / TOTAL_BEATS) * 100;
                  const width = (note.durationBeats / TOTAL_BEATS) * 100;
                  return (
                    <div
                      key={note.id}
                      className="absolute overflow-hidden rounded-sm bg-cyan-400/85 shadow-[0_0_10px_rgba(34,211,238,0.25)]"
                      style={{
                        top: row * 20,
                        height: 18,
                        left: `${left}%`,
                        width: `${width}%`,
                      }}
                    />
                  );
                })}

                <div
                  className="pointer-events-none absolute top-0 bottom-0 w-px bg-cyan-300"
                  style={{ left: `${playheadPercent}%` }}
                />
              </div>
            </div>
          </div>

          <div className="flex h-12 shrink-0 border-t border-white/8">
            <div className="flex w-12 shrink-0 items-center justify-center border-r border-white/8 text-[9px] uppercase tracking-wide text-slate-500">
              Vel
            </div>
            <div className="relative min-w-0 flex-1 bg-[#0e1118]">
              {notes.map((note) => {
                const left = (note.startBeat / TOTAL_BEATS) * 100;
                const width = (note.durationBeats / TOTAL_BEATS) * 100;
                return (
                  <div
                    key={`${note.id}-vel`}
                    className="absolute bottom-1 rounded-sm bg-fuchsia-400/70"
                    style={{
                      left: `${left}%`,
                      width: `${Math.max(width - 0.4, 1)}%`,
                      height: `${note.velocity * 0.32}px`,
                    }}
                  />
                );
              })}
            </div>
          </div>
        </div>
      )}
    </section>
  );
}
