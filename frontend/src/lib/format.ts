/** Server timestamps are UTC with an offset; treat a bare timestamp as UTC rather than local time. */
export function parseServerTime(value: string): number {
  const hasZone = /([zZ]|[+-]\d{2}:?\d{2})$/.test(value);
  return Date.parse(hasZone ? value : `${value}Z`);
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(bytes < 10 * 1024 ? 1 : 0)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

const clock = new Intl.DateTimeFormat(undefined, { hour: "numeric", minute: "2-digit" });

export function formatClock(value: string): string {
  return clock.format(parseServerTime(value));
}

/** "0:12", "3:05", "1:02:09": a clip's length. */
export function formatDuration(seconds: number): string {
  const total = Math.max(0, Math.round(seconds));
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const secs = String(total % 60).padStart(2, "0");
  if (hours > 0) return `${hours}:${String(minutes).padStart(2, "0")}:${secs}`;
  return `${minutes}:${secs}`;
}

/** "1 h 42 m", "8 m", "40 s": time left until the room closes. */
export function formatRemaining(ms: number): string {
  if (ms <= 0) return "0 m";
  const totalSeconds = Math.floor(ms / 1000);
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  if (hours > 0) return `${hours} h ${String(minutes).padStart(2, "0")} m`;
  if (minutes > 0) return `${minutes} m`;
  return `${totalSeconds} s`;
}

export function initials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return "?";
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
}

// Each person keeps one pale tint, picked from their id so it is the same on every device.
const TINTS = ["#E7DCCB", "#D9E0D6", "#DCD8E3", "#E8D6D0", "#D5DEE2", "#E4DFC9"];

export function tintFor(id: string): string {
  let hash = 0;
  for (let i = 0; i < id.length; i++) hash = (hash * 31 + id.charCodeAt(i)) | 0;
  return TINTS[Math.abs(hash) % TINTS.length];
}

/** Ids for optimistic messages and uploads. randomUUID needs a secure context, so fall back. */
export function makeId(): string {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto && window.isSecureContext) {
    return crypto.randomUUID();
  }
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}
