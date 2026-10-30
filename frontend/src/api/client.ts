import type { FileList, FileOut, MessagePage, RoomDetails, RoomSession } from "./types";

/** An API failure with the server's own message, status and any Retry-After hint. */
export class ApiError extends Error {
  readonly status: number;
  readonly retryAfter: number | null;

  constructor(status: number, message: string, retryAfter: number | null = null) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.retryAfter = retryAfter;
  }
}

// Empty in development (the Vite proxy serves /api on the page's origin). In production the API is
// hosted separately, so VITE_API_URL holds its origin, e.g. https://api.example.com.
const API_ORIGIN: string = import.meta.env.VITE_API_URL ?? "";
const API = `${API_ORIGIN}/api`;

/** The WebSocket URL for a room, on the API's host (or the page's host when proxied). */
export function roomSocketUrl(roomId: string): string {
  const base = new URL(API_ORIGIN || window.location.origin);
  const protocol = base.protocol === "https:" ? "wss:" : "ws:";
  return `${protocol}//${base.host}/api/rooms/${roomId}/ws`;
}

/** FastAPI returns `detail` as a string for our own errors and as a list for validation errors. */
function messageFrom(body: unknown, fallback: string): string {
  if (body && typeof body === "object" && "detail" in body) {
    const detail = (body as { detail: unknown }).detail;
    if (typeof detail === "string") return detail;
    if (Array.isArray(detail) && detail[0] && typeof detail[0] === "object" && "msg" in detail[0]) {
      return String((detail[0] as { msg: unknown }).msg);
    }
  }
  return fallback;
}

function retryAfterFrom(response: Response): number | null {
  const value = Number(response.headers.get("Retry-After"));
  return Number.isFinite(value) && value > 0 ? value : null;
}

async function request<T>(path: string, init: RequestInit = {}, token?: string): Promise<T> {
  const headers = new Headers(init.headers);
  if (token) headers.set("Authorization", `Bearer ${token}`);
  if (init.body && !headers.has("Content-Type")) headers.set("Content-Type", "application/json");

  let response: Response;
  try {
    response = await fetch(`${API}${path}`, { ...init, headers });
  } catch {
    throw new ApiError(0, "Can't reach CodeRoom. Check your connection and try again.");
  }

  if (!response.ok) {
    const body = await response.json().catch(() => null);
    throw new ApiError(response.status, messageFrom(body, `Request failed (${response.status})`), retryAfterFrom(response));
  }
  if (response.status === 204) return undefined as T;
  return (await response.json()) as T;
}

/** Without a code the server picks a five-digit one; with one, it's the code people type to join. */
export function createRoom(displayName: string, lifetimeMinutes: number, code?: string): Promise<RoomSession> {
  return request<RoomSession>("/rooms", {
    method: "POST",
    body: JSON.stringify({ display_name: displayName, lifetime_minutes: lifetimeMinutes, ...(code ? { code } : {}) }),
  });
}

export function joinRoom(code: string, displayName: string): Promise<RoomSession> {
  return request<RoomSession>("/rooms/join", {
    method: "POST",
    body: JSON.stringify({ code, display_name: displayName }),
  });
}

export function getRoom(roomId: string, token: string): Promise<RoomDetails> {
  return request<RoomDetails>(`/rooms/${roomId}`, {}, token);
}

export function leaveRoom(roomId: string, token: string): Promise<void> {
  return request<void>(`/rooms/${roomId}/leave`, { method: "DELETE" }, token);
}

export function getMessages(
  roomId: string,
  token: string,
  options: { limit?: number; before?: string; after?: string } = {},
): Promise<MessagePage> {
  const params = new URLSearchParams({ limit: String(options.limit ?? 50) });
  if (options.before) params.set("before", options.before);
  if (options.after) params.set("after", options.after);
  return request<MessagePage>(`/rooms/${roomId}/messages?${params}`, {}, token);
}

export function getFiles(roomId: string, token: string): Promise<FileList> {
  return request<FileList>(`/rooms/${roomId}/files`, {}, token);
}

/** Fetches a file through the API with the session header, so it can be shown or saved as a blob. */
export async function fetchFileBlob(roomId: string, token: string, fileId: string): Promise<Blob> {
  const response = await fetch(`${API}/rooms/${roomId}/files/${fileId}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!response.ok) {
    const body = await response.json().catch(() => null);
    throw new ApiError(response.status, messageFrom(body, "Couldn't download this file."), retryAfterFrom(response));
  }
  return response.blob();
}

/**
 * Uploads the raw file bytes (the API expects the body, not multipart) and reports progress.
 * XMLHttpRequest is used because fetch doesn't expose upload progress.
 */
export function uploadFile(
  roomId: string,
  token: string,
  file: File,
  onProgress: (fraction: number) => void,
): Promise<FileOut> {
  return new Promise<FileOut>((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open("POST", `${API}/rooms/${roomId}/files?name=${encodeURIComponent(file.name)}`);
    xhr.setRequestHeader("Authorization", `Bearer ${token}`);
    xhr.upload.onprogress = (event) => {
      if (event.lengthComputable) onProgress(event.loaded / event.total);
    };
    xhr.onload = () => {
      if (xhr.status >= 200 && xhr.status < 300) {
        resolve(JSON.parse(xhr.responseText) as FileOut);
        return;
      }
      let body: unknown = null;
      try {
        body = JSON.parse(xhr.responseText);
      } catch {
        body = null;
      }
      const retry = Number(xhr.getResponseHeader("Retry-After"));
      reject(new ApiError(xhr.status, messageFrom(body, "Upload failed."), retry > 0 ? retry : null));
    };
    xhr.onerror = () => reject(new ApiError(0, "Upload interrupted. Check your connection."));
    xhr.onabort = () => reject(new ApiError(0, "Upload cancelled."));
    xhr.send(file);
  });
}
