import type { Category, IndexEntry } from "@daw/sounds";

export interface SampleFilter {
  query: string;
  category: Category | "All";
  pack: string | "All";
}

/** Splits the search box into lower-case words; every word must match somewhere in the sample's name, category, pack or tags. */
export function filterSamples(entries: IndexEntry[], f: SampleFilter): IndexEntry[] {
  const words = f.query.toLowerCase().split(/\s+/).filter(Boolean);
  return entries.filter((e) => {
    if (f.category !== "All" && e.category !== f.category) return false;
    if (f.pack !== "All" && e.pack !== f.pack) return false;
    if (words.length === 0) return true;
    const hay = `${e.name} ${e.sub} ${e.category} ${e.pack} ${e.tags.join(" ")}${e.meta.bpm ? ` ${e.meta.bpm}bpm` : ""}`.toLowerCase();
    return words.every((w) => hay.includes(w));
  });
}

/** How many samples each category has within the other two filters (for the chip counts). */
export function categoryCounts(entries: IndexEntry[], f: Pick<SampleFilter, "query" | "pack">): Map<Category, number> {
  const counts = new Map<Category, number>();
  for (const e of filterSamples(entries, { ...f, category: "All" })) counts.set(e.category, (counts.get(e.category) ?? 0) + 1);
  return counts;
}
