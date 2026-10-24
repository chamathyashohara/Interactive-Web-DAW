# Novelty of the Beginner-Friendly Adaptive DAW

*Component 2, research project J26-IM-303. This note is written for the evaluation panel: it states the novelty claim, places the
component against existing tools, and points to the evidence. Competitor rows reflect the tools as generally known; verify the
specifics against current versions before the defense, as these products change.*

## The claim, in one sentence

> A **single system** in which completing music-theory lessons **unlocks the features of a real, exportable DAW** (mastery-gated
> progression) **and** the DAW gives **in-context theory feedback while you compose** — marking out-of-key notes red, naming the nearest
> in-key notes to use instead, and offering a one-click fix — with the learner's progress and mistakes **measured** to show the approach works.

No existing tool combines those three things: *make a real song*, *features gated by mastered lessons*, and *theory feedback on your
own music*. Each category of tool has at most two.

## Comparison

Legend: ✓ present · ◐ partial / indirect · ✗ absent.

| Capability | **This DAW** | Chrome Music Lab / Groove Pizza | GarageBand | Soundtrap (Edu) | FL Studio / Ableton | Yousician / Melodics |
|---|:--:|:--:|:--:|:--:|:--:|:--:|
| Make a real, multi-track, **exportable** song | ✓ | ✗ (toy loops) | ✓ | ✓ | ✓ | ✗ (play exercises) |
| **Features unlock as lessons are mastered** | ✓ | ✗ | ✗ | ✗ | ✗ | ◐ (exercises gate exercises, not a DAW) |
| **In-context theory feedback on your composition** (flags the note, suggests the fix) | ✓ | ✗ | ✗ | ✗ | ◐ (scale highlight only) | ◐ (feedback on playing, not composing) |
| Lessons and the tool are **one system** (lessons drive the actual DAW) | ✓ | ✗ | ◐ (lessons separate from the DAW) | ◐ (templates/lessons beside the DAW) | ✗ | ✗ |
| **Adapts** to the learner (beginner vs full mode) | ✓ | ✗ | ✗ | ◐ | ✗ | ✓ (difficulty) |
| Teaches **arrangement & production** (energy, build-ups, drops), not just notes | ✓ | ✗ | ◐ | ◐ | ✗ | ✗ |
| Built-in, reason-giving **mistake correction** (red notes + one-click fix) | ✓ | ✗ | ✗ | ✗ | ✗ | ◐ |
| Progress & mistakes **measured** for evaluation | ✓ | ✗ | ✗ | ◐ | ✗ | ◐ (internal) |
| Runs **locally**, audio stays on device | ✓ | ✗ (web) | ✓ | ✗ (web) | ✓ | ◐ |
| Free to the learner | ✓ | ✓ | ◐ (bundled) | ✗ (subscription) | ✗ | ✗ |

## How to read it

Three families of tools exist, and each leaves a gap this component fills:

- **Beginner / web toys** (Chrome Music Lab, Groove Pizza): approachable, but you make toys not songs, there is no progression, and
  almost no theory is taught. You outgrow them in an afternoon.
- **Real DAWs** (GarageBand, FL Studio, Ableton, Soundtrap): powerful and exportable, but they assume you already know music. They
  present every feature at once and give no feedback on *your* musical choices. (Ableton/FL highlight scale notes — useful, but they
  never tell you *why* a note is wrong or stop you drowning in features.)
- **Instrument-learning apps** (Yousician, Melodics): these *do* have mastery-based progression and real-time feedback — but on
  **playing graded exercises**, not on **creating and exporting your own music**. You never build a song.

This component is the one place where **you create your own song in a real DAW, the studio grows with you as you master theory, and the
tool teaches and corrects your actual musical decisions as you make them.** That intersection is the contribution.

## Why the panel can believe the ✓s in our column

Every claimed capability is implemented and, for the pedagogical ones, **instrumented**, so the novelty is demonstrated, not asserted:

- **Mastery-gated unlocking:** a feature registry maps 25 DAW features to the lessons that unlock them; completing a lesson immediately
  unlocks its features in the running app (`packages/shared/src/features.ts`, covered by tests and the M4 end-to-end suite).
- **In-context theory feedback:** out-of-key notes render red with a specific, actionable message (e.g. "D♯ is not in C major. Try D or E.")
  and a one-click *Fix* that moves them to the nearest in-key note. This is feedback on *your own composition*, which no DAW gives.
- **Measured evidence (the differentiator a panel will press on):** the app records, per learner and with consent, the out-of-key rate
  over the first vs. the last third of their notes (does accuracy improve with practice?), the time to correct a red note, how often a
  learner reaches for a still-locked feature (readiness), and how long after a lesson unlocks a feature it is first used (adoption). It
  exports to JSON/CSV with a multi-participant analysis script (`docs/evaluation-data.md`). The comparison of **beginner mode vs
  all-features mode** is built into these metrics, which is the controlled contrast the evaluation needs.

## Honest limitations (so they are not used against you)

- The comparison is on **design/capability**, not a head-to-head user study against those products; the user study evaluates *this*
  tool's beginner mode vs. its own all-features mode, not vs. GarageBand.
- Competitors evolve — scale/key helpers in particular. The novelty is the **combination and the lesson↔DAW coupling**, which survives
  a competitor adding any single row, not any one feature in isolation.
- Audio-plugin (VST3) support is partial (in progress) and is a *capability* bonus, not part of the pedagogical novelty.
- The pedagogical claims rest on the planned participant study; the infrastructure to measure them is done, the data collection is the
  remaining step.

## One line for the slide

> *Existing tools let you **create** (DAWs), or **teach** (learning apps), or stay **simple** (web toys) — this is the first to do all
> three at once, by making mastered theory lessons unlock a real DAW that corrects your own music as you write it, with the learning
> effect measured.*
