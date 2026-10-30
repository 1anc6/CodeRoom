import { useState } from "react";
import type { FileOut } from "../api/types";
import { Download } from "../components/Icons";
import { formatBytes, formatClock } from "../lib/format";
import { isPreviewable, saveFile, typeLabel, useThumbnail } from "./fileUrls";

interface FileRowProps {
  file: FileOut;
  roomId: string;
  token: string;
  onPreview: (file: FileOut) => void;
  onError: (message: string) => void;
  variant?: "list" | "card";
  showSender?: boolean;
}

/** One shared file: thumbnail or type, name, size and sender, with preview and download. */
export function FileRow({ file, roomId, token, onPreview, onError, variant = "list", showSender = true }: FileRowProps) {
  const [thumbEl, setThumbEl] = useState<HTMLSpanElement | null>(null);
  const thumb = useThumbnail(roomId, token, file, thumbEl);
  const [saving, setSaving] = useState(false);
  const previewable = isPreviewable(file);

  async function download() {
    setSaving(true);
    try {
      await saveFile(roomId, token, file);
    } catch (error) {
      onError(error instanceof Error ? error.message : "Couldn't download this file.");
    } finally {
      setSaving(false);
    }
  }

  const visual = (
    <span ref={setThumbEl} className={`file__thumb${thumb ? " has-image" : ""}`} aria-hidden="true">
      {thumb ? <img src={thumb} alt="" /> : typeLabel(file)}
    </span>
  );

  return (
    <div className={`file file--${variant}`}>
      {previewable ? (
        <button type="button" className="file__open" onClick={() => onPreview(file)} aria-label={`Preview ${file.name}`}>
          {visual}
        </button>
      ) : (
        visual
      )}
      <span className="file__text">
        {previewable ? (
          <button type="button" className="file__name" onClick={() => onPreview(file)} title={file.name}>
            {file.name}
          </button>
        ) : (
          <span className="file__name" title={file.name}>
            {file.name}
          </span>
        )}
        <span className="file__meta">
          {formatBytes(file.size_bytes)}
          {showSender && ` · ${file.display_name}`} · {formatClock(file.created_at)}
        </span>
      </span>
      <button
        type="button"
        className="icon-btn"
        onClick={download}
        disabled={saving}
        aria-label={`Download ${file.name}`}
        title="Download"
      >
        <Download size={18} />
      </button>
    </div>
  );
}
