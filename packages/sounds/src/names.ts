import type { Category } from "./library.ts";

/**
 * Helpers for importing third-party sample packs: cleaning names (e.g. removing a brand word like "KSHMR"),
 * guessing a category from the folder/file name, and reading key or tempo tags out of file names.
 * Pure functions, no file access.
 */

const GENERIC_WORDS = new Set([
  "kick", "kicks", "snare", "snares", "clap", "claps", "hat", "hats", "hi", "crash", "ride", "tom", "toms", "perc", "loop", "loops", "fill", "fills", "fx", "bass", "sub", "synth", "vocal",
  "big", "tight", "hard", "short", "long", "open", "closed", "top", "low", "mid", "high", "drum", "drums", "sample", "samples", "the", "a",
]);

/**
 * Finds a brand word that starts most of a pack's file names ("KSHMR Big Kick 01" ...). Returns null when there is none.
 * A brand must start at least 60% of at least 8 names and must not be an ordinary drum word or a number.
 */
export function detectBrandWord(names: string[]): string | null {
  if (names.length < 8) return null;
  const counts = new Map<string, { n: number; original: string }>();
  for (const name of names) {
    const first = name.trim().split(/\s+/)[0] ?? "";
    const key = first.toLowerCase();
    const cur = counts.get(key);
    if (cur) cur.n++;
    else counts.set(key, { n: 1, original: first });
  }
  let best: { n: number; original: string } | null = null;
  for (const [key, v] of counts) {
    if (key.length < 3 || /^\d+$/.test(key) || GENERIC_WORDS.has(key)) continue;
    if (v.n >= names.length * 0.6 && (!best || v.n > best.n)) best = v;
  }
  return best ? best.original : null;
}

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** Removes the brand word (and any extra words) as whole words, then tidies spaces and stray separators. */
export function cleanName(base: string, brand: string | null, extraWords: string[] = []): string {
  let s = base.replace(/_/g, " ");
  for (const w of [brand, ...extraWords]) if (w) s = s.replace(new RegExp(`\\b${escapeRe(w)}\\b`, "gi"), " ");
  s = s.replace(/\s*-\s*-\s*/g, " - ").replace(/\s+/g, " ").trim().replace(/^[\s\-_.]+|[\s\-_.]+$/g, "");
  return s || base.trim();
}

const TRAILING_TAG = /\s*\((?:[A-G][#b]?m?|\d{2,3}\s?bpm|[A-Za-z]{1,3}\s*\d{2,3}\s?bpm)\)\s*$/i;

/** The name a new track gets: the clean sample name without a trailing key/tempo tag. "Big Kick 01 (A)" -> "Big Kick 01". */
export function trackNameFor(clean: string): string {
  return clean.replace(TRAILING_TAG, "").trim() || clean;
}

const PC: Record<string, number> = { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 };

/** Reads a trailing "(F#)", "(Am)" or "(G#m)" tag. `minor` is null for a bare note name, because "(A)" could be a tuning or a major key. */
export function parseKeyTag(name: string): { pitchClass: number; minor: boolean | null } | null {
  const m = /\(([A-G])([#b]?)(m?)\)\s*$/.exec(name.trim());
  if (!m) return null;
  let pc = PC[m[1]!]!;
  if (m[2] === "#") pc = (pc + 1) % 12;
  if (m[2] === "b") pc = (pc + 11) % 12;
  return { pitchClass: pc, minor: m[3] === "m" ? true : null };
}

export function parseBpm(name: string): number | null {
  const m = /(\d{2,3})\s?bpm/i.exec(name);
  if (!m) return null;
  const v = Number(m[1]);
  return v >= 40 && v <= 250 ? v : null;
}

/** Guesses a browser category from a sample's folders and name. The first matching rule wins. */
export function categorize(folders: string[], name: string): { category: Category; sub: string } {
  const text = `${folders.join(" ")} ${name}`.toLowerCase().replace(/[_/\\-]+/g, " ");
  const has = (re: RegExp) => re.test(text);
  if (has(/\bloops?\b/)) return { category: "Loop", sub: "Loop" };
  if (has(/\bfills?\b/)) return { category: "Loop", sub: "Fill" };
  if (has(/\bvocals?\b|\bvox\b/)) return { category: "FX", sub: "Vocal" };
  if (has(/\b(sfx|fx|risers?|sweeps?|impacts?|downlifters?|uplifters?|reverse|ambiance|ambience|white noise|noise|foley|stops?)\b/)) return { category: "FX", sub: "FX" };
  if (has(/\bkicks?\b/)) return { category: "Kick", sub: "Kick" };
  if (has(/\bsnares?\b/)) return { category: "Snare", sub: "Snare" };
  if (has(/\bclaps?\b/)) return { category: "Clap", sub: "Clap" };
  if (has(/\b(hi ?hats?|hats?)\b/)) return { category: "Hat", sub: has(/\bopen\b/) ? "Open Hat" : "Closed Hat" };
  if (has(/\b(crash(es)?|rides?|cymbals?|splash|china)\b/)) return { category: "Cymbal", sub: "Cymbal" };
  if (has(/\btoms?\b/)) return { category: "Tom", sub: "Tom" };
  if (has(/\b(shakers?|tambourines?|tamb|snaps?|perc(ussion)?|congas?|bongos?|claves?|cowbells?|rim(shots?)?|triangles?|woodblocks?|timbales?)\b/)) return { category: "Percussion", sub: "Percussion" };
  if (has(/\b(808|bass|sub)\b/)) return { category: "Bass", sub: "Bass" };
  if (has(/\b(pads?|strings?|choir|orchestra)\b/)) return { category: "Pad", sub: "Pad" };
  if (has(/\b(pianos?|keys?|rhodes|organ|bells?|guitar|harp|marimba)\b/)) return { category: "Keys", sub: "Keys" };
  if (has(/\b(leads?|synths?|plucks?|arps?|stabs?)\b/)) return { category: "Synth", sub: "Synth" };
  if (has(/\bdrums?\b/)) return { category: "Percussion", sub: "Drums" };
  return { category: "Other", sub: "Other" };
}
