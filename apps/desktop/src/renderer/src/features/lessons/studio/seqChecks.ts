import { TICKS_PER_BAR, type Project } from "@daw/shared";
import type { CheckResult } from "../types";
import type { StudioCheck } from "./types";

/**
 * Checks for the Drum sequencer lessons. They read the lesson's drum track the way the step sequencer shows it: one bar
 * is sixteen pads, pad n starts at (n - 1) x 240 ticks, the beats are pads 1, 5, 9 and 13. Kick is pitch 36 (35 is the
 * second kick), snare 38. Pads count on across bars (bar 2 starts at pad 17).
 */

export const PAD_TICKS = TICKS_PER_BAR / 16;
const KICKS = [36, 35];
const SNARE = 38;
const BEAT_PADS = [1, 5, 9, 13];
export const padTick = (pad: number) => (pad - 1) * PAD_TICKS;
const padOf = (tick: number) => Math.floor(tick / PAD_TICKS) + 1;
/** Pad within its bar (1-16) and which bar (1-based). */
const inBar = (pad: number) => ({ bar: Math.floor((pad - 1) / 16) + 1, pad: ((pad - 1) % 16) + 1 });
const beatOf = (pad: number) => BEAT_PADS.indexOf(inBar(pad).pad) + 1;

interface Hit {
  pitch: number;
  tick: number;
  velocity: number;
}
/** Every unmuted hit on the lesson's drum tracks, in song time, in order. */
function hitsOf(p: Project): Hit[] {
  const out: Hit[] = [];
  for (const t of Object.values(p.tracks)) {
    if (t.instrument !== "drums") continue;
    for (const c of Object.values(t.clips)) for (const n of Object.values(c.notes)) if (!n.muted) out.push({ pitch: n.pitch, tick: c.startTick + n.startTick, velocity: n.velocity });
  }
  return out.sort((a, b) => a.tick - b.tick || a.pitch - b.pitch);
}
const kicksOf = (p: Project, pitch?: number) => hitsOf(p).filter((h) => (pitch ? h.pitch === pitch : KICKS.includes(h.pitch)));

function result(items: { label: string; ok: boolean; fix: string }[], success: string): CheckResult {
  const missing = items.find((i) => !i.ok);
  const ok = items.filter((i) => i.ok).length;
  return { pass: !missing, score: items.length ? ok / items.length : 1, feedback: missing ? missing.fix : success, items: items.map(({ label, ok }) => ({ label, ok })) };
}

/** "pad 9" in one bar, "pad 9 of bar 2" further on. */
const padName = (pad: number) => {
  const b = inBar(pad);
  return b.bar === 1 ? `pad ${b.pad}` : `pad ${b.pad} of bar ${b.bar}`;
};
const beatName = (pad: number) => (beatOf(pad) > 0 ? `beat ${beatOf(pad)} (${padName(pad)})` : padName(pad));

export function runSeqCheck(p: Project, check: StudioCheck): CheckResult | null {
  switch (check.kind) {
    case "kickPads": {
      const kicks = kicksOf(p, check.pitch);
      const pads = kicks.map((k) => padOf(k.tick));
      const want = check.exact ?? check.has ?? [];
      const missing = want.filter((w) => !pads.includes(w));
      const extra = check.exact ? [...new Set(pads)].filter((x) => !check.exact!.includes(x)) : [];
      const items = [
        {
          label: `Kick on ${want.map((w) => `pad ${w}`).join(", ")}`,
          ok: missing.length === 0,
          fix: kicks.length === 0 ? (check.pitch ? "The kick row is the top row. Click the first pad." : "No kick yet. The kick row is the top row: click a pad in it.") : `No kick on ${missing.map(beatName).join(", ")}.`,
        },
      ];
      if (check.exact) items.push({ label: "No other kicks", ok: extra.length === 0, fix: `Extra kick on ${extra.map(padName).join(", ")}: click it again to remove it.` });
      return result(items, check.exact?.length === 4 ? "Four on the floor: a kick on every beat." : check.exact?.length === 2 ? "Kicks on 1 and 3: lighter, with more space." : "The kick lands right on the first beat.");
    }
    case "offBeat": {
      const pads = kicksOf(p).map((k) => padOf(k.tick));
      const off = pads.filter((x) => !BEAT_PADS.includes(inBar(x).pad));
      return result(
        [
          { label: `At least ${check.min} kicks (${pads.length} now)`, ok: pads.length >= check.min, fix: `Add more kicks: at least ${check.min}.` },
          { label: "At least one kick off the beat", ok: off.length > 0, fix: "Every kick is on a beat. Try one pad to the right of a beat pad." },
        ],
        `A kick on ${padName(off[0] ?? 7)}, between the beats: the groove starts to bounce.`,
      );
    }
    case "accent": {
      const kicks = kicksOf(p);
      const one = kicks.find((k) => k.tick === 0);
      const others = kicks.filter((k) => k.tick !== 0);
      return result(
        [
          { label: "Kick on pad 1 is an accent (127)", ok: one?.velocity === 127, fix: one ? "Hold Shift and click the pad. It lights brighter." : "Put a kick on pad 1 first, then Shift+click it." },
          { label: "Another kick is normal (softer)", ok: others.some((k) => k.velocity < 127), fix: others.length ? "Leave the other kicks normal: one plain click, no Shift." : "Add at least one more kick, with a plain click." },
        ],
        "Beat 1 now hits harder than the rest: the bar has a clear start.",
      );
    }
    case "snareRoom": {
      const hits = hitsOf(p);
      const missing = check.pads.filter((x) => !hits.some((h) => h.pitch === SNARE && h.tick === padTick(x)));
      const clash = check.pads.filter((x) => hits.some((h) => KICKS.includes(h.pitch) && h.tick === padTick(x)));
      return result(
        [
          { label: `Snare on ${check.pads.map((x) => `pad ${x}`).join(" and ")}`, ok: missing.length === 0, fix: `Put a snare (the Snare row) on ${missing.map(beatName).join(" and ")}.` },
          { label: "No kick under the snare", ok: clash.length === 0, fix: `The snare owns ${check.pads.length > 1 ? `pads ${check.pads.join(" and ")}` : `pad ${check.pads[0]}`}. Move the kick off ${clash.map(padName).join(" and ")}.` },
        ],
        "Kick and snare take turns: each has its own pads.",
      );
    }
    case "bars": {
      const kicks = kicksOf(p);
      const perBar = Array.from({ length: check.bars }, (_, b) =>
        kicks
          .filter((k) => k.tick >= b * TICKS_PER_BAR && k.tick < (b + 1) * TICKS_PER_BAR)
          .map((k) => `${k.tick - b * TICKS_PER_BAR}:${k.pitch}`)
          .sort()
          .join(","),
      );
      const empty = perBar.findIndex((x) => !x);
      const items = [{ label: `All ${check.bars} bars have kicks`, ok: empty < 0, fix: `Bar ${empty + 1} has no kick. Use Copy to all bars first, then open bar ${check.bars} with the bar buttons.` }];
      if (check.lastDiffers !== false) items.push({ label: `Bar ${check.bars} differs from bar 1`, ok: perBar[check.bars - 1] !== perBar[0], fix: `Bar ${check.bars} is the same as bar 1. Open bar ${check.bars} with the bar buttons and add a kick on pad 16.` });
      return result(items, check.lastDiffers === false ? `Every bar has the pattern now.` : `Three bars the same, then a change in bar ${check.bars}: it leads into the next loop.`);
    }
    case "loopRegion": {
      const loop = p.loop;
      const bars = loop ? (loop.endTick - loop.startTick) / TICKS_PER_BAR : 0;
      return result(
        [{ label: `A loop region of at least ${check.minBars} bars`, ok: bars >= check.minBars, fix: loop ? `The loop is ${Math.round(bars * 4) / 4} bar(s). Drag its end in the LOOP strip to make it ${check.minBars} bars.` : "Drag in the thin LOOP strip above the numbers." }],
        `The loop repeats ${Math.round(bars)} bars over and over.`,
      );
    }
    case "kickRamp": {
      const kicks = kicksOf(p);
      const rise = kicks.length > 1 ? kicks[kicks.length - 1]!.velocity - kicks[0]!.velocity : 0;
      return result(
        [
          { label: "Several kicks to ramp", ok: kicks.length > 1, fix: "Put kicks in the bars first (Copy to all bars helps)." },
          { label: `Kicks get louder by at least ${check.rise} (${rise} now)`, ok: rise >= check.rise, fix: "Click the Kick name first, so Ramp changes only the kick. Then press Ramp and choose Build up." },
        ],
        "The kicks swell from soft to loud: the pattern builds.",
      );
    }
    case "pattern": {
      const hits = hitsOf(p);
      const items = check.rows.map((row) => {
        const pads = hits.filter((h) => h.pitch === row.pitch).map((h) => padOf(h.tick));
        const missing = row.pads.filter((x) => !pads.includes(x));
        const extra = row.exact ? [...new Set(pads)].filter((x) => !row.pads.includes(x)) : [];
        return {
          label: `${row.name} on ${row.pads.map((x) => `pad ${x}`).join(", ")}`,
          ok: !missing.length && !extra.length,
          fix: missing.length ? `${row.name}: nothing on ${missing.map(padName).join(", ")} yet.` : `${row.name}: remove the extra hit on ${extra.map(padName).join(", ")}.`,
        };
      });
      return result(items, "The full basic beat: every drum on its own pads.");
    }
    default:
      return null;
  }
}
