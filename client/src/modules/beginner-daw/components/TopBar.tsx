import type { ProjectInfo } from "../types/daw";
import { TransportBar } from "./TransportBar";

interface TopBarProps {
  project: ProjectInfo;
}

function WaveformMark() {
  return (
    <svg viewBox="0 0 28 20" className="h-5 w-7" aria-hidden="true">
      <path
        d="M1 10h3l2-6 3 12 3-16 3 16 3-10 2 4h5"
        fill="none"
        stroke="#22d3ee"
        strokeWidth="1.8"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

export function TopBar({ project }: TopBarProps) {
  return (
    <header className="flex shrink-0 items-center gap-4 rounded-xl border border-white/8 bg-[#12151c] px-3 py-2">
      <div className="flex min-w-0 items-center gap-2">
        <div className="flex h-9 w-9 items-center justify-center rounded-lg bg-cyan-400/10 ring-1 ring-cyan-400/30">
          <WaveformMark />
        </div>
        <div className="min-w-0">
          <p className="text-[11px] font-semibold tracking-[0.22em] text-cyan-300">
            WAVEFORM
          </p>
          <p className="text-[10px] text-slate-400">Beginner Studio</p>
        </div>
      </div>

      <div className="h-8 w-px bg-white/10" />

      <div className="min-w-0">
        <p className="truncate text-sm font-medium text-white">{project.name}</p>
        <p className="flex items-center gap-1.5 text-[11px] text-emerald-400">
          <span className="h-1.5 w-1.5 rounded-full bg-emerald-400" />
          Saved
        </p>
      </div>

      <div className="flex items-center gap-1">
        <button
          type="button"
          aria-label="Undo"
          title="Undo"
          className="rounded-md px-2 py-1 text-xs text-slate-300 hover:bg-white/8"
        >
          Undo
        </button>
        <button
          type="button"
          aria-label="Redo"
          title="Redo"
          className="rounded-md px-2 py-1 text-xs text-slate-500 hover:bg-white/8"
        >
          Redo
        </button>
      </div>

      <TransportBar project={project} />

      <div className="ml-auto flex items-center gap-2">
        <div className="hidden text-right lg:block">
          <p className="text-xs font-medium text-white">{project.author}</p>
          <p className="text-[10px] text-slate-400">Student</p>
        </div>
        <div
          className="flex h-8 w-8 items-center justify-center rounded-full bg-gradient-to-br from-cyan-400 to-fuchsia-500 text-xs font-semibold text-slate-950"
          aria-label="Profile"
        >
          {project.author.slice(0, 1)}
        </div>
      </div>
    </header>
  );
}
