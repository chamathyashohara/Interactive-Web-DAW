# Project system (many named projects)

The DAW used to keep one hidden, autosaved project. It now manages **many named projects**, each its own thing you can create,
open, copy, rename and delete — from the **Project menu** at the top-left of the window (the DAW's name is the menu). This is also
what the collaboration layer needs: a project with a stable identity it can share into a session.

## For the user

The **Project menu** (click the project name, next to **CollabDAW**), FL-style:

- **New project** — a fresh, empty project.
- **Open…** (Ctrl+O) — open a `.daw` project file the user picks.
- **Save** (Ctrl+S) — writes the project to its `.daw` file; the first time it asks for a name and place, after that it saves there
  again without asking. The project takes the file's name.
- **Save as…** (Ctrl+Shift+S) — save to a new `.daw` file.
- **Import MIDI…** — turn a `.mid` file into a new project (one track per MIDI track, the drum channel becomes a drum track, the
  tempo and every note carried over).
- **Export…** (Ctrl+E) — the export settings window (WAV quality, tail length), then render to a file.
- **Recent projects** — the list, most recently opened first; click one to switch. Each has a ✕ to delete (✕ then *Delete?*). The
  only remaining project cannot be deleted.

Switching or opening reloads the whole DAW onto that project. Every project also autosaves continuously underneath (the crash-safe
snapshot+journal), so nothing is lost on a switch or a crash even before the user saves to a file.

## How it is stored

```
<userData>/projects/
  index.json            names, created/modified times, recently-opened order
  <project-id>/         one folder per project
    snapshot.json       the durable snapshot + journal (unchanged format)
    journal.ndjson
```

- **`Workspace`** (`apps/desktop/src/main/project/workspace.ts`) owns identity and metadata: list, create, open (hands out a
  `LocalStore` for the folder), rename, duplicate (Save As), delete, and the recently-opened order. Pure Node, unit-tested.
- **`ProjectService.load(store)`** switches the live editor to another project's store and clears undo/redo; `flush()` writes the
  latest edits to disk before a copy; `setName()` renames without putting it in the undo history.
- The existing single project (the old `projects/default` folder) is **adopted automatically**, and the index is rebuilt from the
  folders if `index.json` is ever lost — so no project is stranded by the change.

## Compatibility and tests

- The fixed-directory mode used by the end-to-end tests (`DAW_DATA_DIR`) is unchanged, so all existing suites still pass. In that
  mode the active project is shown in the menu even though it lives outside the workspace.
- Normal runs use the workspace under `<userData>/projects` (override with `DAW_PROJECTS_DIR`).
- Tests: `workspace.test.ts` (10, pure Node) and `apps/desktop/e2e/projects.mjs` (8 checks with the real mouse: first run, New,
  Open, Save As, rename, delete, and that a rename + content survive a relaunch).

## For the collaboration layer

Each project now has a stable `id` and `name` (in both the workspace index and `project.name`). To host or join a session, the
collaboration module takes the current project (via the existing `getInitial()` / project update stream) as the session's seed and
applies ops through the same `applyOp`. The project identity it needs is now first-class.

## Project files, Import and Export

- **`.daw` file** — a JSON file `{ format: "collab-daw-project", version, project }`. Save/Save as write it; Open reads it (a file
  that is not a project is refused with a message, not a crash). The workspace remembers the file a project is linked to, so Save
  writes there again. `project:saveFile` / `project:saveFileAs` / `project:openFile` in the main process.
- **Import MIDI** — a pure Standard MIDI File parser (`apps/desktop/src/main/midi/parseMidi.ts`, format 0/1, note on/off, running
  status, tempo and track-name meta) and a builder (`midiToProject.ts`) that scales the file's division to our PPQ=960, makes one
  track per MIDI track (all-channel-9 tracks become drums), and caps to the DAW's track/song limits. 7 unit tests.
- **Export** — a settings window (format info, tail length) then the existing offline WAV render; the tail length reaches the engine.

## Not done

Exporting MIDI, importing a `.daw` as extra tracks into the current project (it opens as its own project), an "unsaved changes"
prompt (there is none — it autosaves), audio formats other than WAV, and folders/tags for organising many projects.
