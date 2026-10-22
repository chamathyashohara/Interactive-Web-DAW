import { useRef } from "react";

interface Props {
  value: number;
  min: number;
  max: number;
  onChange: (value: number) => void;
  /** Cap colour (the coloured top of the knob). */
  color?: string;
  size?: number;
  defaultValue?: number;
  label: string;
  testId?: string;
  disabled?: boolean;
  title?: string;
  /** The scale lights up from the centre (pan) instead of from the minimum. */
  bipolar?: boolean;
}

const SWEEP = 135; // degrees either side of straight up
const TICKS = 11;

/**
 * A rotary knob with a ridged body, a coloured cap, a pointer line and a printed scale that lights up to the value.
 * Drag up/down to turn (hold Shift for fine steps), double-click to reset, mouse wheel to nudge.
 * A real (invisible) range input is inside, so keyboard and tests work as with a slider.
 */
export function Knob({ value, min, max, onChange, color = "#e2e8f0", size = 28, defaultValue, label, testId, disabled, title, bipolar }: Props) {
  const drag = useRef<{ y: number; v: number } | null>(null);
  const frac = max === min ? 0 : Math.min(1, Math.max(0, (value - min) / (max - min)));
  const angle = -SWEEP + frac * 2 * SWEEP;
  const clamp = (v: number) => Math.min(max, Math.max(min, Math.round(v)));

  const onDown = (e: React.PointerEvent) => {
    if (disabled || e.button !== 0) return;
    drag.current = { y: e.clientY, v: value };
    e.currentTarget.setPointerCapture(e.pointerId);
  };
  const onMove = (e: React.PointerEvent) => {
    const d = drag.current;
    if (!d) return;
    const perPx = (max - min) / (e.shiftKey ? 600 : 140); // a full sweep takes about 140 px of travel
    const next = clamp(d.v + (d.y - e.clientY) * perPx);
    if (next !== value) onChange(next);
  };
  const onUp = () => {
    drag.current = null;
  };

  const r = size / 2;
  const lit = (i: number) => {
    const f = i / (TICKS - 1);
    return bipolar ? (frac >= 0.5 ? f >= 0.5 && f <= frac + 1e-6 : f <= 0.5 && f >= frac - 1e-6) : f <= frac + 1e-6;
  };
  return (
    <div
      className={`hw-knob ${disabled ? "hw-disabled" : ""}`}
      style={{ width: size, height: size, ["--cap" as string]: color }}
      onPointerDown={onDown}
      onPointerMove={onMove}
      onPointerUp={onUp}
      onPointerCancel={onUp}
      onDoubleClick={() => !disabled && defaultValue !== undefined && onChange(defaultValue)}
      onWheel={(e) => !disabled && onChange(clamp(value - Math.sign(e.deltaY) * Math.max(1, (max - min) / 40)))}
      title={title}
      data-value={value}
    >
      <svg className="pointer-events-none absolute inset-0" width={size} height={size} viewBox={`${-r} ${-r} ${size} ${size}`} aria-hidden>
        {Array.from({ length: TICKS }, (_, i) => {
          const a = ((-SWEEP + (i / (TICKS - 1)) * 2 * SWEEP) * Math.PI) / 180;
          const on = lit(i);
          return <line key={i} x1={Math.sin(a) * (r - 3.5)} y1={-Math.cos(a) * (r - 3.5)} x2={Math.sin(a) * (r - 0.5)} y2={-Math.cos(a) * (r - 0.5)} stroke={on ? color : "rgba(226,232,240,.28)"} strokeWidth={on ? 1.6 : 1} strokeLinecap="round" />;
        })}
      </svg>
      <div className="hw-knob-spin" style={{ transform: `rotate(${angle}deg)` }}>
        <div className="hw-knob-cap" />
        <div className="hw-knob-mark" />
      </div>
      <div className="hw-knob-gloss" />
      <input type="range" className="hw-hidden-input" min={min} max={max} value={value} disabled={disabled} onChange={(e) => onChange(Number(e.target.value))} aria-label={label} data-testid={testId} tabIndex={disabled ? -1 : 0} />
    </div>
  );
}
