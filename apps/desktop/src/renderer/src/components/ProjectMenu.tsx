import { useEffect, useRef, useState } from "react";
import { projectsStore, projectStore, useStore } from "../store";

/**
 * The project ("File") menu: the current project's name opens a dropdown to create a new project, open another, save a
 * copy (Save As), rename, or delete. Switching projects reloads the whole DAW onto that project.
 */
export function ProjectMenu() {
  const { projects, activeId } = useStore(projectsStore);
  const { project } = useStore(projectStore);
  const [open, setOpen] = useState(false);
  const [mode, setMode] = useState<null | "rename" | "saveAs">(null);
  const [draft, setDraft] = useState("");
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null);
  const ref = useRef<HTMLDivElement>(null);

  const current = projects.find((p) => p.id === activeId);
  const name = current?.name ?? project?.name ?? "Project";

  useEffect(() => {
    if (!open) return;
    const away = (e: PointerEvent) => !ref.current?.contains(e.target as Node) && (setOpen(false), setMode(null), setConfirmDelete(null));
    const esc = (e: KeyboardEvent) => e.key === "Escape" && (setOpen(false), setMode(null), setConfirmDelete(null));
    window.addEventListener("pointerdown", away);
    window.addEventListener("keydown", esc);
    return () => {
      window.removeEventListener("pointerdown", away);
      window.removeEventListener("keydown", esc);
    };
  }, [open]);

  const close = () => (setOpen(false), setMode(null), setConfirmDelete(null));
  const begin = (m: "rename" | "saveAs") => {
    setMode(m);
    setDraft(m === "rename" ? name : `${name} copy`);
    setConfirmDelete(null);
  };
  const commit = async () => {
    const n = draft.trim();
    if (!n) return;
    if (mode === "rename") await window.daw.projects.rename(activeId, n);
    else if (mode === "saveAs") await window.daw.projects.saveAs(n);
    close();
  };
  const row = "flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-[12px] text-slate-200 hover:bg-white/10";

  return (
    <div className="relative" ref={ref}>
      <button
        className="hw-btn flex max-w-[200px] items-center gap-1.5 px-2.5 py-1 text-xs"
        aria-pressed={open}
        onClick={() => (open ? close() : setOpen(true))}
        title="Projects: new, open, save a copy, rename"
        data-testid="project-menu"
      >
        <span className="text-slate-400">▦</span>
        <span className="truncate font-medium" data-testid="project-name">{name}</span>
        <span className="text-slate-500">▾</span>
      </button>

      {open && (
        <div className="hw-popover absolute top-full left-0 z-[65] mt-1.5 w-[280px] p-2 text-[12px]" data-testid="project-popover">
          {mode ? (
            <div className="p-1" data-testid="project-name-form">
              <div className="hw-legend mb-1.5 !text-[10px]">{mode === "rename" ? "RENAME PROJECT" : "SAVE A COPY AS"}</div>
              <input
                autoFocus
                value={draft}
                maxLength={80}
                onChange={(e) => setDraft(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") void commit();
                  if (e.key === "Escape") setMode(null);
                  e.stopPropagation();
                }}
                className="hw-field w-full px-2 py-1.5 text-[12px]"
                aria-label="Project name"
                data-testid="project-name-input"
              />
              <div className="mt-2 flex justify-end gap-1.5">
                <button className="hw-btn px-2 py-1 text-[11px]" onClick={() => setMode(null)}>Cancel</button>
                <button className="hw-btn hw-go px-3 py-1 text-[11px]" disabled={!draft.trim()} onClick={() => void commit()} data-testid="project-name-ok">
                  {mode === "rename" ? "Rename" : "Save copy"}
                </button>
              </div>
            </div>
          ) : (
            <>
              <button className={row} onClick={() => void window.daw.projects.new().then(close)} data-testid="project-new">
                <span className="text-slate-400">＋</span> New project
              </button>
              <button className={row} onClick={() => begin("saveAs")} data-testid="project-saveas">
                <span className="text-slate-400">⧉</span> Save a copy…
              </button>
              <button className={row} onClick={() => begin("rename")} data-testid="project-rename">
                <span className="text-slate-400">✎</span> Rename…
              </button>
              <div className="my-1.5 border-t border-white/10" />
              <div className="hw-legend px-2 pb-1 !text-[10px]">OPEN A PROJECT</div>
              <div className="max-h-[40vh] overflow-y-auto">
                {projects.map((p) => (
                  <div key={p.id} className={`flex items-center gap-1 rounded ${p.id === activeId ? "bg-cyan-400/10" : "hover:bg-white/10"}`} data-testid="project-row" data-project-id={p.id} data-active={p.id === activeId ? "true" : undefined}>
                    <button
                      className="flex min-w-0 flex-1 items-center gap-2 px-2 py-1.5 text-left"
                      disabled={p.id === activeId}
                      onClick={() => void window.daw.projects.open(p.id).then(close)}
                      title={p.id === activeId ? "Current project" : `Open ${p.name}`}
                    >
                      <span className={`h-1.5 w-1.5 shrink-0 rounded-full ${p.id === activeId ? "bg-cyan-300" : "bg-white/20"}`} />
                      <span className="truncate text-slate-200">{p.name}</span>
                    </button>
                    {confirmDelete === p.id ? (
                      <button className="hw-btn hw-red mr-1 px-1.5 py-0.5 text-[10px]" onClick={() => void window.daw.projects.delete(p.id).then(() => setConfirmDelete(null))} data-testid="project-delete-confirm">
                        Delete?
                      </button>
                    ) : (
                      <button
                        className="mr-1 rounded px-1.5 py-0.5 text-[12px] text-slate-500 hover:bg-rose-500/20 hover:text-rose-200 disabled:opacity-30"
                        disabled={projects.length <= 1}
                        onClick={() => setConfirmDelete(p.id)}
                        title={projects.length <= 1 ? "The only project cannot be deleted" : `Delete ${p.name}`}
                        data-testid="project-delete"
                        aria-label={`Delete ${p.name}`}
                      >
                        ✕
                      </button>
                    )}
                  </div>
                ))}
              </div>
            </>
          )}
        </div>
      )}
    </div>
  );
}
