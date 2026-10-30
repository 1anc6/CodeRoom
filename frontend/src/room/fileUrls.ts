import { useEffect, useState } from "react";
import { fetchFileBlob } from "../api/client";
import type { FileOut } from "../api/types";

// Downloads need the session header, so files are fetched once and shown through blob URLs.
// URLs are cached per room and released when the room screen goes away.
const cache = new Map<string, Promise<string>>();

function key(roomId: string, fileId: string): string {
  return `${roomId}:${fileId}`;
}

export function getFileUrl(roomId: string, token: string, fileId: string): Promise<string> {
  const k = key(roomId, fileId);
  let pending = cache.get(k);
  if (!pending) {
    pending = fetchFileBlob(roomId, token, fileId).then((blob) => URL.createObjectURL(blob));
    pending.catch(() => cache.delete(k));
    cache.set(k, pending);
  }
  return pending;
}

export function releaseRoomUrls(roomId: string): void {
  for (const [k, pending] of cache) {
    if (k.startsWith(`${roomId}:`)) {
      pending.then((url) => URL.revokeObjectURL(url)).catch(() => undefined);
      cache.delete(k);
    }
  }
}

export async function saveFile(roomId: string, token: string, file: FileOut): Promise<void> {
  const url = await getFileUrl(roomId, token, file.id);
  const link = document.createElement("a");
  link.href = url;
  link.download = file.name;
  document.body.appendChild(link);
  link.click();
  link.remove();
}

export function isPreviewable(file: FileOut): "image" | "video" | null {
  if (file.mime_type.startsWith("image/") && file.mime_type !== "image/heic") return "image";
  if (file.mime_type === "video/mp4" || file.mime_type === "video/webm") return "video";
  return null;
}

/** A blob URL for an image thumbnail, fetched only once the element is near the viewport. */
export function useThumbnail(roomId: string, token: string, file: FileOut, element: HTMLElement | null): string | null {
  const [url, setUrl] = useState<string | null>(null);
  const wanted = isPreviewable(file) === "image";

  useEffect(() => {
    if (!wanted || !element) return;
    let cancelled = false;
    const load = () =>
      getFileUrl(roomId, token, file.id)
        .then((u) => !cancelled && setUrl(u))
        .catch(() => undefined);

    if (!("IntersectionObserver" in window)) {
      void load();
      return () => {
        cancelled = true;
      };
    }
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((e) => e.isIntersecting)) {
          observer.disconnect();
          void load();
        }
      },
      { rootMargin: "200px" },
    );
    observer.observe(element);
    return () => {
      cancelled = true;
      observer.disconnect();
    };
  }, [roomId, token, file.id, wanted, element]);

  return url;
}

/** A short type label from the file's own extension, falling back to its detected type. */
export function typeLabel(file: FileOut): string {
  const ext = file.name.includes(".") ? file.name.split(".").pop() ?? "" : "";
  if (ext && ext.length <= 4) return ext.toUpperCase();
  const sub = file.mime_type.split("/")[1] ?? "file";
  return sub.slice(0, 4).toUpperCase();
}
