import { Link } from "react-router-dom";

/** The mark: a room seen from above, two people in it, one of them the brass host. */
export function Mark({ size = 28 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 32 32" aria-hidden="true" focusable="false">
      <rect width="32" height="32" rx="9" fill="var(--ink)" />
      <circle cx="11" cy="13" r="3.2" fill="var(--accent)" />
      <circle cx="21" cy="13" r="3.2" fill="var(--on-ink)" />
      <rect x="8" y="20" width="16" height="3" rx="1.5" fill="var(--on-ink)" opacity="0.55" />
    </svg>
  );
}

export function Wordmark({ to = "/" }: { to?: string }) {
  return (
    <Link to={to} className="wordmark" aria-label="CodeRoom home">
      <Mark />
      <span>CodeRoom</span>
    </Link>
  );
}
