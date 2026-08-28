import { useState } from "react";
import type { ProjectInfo, ProjectPanelTab } from "../types/daw";

interface ProjectPanelProps {
  project: ProjectInfo;
}

const TABS: { id: ProjectPanelTab; label: string }[] = [
  { id: "project", label: "Project" },
  { id: "notes", label: "Notes" },
  { id: "files", label: "Files" },
];

export function ProjectPanel({ project }: ProjectPanelProps) {
  const [tab, setTab] = useState<ProjectPanelTab>("project");

  return (
    <section className="flex min-h-0 flex-col overflow-hidden rounded-xl border border-white/8 bg-[#12151c]">
      <div className="flex gap-1 border-b border-white/8 px-2 py-1.5">
        {TABS.map((item) => (
          <button
            key={item.id}
            type="button"
            onClick={() => setTab(item.id)}
            className={`rounded-md px-2.5 py-1 text-[11px] font-medium ${
              tab === item.id
                ? "bg-white/10 text-white"
                : "text-slate-400 hover:bg-white/5"
            }`}
          >
            {item.label}
          </button>
        ))}
      </div>

      {tab === "project" ? (
        <div className="min-h-0 flex-1 overflow-auto p-3">
          <div className="flex aspect-[16/9] items-center justify-center rounded-lg bg-gradient-to-br from-cyan-500/20 via-slate-800 to-fuchsia-500/20 ring-1 ring-white/10">
            <p className="text-[10px] tracking-[0.2em] text-cyan-200">ARTWORK</p>
          </div>
          <h2 className="mt-3 text-sm font-medium text-white">{project.name}</h2>
          <dl className="mt-3 space-y-2 text-xs">
            <Row label="Tempo" value={`${project.bpm} BPM`} />
            <Row label="Key" value={project.key} />
            <Row label="Time" value={project.timeSignature} />
            <Row label="Swing" value={`${project.swing}%`} />
          </dl>
          <div className="mt-4 rounded-lg bg-black/25 p-2">
            <p className="text-[10px] uppercase tracking-wide text-slate-500">
              Simple settings
            </p>
            <label className="mt-2 flex items-center justify-between text-xs text-slate-300">
              Count-in
              <input type="checkbox" defaultChecked className="accent-cyan-400" />
            </label>
            <label className="mt-2 flex items-center justify-between text-xs text-slate-300">
              Metronome
              <input type="checkbox" className="accent-cyan-400" />
            </label>
          </div>
        </div>
      ) : null}

      {tab === "notes" ? (
        <p className="p-3 text-xs leading-5 text-slate-400">
          Verse idea: keep the lead sparse so the vocal can sit on top. Add a riser before the
          chorus.
        </p>
      ) : null}

      {tab === "files" ? (
        <ul className="space-y-1 p-3 text-xs text-slate-300">
          <li>Neon Dreams.wfproj</li>
          <li>Vocal Take 01.wav</li>
          <li>Demo Bounce.wav</li>
        </ul>
      ) : null}
    </section>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-center justify-between">
      <dt className="text-slate-500">{label}</dt>
      <dd className="font-medium text-slate-200">{value}</dd>
    </div>
  );
}
