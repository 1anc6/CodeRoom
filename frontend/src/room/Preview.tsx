import { useEffect, useRef, useState } from "react";
import type { FileOut } from "../api/types";
import { Close, Download } from "../components/Icons";
import { formatBytes } from "../lib/format";
import { getFileUrl, isPreviewable, saveFile } from "./fileUrls";

interface PreviewProps {
  file: FileOut | null;
  roomId: string;
  token: string;
  onClose: () => void;
  onError: (message: string) => void;
}

/** A modal view of an image or video, using the native dialog for focus trapping and Escape. */
export function Preview({ file, roomId, token, onClose, onError }: PreviewProps) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const [url, setUrl] = useState<string | null>(null);

  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;
    if (file && !dialog.open) dialog.showModal();
    if (!file && dialog.open) dialog.close();
  }, [file]);

  useEffect(() => {
    setUrl(null);
    if (!file) return;
    let cancelled = false;
    getFileUrl(roomId, token, file.id)
      .then((u) => !cancelled && setUrl(u))
      .catch((error: unknown) => {
        if (cancelled) return;
        onError(error instanceof Error ? error.message : "Couldn't open this file.");
        onClose();
      });
    return () => {
      cancelled = true;
    };
  }, [file, roomId, token, onClose, onError]);

  const kind = file ? isPreviewable(file) : null;

  return (
    <dialog
      ref={dialogRef}
      className="preview"
      onClose={onClose}
      onClick={(e) => {
        // A click on the backdrop (the dialog itself, not its content) closes it.
        if (e.target === dialogRef.current) onClose();
      }}
      aria-label={file ? `Preview of ${file.name}` : "Preview"}
    >
      {file && (
        <div className="preview__inner">
          <div className="preview__bar">
            <span className="preview__name">
              <strong>{file.name}</strong>
              <span>
                {formatBytes(file.size_bytes)} · from {file.display_name}
              </span>
            </span>
            <button
              type="button"
              className="icon-btn"
              onClick={() => saveFile(roomId, token, file).catch(() => onError("Couldn't download this file."))}
              aria-label={`Download ${file.name}`}
            >
              <Download size={18} />
            </button>
            <button type="button" className="icon-btn" onClick={onClose} aria-label="Close preview">
              <Close size={18} />
            </button>
          </div>
          <div className="preview__media">
            {!url && <span className="preview__loading">Opening…</span>}
            {url && kind === "image" && <img src={url} alt={file.name} />}
            {url && kind === "video" && <video src={url} controls playsInline />}
          </div>
        </div>
      )}
    </dialog>
  );
}
