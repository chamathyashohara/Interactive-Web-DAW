import { useRef } from "react";

interface Props {
  value: number;
  min: number;
  max: number;
  onChange: (value: number) => void;
  orientation?: "vertical" | "horizontal";
  /** Colour of the line across the cap. */
  color?: string;
  /** Value to jump back to on double-click. */
  defaultValue?: number;
  label: string;
  testId?: string;
  disabled?: boolean;
  title?: string;
  /** Draw the 0-10 scale beside the slot (mixer faders). */
  scale?: boolean;
  className?: string;
  style?: React.CSSProperties;
}

const CAP_V = { w: 26, h: 32 };
const CAP_H = { w: 14, h: 16 };

/**
 * A mixer fader: a slot, a printed scale and a ridged metal cap. It still contains a real range input (invisible, same label)
 * so the keyboard, screen readers and tests work exactly as with a plain slider.
 */
export function Fader({ value, min, max, onChange, orientation = "vertical", color = "#f59e0b", defaultValue, label, testId, disabled, title, scale, className = "", style }: Props) {
  const vertical = orientation === "vertical";
  const cap = vertical ? CAP_V : CAP_H;
  const ref = useRef<HTMLDivElement>(null);
  const grab = useRef<number | null>(null); // pointer offset from the cap centre while dragging
  const frac = max === min ? 0 : Math.min(1, Math.max(0, (value - min) / (max - min)));
  const capSize = vertical ? cap.h : cap.w;

  const fromPointer = (e: React.PointerEvent, offset: number) => {
    const r = ref.current!.getBoundingClientRect();
    const len = (vertical ? r.height : r.width) - capSize;
    const pos = (vertical ? e.clientY - r.top : e.clientX - r.left) - capSize / 2 - offset;
    const f = len <= 0 ? 0 : Math.min(1, Math.max(0, vertical ? 1 - pos / len : pos / len));
    const next = Math.round(min + f * (max - min));
    if (next !== value) onChange(next);
  };
  const onDown = (e: React.PointerEvent) => {
    if (disabled || e.button !== 0) return;
    const r = ref.current!.getBoundingClientRect();
    const len = (vertical ? r.height : r.width) - capSize;
    const capCentre = (vertical ? (1 - frac) * len : frac * len) + capSize / 2;
    const at = vertical ? e.clientY - r.top : e.clientX - r.left;
    // grabbing the cap keeps it under the finger; pressing the slot elsewhere moves the cap there
    grab.current = Math.abs(at - capCentre) <= capSize / 2 ? at - capCentre : 0;
    e.currentTarget.setPointerCapture(e.pointerId);
    fromPointer(e, grab.current);
  };
  const onMove = (e: React.PointerEvent) => {
    if (grab.current !== null) fromPointer(e, grab.current);
  };
  const onUp = () => {
    grab.current = null;
  };

  const capPos = vertical ? { top: `calc((1 - ${frac}) * (100% - ${cap.h}px))`, left: "50%", marginLeft: -cap.w / 2 } : { left: `calc(${frac} * (100% - ${cap.w}px))`, top: "50%", marginTop: -cap.h / 2 };
  const ticks = scale && vertical ? Array.from({ length: 11 }, (_, i) => i) : [];
  return (
    <div
      ref={ref}
      className={`hw-fader ${vertical ? "hw-fader-v" : "hw-fader-h"} ${disabled ? "hw-disabled" : ""} ${className}`}
      style={{ ...style, ["--cap-color" as string]: color }}
      onPointerDown={onDown}
      onPointerMove={onMove}
      onPointerUp={onUp}
      onPointerCancel={onUp}
      onDoubleClick={() => !disabled && defaultValue !== undefined && onChange(defaultValue)}
      title={title}
      data-value={value}
    >
      <div className="hw-fader-slot" />
      {ticks.map((i) => (
        <div key={i} className={`hw-fader-tick ${i % 5 === 0 ? "hw-fader-tick-major" : ""}`} style={{ top: `calc(${cap.h / 2}px + (100% - ${cap.h}px) * ${i / 10})` }}>
          {i % 5 === 0 && <span>{10 - i}</span>}
        </div>
      ))}
      <div className="hw-fader-cap" style={{ width: cap.w, height: cap.h, ...capPos }} />
      <input type="range" className="hw-hidden-input" min={min} max={max} value={value} disabled={disabled} onChange={(e) => onChange(Number(e.target.value))} aria-label={label} data-testid={testId} tabIndex={disabled ? -1 : 0} />
    </div>
  );
}
