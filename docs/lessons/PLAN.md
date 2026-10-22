# Component 1: Interactive Music Learning Module (plan)

Status: **plan approved; Milestones 1 and 2 coded and committed locally (not pushed); M3 (pilot and polish) not started.** See "M1 status" and "M2 status" at the end.
Branch: `feature/learning` (fast-forwarded to `origin/develop` at `2823884`, M3).
Owner: Component 1 (IT23250406). Scope from the TAF (J26-IM-303): interactive lessons on chord progressions, melody,
rhythm and MIDI editing as editable piano-roll exercises with immediate feedback, a transition into the DAW after a
lesson, and evaluation by pre/post test, completion time, exercise accuracy and SUS.

Throughout this document, **[C]** means confirmed by reading the code on this branch and **[A]** means an assumption
that still needs checking.

---

## 0. What the code gives us

### Confirmed [C]

| Fact | Where |
|---|---|
| One project only. The main process opens `projects/default` in `userData` and owns one `ProjectService`. There is no "open another project", "new project" or "replace project" op or IPC. | `main/index.ts`, `projectService.ts` |
| The renderer reads with `window.daw.getInitial()` / `onProject(cb)` and edits only with `dispatch(op, group?)` / `dispatchBatch(ops, group?)`. A batch is validated all-or-nothing and becomes **one undo step**. The result is `{ ok, reason? }`. | `preload/index.ts`, `projectService.ts` |
| `projectStore` (renderer) already mirrors the project, so a lesson panel can read it with `useStore(projectStore)`. | `store.ts` |
| Model: `Project → tracks → clips → notes`. Note times are integer ticks **relative to the clip**, `PPQ = 960`, 4/4 only (`TICKS_PER_BAR = 3840`). Notes have `pitch` (0-127), `velocity` (1-127) and an optional `muted`. | `shared/model.ts` |
| Ops available: `addTrack` (a whole track with clips and notes), `deleteTrack` (not the last one), `updateTrack` (name, colour, volume, pan, mute, solo), `addClip` / `updateClip` / `deleteClip`, `addNote` / `updateNote` / `deleteNote`, `setTempo`, `setSongLength`, `setMasterVolume`. | `shared/ops.ts` |
| Validation rules a lesson setup must respect: at most 16 tracks; a clip must fit inside `songBars` (default 8) and not overlap other clips on its track; notes must lie inside their clip; ids must be unique. | `shared/apply.ts` |
| `PianoRoll` is a self-contained component. It takes `track`, `clip`, `tool`, `snap`, `gridTicks`, zoom and `keysEnabled` as props and dispatches its own ops. `App` decides which track/clip it shows via `selectTrackClip(trackId, clipId)`. | `PianoRoll.tsx`, `App.tsx` |
| Piano-roll tools: Draw, Paint, Select (move/resize/box), Delete, Mute, Slice, Copy/Paste/Duplicate, Quantize, a velocity lane, and drum-name rows. Visible pitch range is **C2-B5 (36-83)**. | `PianoRoll.tsx`, `geometry.ts` |
| Drum kit mapping: 36 kick, 38 snare, 39 clap, 42 closed hat, 46 open hat, toms 41/43/45/47. | `engine/src/Drums.h` |
| Playback always loops over the **whole song** (`songBars`) and plays every non-muted track. There is no loop region and no "play this clip only". | `ADR-003`, `snapshot.ts` |
| `geometry.ts` already has `NOTE_NAMES` and `pitchLabel()`, which hints can reuse (read-only import). | `geometry.ts` |
| Renderer tests run under Vitest from `apps/desktop` (for example `pianoRoll/editing.test.ts` tests pure op builders against the shared `applyOp`). | `apps/desktop/package.json` |
| The renderer runs with `contextIsolation: true` and `nodeIntegration: false`, so it has **no file-system access**. `localStorage` is available (Chromium, persisted in `userData`). | `main/index.ts` |
| No network is used anywhere in the renderer today. | whole renderer |

### Assumed [A] (to verify before or during milestone 1)

- A1. `localStorage` survives app restarts and engine restarts in this Electron setup. (Chromium default; I'll check it in M1.)
- A2. A Blob plus `<a download>` in the renderer opens Electron's default save dialog, so study data can be exported
  without a main-process change. If not, see request R2 below.
- A3. The teammate who owns unlocks and the red out-of-key overlay (Component 2) also works in the renderer and can subscribe to an
  in-process event. Their code location is unknown; I need to ask them.
- A4. Adding one "Lessons" button and one side panel to `App.tsx` (about 10-15 lines) is acceptable, as you said.
- A5. Pre-test, post-test and SUS are run **outside the app** (on paper or an offline form) and linked to app logs only by
  a participant code. They are not part of this component's code.

### Divergence to note for the thesis (not mine to change)

The TAF describes a **browser-based** DAW with login, MongoDB and Tone.js. ADR-001 changed this to a standalone
Electron app with a JUCE engine and local storage. The lessons follow the code (local, offline, no accounts). The
report's methodology section should say so.

---

## a) Lesson format (content, not code)

Lessons are **plain data**: typed TypeScript objects containing no functions, so they could equally be JSON. A unit test
checks that every lesson round-trips through `JSON.stringify`/`JSON.parse` unchanged, which keeps them data.
Behaviour lives in a small library of **check kinds**. A lesson names a check kind and supplies its parameters.

```ts
// features/lessons/types.ts (sketch)
type Concept = "chords" | "melody" | "rhythm" | "midi-editing";

interface Lesson {
  id: string;            // "chords-1": stable, used in logs and the completed event
  version: number;       // bumped when content changes, so logs stay interpretable
  title: string;
  concept: Concept;
  summary: string;       // one line in the lesson list
  steps: Step[];         // shown in order; the learner pages through them
}

type Step =
  | { kind: "explain"; id: string; title: string; body: string /* short plain text, a few paragraphs max */ }
  | { kind: "exercise"; id: string; title: string; goal: string; exercise: Exercise };

interface Exercise {
  instrument: "synth" | "drums";
  bars: number;                       // clip length, 1-4
  tempo?: number;                     // optional; only set if the lesson needs it
  starterNotes: StarterNote[];        // what is already in the clip (ids generated at setup)
  check: CheckSpec;                   // which pure check runs, with its parameters
  hints: string[];                    // authored hints, revealed one by one by the "Hint" button
}

type StarterNote = { pitch: number; startTick: number; durationTicks: number; velocity?: number };

type CheckSpec =
  | { kind: "chordsPerBar"; chords: string[][] }                  // pitch-class names per bar, e.g. [["C","E","G"], ...]
  | { kind: "melodyInKey"; key: string; scale: "major"; minNotes: number; endOn?: string; monophonic: boolean }
  | { kind: "drumPattern"; voices: { pitch: number; label: string; onsets: number[] /* ticks within the bar */ }[]; tolerance: number }
  | { kind: "matchTarget"; target: StarterNote[]; tolerance: { start: number; duration: number }; velocityRange?: [number, number] };
```

Files:

```
apps/desktop/src/renderer/src/features/lessons/
  types.ts              Lesson / Step / Exercise / CheckSpec / CheckResult
  content/              one file per lesson (data only) + index.ts listing them in order
  checks/               one pure function per check kind + checks.test.ts
  theory.ts             pitch-class helpers (note name <-> pitch class, scale membership). Pure, tested
  setup.ts              pure: Exercise -> OpBody[] that creates or resets the lesson track/clip. Tested against applyOp
  progress.ts           completion state (localStorage)
  studyLog.ts           anonymous evaluation log (localStorage) + export
  events.ts             "lesson completed" event (see d)
  LessonPanel.tsx       UI: lesson list, step pager, Check / Hint / Reset buttons, feedback
docs/lessons/PLAN.md    this file
docs/lessons/CONTENT.md the lesson texts in readable form, for review by a music educator
```

## b) How an exercise works

1. **Start.** The learner opens a lesson and reaches an exercise step. `setup.ts` builds a batch:
   - `addTrack` with id `lesson-<lessonId>`, name `Lesson: <title>`, the exercise instrument, and **one clip** of
     `bars` bars at bar 1 containing the starter notes (fresh note ids from `crypto.randomUUID()`);
   - `setSongLength` first, in the same batch, if the song is shorter than the clip.
   It is sent with `dispatchBatch(ops, "lesson-setup")`. If the track already exists (the learner came back), it is reused
   rather than duplicated. If there are already 16 tracks, the panel says so and does not start.
2. **Edit.** The panel calls App's existing `selectTrackClip(trackId, clipId)`, so the **real piano roll** shows the
   lesson clip with all its normal tools. The learner edits with the same tools they will use later in the DAW. No
   separate editor is built.
3. **Check.** The learner presses **Check**. The panel reads the lesson clip from `projectStore` and calls the pure
   function:

   ```ts
   type CheckFn = (clip: Clip, spec: CheckSpec) => CheckResult;
   interface CheckResult {
     pass: boolean;
     score: number;        // 0..1, used as "exercise accuracy" (defined per check kind below)
     feedback: string;     // the first concrete problem in plain words, or a success message
     items?: { label: string; ok: boolean }[];   // optional checklist, e.g. "Bar 2: G major ✓"
   }
   ```
   Muted notes are ignored by every check. Checks never dispatch and never touch the DOM, so they can be unit tested
   with plain clip objects.
4. **Feedback.** The result shows straight away under the Check button. On a pass, the step completes and the next
   step unlocks. The **Hint** button reveals the next authored hint; this is logged separately from Check feedback so
   "hint use" stays a clean metric.
5. **Reset.** This replaces the clip's notes with the starter notes as one batch (`deleteNote` ×n + `addNote` ×m),
   so it is one undo step.

Score (accuracy) definitions, kept simple so they can be stated in the report:
- `chordsPerBar`: fraction of bars whose sounding pitch-class set equals the target chord.
- `melodyInKey`: in-key notes ÷ all notes, multiplied by 0 if fewer than `minNotes` (pass also needs `endOn` and the monophony rule).
- `drumPattern`: required hits found ÷ (required hits + extra hits on those voices).
- `matchTarget`: target notes matched ÷ max(target count, notes present).

## c) The first four lessons

All exercises are in C major, 4/4, 120 BPM, and inside the visible range C2-B5. Every lesson is one or two short
explain steps followed by **one** exercise.

| # | Lesson | Exercise (starter → task) | Check (pass when) | Example feedback |
|---|---|---|---|---|
| 1 | **Chord progressions:** triads and I-V-vi-IV in C | 4-bar synth clip. Bar 1 already holds C-E-G (C major) and the step text shows the four chord names. Task: build G, Am and F in bars 2-4. | `chordsPerBar` with `[[C,E,G],[G,B,D],[A,C,E],[F,A,C]]`: the pitch classes sounding on beat 1 of each bar equal the target. Inversions and octave doublings are accepted; extra pitch classes are not. | "Bar 3 should be A minor (A, C, E). You have A, C, F: change F to E." |
| 2 | **Melody:** staying in the key | 2-bar synth clip; the starter is a single C4 on beat 1. Task: write a melody of at least 8 notes using only C major notes and end on C. | `melodyInKey`: every pitch class is in C major, at least 8 notes, no overlapping notes, last note's pitch class is C. | "F#4 in bar 1, beat 3 is not in C major. Try F or G." |
| 3 | **Rhythm:** a basic beat | 1-bar drum clip, empty. Task: kick on every beat, snare on beats 2 and 4, closed hats on every 8th. | `drumPattern`: kick (36) onsets {0, 960, 1920, 2880}, snare (38) {960, 2880}, hat (42) every 480, tolerance ±60 ticks. Extra kicks or snares fail. | "Kick: 3 of 4 found. Missing on beat 4." |
| 4 | **MIDI editing:** fix a recorded melody | 2-bar synth clip with a short melody containing 4 planted mistakes: one note off the grid, one too long, one far too loud (velocity 127), one duplicated note. Task: fix them (Quantize, resize, velocity lane, Delete). | `matchTarget`: notes equal the target list within ±30 ticks start / ±60 ticks duration, and every velocity is in [60, 110]. | "The note E4 at bar 2, beat 1 is still too loud (127). Lower it in the velocity lane." |

Lesson 2 does **not** draw red out-of-key notes; that overlay belongs to Component 2. It only gives text feedback after
Check. If the overlay is active during the lesson, both agree because both use "pitch class in C major".

## d) How the lessons plug into the DAW

- **UI:** one toggle button "Lessons" in the header and a `<LessonPanel>` side panel in `App.tsx`, receiving
  `selectTrackClip` as a prop. That is the only change outside `features/lessons/`. No restructuring.
- **Reading state:** `useStore(projectStore)` finds the lesson track/clip by its id. If the learner undoes the setup
  (Ctrl+Z) or deletes the track, the panel notices it is gone and offers "Restart exercise". It never crashes.
- **Writing state:** only `window.daw.dispatchBatch` with ops built by pure functions in `setup.ts`.
- **Hints:** shown in the panel, not as overlays on the piano roll (keeps Component 2's overlay free).
- **After a lesson:** the lesson panel shows "Apply it in the DAW". This closes the panel and leaves the lesson track
  selected in the arrangement, so the learner's work is the starting point of their own production. This is the
  "seamless transition" objective.
- **Lesson-completed event** (lives in `features/lessons/events.ts`, renderer only, no shared-package change):

  ```ts
  export interface LessonCompletedEvent {
    type: "lesson-completed";
    schema: 1;
    lessonId: string;        // "chords-1"
    lessonVersion: number;
    concept: "chords" | "melody" | "rhythm" | "midi-editing";
    completedAt: string;     // ISO 8601
    trackId: string;         // where the learner's result lives, so Component 2 can point at it
    clipId: string;
  }
  export function onLessonCompleted(cb: (e: LessonCompletedEvent) => void): () => void;  // returns unsubscribe
  export function completedLessons(): LessonCompletedEvent[];  // persisted, so unlocks survive a restart
  ```
  The event carries **no** evaluation metrics or participant data, so Component 2 is not coupled to the study log.
  It fires once per lesson (the first completion), and again only if the learner explicitly redoes the lesson.

## e) Evaluation data

**What the app records** (only while a study session is active, see below), one record per exercise attempt-session:

| Field | Meaning |
|---|---|
| `participant` | Code typed by the researcher, e.g. `P07`. Never a name, email or machine identifier. |
| `session` | Random UUID per study session |
| `lessonId`, `lessonVersion`, `stepId` | What was attempted |
| `startedAt`, `endedAt`, `durationMs` | Wall-clock time from exercise start to pass (or leaving the exercise) |
| `outcome` | `passed` / `left` / `abandoned` (app closed) |
| `checks` | Number of Check presses (attempts) |
| `firstScore`, `finalScore`, `scores[]` | Accuracy from the checker at each Check |
| `hintsShown` | Number of authored hints revealed |
| `resets` | Number of Reset presses |

**How:** stored in `localStorage` under `lessons.study.v1`, on the study laptop only, never sent anywhere. A
researcher-only **Study** section in the lesson panel lets you start a session (enter a participant code), end it,
**Export JSON** (and a flat CSV for SPSS/Excel), and **Delete data for a participant code** to support withdrawal.
Without an active study session **nothing is logged**. Normal use of the DAW is not tracked. Learner progress
(`lessons.progress.v1`) is stored separately and contains no metrics.

**What ethics approval will normally require** (confirm against the actual SLIIT ethics form; this is not legal advice):
- Ethics committee approval **before** any participant session, then an information sheet and signed informed consent per participant.
- Anonymised data: the participant-code ↔ identity list is kept on paper or a separate file by the researcher, never in the app or its exports.
- Participants can withdraw and have their data deleted (supported by delete-by-code).
- Data minimisation: only the fields above. No audio, no screen recording, no free text from participants in the app.
- Secure storage: exported files kept on university or encrypted storage, the laptop's local copy deleted after export, and a stated retention period.
- Pre-test, post-test and SUS sheets carry the same participant code only.
- Study protocol states that sessions are offline and what is logged; the consent form says the same.

## f) Risks and how each is tested

| # | Risk | Status | Mitigation | Test |
|---|---|---|---|---|
| R-1 | Lesson setup lives in the user's real project (single project, [C]). It adds a track, takes one of 16 slots, is saved, and appears in exports. | [C] | Reuse one track per lesson; refuse with a message at 16 tracks; the track is clearly named "Lesson: …"; this is also what makes the hand-off to the DAW work. | Unit: `setup.ts` ops apply cleanly with shared `applyOp` on a fresh project, a 16-track project (expect refusal) and a 2-bar song (expect `setSongLength` first). |
| R-2 | Ctrl+Z can undo the lesson setup or other lesson edits. | [C] | Panel detects missing track/clip and offers Restart. Setup is a single batch, so one undo removes it cleanly. | Manual in M1: start lesson, press Ctrl+Z, panel recovers. |
| R-3 | Playback plays every track and loops the whole song, not just the exercise clip. | [C] | M1: accept; the clip is at bar 1 and Play starts there. Later, if confusing in pilot testing: solo the lesson track during the exercise (an existing op), or request a loop region (R3). | Pilot with 2-3 people before the study. |
| R-4 | A check is musically wrong or too strict (e.g. rejects a valid inversion). | [A] | Checks are pure and table-tested; lesson texts in `CONTENT.md` reviewed by a music lecturer or producer, as the TAF plans. | Unit tests per check kind: correct, inversion, octave doubling, missing note, wrong note, extra note, muted note ignored, empty clip, notes off grid within tolerance. |
| R-5 | Starter content is invalid (outside the clip, outside the visible pitch range). | [C] | Content test validates every lesson. | Unit: each exercise's setup ops pass `applyOp`; all pitches within 36-83; every lesson survives the JSON round-trip. |
| R-6 | Study data lost (localStorage cleared, or a reinstall). | [A1] | Export at the end of every session (in the protocol); data written on every Check, not only at the end. | M1: record, restart the app, export, compare. |
| R-7 | Export download does not work in Electron without main-process code. | [A2] | Fallback: "Copy to clipboard", or request R2. | M1 manual check. |
| R-8 | Clash with Component 2 (overlay, unlocks, the same header area). | [A3] | Event-only contract; no shared UI. Agree on the event shape before M2. | Review this section with the teammate. |
| R-9 | Keyboard shortcuts: Space (play) and tool keys fire while typing in panel inputs. | [C] (App ignores Space in inputs; PianoRoll uses `keysEnabled`) | Panel uses normal inputs only; avoid capturing global keys. | Manual in M1. |
| R-10 | Engine down or no audio device. | [C] | Checks don't need audio; lessons still work silently. | Manual: "Kill engine" during a lesson, then press Check. |
| R-11 | Scope creep (full theory course). | — | Four lessons, one exercise each, four check kinds. Anything else waits for pilot feedback. | Plan review. |

### Possible requests to the shared/main code (not needed for M1)

- **R1** (only if R-1 proves unacceptable in the pilot): a separate lesson project in the main process, so exercises never touch the user's project. This is a bigger change owned by the DAW core team.
- **R2** (only if A2 fails): an IPC `lessons:saveFile(name, text)` that opens a save dialog in the main process.
- **R3** (only if R-3 confuses pilot users): a playback loop region `{ startTick, endTick }` in the engine protocol.

## g) Milestone 1: framework + lesson 1 (chords), end to end

Deliverables: `types.ts`, `theory.ts`, `checks/chordsPerBar.ts`, `setup.ts`, `content/chords-1.ts`, `progress.ts`,
`events.ts`, `studyLog.ts` (record + export JSON), `LessonPanel.tsx`, tests, a 10-15 line change to `App.tsx`, and
`docs/lessons/CONTENT.md` for lesson 1.

Acceptance criteria you can check:

1. `npm test -w apps/desktop` passes, including new tests:
   - `chordsPerBar`: at least 8 cases (correct; inversion accepted; octave doubling accepted; missing note; wrong note; extra pitch class; muted note ignored; empty clip) with the expected `pass`, `score` and the bar named in `feedback`.
   - `setup.ts`: ops apply with the shared `applyOp` on a fresh project; refuse at 16 tracks; extend a 2-bar song; reuse an existing lesson track.
   - Content: lesson 1 survives the JSON round-trip, all pitches are within 36-83, and starter notes lie inside the clip.
2. `npm run typecheck` passes; `npm test` for the other workspaces still passes, untouched.
3. Manual, in the built app:
   a. "Lessons" opens the panel; lesson 1 is listed.
   b. Start shows a track "Lesson: Chords", 4 bars, with C-E-G in bar 1, in the normal piano roll.
   c. Check with bars 2-4 empty fails and the feedback names bar 2 and G major.
   d. After entering G, Am and F (any inversion), Check passes and "Apply it in the DAW" appears.
   e. Ctrl+Z after Start removes the track and the panel offers Restart without errors.
   f. After restarting the app, lesson 1 still shows as completed.
   g. The completed event is received by a test subscriber (logged to the dev console in M1).
   h. With a study session for code `P00`, the exported JSON contains one record with `checks`, `firstScore`, `finalScore`, `hintsShown` and `durationMs`. With no session, nothing is recorded.
4. `git diff --stat origin/develop` shows changes only in `apps/desktop/src/renderer/src/features/lessons/`,
   `docs/lessons/`, and a small `App.tsx` diff. No `package.json` or lockfile changes.

Then M2: lessons 2-4 (three more check kinds, same framework). M3: the study-mode UI polish, CSV export, pilot with 2-3
people, and any fix from R-3/R-8.

## Questions for you before I start

1. Is putting the exercise on a real track in the user's project (R-1) acceptable for now, or should I ask the core team for R1 first?
2. Who on Component 2 should agree the `LessonCompletedEvent` shape, and where does their code live?
3. Will pre/post tests and SUS be on paper or an offline form (A5), or do you want them in the app later?

## M1 status (2026-10-20)

Acceptance criteria from section g:

| # | Criterion | Result |
|---|---|---|
| 1 | `npm test -w apps/desktop` incl. new tests | **Done:** 70/70 (35 existing + 35 new: 13 chord-check cases, setup/reset/content, study log, completed event) |
| 2 | `npm run typecheck`; other workspaces untouched | **Done:** clean; shared 31/31 |
| 3a-3h | Checks in the built app | **Done except the export download.** Driven over CDP against the real Electron app (engine not built, so no audio): panel opens; Start creates "Lesson: Chords" (4 bars, C-E-G); Check on the starting state names bar 2 / G major; a wrong note in bar 3 gives "change F to E"; a correct progression passes and shows "Apply it in the DAW"; Ctrl+Z-style undo removes the track and the panel offers Start again; after an app restart lesson 1 is still completed and the completed event is persisted; with no study session nothing is logged. 12/12. **Not verified in the app:** the study session UI and the JSON/CSV download (assumption A2); both are covered by unit tests only. |
| 4 | Diff limited to `features/lessons/`, `docs/lessons/`, small `App.tsx` diff, no package changes | **Done:** `App.tsx` +10/-2 (import, one state, one button, one panel, one wrapper div for the side-by-side layout); no `package.json`/lockfile changes |

Deviation from the sketch in section a: `Exercise` has no `tempo` field and `CheckSpec` has only the `chordsPerBar` kind
for now (YAGNI until lessons 2-4). The completed event is recorded when Check first passes; the study record closes as
`passed` at the same moment.

## M2 status (2026-10-20)

Lessons 2-4 are in (`melody-1`, `rhythm-1`, `midi-editing-1`) with their three check kinds, all pure and unit tested
(28 new check tests; desktop total 110/110, shared 31/31, typecheck clean, renderer builds).

Driven in the real Electron app (engine not built, so silent) in an isolated profile, 10/10: each lesson fails from its
starting state with the intended message and passes after the correct edits. In lesson 4 the real **Quantize button**
fixed the late note; the other edits (and all notes in lessons 2 and 3) were applied through `dispatchBatch`, i.e. the
same ops the piano roll sends, not by mouse-drawing in the piano roll.

Deviations from sections a and c:
- `melodyInKey` score = in-key notes / max(notes, minNotes) rather than 0 below the minimum, so a 7-note tune scores 0.875.
  Pass is separate from score, so score 1 with a failed rule is possible.
- `matchTarget` takes a required `velocityRange` and reports four categories (timing, length, loudness, clean-up).
- `drumPattern` repeats its one-bar onsets for every bar of the clip and lists at most three missing positions.
- Lesson ids are `melody-1`, `rhythm-1`, `midi-editing-1`.

Still unverified: audio, the study-session UI, the JSON/CSV download (A2), and review of the wording by a music educator.

Test hygiene note: my first in-app runs wrote lesson progress into the machine's default app profile
(`%APPDATA%\@daw\desktop`) because `--user-data-dir` pointed at a folder that did not exist. I removed those keys
(`lessons.progress.v1`, `lessons.study.v1`, `probe`); the app recreates an empty `lessons.study.v1` on launch.
The DAW project data was never touched (`DAW_DATA_DIR` was a temp folder).

## Learn view redesign (2026-10-20)

The side panel was replaced by a full-page **Learn view** (opened by the studio's Lessons button, closed with Open Studio /
Back to Studio), following the supplied mockups: header with lesson icon, title and overall progress, Previous/Next lesson,
tabs (Lesson, Notes, Practice, Summary), a pinned Back/Next row, the **real piano roll** on the exercise clip beside the
lesson with a transport bar (play, time, tempo) and tool buttons, a step tracker, and a Need-help box with Replay.
Extras chosen by the owner: Notes tab, Summary tab, voice guidance with Replay, lesson search.

Code: `LearnView.tsx` (page, search, voice toggle), `LessonPage.tsx` (tabs, tracker, help), `PianoPane.tsx` (transport +
piano roll), `useExercise.ts` (all exercise behaviour, unchanged semantics), `learnModel.ts` (pure search/progress/speech text,
unit tested), `speech.ts`, `Icons.tsx`, `StudySection.tsx`. `LessonPanel.tsx` was removed (its logic moved into `useExercise.ts`
and `StudySection.tsx`). Lesson data gained optional `tryIt`/`tips` per explain step and a required `recap`; all lessons are now
`version: 2`. `App.tsx`: the Lessons button now sets one flag and, when set, App returns `<LearnView>` early (the studio
state in App, such as selected track and zoom, is kept). The earlier side-panel wrapper div was removed again, so the net App.tsx change is smaller.

Verified in the built app (13/13): view replaces the studio; Next/Start practice; failing then passing check; summary and 25 %
progress; notes persisted; search finds and opens a lesson; Open Studio returns to the DAW; no console errors. Screenshots were
checked by eye. **Not verified:** voice guidance (needs a Windows speech voice and ears), Play audio through the engine.

Privacy and ethics notes for the new features:
- **Notes** are free text typed by the learner. They are stored only in local storage (`lessons.notes.v1`), are never written to the
  study log, never exported and never sent anywhere. The Notes tab says so. If the ethics committee wants no free text at all
  on study machines, the Notes tab can be hidden for study sessions.
- **Voice guidance** uses the operating system's offline speech voices; no audio or text leaves the computer.
- The learner's last-opened lesson and the voice toggle are stored locally (`lessons.last.v1`, `lessons.voice.v1`).

## Seven-stage sub-lessons and the learning path (2026-10-20)

New curriculum (modules M0-M5, ~40 sub-lessons, from the course outline) and a seven-stage flow per sub-lesson:
**Hook, Watch, Try, Practice, Feedback, Quick check, Done.** Decisions agreed with the owner: (1) small additive hooks in the
shared `PianoRoll` (see below), (2) a lesson-only version of red wrong notes (Try stage, driven by the sub-lesson's own allowed
pitch classes; Component 2's general out-of-key overlay is separate and shares no code), (3) framework plus one finished
sub-lesson first, (4) migrate the four earlier lessons into the modules later (they stay under "Earlier lessons" meanwhile).

Built: the stage player (`SubLessonPage.tsx`), learning path screen (`LearningPath.tsx`, `curriculum.ts`), pure helpers
(`subLesson.ts`), the new `rootNotes` check, `useExercise` generalised (Try and Practice share one lesson track; Try does not
complete the lesson, Practice does), `audio.ts` `playEvents`, and **M3 "The root note"** end to end.

- **Watch:** the roll is read-only and draws the demonstration itself as guide notes (root marked), with sound (the built-in preview
  synth, so it works without the engine) and captions; optional voice reads the captions.
- **Try:** the real clip with dashed ghost notes; notes outside the allowed pitch classes turn red immediately; Next is locked until the check passes.
- **Practice:** a blank roll, no ghosts, Try notes cleared once on first entry; three hint levels: reminder text, highlighted rows, then the answer as ghost notes.
- **Tools taught so far:** the roll only offers the tools a sub-lesson lists (here Draw, Select, Delete) and hides the clipboard/Quantize strip.
- **Recording:** every Check and hint is logged by the existing study log with step ids `try`, `practice`, `quick-check` (only while a study session is on).

PianoRoll change (additive, optional `guide` prop; nothing changes when it is omitted): `GuideNote`/`PianoRollGuide` types,
dashed or solid guide notes drawn under the real notes, highlighted rows, a per-note colour map, a tool allow-list, hiding the
edit-strip commands and their shortcuts, and a read-only mode. Needs the piano-roll owner's OK before it is committed.

Verified in the built app, 29/29: path with six modules; planned items not clickable; Hook, Watch (captions advance, root marked),
Try (ghosts, red note, locked Next, real mouse click draws), Practice (blank, three hint levels, targeted feedback), quick check
(wrong then right), Done recap, completed event stored, path shows Done, search lists planned items as Soon, earlier lessons open,
no study records without a session, no console errors. Unit tests: 143 desktop (new: root check, sub-lesson data validity,
helpers, curriculum). Not verified: voice guidance, Watch sound quality (could not listen), the other modules (not written).

## M0 complete; shared practice track; more check kinds (2026-10-20)

- **All six M0 sub-lessons** are written (`content/m0.ts`), alongside M3 "The root note". M1, M2, the rest of M3, M4 and M5
  are still listed as planned.
- **One shared practice track.** Every sub-lesson now uses one track/clip (`Lesson: Practice`) that is reset to each stage's
  length and starting notes on first entry, instead of one track per lesson: the project holds at most 16 tracks and the
  path has about 40 sub-lessons. Consequence: the learner's result stays in that clip until the next sub-lesson starts.
- **Starting notes** for Try and Practice (something to move, fix or continue), optional edit-strip commands per stage,
  optional custom hint wording, and a "Next sub-lesson" button on Done.
- **New pure checks** (for the remaining modules too): `slots` (place exactly these notes, with optional pitch / time / length
  windows), `tempo` (reads the project tempo), `all` (combine checks), `chordsAtTicks` (chords at any beat), `inSet` (melody from a
  given note set), `chordSet` (free progression from a chord list, start/end/no-repeat rules), `chordToneMelody` (chord tones on
  strong beats), `repeatBars` (motif, repeat, variation); chords can require a `bass` note; the chord feedback now names the
  major/minor third mix-up ("E♭ makes it minor: raise it one row (a semitone) to E").
- **Automatic validation of every sub-lesson** (`allSubLessons.test.ts`): plain data, every stage written, guide notes in range,
  Try ghost passes and Try start does not, Practice answer passes and Practice start does not, hint levels, rows cover the
  answer, Watch steps sound, setup ops valid. 201 desktop tests.
- **In the built app, 36/36:** every written sub-lesson driven Hook → Watch → Try → Practice (3 hints) → Quick check (wrong,
  then right) → Done → next, path shows Done, no console errors. Not verified: sound quality, voice guidance.

## M1 complete (2026-10-20)

All six M1 Notes sub-lessons are written (`content/m1.ts`). Unit tests 250/250 (every sub-lesson validated); in the built
app every M1 sub-lesson was driven end to end, 31/31, no console errors. M2, the rest of M3, M4 and M5 remain planned.

## M3 complete (2026-10-20)

All eight M3 Chords sub-lessons (`content/m3.ts`), beginner wording. Chord feedback spells flats as ♭ and names the
major/minor third mix-up and wrong bottom notes. Unit tests 311/311; in the built app every M3 sub-lesson driven end to end,
41/41, no console errors. Remaining: M2, M4, M5.

## M2 complete (2026-10-20)

All seven M2 Scales and keys sub-lessons (`content/m2.ts`), beginner wording. Unit tests 368/368; in the built app every M2
sub-lesson driven end to end, 36/36, no console errors. Remaining: M4 Chord progressions, M5 Melody.

## M4 complete (2026-10-20)

All six M4 Chord progressions sub-lessons (`content/m4.ts`), beginner wording. Unit tests 417/417; in the built app every M4
sub-lesson driven end to end, 31/31, no console errors. Remaining: M5 Melody.

## M5 complete: the whole path is written (2026-10-20)

All five M5 Melody sub-lessons (`content/m5.ts`). Every outline item of M0-M5 now has content (39 sub-lessons); a test
enforces that. Unit tests 453/453 desktop, 31/31 shared. In the built app all 39 sub-lessons were driven end to end in one run (Hook, Watch, Try, Practice with 3 hints, Quick check, Done, next), 191/191 checks, no console errors.

## Fix: silent keys and notes in lessons (2026-10-21)

Report: no sound when clicking keys or drawing notes in Try/Practice, engine connected. Cause: the learner had muted the
"Lesson: Practice" track (and the earlier lesson tracks) in the studio; the engine is silent for a muted track, previews
included, and the lessons gave no sign of it. Fix: starting a lesson stage unmutes the lesson's own track (same batch as
the setup), and the lesson piano roll shows a banner with a one-click fix whenever its track cannot be heard (muted,
another track soloed, track or master fader at 0); pure helper `audibility.ts` with tests. Verified with the engine's own
meters in the built app, 7/7: muted preview is silent, Unmute brings it back, solo elsewhere is detected and cleared, and a
new stage unmutes by itself.


## Beginner and navigation improvements (2026-10-21)

1. **Beats and bars**: new L1 sub-lesson "Beats and bars"; beat numbers on the ruler; target positions highlighted on the
   roll and drawn in a "Where your notes go" beat counter, derived from each exercise's own check (`timeTargets`).
2. **Progress kept between the lessons and the studio**: the Learn view reopens on the same sub-lesson and stage; Try/Practice
   no longer reset the shared practice clip when it still holds that stage's notes; when another stage or sub-lesson used the
   clip in between, the learner's notes for this stage are saved and restored; hint level, passed stages, the quick-check
   answer and the piano-roll tool/zoom/grid are kept (`lessonState.ts`, local storage). Earlier lessons keep their tab/step.
   Cause of the old behaviour: the "first entry" flag lived in the page, so every visit reset the clip and started at Hook.
3. **L1-L6** display codes (internal ids unchanged).
4. Path **Start** chip is white with dark text; **Done** stays green.
5. **Replay** never overlaps: one speech controller (generation counter; waits until the speech engine is idle before
   speaking) used by every voice line.
6. Hook **Hear it** speaks the Hook; **Play example** plays the notes.
7. **Watch** lights each key while it sounds and scrolls the roll so the key is visible (follows each note when a phrase
   spans more than the view). Implemented with an ease-out scroll driven by animation frames (Chromium's smooth scrolling
   was cancelled by the roll's re-renders), jumping directly when the window is hidden.

PianoRoll additions (optional `guide` fields, no change when unused): `columns`, `countBeats`, `activeKeys`, `focus`.
Verified in the built app: 27/27 requirement checks (speech spied for overlap, Web Audio spied for piano notes, key
visibility measured, notes compared after studio round-trip, other sub-lesson and app restart).

## Main Lessons page (2026-10-21)

The Learn view now opens on a main **Lessons** page ("What would you like to learn?") with four cards in a two-column
grid (one column below 768 px): **Piano**, **Kick Drums**, **Mixing**, **DAW Features** (`mainLessons.ts` holds the card
data, `LessonsHome.tsx` the page). The Learn view gained a sidebar (Studio, Learn; Home, Collaborate, Projects, Settings
and Log out are shown disabled with "Soon" because those features do not exist in this app) and a header with the
Waveform Studio logo (back to the Lessons page), a disabled notifications bell and the profile (study participant code
or "Guest").

- **Piano** opens the existing L1-L6 learning path unchanged, with an "All lessons" breadcrumb back. Its card lists the
  six module titles and shows the learner's progress (done of built sub-lessons).
- **Kick Drums, Mixing, DAW Features** have no lesson pages yet. Each opens a "Coming soon" page (`CollectionPage.tsx`)
  with its planned topics and links to existing related lessons (Kick → Rhythm; DAW Features → L1 "What you see" and
  MIDI editing). To connect a real collection later: set `available: true` and route its id in `LearnView`'s `openMain`.
- Navigation is state-based like the rest of the Learn view (`LearnViewState` gained `lessons`, `collection`); the last
  view is restored after visiting the studio. Every card and button is a real `<button>`, keyboard reachable, with
  visible focus rings and labels.

Verified in the built app: 27/27 page checks (layout at 1500/1024/700 px, card order, Piano → L1-L6 → back, keyboard
Enter, a sub-lesson's Try check, the three not-available pages and their related lessons, studio round-trip, no console
errors) and the full 39 sub-lesson regression (196/196).

## Fix: finished sub-lessons can be done again (2026-10-21)

Reopening a finished sub-lesson used to land on the Done screen with the quick check answered (Check answer disabled),
every hint used (Hint disabled) and the old answer still in Practice; sub-lessons finished before progress was saved had
every stage after Hook locked. Now opening a finished sub-lesson (from the path, search, "Next" or a related link) starts
a new run-through from Hook (`lessonState.replaySub`: quick check unanswered, hints hidden, Try/Practice back to their
starting notes), and a finished sub-lesson keeps every stage open with Next always available. It stays Done on the path.
Verified: 15/15 replay checks (including after an app restart and with no saved progress), 27/27 page checks, 196/196
regression.

## Merge of develop (Chamath's M4: piano roll UI, unlocks, sample library) (2026-10-21)

`origin/develop` (e2fbdb0) merged into feature/learning. Conflicts:
- `App.tsx`: kept Chamath's toolbar; the Lessons button sits before Sounds.
- `PianoRoll.tsx`: kept Chamath's UI (PianoKeys, window buttons, key help, red out-of-key notes, unlock locks) and
  re-applied the lesson `guide` options. Additive changes: the window-button props are optional (the lessons' roll has
  none), the lesson roll is never locked by beginner-mode unlocks (it is where those features are learned; the lesson
  limits its own tools), a guide note colour wins over the red out-of-key colour, and `PianoKeys` gained `activeKeys`.
- Rebuilt the engine (sample playback). Verified: all unit tests (shared, sounds, desktop), Chamath's pianoroll-ui
  16/16, m4 50/50 and samples 73/73, the lesson regression 196/196.

## Kick Drums course: M12 and M13 in the Piano lesson format (2026-10-21)

The Kick Drums card opens its own course (`studio/`): **K1 Sounds and beats** (M12.1-M12.6) and **K2 Build-up and
drop** (M13.1-M13.6), ids as in CURRICULUM.md. Each lesson uses the same template as the Piano sub-lessons:

- Six stages (Hook, Watch, Try, Practice, Quick check, Done), Lesson/Notes tabs, the progress tracker, Need help with
  Replay, voice guidance; stages unlock in order and a finished lesson can be replayed (`StudioLessonPage`).
- All practical work happens inside the lesson, in the right-hand workspace (`StudioPane`), never in the main DAW: a
  sound browser (chips, search, click or arrow keys to listen, drag to use) and an arrangement of the lesson's own tracks
  (drop sounds, move clips with snap, change a clip's length by dragging its right edge (snapped, at least one beat,
  one Undo step), Duplicate, Delete, mute, solo, Fit, BPM, grid 1 bar-1/32 (starts at 1/4 so clips move by beats; the
  Grid and Snap choice is remembered for every lesson), playhead, Play). Lessons
  that edit notes (M13.3, M13.4, M13.6) open the selected clip in the real piano roll below it. It edits the real
  project through the shared ops, so Undo and the engine work as everywhere else.
- Hook: explanation, Hear it, Play example (the sounds, lit in the browser). Watch: captions step by step, lighting
  chips, sounds, bars and dashed targets, playing the example song's bars. Try: a small guided step with the target
  shown. Practice: the full task from the table, three hints (the third shows the target).
- Each Try/Practice starts from its own setup the first time it opens: a clear arrangement, a 90 BPM loop (M12.6) or the
  example song (three lesson tracks over 24 bars in 8-bar clips; `studio/exampleSong.ts`). Start over sets it up again.
- Only lesson tracks (`lesson-k-*`, `lesson-song-*`) are shown and checked; the learner's own tracks are never touched.
- **Every lesson has its own workspace** (`studio/space.ts`): opening a lesson saves the previous lesson's tracks (with
  its stage setup and listening) and takes them out of the song, then brings back the tracks this lesson had last time.
  Only the open lesson's tracks are in the project, because a song holds at most 16 tracks. Saved in local storage, so
  it survives restarts.
- Checks (`studio/checks.ts`, pure, unit tested) read the project and the library categories; every message names the
  track and bar. Passing Practice records the lesson (Done ticks, `lesson-completed`) and calls
  `window.daw.completeLesson("M12.x")` for the DAW's progress and unlocks.
- The lesson workspace is not locked by beginner mode (like the lessons' piano roll).

Verified: 27 unit tests for content, Try/Practice checks, setups, the lesson-only view and workspace switching; 36/36
in the built app (including M12.2 -> M12.4 -> M12.2 -> M12.4 keeping each lesson's own tracks)
(template parts, no redirect, Hook/Watch, M12.1 with clicks in the lesson's sound list, M12.2 real drag-and-drop and
dragging a clip, M12.4 grid 1/4 vs 1 bar, M13.2 example song, Watch, deleting clips, M13.3 riser drop and the notes
editor, DAW `completedLessons`).

## Drum sequencer course (2026-10-22)

New main lesson card **Drum sequencer** (third on the Lessons page, rose accent), its own course with ten lessons on
the DAW's step sequencer: **S1 Kick basics** (M14.1-M14.5) and **S2 Shaping the beat** (M14.6-M14.10). Ids continue the
curriculum after the Kick Drums course; passing Practice calls `window.daw.completeLesson("M14.x")`.

- Same template as Kick Drums and Piano (Hook, Watch, Try, Practice, Quick check, Done; Notes; tracker; Replay), and
  every lesson has its own workspace (its drum track is saved and swapped back in).
- Workspace (`studio/SequencerPane.tsx`): Chamath's `StepSequencer` on the lesson's own drum track (`lesson-k-seq`),
  with Play, Click (metronome, switched off when the lesson closes), TAP, the position readout, BPM, Loop and his LOOP
  strip (`SectionRuler`). Hook and Watch show demonstration pads that light and play the pattern (Web Audio).
- Pads: one bar is 16 pads, pad n starts at (n - 1) x 240 ticks, beats are pads 1, 5, 9, 13; kick 36 (35 counts as a
  kick), snare 38. Checks in `studio/seqChecks.ts` use the hint wording from the brief.
- Click and TAP cannot be read from the project, so M14.1 and M14.3 have "Tell me when you did it" tick boxes; Check
  passes only with the pattern right and the boxes ticked.
- Loop (M14.9) and Ramp (M14.10) work in the lesson workspace; in the Studio they unlock with M8.2 and M7.4 (the hook
  text says so).
- Sample kicks (sound browser) stay in the Kick Drums course; this course only uses the built-in drum track.

Verified: 12 unit tests (every lesson's setup, each check passing and failing with the right hint, the Piano practice
track untouched); 29/29 in the built app with real mouse input (pad click, Shift+click accent, Copy to all bars, bar
buttons, Loop and a two-bar drag in the LOOP strip, row select + Ramp Build up, TAP tempo, tick boxes, own workspace
per lesson, card progress, DAW `completedLessons`).
