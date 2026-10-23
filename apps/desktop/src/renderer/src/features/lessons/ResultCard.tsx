import { CheckIcon } from "./Icons";
import type { CheckResult } from "./types";

/** The feedback card shown after Check: names the specific mistake and ticks each requirement. */
export function ResultCard({ result }: { result: CheckResult }) {
  return (
    <div className={`rounded-xl p-4 ring-1 ${result.pass ? "bg-emerald-400/10 ring-emerald-400/30" : "bg-rose-400/10 ring-rose-400/30"}`} data-testid="lesson-result" data-pass={result.pass}>
      <div className={`font-semibold ${result.pass ? "text-emerald-200" : "text-rose-200"}`}>{result.pass ? "Well done!" : "Not yet, keep going"}</div>
      <div className="mt-1 text-sm text-slate-200">{result.feedback}</div>
      <ul className="mt-3 flex flex-col gap-1 text-sm">
        {result.items.map((i) => (
          <li key={i.label} className={`flex items-center gap-2 ${i.ok ? "text-emerald-300" : "text-slate-400"}`}>
            <span className={`flex h-4 w-4 items-center justify-center rounded-full ${i.ok ? "bg-emerald-400/20" : "ring-1 ring-slate-500"}`}>{i.ok && <CheckIcon size={11} />}</span>
            {i.label}
          </li>
        ))}
      </ul>
    </div>
  );
}
