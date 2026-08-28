import type { EffectSlot } from "../types/daw";

interface EffectsRackProps {
  effects: EffectSlot[];
}

export function EffectsRack({ effects }: EffectsRackProps) {
  return (
    <section className="flex min-h-0 flex-1 flex-col overflow-hidden rounded-xl border border-white/8 bg-[#12151c] p-3">
      <p className="text-[11px] font-semibold uppercase tracking-wide text-slate-300">
        Effects
      </p>
      <p className="text-[10px] text-slate-500">Shape the master sound</p>

      <ul className="mt-2 min-h-0 flex-1 space-y-1.5 overflow-auto">
        {effects.map((effect) => (
          <li
            key={effect.id}
            className="flex items-center justify-between rounded-lg bg-black/25 px-2 py-1.5"
          >
            <div>
              <p className="text-xs font-medium text-white">{effect.name}</p>
              <p className="text-[10px] text-slate-500">{effect.detail}</p>
            </div>
            <span
              className={`rounded-full px-2 py-0.5 text-[10px] ${
                effect.enabled
                  ? "bg-cyan-400/15 text-cyan-200"
                  : "bg-white/5 text-slate-500"
              }`}
            >
              {effect.enabled ? "On" : "Off"}
            </span>
          </li>
        ))}
      </ul>

      <button
        type="button"
        className="mt-2 w-full rounded-lg border border-dashed border-white/15 py-1.5 text-xs text-slate-300 hover:bg-white/5"
      >
        + Add Effect
      </button>
    </section>
  );
}
