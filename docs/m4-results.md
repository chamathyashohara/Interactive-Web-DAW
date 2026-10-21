# Milestone 4 results: beginner layer foundation

Date: 2026-10-21. Hardware: 11th Gen Intel Core i5-11400H, Focusrite USB output, Windows 11. No engine (C++) changes in this milestone.

## What it adds

1. **Project key** (`project.key`: tonic 0-11 + major/minor, or none). Saved with the project, undoable, old projects open with no key.
2. **Key help in the piano roll** (melodic tracks only): scale rows are lit and the root glows, rows outside the key are dimmed, the on-screen keyboard
   marks the same keys, notes outside the key turn red with a plain-English reason ("F♯ is not in C major. Try F or G."), and **Fix** moves each red
   note to the nearest in-key note as one undo step. A toggle hides the help.
3. **Feature unlock registry** (`packages/shared/src/features.ts`, 18 features): locked controls stay visible but disabled with a padlock and a
   tooltip naming the lesson that unlocks them; keyboard shortcuts obey the locks too.
4. **Learner progress** (per user, never in the project): completed lessons and Beginner mode, saved atomically on disk, with an anonymous event log.
5. **Lesson API**: `window.daw.completeLesson("M2.6")` (idempotent, validated), `getProgress`, `onProgress`, `setProgressMode`, `resetProgress`.
   The DAW reacts at once and shows an "Unlocked: ..." toast. See `docs/lessons/INTEGRATION.md`.
6. **Features panel**: what is locked and why, the Beginner-mode switch, and (development builds only) a tool to complete or reset lessons.

## Design decisions

* **Key per project** (not per clip): simplest for beginners and matches how songs are described.
* **Locked features are visible but disabled**, so learners see what they are working towards.
* **Default mode is "all features unlocked"** until the lessons exist; Beginner mode is one switch (or `DAW_PROGRESS_MODE=beginner`). Flipping the default is one line in `main/index.ts`.
* **Starter set** that is never locked: play/stop/tempo, Draw, Delete, Undo/Redo.
* Out-of-key detection uses pitch classes only (octave does not matter), so it is a pure function shared with the lessons' checkers.

## Automated results

| Suite | Result |
|---|---|
| Shared: model, ops, theory (scales, in/out of key, nearest note, names), key op (set/undo/idempotent/migrate), feature registry | 55 / 55 |
| Desktop: storage/recovery, batches, snapshot, editing logic incl. Fix, progress store (persist, idempotent, corrupt file, event log) | 45 / 45 |
| M1 / M2 / M3 end-to-end regression (all features unlocked, the default) | 16 / 35 / 35 |
| Piano roll window and keys (`e2e/pianoroll-ui.mjs`) | 16 / 16 |
| **M4 end-to-end (`e2e/m4.mjs`)**: key and red notes (15 checks), unlocking and persistence (35 checks) | **50 / 50** |

Verified on the running app with real mouse and keyboard input, including: 4 root + 24 other scale + 20 dimmed rows in C major; F#4 red and E4 not; the
exact message text; Fix then one Ctrl+Z; G major makes F# fine and A minor makes it red again; drum tracks never marked; locked tools ignore their shortcut
keys (P, S, M, C) and Ctrl+A / Ctrl+D; dragging a note with Draw does nothing until Select is unlocked; unlocking through the lesson API works without a
restart; rejected lesson ids; idempotent completion; progress and Beginner mode survive a force-kill.

## Known limitations (not hidden)

* The lessons themselves do not exist yet; the DAW side is ready for them (and has a developer tool to simulate completions).
* Gating is a **teaching aid, not security**: it only stops the user interface; nothing prevents someone editing the progress file.
* Key help recognises only major and natural minor (no modes such as Dorian, no key changes inside a song).
* Out-of-key is per note start pitch; passing tones and chromatic notes are all flagged (intended for beginners; the toggle hides it).
* No interaction tracking beyond lesson completions yet (planned next), and no guided "make a song" checklist yet.
* Locking "Edit clips and song length" leaves the first clip editable; a learner in Beginner mode works inside one 4-bar clip per track until M8.2.
