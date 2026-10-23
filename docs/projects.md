# Project system (many named projects)

The DAW used to keep one hidden, autosaved project. It now manages **many named projects**, each its own thing you can create,
open, copy, rename and delete — from the **Project menu** at the top-left of the window (the DAW's name is the menu). This is also
what the collaboration layer needs: a project with a stable identity it can share into a session.

## For the user

The menu (click the project name, next to **CollabDAW**):

- **New project** — starts a fresh, empty project and switches to it.
- **Save a copy…** — a full, independent copy under a new name (the original is untouched).
- **Rename…** — rename the current project.
- **Open a project** — the list of projects, most recently opened first; click one to switch. Each has a ✕ to delete (two clicks:
  ✕ then *Delete?*). The only remaining project cannot be deleted.

Switching reloads the whole DAW onto that project. Every project autosaves continuously, as before, so nothing is lost on a switch
or a crash.

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

## Not done

Importing/exporting a project as a single file (for sharing by hand), a "unsaved changes" concept (there are none — it autosaves),
and folders/tags for organising many projects.
