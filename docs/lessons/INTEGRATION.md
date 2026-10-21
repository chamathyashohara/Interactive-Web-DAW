# How the lessons plug into the DAW (Component 1 <-> Component 2)

This is the contract between the learning module and the beginner-friendly DAW. It exists in the code today and is covered by tests,
so you can build against it now. Read it with `CURRICULUM.md` (the content) and `LESSON-FORMAT.md` (the lesson data format).

## 1. What the lessons must do: report completed lessons

```ts
const r = await window.daw.completeLesson("M2.6");
// r = { ok: true, progress: { mode, completedLessons }, newlyCompleted: true }   (or { ok: false, reason })
```

* Call it **once a sub-lesson is passed** (your `lesson.completed` event). Use the ids from `CURRICULUM.md` (`M<module>.<sub>`, e.g. `M0.4`, `M10.3`).
* It is **idempotent**: calling it again for the same lesson changes nothing (`newlyCompleted: false`).
* Anything that is not a lesson id (`"lesson-1"`, `""`, `"../x"`) is rejected with `ok: false`.
* The DAW reacts immediately: the controls that lesson unlocks become usable, and a toast says what was unlocked. No restart, no reload.
* Progress is saved on disk per user (`progress.json`) with an anonymous event log (`progress-events.ndjson`: lesson id, mode changes, timestamp).
  Progress is **not** part of a song, so it is never saved in the project or synced to collaborators.

## 2. What the lessons can read

```ts
const progress = await window.daw.getProgress();      // { mode: "beginner" | "all", completedLessons: string[] }
const off = window.daw.onProgress((p) => { /* progress changed */ });   // returns an unsubscribe function
const { project } = await window.daw.getInitial();     // the user's song, read-only for lessons
window.daw.onProject(({ project }) => { /* the song changed */ });
```

Use `completedLessons` to show "done" ticks and to decide which lesson is next. Lessons must **not** edit the user's song while teaching;
practice happens in the lesson's own piano roll (see `LESSON-FORMAT.md` section 7).

## 3. The unlock registry (owned by the DAW side)

`packages/shared/src/features.ts` lists every gated feature and the lesson that unlocks it. You do not edit it; ask Chamath to change it.

| Feature | Unlocked by | Feature | Unlocked by |
|---|---|---|---|
| Play/stop/tempo, Draw, Delete, Undo/Redo | always on | Drum tracks | M6.2 |
| Select, move, resize | M0.4 | Edit clips and song length | M8.2 |
| Snap and grid size | M0.4 | Mixer, volume, pan | M9.2 |
| Copy / paste / duplicate | M0.5 | Mute and solo tracks | M9.4 |
| Key and scale help | M2.6 | Export WAV | M10.3 |
| More than one track | M4.6 | Paint tool, Quantize | M6.4 |
| Mute-note tool | M7.4 | Slice tool | M8.4 |

Helpers you can import from `@daw/shared` (pure, tested):

```ts
import { FEATURES, LESSON_TITLES, unlockedByLesson, isLessonId } from "@daw/shared";
unlockedByLesson("M0.4")   // -> the features that lesson unlocks (for a "You unlocked ..." screen)
```

### Beginner mode vs. "all features"
* `mode: "all"` (today's default): every feature is available, so the team can work without finishing lessons.
* `mode: "beginner"`: features stay locked until their lesson is completed. Users switch it in **Features -> Beginner mode**;
  `window.daw.setProgressMode("beginner" | "all")` does the same. When the lessons are ready, the default will be switched to beginner in one line (`main/index.ts`).
* Start the app already in beginner mode for testing: set the environment variable `DAW_PROGRESS_MODE=beginner`.

## 4. Testing your lessons against the DAW

1. Run the app (`npm start`), open **Features**. In development builds there is a **Developer tools** box: pick a lesson and press **Complete** (or **Reset**).
2. Switch **Beginner mode** on to see the locks, then complete lessons from your player and watch controls unlock.
3. In code, call `window.daw.resetProgress()` between test runs.
4. The DAW's own automated tests for all of this are in `apps/desktop/e2e/m4.mjs` (run it to see the expected behaviour).

## 5. Music-theory helpers you can reuse (pure functions, unit-tested)

Exported from `@daw/shared` (`packages/shared/src/theory.ts`). Please use them instead of writing your own so the DAW's red out-of-key notes and your checkers always agree:

```ts
pitchClass(60)                     // 0  (C=0 ... B=11)
noteName(66, key?)                 // "F♯"  (spelled to suit the key; flats in flat keys)
scalePitchClasses({ tonic: 0, mode: "major" })   // [0,2,4,5,7,9,11]
isInKey(66, { tonic: 0, mode: "major" })         // false
nearestInKey(66, key)              // 65
outOfKeyMessage(66, key)           // "F♯ is not in C major. Try F or G."
keyLabel({ tonic: 9, mode: "minor" })            // "A minor"
```

The project key (`project.key`, `null` when none) is set with `window.daw.dispatch({ type: "setKey", key: { tonic, mode } })`.
Lessons that need chords or intervals can add helpers to `features/lessons/theory/` (your folder) or propose additions to `theory.ts` to Chamath.

## 6. Still to come (not available yet)

* Opening the DAW with a **prepared project** for the "Use it in the DAW" task (needs a small main-process API; ask Chamath).
* A lesson-scratch project for demo playback with proper timing (see `LESSON-FORMAT.md` section 7).
* Interaction tracking beyond lesson completions (planned for the next milestone).
