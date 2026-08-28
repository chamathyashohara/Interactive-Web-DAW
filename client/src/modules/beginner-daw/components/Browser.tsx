import { useMemo, useState } from "react";
import type { BrowserItem, BrowserTab } from "../types/daw";

interface BrowserProps {
  items: BrowserItem[];
}

const TABS: { id: BrowserTab; label: string }[] = [
  { id: "sounds", label: "Sounds" },
  { id: "instruments", label: "Instruments" },
  { id: "user", label: "User" },
];

export function Browser({ items }: BrowserProps) {
  const [tab, setTab] = useState<BrowserTab>("sounds");
  const [query, setQuery] = useState("");
  const [selectedId, setSelectedId] = useState(items[0]?.id ?? "");

  const visible = useMemo(() => {
    return items.filter((item) => {
      const matchesTab = item.tab === tab;
      const matchesQuery = item.name.toLowerCase().includes(query.toLowerCase());
      return matchesTab && matchesQuery;
    });
  }, [items, query, tab]);

  const selected = items.find((item) => item.id === selectedId) ?? visible[0];
  const categories = [...new Set(visible.map((item) => item.category))];

  return (
    <section className="flex min-h-0 flex-col overflow-hidden rounded-xl border border-white/8 bg-[#12151c]">
      <div className="border-b border-white/8 px-3 py-2">
        <p className="text-[11px] font-semibold uppercase tracking-wide text-slate-300">
          Browser
        </p>
        <p className="text-[10px] text-slate-500">Find a sound to start with</p>
      </div>

      <div className="flex gap-1 px-2 pt-2">
        {TABS.map((item) => (
          <button
            key={item.id}
            type="button"
            onClick={() => setTab(item.id)}
            className={`flex-1 rounded-md px-2 py-1 text-[11px] ${
              tab === item.id
                ? "bg-white/10 text-white"
                : "text-slate-400 hover:bg-white/5"
            }`}
          >
            {item.label}
          </button>
        ))}
      </div>

      <div className="px-2 py-2">
        <input
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder="Search sounds"
          className="w-full rounded-md border border-white/10 bg-black/30 px-2 py-1.5 text-xs text-white outline-none placeholder:text-slate-500 focus:border-cyan-400/40"
        />
      </div>

      <div className="flex gap-1 overflow-x-auto px-2 pb-2">
        {categories.map((category) => (
          <span
            key={category}
            className="shrink-0 rounded-full bg-white/6 px-2 py-0.5 text-[10px] text-slate-300"
          >
            {category}
          </span>
        ))}
      </div>

      <ul className="min-h-0 flex-1 overflow-auto px-2">
        {visible.map((item) => (
          <li key={item.id}>
            <button
              type="button"
              onClick={() => setSelectedId(item.id)}
              className={`mb-1 flex w-full items-center justify-between rounded-md px-2 py-1.5 text-left text-xs ${
                selected?.id === item.id
                  ? "bg-cyan-400/12 text-cyan-100"
                  : "text-slate-300 hover:bg-white/5"
              }`}
            >
              <span>{item.name}</span>
              <span className="text-[10px] text-slate-500">{item.duration}</span>
            </button>
          </li>
        ))}
      </ul>

      <div className="border-t border-white/8 p-2">
        <p className="text-[10px] uppercase tracking-wide text-slate-500">Preview</p>
        <div className="mt-1 rounded-md bg-black/30 px-2 py-2">
          <p className="text-xs text-white">{selected?.name ?? "No sound selected"}</p>
          <div className="mt-2 flex h-8 items-end gap-px">
            {Array.from({ length: 28 }, (_, index) => (
              <span
                key={index}
                className="flex-1 rounded-sm bg-cyan-400/50"
                style={{ height: `${20 + ((index * 17) % 70)}%` }}
              />
            ))}
          </div>
        </div>
      </div>
    </section>
  );
}
