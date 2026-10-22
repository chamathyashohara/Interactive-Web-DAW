# Evaluation data (for the research)

Step 3 of the plan: the DAW records how a learner uses it, so the study can show whether the beginner features help. It is the measured
evidence for the novelty claim (mastery-gated unlocking plus in-context theory feedback in a real DAW). Everything is **local, anonymous and
opt-in**: nothing is recorded until the participant agrees in **Features -> Study data** and types a participant code (not a name).

## What is recorded

Short events appended to `research-events.ndjson` (beside `progress.json`, never inside a project). Each carries `t` (name), `at` (ms),
`s` (session) and `mode` (the study condition at that moment: `beginner` = features gated by lessons, `all` = everything available).

| Event | Fields | Meaning |
| --- | --- | --- |
| `note.added` | `inKey` (true/false/null), `kind` | a note was placed; `inKey` only when a key is set and the track is a synth |
| `note.corrected` | `ms`, `via` (`manual`/`fix`/`removed`) | a red (out-of-key) note was fixed, and how long it had been red |
| `edit` | `op`, `n`, `fields?`, `kind?` | a kind of edit and how many at once |
| `history` | `kind` (`undo`/`redo`) | undo or redo |
| `ui.tool` / `ui.panel` / `ui.view` / `ui.keyHelp` / `ui.ramp` / `ui.export` | which tool, panel, etc. | interface use |
| `ui.locked` | `lesson` | a locked control was pressed (which lesson it waits for) |
| `lesson.completed`, `mode.changed` | from the lesson log | merged in on export |
| `project.summary` | counts only | the song's size at a checkpoint |

**What is never recorded:** names, file paths, pitches, positions, note or track names, or any other musical content. Only "was this note in
the key". The log is validated field by field: reserved keys are dropped, strings are capped, and only plain short values are kept
(`telemetryStore.ts`). The e2e test greps the raw log to prove no pitch, tick, track or clip name appears.

## Consent and control

* **Start:** tick the agreement box and type a code (2-24 of letters, digits, `-`, `_`). A code that looks like a name or email is refused.
  The draft wording in the panel is a placeholder for the ethics-approved consent text (see `docs/lessons/LESSON-FORMAT.md` section 5).
* A red **Recording <code>** chip stays in the status bar the whole time, so the participant always knows.
* **Stop recording** pauses it; **Stop and delete everything** erases the local log. Both are one click in the panel.

## Export and analysis

* **Export JSON:** one file with every event (lesson log merged in, in time order) and the computed metrics.
* **Export CSV:** two spreadsheet files, `-events.csv` (one row per event, a column per field) and `-metrics.csv` (name, value).
* `scripts/analyze-telemetry.mjs study-*.json` combines several participants' exports into one results table plus summary rows:
  per-participant metrics, the mean/median, the **practice effect** (out-of-key rate over the first vs the last third of each learner's
  notes, paired), and the **unlock-to-first-use delay** per gated feature.

## Metrics (`packages/shared/src/research.ts`)

Pure, tested functions turn the events into numbers:

* **active time** (gaps under a minute), **edits per active minute**
* **out-of-key rate**, and the **first-third vs last-third** rate (does accuracy improve with practice?)
* **corrected share** and **median time to correct** a red note, split by how (by hand, the Fix button, or deleting)
* **undo/redo**, **locked-control attempts** by lesson (a sign the learner is ready for a feature)
* **feature adoption**: for every feature a completed lesson unlocked, how long until it was first used
* every metric is also split by study condition (`beginner` vs `all`), for the comparison the evaluation needs

## Tests

* `packages/shared/test/research.test.ts` (metrics, CSV).
* `apps/desktop/src/main/telemetry/telemetry.test.ts` (consent gate, no content in the log, correction timing, export merge).
* `apps/desktop/e2e/research.mjs` (21 checks: the real consent flow, recording, the privacy grep on the raw log, locked-control capture, JSON/CSV
  export, the analysis script, and that "Stop and delete" erases everything).

## Not done

The pre-test/post-test scores and the SUS questionnaire are separate records (paper or a form), to be joined to these exports by participant code
during analysis; they are not collected inside the app.
