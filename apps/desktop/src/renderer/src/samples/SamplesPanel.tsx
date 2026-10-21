import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { Category, IndexEntry } from "@daw/sounds";
import { importStore, libraryStore, previewIdStore, statusStore, useStore } from "../store";
import { categoryCounts, filterSamples } from "./filter";
import { CATEGORY_COLORS, formatDuration, sampleTag } from "./sampleColors";

export const SAMPLE_DRAG_TYPE = "application/x-daw-sample";

/** The sound being dragged right now. While dragging, the browser only reveals the data type, so the arrangement reads this to draw its drop preview. */
export const dragState: { sampleId: string | null } = { sampleId: null };
const ROW_H = 36;

const CATEGORY_ORDER: Category[] = ["Kick", "Snare", "Clap", "Hat", "Cymbal", "Tom", "Percussion", "Bass", "Keys", "Pad", "Synth", "FX", "Loop", "Other"];

function Wave({ peaks, color, progress }: { peaks: number[]; color: string; progress: number }) {
  const n = peaks.length || 1;
  return (
    <svg viewBox={`0 0 ${n} 20`} preserveAspectRatio="none" className="h-5 w-16 shrink-0" aria-hidden>
      {peaks.map((p, i) => {
        const h = Math.max(1, (p / 255) * 20);
        return <rect key={i} x={i} y={10 - h / 2} width={0.7} height={h} fill={color} opacity={progress >= 0 && i / n <= progress ? 1 : 0.45} />;
      })}
    </svg>
  );
}

function Row({ entry, selected, playing, progress, onClick }: { entry: IndexEntry; selected: boolean; playing: boolean; progress: number; onClick: () => void }) {
  const color = CATEGORY_COLORS[entry.category];
  const tag = sampleTag(entry.meta);
  return (
    <div
      role="option"
      aria-selected={selected}
      draggable
      onDragStart={(e) => {
        e.dataTransfer.setData(SAMPLE_DRAG_TYPE, JSON.stringify({ id: entry.id, name: entry.name, category: entry.category }));
        e.dataTransfer.setData("text/plain", entry.name);
        e.dataTransfer.effectAllowed = "copy";
        dragState.sampleId = entry.id;
      }}
      onDragEnd={() => {
        dragState.sampleId = null;
      }}
      onClick={onClick}
      title={`${entry.name} · ${entry.pack} · ${formatDuration(entry.durationSec)}${tag ? ` · ${tag}` : ""}\nClick to listen, drag onto the arrangement`}
      className={`flex cursor-pointer items-center gap-2 border-l-2 px-2 text-xs ${selected ? "bg-white/10" : "hover:bg-white/5"}`}
      style={{ height: ROW_H, borderLeftColor: selected ? color : "transparent" }}
      data-testid="sample-row"
      data-sample-id={entry.id}
      data-playing={playing ? "true" : undefined}
    >
      <span className="h-2 w-2 shrink-0 rounded-full" style={{ background: color }} />
      <span className="min-w-0 flex-1 truncate text-slate-200">{entry.name}</span>
      {tag && <span className="shrink-0 rounded bg-white/10 px-1 text-[10px] text-slate-300">{tag}</span>}
      <Wave peaks={entry.peaks} color={color} progress={playing ? progress : -1} />
      <span className="w-10 shrink-0 text-right font-mono text-[10px] text-slate-500">{formatDuration(entry.durationSec)}</span>
    </div>
  );
}

function ImportBanner() {
  const { progress, result } = useStore(importStore);
  if (progress && !result) {
    const pct = progress.total ? Math.round((progress.done / progress.total) * 100) : 0;
    return (
      <div className="border-b border-white/10 px-3 py-2 text-[11px] text-cyan-200" data-testid="import-progress">
        {progress.phase === "extracting" ? "Unpacking the zip…" : `Importing ${progress.done} of ${progress.total}…`}
        <span className="mt-1 block h-1 overflow-hidden rounded bg-white/10"><span className="block h-full bg-cyan-400" style={{ width: `${progress.phase === "extracting" ? 5 : pct}%` }} /></span>
      </div>
    );
  }
  if (!result) return null;
  return (
    <div className={`border-b border-white/10 px-3 py-2 text-[11px] ${result.ok ? "text-emerald-200" : "text-rose-200"}`} data-testid="import-result" data-ok={result.ok ? "true" : "false"}>
      <div className="flex items-start gap-2">
        <div className="flex-1">
          {result.ok ? (
            <>
              Added <b>{result.added}</b> sample{result.added === 1 ? "" : "s"} to <b>{result.pack}</b>
              {result.brandRemoved && <> · removed “{result.brandRemoved}” from the names</>}
              {result.duplicates > 0 && <> · {result.duplicates} already in your library</>}
              {result.failed.length > 0 && (
                <details className="mt-1 text-rose-200">
                  <summary className="cursor-pointer">{result.failed.length} could not be read</summary>
                  <ul className="mt-1 max-h-24 overflow-auto text-[10px] text-slate-400">
                    {result.failed.slice(0, 50).map((f) => (
                      <li key={f.file}>{f.file}: {f.reason}</li>
                    ))}
                  </ul>
                </details>
              )}
            </>
          ) : (
            result.reason ?? "The import did not finish."
          )}
        </div>
        <button className="text-slate-500 hover:text-slate-200" onClick={() => importStore.set({ progress: null, result: null })} aria-label="Dismiss">×</button>
      </div>
    </div>
  );
}

export function SamplesPanel({ onClose }: { onClose: () => void }) {
  const lib = useStore(libraryStore);
  const previewId = useStore(previewIdStore);
  const status = useStore(statusStore);
  const imp = useStore(importStore);
  const [query, setQuery] = useState("");
  const [category, setCategory] = useState<Category | "All">("All");
  const [pack, setPack] = useState<string>("All");
  const [selected, setSelected] = useState<string | null>(null);
  const [scrollTop, setScrollTop] = useState(0);
  const [viewH, setViewH] = useState(400);
  const listRef = useRef<HTMLDivElement>(null);

  const filtered = useMemo(() => filterSamples(lib.entries, { query, category, pack }), [lib.entries, query, category, pack]);
  const counts = useMemo(() => categoryCounts(lib.entries, { query, pack }), [lib.entries, query, pack]);

  useEffect(() => {
    const el = listRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setViewH(el.clientHeight));
    ro.observe(el);
    setViewH(el.clientHeight);
    return () => ro.disconnect();
  }, []);

  const stop = useCallback(() => {
    window.daw.stopPreviewSample();
    previewIdStore.set(null);
  }, []);
  const play = useCallback((id: string) => {
    setSelected(id);
    window.daw.previewSample(id);
    previewIdStore.set(id);
  }, []);
  // The engine reports -1 when nothing plays. A sound that is still loading also reads -1, so the "now playing" id is only
  // cleared when a sound that was playing has ended (by itself or because it was stopped).
  const fraction = status?.preview ?? -1;
  const wasPlaying = useRef(false);
  useEffect(() => {
    if (fraction >= 0) wasPlaying.current = true;
    else if (wasPlaying.current) {
      wasPlaying.current = false;
      previewIdStore.set(null);
    }
  }, [fraction]);
  useEffect(() => () => window.daw.stopPreviewSample(), []);

  const move = (delta: number) => {
    if (filtered.length === 0) return;
    const i = filtered.findIndex((e) => e.id === selected);
    const next = filtered[Math.max(0, Math.min(filtered.length - 1, i < 0 ? 0 : i + delta))]!;
    play(next.id);
    const top = filtered.indexOf(next) * ROW_H;
    const el = listRef.current;
    if (el && (top < el.scrollTop || top + ROW_H > el.scrollTop + el.clientHeight)) el.scrollTop = Math.max(0, top - el.clientHeight / 2);
  };

  const first = Math.max(0, Math.floor(scrollTop / ROW_H) - 4);
  const last = Math.min(filtered.length, Math.ceil((scrollTop + viewH) / ROW_H) + 4);
  const importing = imp.progress !== null && imp.result === null;

  const doImport = async (mode: "zip" | "folder") => {
    importStore.set({ progress: { phase: "importing", done: 0, total: 0 }, result: null });
    const r = await window.daw.importSamples(mode);
    if (r.canceled) importStore.set({ progress: null, result: null });
    else importStore.set({ progress: null, result: r });
  };

  const present = CATEGORY_ORDER.filter((c) => counts.has(c));
  return (
    <aside className="flex w-[300px] shrink-0 flex-col border-r border-white/10 bg-[#0f121a]" data-testid="samples-panel" aria-label="Sample browser">
      <div className="flex items-center gap-2 border-b border-white/10 px-3 py-2">
        <span className="text-xs font-semibold text-slate-200">Sounds</span>
        <span className="text-[10px] text-slate-500" data-testid="sample-count">{filtered.length} of {lib.entries.length}</span>
        <button className="ml-auto text-slate-500 hover:text-slate-200" onClick={() => (stop(), onClose())} aria-label="Close sounds" title="Close the sound browser">×</button>
      </div>

      <div className="space-y-2 border-b border-white/10 p-2">
        <input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "ArrowDown" || e.key === "ArrowUp") {
              e.preventDefault();
              move(e.key === "ArrowDown" ? 1 : -1);
            } else if (e.key === "Escape") {
              if (query) setQuery("");
              else stop();
            } else if (e.key === "Enter" && filtered[0] && !selected) play(filtered[0].id);
          }}
          placeholder="Search: kick, trap, 120 bpm…"
          className="w-full rounded-md bg-white/5 px-2 py-1.5 text-xs text-slate-100 outline-none placeholder:text-slate-500 focus:ring-1 focus:ring-cyan-400/50"
          aria-label="Search sounds"
          data-testid="sample-search"
        />
        <div className="flex flex-wrap gap-1" role="toolbar" aria-label="Sound categories">
          <button className={`rounded px-1.5 py-0.5 text-[10px] ${category === "All" ? "bg-cyan-400/20 text-cyan-200" : "bg-white/5 text-slate-400 hover:bg-white/10"}`} onClick={() => setCategory("All")} data-testid="cat-All">
            All
          </button>
          {present.map((c) => (
            <button
              key={c}
              className={`rounded px-1.5 py-0.5 text-[10px] ${category === c ? "bg-cyan-400/20 text-cyan-200" : "bg-white/5 text-slate-400 hover:bg-white/10"}`}
              onClick={() => setCategory(category === c ? "All" : c)}
              data-testid={`cat-${c}`}
            >
              <span className="mr-1 inline-block h-1.5 w-1.5 rounded-full align-middle" style={{ background: CATEGORY_COLORS[c] }} />
              {c} <span className="text-slate-500">{counts.get(c)}</span>
            </button>
          ))}
        </div>
        <div className="flex gap-1">
          <select value={pack} onChange={(e) => setPack(e.target.value)} className="min-w-0 flex-1 rounded-md bg-white/5 px-1.5 py-1 text-[11px] text-slate-200 outline-none" aria-label="Pack" data-testid="pack-select">
            <option value="All" className="bg-[#12151c]">All packs</option>
            {lib.packs.map((p) => (
              <option key={p.name} value={p.name} className="bg-[#12151c]">
                {p.name} ({p.count})
              </option>
            ))}
          </select>
        </div>
        <div className="flex gap-1">
          <button className="flex-1 rounded-md bg-white/5 px-2 py-1 text-[11px] text-slate-200 hover:bg-white/10 disabled:opacity-40" disabled={importing || lib.status.state !== "ready"} onClick={() => void doImport("zip")} title="Add a sample pack from a .zip file" data-testid="import-zip">
            + Import zip…
          </button>
          <button className="flex-1 rounded-md bg-white/5 px-2 py-1 text-[11px] text-slate-200 hover:bg-white/10 disabled:opacity-40" disabled={importing || lib.status.state !== "ready"} onClick={() => void doImport("folder")} title="Add a folder of samples" data-testid="import-folder">
            + Import folder…
          </button>
        </div>
      </div>

      <ImportBanner />

      {lib.status.state === "preparing" && (
        <div className="p-4 text-xs text-slate-400" data-testid="library-preparing">
          Getting your sounds ready for the first time… {Math.round(lib.status.fraction * 100)}%
          <span className="mt-2 block h-1 overflow-hidden rounded bg-white/10"><span className="block h-full bg-cyan-400" style={{ width: `${lib.status.fraction * 100}%` }} /></span>
        </div>
      )}
      {lib.status.state === "error" && <div className="p-4 text-xs text-rose-300">Could not prepare the sounds: {lib.status.message}</div>}

      <div
        ref={listRef}
        role="listbox"
        aria-label="Sounds"
        tabIndex={0}
        onScroll={(e) => setScrollTop(e.currentTarget.scrollTop)}
        onKeyDown={(e) => {
          if (e.key === "ArrowDown" || e.key === "ArrowUp") {
            e.preventDefault();
            move(e.key === "ArrowDown" ? 1 : -1);
          } else if (e.key === "Escape") stop();
          else if (e.key === "Enter" && selected) play(selected);
        }}
        className="relative min-h-0 flex-1 overflow-y-auto outline-none"
        data-testid="sample-list"
      >
        {lib.status.state === "ready" && filtered.length === 0 && <div className="p-4 text-xs text-slate-500">Nothing matches. Try a shorter search or pick “All”.</div>}
        <div style={{ height: filtered.length * ROW_H, position: "relative" }}>
          <div style={{ position: "absolute", top: first * ROW_H, left: 0, right: 0 }}>
            {filtered.slice(first, last).map((e) => (
              <Row key={e.id} entry={e} selected={selected === e.id} playing={previewId === e.id && fraction >= 0} progress={fraction} onClick={() => (previewId === e.id && fraction >= 0 ? (stop(), setSelected(e.id)) : play(e.id))} />
            ))}
          </div>
        </div>
      </div>
      <div className="border-t border-white/10 px-3 py-1.5 text-[10px] text-slate-500">Click to listen · ↑ ↓ to browse · drag a sound onto the arrangement</div>
    </aside>
  );
}
