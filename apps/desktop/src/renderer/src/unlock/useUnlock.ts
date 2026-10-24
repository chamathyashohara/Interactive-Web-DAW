import { isUnlocked, lockReason, type FeatureId } from "@daw/shared";
import { progressStore, useStore } from "../store";

/**
 * Feature gating for the beginner-friendly DAW. `can(id)` says whether a feature is available; `reason(id)` is the
 * tooltip text for a locked one ("Locked. Unlocked by lesson M6.4: ...") or null. Re-renders when progress changes,
 * so a lesson completed elsewhere unlocks controls immediately.
 */
export function useUnlock() {
  const progress = useStore(progressStore);
  return {
    can: (id: FeatureId) => isUnlocked(progress, id),
    reason: (id: FeatureId) => lockReason(progress, id),
  };
}

/** For event handlers that must see the very latest progress without waiting for a render. */
export const canNow = (id: FeatureId): boolean => isUnlocked(progressStore.get(), id);
