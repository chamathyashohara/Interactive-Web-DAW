import { useEffect, useRef, useState } from "react";
import { projectsStore, projectStore, useStore } from "../store";

/**
 * The project ("File") menu: the current project's name opens it. New, Open and Save work with real project files the
 * user chooses (Save prompts for a name and place the first time, then Ctrl+S saves there again). Below, the recent
 * projects can be reopened in one click. Import and Export open their own windows.
 */
export function ProjectMenu({ onExport }: { onExport: () => void }) {
  const { projects, activeId } = useStore(projectsStore);
  const { project } = useStore(projectStore);
  const [open, setOpen] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null);
  const [flash, setFlash] = useState("");
  const ref = useRef<HTMLDivElement>(null);

  const current = projects.find((p) => p.id === activeId);
  const name = current?.name ?? project?.name ?? "Project";

  useEffect(() => {
    if (!open) return;
    const away = (e: PointerEvent) => !ref.current?.contains(e.target as Node) && close();
    const esc = (e: KeyboardEvent) => e.key === "Escape" && close();
    window.addEventListener("pointerdown", away);
    window.addEventListener("keydown", esc);
    return () => {
      window.removeEventListener("pointerdown", away);
      window.removeEventListener("keydown", esc);
    };
  }, [open]);

  const close = () => (setOpen(false), setConfirmDelete(null));
  const toast = (msg: string) => {
    setFlash(msg);
    setTimeout(() => setFlash(""), 2500);
  };
  const save = async (as: boolean) => {
    const r = await (as ? window.daw.projects.saveAsFile() : window.daw.projects.save());
    if (r.ok && r.path) toast(`Saved to ${r.path.split(/[\\/]/).pop()}`);
    close();
  };

  const item = "flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-[12px] text-slate-200 hover:bg-white/10";
  const key = (k: string) => <span className="ml-auto text-[10px] text-slate-500">{k}</span>;

  return (
    <div className="relative" ref={ref}>
      <button
        className="hw-btn flex max-w-[220px] items-center gap-1.5 px-2.5 py-1 text-xs"
        aria-pressed={open}
        onClick={() => (open ? close() : setOpen(true))}
        title="Project: new, open, save, export"
        data-testid="project-menu"
      >
        <span className="text-slate-400">▦</span>
        <span className="truncate font-medium" data-testid="project-name">{name}</span>
        <span className="text-slate-500">▾</span>
      </button>
      {flash && <span className="absolute top-full left-0 mt-1 whitespace-nowrap rounded bg-emerald-500/20 px-2 py-0.5 text-[10px] text-emerald-200" data-testid="project-flash">{flash}</span>}

      {open && (
        <div className="hw-popover absolute top-full left-0 z-[65] mt-1.5 w-[280px] p-1.5 text-[12px]" data-testid="project-popover">
          <button className={item} onClick={() => void window.daw.projects.new().then(close)} data-testid="project-new">
            <span className="text-slate-400">＋</span> New project
          </button>
          <button className={item} onClick={() => void window.daw.projects.openFile().then(close)} data-testid="project-open-file">
            <span className="text-slate-400">↥</span> Open…{key("Ctrl+O")}
          </button>
          <div className="my-1 border-t border-white/10" />
          <button className={item} onClick={() => void save(false)} data-testid="project-save">
            <span className="text-slate-400">💾</span> Save{key("Ctrl+S")}
          </button>
          <button className={item} onClick={() => void save(true)} data-testid="project-save-as">
            <span className="text-slate-400">💾</span> Save as…{key("Ctrl+Shift+S")}
          </button>
          <div className="my-1 border-t border-white/10" />
          <button className={item} onClick={() => void window.daw.projects.importMidi().then((r) => { if (r.ok) toast(`Imported ${r.tracks} track${r.tracks === 1 ? "" : "s"}`); else if (!r.canceled) toast(r.reason ?? "Could not import."); close(); })} data-testid="project-import-midi" title="Import a MIDI file as a new project">
            <span className="text-slate-400">↧</span> Import MIDI…
          </button>
          <button className={item} onClick={() => (close(), onExport())} data-testid="project-export">
            <span className="text-slate-400">⤓</span> Export…{key("Ctrl+E")}
          </button>
          <div className="my-1 border-t border-white/10" />
          <div className="hw-legend px-2 pb-1 !text-[10px]">RECENT PROJECTS</div>
          <div className="max-h-[36vh] overflow-y-auto">
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
        </div>
      )}
    </div>
  );
}
