# Lesson format and checker contract

Companion to [`CURRICULUM.md`](CURRICULUM.md). Lessons are **data**, not code: adding a lesson means adding a file, not changing the player.
Everything below is a proposal for Component 1 to refine in `docs/lessons/PLAN.md`. Where it needs something from the DAW core
(`packages/shared`, `main`, `engine`), it is listed in section 7 as a **request to Chamath**, not something to edit yourself.

## 1. Where things live (proposed)

```
apps/desktop/src/renderer/src/features/lessons/
  content/                 one file per sub-lesson, e.g. m3-4-major-triad.ts   (data only)
  engine/                  lesson player (step machine), demo runner, hint logic, telemetry
  checks/                  PURE checker functions + their unit tests            (no React, no window.daw)
  theory/                  pure music-theory helpers (pitch classes, scales, chords)  (+ tests)
  ui/                      the learning interface (LessonScreen, LessonPianoRoll, panels)
```

Keep `checks/` and `theory/` free of React and Electron so they can be unit-tested with `npm test`.

## 2. Types (proposed)

Time is in **ticks** (960 per quarter note = 1 beat; a 4/4 bar = 3840). Pitch is a **MIDI number** (C4 = 60). `pitchClass = pitch mod 12` (C = 0 ... B = 11).

```ts
export type Beats = number;                       // helpers convert to ticks: beats * 960
export interface NoteSpec { pitch: number; startBeat: Beats; durationBeats: Beats; velocity?: number; label?: string; role?: "root" | "third" | "fifth" }

export interface Lesson {
  id: string;                  // "M3.4"
  module: string;              // "M3"
  title: string;               // "The major triad"
  summary: string;             // one sentence
  prerequisites: string[];     // ["M3.3"]
  estMinutes: number;
  steps: Step[];               // hook -> watch -> try -> practice (one or more) -> done
  quiz: QuizQuestion[];        // 1-3 questions
  dawTask?: { prompt: string; projectPreset: string };   // "Use it in the DAW"
}

export type Step = HookStep | WatchStep | TryStep | PracticeStep;
export interface HookStep     { kind: "hook"; text: string; soundNotes?: NoteSpec[] }
export interface WatchStep    { kind: "watch"; script: DemoEvent[]; range: { low: number; high: number }; bars: number; tempo: number }
export interface TryStep      { kind: "try"; prompt: string; ghost: NoteSpec[]; highlightRows?: number[]; successWhen: Check; redWrongNotes: boolean }
export interface PracticeStep {
  kind: "practice";
  task: string;                       // "Build a G major chord."
  startNotes?: NoteSpec[];            // pre-placed notes (may be empty -> blank roll)
  range: { low: number; high: number }; // visible rows, e.g. C3..C5
  tools: Array<"draw" | "select" | "delete" | "move" | "resize" | "copy" | "undo">;
  bars: number;
  check: Check;
  hints: [string, string];            // tier 1 reminder, tier 2 explanation (tier 2 also highlights rows)
  highlightForTier2?: number[];       // rows to highlight on tier 2
  solution: NoteSpec[];               // tier 3: shown as ghost notes
  mistakes: Record<string, string>;   // mistake code -> message shown to the learner
}
export interface DemoEvent {          // what the Watch step draws, in order
  at: Beats;                          // when (on the demo timeline)
  add?: NoteSpec[];                   // notes drawn at this moment
  remove?: number[];                  // pitches removed
  play?: "soloNewNotes" | "all";      // what is heard
  caption?: string;                   // shown as text ("C is the root")
  highlightRows?: number[];
  labels?: Array<{ pitch: number; text: string }>;   // text drawn on a note ("root", "+4", "+3")
}
export interface QuizQuestion { prompt: string; kind: "multiple-choice" | "click-note"; options?: string[]; answer: number | { pitch: number }; explain: string }
```

## 3. Checker contract (pure functions)

```ts
// notes are the learner's notes in the practice roll, relative to the roll (startBeat 0 = start of the roll).
export type CheckNote = { id: string; pitch: number; startBeat: number; durationBeats: number };
export interface CheckResult { passed: boolean; score: number /* 0..1 */; mistakes: Array<{ code: string; noteIds?: string[]; detail?: Record<string, unknown> }> }
export type Check = /* one of the types below */;
export function runCheck(check: Check, notes: CheckNote[], ctx: CheckContext): CheckResult;
```

| Check `type` | Parameters | Passes when | Mistake codes it can return |
|---|---|---|---|
| `noteAt` | `pitch`, `startBeat?`, `durationBeats?`, `tolerance?` | a note matches | `WRONG_PITCH`, `WRONG_START`, `WRONG_LENGTH`, `MISSING` |
| `noteSequence` | `notes: [{pitch \| pitchClass, startBeat, durationBeats?}]`, `ordered` | the sequence matches | `WRONG_PITCH(i)`, `WRONG_ORDER`, `MISSING(i)`, `EXTRA` |
| `pitchClassSet` | `pitchClasses` or `{root, quality}`, `simultaneous`, `count?`, `rootLowest?` | the notes at one start form exactly this chord | `NOT_SIMULTANEOUS`, `WRONG_THIRD`, `WRONG_FIFTH`, `MISSING_NOTE`, `EXTRA_NOTE`, `ROOT_NOT_LOWEST` |
| `scale` | `tonic`, `scale` (`major`/`naturalMinor`/`pentatonicMajor`/`pentatonicMinor`), `mode: "exact" \| "allInScale"`, `ordered?` | the notes are the scale (exact) or all in it | `OUT_OF_KEY(noteIds)`, `WRONG_STEP(i)`, `MISSING_DEGREE(n)` |
| `interval` | `fromPitch`, `semitones` | a note exists at that distance | `WRONG_INTERVAL(actual)` |
| `progression` | `key: {tonic, mode}`, `degrees?` (e.g. `["I","V","vi","IV"]`), `barCount`, `rules?` | each bar's chord equals the expected degree, or (free mode) follows the rules | `WRONG_CHORD(bar)`, `CHORD_NOT_IN_KEY(bar)`, `BAD_ENDING`, `BAR_EMPTY(bar)` |
| `rhythmGrid` | `rows: { [drumPitch]: number[] }` (beat positions), `unit`, `exact?` | hits are on the expected positions | `MISSING_HIT(row, beat)`, `EXTRA_HIT(row, beat)` |
| `rules` | list of rule ids, e.g. `"in-key"`, `"mostly-stepwise"`, `"chord-tones-on-strong-beats"`, `"two-note-lengths"`, `"has-rest"`, `"ends-on-chord-tone"` | all listed rules hold | one code per failed rule |
| `opSeen` | `ops: [{type, min}]` | the learner performed these actions (training lessons) | `NOT_DONE(type)` |
| `state` | `tempo?`, `loop?`, `played?` | UI state matches (training) | `TEMPO_WRONG`, `LOOP_OFF`, `NOT_PLAYED` |
| `all` / `any` | `checks: Check[]` | combination | union of the inner mistakes |

Every checker must have **a passing and a failing unit test**, and **every mistake code needs a message** in the lesson's `mistakes` table.
Mistake messages **name the specific note or step** ("E-flat makes it minor") and say **what to do** ("raise it one row").

Music-theory helpers the checks share (write once, test once): `pitchClass(p)`, `noteName(p)`, `scaleNotes(tonic, scale)`, `triad(root, quality)`,
`chordFromDegree(key, degree)`, `chordSymbolToPitchClasses("F#m")`, `identifyChord(pitches)` (returns root, quality, inversion).

## 4. Feedback and hints (behaviour)

1. Learner presses **Check** -> `runCheck` -> if `passed`: green, next step. Else: red notes (`noteIds`) + messages from `mistakes[code]`.
2. After the **2nd failed check** (or on request) show hint tier 1, then tier 2 (rows highlighted), then tier 3 (`solution` ghost notes). Retries unlimited.
3. Mastery = `mastered` (first try, no tier 3), `passed` (with hints), `not-yet`.

## 5. Events and data for the evaluation (local, anonymous)

Record a small append-only log per participant code (no names). Show a consent screen before recording; do not record before consent.

```ts
type LessonEvent =
  | { t: "lesson.started"; lessonId: string; at: number }
  | { t: "step.entered"; lessonId: string; step: number; at: number }
  | { t: "exercise.checked"; lessonId: string; step: number; attempt: number; passed: boolean; mistakes: string[]; hintTier: 0 | 1 | 2 | 3; at: number }
  | { t: "quiz.answered"; lessonId: string; question: number; correct: boolean; at: number }
  | { t: "lesson.completed"; lessonId: string; mastery: "mastered" | "passed"; attempts: number; seconds: number; hintTiersUsed: number[]; at: number };
```

Pre-test / post-test scores and the SUS questionnaire are separate records. Export as JSON/CSV for analysis.
**`lesson.completed` is also the event the DAW's unlock system listens to** (see the unlock map in `CURRICULUM.md` section 12).

## 6. Worked examples

### 6.1 M0.3 Draw and delete a note (training)

```ts
export const m0_3: Lesson = {
  id: "M0.3", module: "M0", title: "Draw and delete a note",
  summary: "A note has a pitch (which row) and a start time (which column).",
  prerequisites: ["M0.2"], estMinutes: 3,
  steps: [
    { kind: "hook", text: "Every sound in your song is a note you draw on the piano roll." },
    { kind: "watch", bars: 1, tempo: 100, range: { low: 55, high: 76 }, script: [
      { at: 0, add: [{ pitch: 60, startBeat: 0, durationBeats: 1 }], play: "soloNewNotes", caption: "Click a row at a time: this note is C4, starting on beat 1." },
      { at: 1, add: [{ pitch: 64, startBeat: 1, durationBeats: 1 }], play: "soloNewNotes", caption: "A note further up the roll sounds higher." },
      { at: 2, remove: [64], caption: "The Delete tool (or right-click) removes a note." },
    ] },
    { kind: "practice", task: "Draw three notes in bar 1, then delete the middle one.", bars: 1, range: { low: 55, high: 76 },
      tools: ["draw", "delete"], startNotes: [],
      check: { type: "all", checks: [
        { type: "opSeen", ops: [{ type: "addNote", min: 3 }, { type: "deleteNote", min: 1 }] },
        { type: "rules", rules: ["exactly-2-notes-left"] } ] },
      hints: ["Pick the Draw tool (D), click three times in bar 1.", "Now pick the Delete tool (E) and click the middle note."],
      highlightForTier2: [], solution: [{ pitch: 60, startBeat: 0, durationBeats: 1 }, { pitch: 67, startBeat: 2, durationBeats: 1 }],
      mistakes: { NOT_DONE: "Draw three notes first, then delete one.", EXTRA_NOTE: "You have too many notes left. The task ends with two." } },
  ],
  quiz: [{ prompt: "A note that is higher up the roll sounds...", kind: "multiple-choice", options: ["lower", "higher", "the same"], answer: 1, explain: "Up the roll = higher pitch." }],
  dawTask: { prompt: "Draw a three-note tune in the DAW piano roll.", projectPreset: "blank-synth" },
};
```

### 6.2 M3.4 The major triad (theory)

```ts
export const m3_4: Lesson = {
  id: "M3.4", module: "M3", title: "The major triad",
  summary: "Major triad = root, then 4 semitones up, then 3 more.",
  prerequisites: ["M3.2", "M3.3"], estMinutes: 8,
  steps: [
    { kind: "hook", text: "Listen: this is a major chord. Bright and happy.", soundNotes: [
      { pitch: 60, startBeat: 0, durationBeats: 2 }, { pitch: 64, startBeat: 0, durationBeats: 2 }, { pitch: 67, startBeat: 0, durationBeats: 2 } ] },
    { kind: "watch", bars: 1, tempo: 80, range: { low: 55, high: 76 }, script: [
      { at: 0, add: [{ pitch: 60, startBeat: 0, durationBeats: 4, role: "root", label: "root" }], play: "soloNewNotes", caption: "Start on the root: C." },
      { at: 1, add: [{ pitch: 64, startBeat: 0, durationBeats: 4, label: "+4" }], play: "soloNewNotes", caption: "Count 4 semitones up: E." },
      { at: 2, add: [{ pitch: 67, startBeat: 0, durationBeats: 4, label: "+3" }], play: "soloNewNotes", caption: "Add 3 more: G. Together: C major." },
      { at: 3, play: "all", caption: "Root + 4 + 3 = major triad." } ] },
    { kind: "try", prompt: "Build G major. Follow the ghost notes.", redWrongNotes: true,
      ghost: [{ pitch: 55, startBeat: 0, durationBeats: 4 }, { pitch: 59, startBeat: 0, durationBeats: 4 }, { pitch: 62, startBeat: 0, durationBeats: 4 }],
      successWhen: { type: "pitchClassSet", pitchClasses: { root: 7, quality: "major" } as never, simultaneous: true } },
    { kind: "practice", task: "Build a D major chord (hint: it contains F#).", bars: 1, range: { low: 48, high: 72 }, tools: ["draw", "select", "delete", "move"],
      check: { type: "pitchClassSet", pitchClasses: { root: 2, quality: "major" } as never, simultaneous: true, count: 3 },
      hints: ["Major = root, +4 semitones, +3 more. D is the root.", "D + 4 = F#, F# + 3 = A. Look at the highlighted rows."],
      highlightForTier2: [50, 54, 57], solution: [{ pitch: 50, startBeat: 0, durationBeats: 4 }, { pitch: 54, startBeat: 0, durationBeats: 4 }, { pitch: 57, startBeat: 0, durationBeats: 4 }],
      mistakes: {
        NOT_SIMULTANEOUS: "The notes start at different times. Put all three in the same column.",
        WRONG_THIRD: "The middle note should be 4 semitones above D. If you used F, that makes it D minor.",
        WRONG_FIFTH: "The top note should be 3 semitones above the middle note (7 above the root).",
        MISSING_NOTE: "A triad has three notes: root, third and fifth.",
      } },
  ],
  quiz: [
    { prompt: "How many semitones from the root to the middle note of a major triad?", kind: "multiple-choice", options: ["3", "4", "5"], answer: 1, explain: "Major third = 4 semitones." },
    { prompt: "Click the root of this chord.", kind: "click-note", answer: { pitch: 53 }, explain: "The root is the lowest note: F." },
  ],
  dawTask: { prompt: "Place a C major chord in bar 1 of the DAW piano roll and play it.", projectPreset: "blank-synth" },
};
```
(`as never` marks places where the exact `{root, quality}` type is for you to define.)

## 7. Open questions and requests for Chamath (put your answers in `PLAN.md`)

You may not edit `packages/shared`, `engine`, or the main process; **write requests** instead.

1. **Sound for demos.** Option A: a separate **lesson scratch project** loaded into the audio engine (proper timing, looping, tempo), which needs main-process support. Option B (works today): `window.daw.preview(trackId, pitch, velocity, on)` scheduled from JavaScript (about 10-20 ms jitter, fine for teaching; it makes sound without changing the user's project; use any existing track id as the voice). **Recommendation:** start with B, ask Chamath for A.
2. **The lesson piano roll.** The DAW's `PianoRoll` is bound to the real project and edits it. The lessons need ghost notes, restricted ranges, local state. **Recommendation:** build a separate `LessonPianoRoll` with its own local note state, reusing only the pure helpers in `pianoRoll/geometry.ts`. The learner's practice never touches the user's project.
3. **"Use it in the DAW".** Opening the DAW with a prepared project needs a way to load a preset project. Ask Chamath for a small API.
4. **`lesson.completed` delivery.** Propose: an in-process event bus (`features/lessons/events.ts`) that the DAW side can subscribe to, plus persisted progress (local JSON). Agree the shape with Chamath.
5. **Participant codes and consent** for the evaluation: where the consent text lives and who approves it (ethics requirement in the project proposal).

## 8. First milestone (suggested acceptance criteria)

**L-M1: "Lesson player + M0.1-M0.3 + checker library".**
1. A lesson file in `content/` is loaded and played through Hook, Watch, Practice, Done.
2. The Watch step draws notes on the lesson piano roll with captions and sound.
3. The Practice step runs `runCheck`; wrong answers show the message from `mistakes[code]`; hint tiers 1-3 work.
4. `noteAt`, `noteSequence`, `pitchClassSet`, `scale`, `opSeen`, `all` checkers exist with a passing and a failing unit test each (`npm test` green).
5. M0.1, M0.2, M0.3 can be completed by a person who has never used the DAW; at least 3 people tried it and their time and attempts were recorded.
6. A `lesson.completed` event is emitted with the shape in section 5.
