import type { RoomSession } from "./api/types";

// The session (room code and token) lives in sessionStorage: it survives a refresh in this tab
// and is gone when the tab closes. Storage can be blocked, so every access is guarded.
const SESSION_KEY = "coderoom.session";
const NAME_KEY = "coderoom.name";

export function saveSession(session: RoomSession): void {
  try {
    sessionStorage.setItem(SESSION_KEY, JSON.stringify(session));
  } catch {
    // Storage unavailable: the room still works until a refresh.
  }
}

export function loadSession(): RoomSession | null {
  try {
    const raw = sessionStorage.getItem(SESSION_KEY);
    return raw ? (JSON.parse(raw) as RoomSession) : null;
  } catch {
    return null;
  }
}

export function clearSession(): void {
  try {
    sessionStorage.removeItem(SESSION_KEY);
  } catch {
    // Nothing to clear.
  }
}

/** Remembers the last display name on this device so the next visit starts filled in. */
export function rememberName(name: string): void {
  try {
    localStorage.setItem(NAME_KEY, name);
  } catch {
    // Optional convenience only.
  }
}

export function lastName(): string {
  try {
    return localStorage.getItem(NAME_KEY) ?? "";
  } catch {
    return "";
  }
}
