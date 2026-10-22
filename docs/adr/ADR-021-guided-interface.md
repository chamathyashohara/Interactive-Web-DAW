# ADR-021: A guided "Start here" view over the existing panels, and one style sheet for both apps

- **Status:** Implemented in Stage 10 (19 Oct 2026). Awaiting the researcher's review.
- **Builds on:** ADR-004 (Qt 6 Widgets), ADR-001 (one shared UI library), and every panel from Stages 4–11.
- **Traces:** APP-01…03, SES-04…08, STA-01/02/04, REC-03, XFER-05, BRIEF (Stage 10), D-88…D-93

## Context
The Stage 10 brief asks for interfaces a producer and a performer can actually use, and it opens
with a warning: do not replace working engine code to restructure the interface.

By Stage 11 one window held, stacked in a single tab: a role banner, a status box, the session
panel (interface list, port, start lead, pairing, readiness checklist for both PCs, per-PC take
rows, take copies), the live-audio panel, and the audio panel (devices, meters, monitoring,
folders, take list, recovery). Everything a researcher needs for evidence, and far too much for a
first-time user: nothing says what to do first, and most controls are irrelevant until a session
exists.

The researcher also supplied a reference image of a consumer music app (cards, large friendly
buttons, one idea per block). Its *features* are not ours — there is no MIDI editor, no sample
library, no plugins and no phone app in this project, and no control may suggest otherwise — but
its *simplicity* is exactly what the brief asks for.

## Decision
- **Add a view, keep every control.** A new first tab, **"Start here"**, is the default. The old
  single tab becomes **"All controls"**, unchanged, and **Diagnostics** stays. Nothing was
  deleted, so the evidence the research needs is still one click away.
- **The guided view owns no state and no engine code** (`simple_panel.*`). It is a control
  surface:
  - every button calls a small `ui_*` method that drives the **existing widget** on the audio or
    session panel (`consent_check_->setChecked(...)`, `record()`, …), never the controller
    directly, so the two views can never disagree;
  - everything it displays is read from `SessionController::snapshot()` and the audio panel on a
    150 ms timer, so what is on screen is the engine's state, not a memory of a button press.
- **Four numbered steps**, each a card with a badge, a title, one plain-English line of status and
  only the controls for that step:
  1. **Sound** - turn on the microphone and the headphones, with a live level bar;
  2. **Connect the two PCs** - producer: one *Start the session* button, then the address and the
     pairing code in large type; performer: two boxes and *Join*;
  3. **Record** - the producer's Record/Stop, and one line per PC;
  4. **The performer's recording on the producer's PC** - request a copy (producer) or allow
     copies (performer), with the transfer state in words.
- **A step badge shows `OK` only when that step is really finished**, computed from the snapshot
  (device open, link Connected, take finalised, copy VERIFIED), never from a click.
- **Every disabled button explains itself** in its tooltip and in the step's status line, in the
  user's words: "Not available: the performer has not allowed copies yet".
- **One application style sheet** (`theme.*`): fixed light colours, cards, rounded controls, one
  accent. Fixed rather than following the system theme, because screenshots go into test reports
  and the status colours must have known contrast.
- **Status is never colour alone.** Each pill carries a symbol and a word as well
  (`REC  RECORDING`, `OK  Ready`, `X  connection lost`), and the step badges use `OK` / a number.
- **The light look is forced, not inherited.** The apps set the **Fusion** style and a light
  **palette** before the style sheet. The native Windows style follows the system dark/light
  setting, so on a PC in dark mode every widget the style sheet does not colour explicitly (check
  boxes, line edits, menus) drew white text on these white cards. The application font is set with
  `QApplication::setFont` rather than a `QWidget` style-sheet rule.
- **Check-box indicators are shipped as images** (`libs/ui_common/resources/check_*.svg`, in a Qt
  resource). A style-sheet indicator *without* an image is a blank square with no tick, and the
  consent boxes must be unmistakable in both states.

## Verified (19 Oct 2026, evidence `2026-10-19_devpc_stage10_gui_runs.txt`)
The two GUI applications were driven end to end through **Windows UI Automation**, the same
interface a screen reader uses, so every control pressed is a real control with an accessible
name. Both apps ran on one PC.

- Sound on, session created, performer joined, both PCs Ready, take recorded and stopped, copy
  requested and **VERIFIED**: every step card reached `OK` in order.
- The producer showed RECORDING only after the performer's app reported its own start.
- Take 1: 336 060 frames (producer) and 336 059 (performer), 7.0 s, 48 kHz, 2 ch. The copy on the
  producer side is **byte-identical** to the performer's original (independent SHA-256), and both
  pass the structural reader.
- 18 controls on the producer window are keyboard-focusable and all expose accessible names.
- **Two faults were found by this test and fixed:** consent ticked before a session existed was
  discarded (the guided view mirrored a controller that did not exist yet); and the interface
  picker could choose a `169.254.x` link-local address, which no second PC can ever reach.

## Consequences and limits
- **Two PCs:** still not run. This stage does not close that gap.
- **No usability study.** "Easier" is a design claim here, not a measured result: no first-time
  user has been observed using it, and the brief's acceptance criteria about beginners cannot be
  judged from one automated run.
- **Keyboard:** focus order and names were checked programmatically, not by someone working
  through the app with only a keyboard, and no screen reader was run.
- **Light theme only.** A PC in dark mode still gets this light window.
- **The live-audio panel is not in the guided view.** Talkback has no step yet; it runs with its
  defaults and is configured in "All controls".
- **The reference design's features were deliberately not copied**: no waveform display, no MIDI,
  no sample browser and no plugin area, because the engine has none of them and a button that
  does nothing would be a false claim.
