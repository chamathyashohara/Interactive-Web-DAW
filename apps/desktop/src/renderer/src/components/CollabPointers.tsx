import { useEffect } from "react";
import { collabPointers, collabStore, useStore } from "../store";

/** How often (at most) this window tells the others where its pointer is. */
const SEND_EVERY_MS = 33;

/**
 * Live pointers: while in a session, this window reports where the mouse is and draws everyone else's pointer
 * in their colour with their name. Positions are fractions of the window, so different window sizes line up roughly.
 */
export function CollabPointers() {
  const state = useStore(collabStore);
  const pointers = useStore(collabPointers);
  const active = state.active;

  useEffect(() => {
    if (!active) return;
    let last = 0;
    const move = (e: PointerEvent) => {
      const now = performance.now();
      if (now - last < SEND_EVERY_MS) return;
      last = now;
      window.daw.collab.sendPointer({ x: e.clientX / window.innerWidth, y: e.clientY / window.innerHeight });
    };
    const leave = () => window.daw.collab.sendPointer(null);
    window.addEventListener("pointermove", move);
    document.documentElement.addEventListener("pointerleave", leave);
    return () => {
      window.removeEventListener("pointermove", move);
      document.documentElement.removeEventListener("pointerleave", leave);
      collabPointers.set({});
    };
  }, [active]);

  if (!state.active) return null;
  return (
    <div className="pointer-events-none fixed inset-0 z-[90] overflow-hidden" data-testid="collab-pointers" aria-hidden>
      {state.users
        .filter((u) => u.id !== state.me && pointers[u.id])
        .map((u) => {
          const p = pointers[u.id]!;
          return (
            <div key={u.id} className="absolute left-0 top-0" style={{ transform: `translate(${p.x * 100}vw, ${p.y * 100}vh)` }} data-testid={`collab-pointer-${u.id}`}>
              <svg width="16" height="20" viewBox="0 0 16 20">
                <path d="M1 1 L1 16 L5 12 L8 19 L10.5 18 L7.5 11 L13 11 Z" fill={u.color} stroke="#111" strokeWidth="1" />
              </svg>
              <span className="ml-3 -mt-1 inline-block whitespace-nowrap rounded px-1 text-[10px] font-medium text-black" style={{ background: u.color }}>
                {u.name}
              </span>
            </div>
          );
        })}
    </div>
  );
}
