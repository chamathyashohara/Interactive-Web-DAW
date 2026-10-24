/** Small padlock shown on locked controls. Decorative: the reason is in the control's title. */
export function LockIcon({ className = "" }: { className?: string }) {
  return (
    <svg className={`inline-block ${className}`} width="10" height="10" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.3" aria-hidden="true" data-lock="true">
      <rect x="2" y="5.5" width="8" height="5.5" rx="1" />
      <path d="M4 5.5V3.8a2 2 0 0 1 4 0v1.7" />
    </svg>
  );
}
