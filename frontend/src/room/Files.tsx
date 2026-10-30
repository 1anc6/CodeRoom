import { useRef } from "react";
import type { FileOut } from "../api/types";
import { Close, Paperclip } from "../components/Icons";
import { formatBytes } from "../lib/format";
import { FileRow } from "./FileRow";
import type { Upload } from "./useRoom";

const ROOM_STORAGE_BYTES = 100 * 1024 * 1024;

// The same allowlist the server enforces; the picker uses it as a hint, the server decides.
export const ACCEPT =
  "image/jpeg,image/png,image/gif,image/webp,image/heic,image/avif,application/pdf,.doc,.docx,.xls,.xlsx,.ppt,.pptx,.odt,.ods,.odp,.txt,.md,.csv,video/mp4,video/quicktime,video/webm,.mkv";

interface FilesProps {
  roomId: string;
  token: string;
  files: FileOut[];
  uploads: Upload[];
  disabled: boolean;
  onUpload: (files: File[]) => void;
  onDismissUpload: (id: string) => void;
  onPreview: (file: FileOut) => void;
  onError: (message: string) => void;
}

export function Files({ roomId, token, files, uploads, disabled, onUpload, onDismissUpload, onPreview, onError }: FilesProps) {
  const inputRef = useRef<HTMLInputElement>(null);
  const used = files.reduce((sum, f) => sum + f.size_bytes, 0);
  const fraction = Math.min(1, used / ROOM_STORAGE_BYTES);
  const newestFirst = [...files].reverse();

  return (
    <section className="panel files" aria-labelledby="files-title">
      <div className="panel__head">
        <h2 id="files-title" className="panel__title">
          Files
        </h2>
        <span className="panel__count tabular">{files.length}</span>
      </div>

      <div className="storage">
        <div className="storage__text">
          <span className="tabular">{formatBytes(used)} of 100 MB</span>
          <span className="storage__soft">25 MB a file</span>
        </div>
        <div
          className="storage__bar"
          role="progressbar"
          aria-label="Room storage used"
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={Math.round(fraction * 100)}
        >
          <span style={{ transform: `scaleX(${fraction})` }} />
        </div>
      </div>

      <button type="button" className="btn btn--quiet files__add" onClick={() => inputRef.current?.click()} disabled={disabled}>
        <Paperclip size={18} />
        Add files
      </button>
      <input
        ref={inputRef}
        type="file"
        multiple
        accept={ACCEPT}
        hidden
        onChange={(e) => {
          if (e.target.files?.length) onUpload(Array.from(e.target.files));
          e.target.value = "";
        }}
      />

      {uploads.length > 0 && (
        <ul className="uploads" aria-label="Uploads">
          {uploads.map((u) => (
            <li key={u.id} className={`upload${u.state === "failed" ? " is-failed" : ""}`}>
              <span className="upload__name" title={u.name}>
                {u.name}
              </span>
              {u.state === "failed" ? (
                <>
                  <span className="upload__error">{u.error}</span>
                  <button type="button" className="icon-btn icon-btn--small" onClick={() => onDismissUpload(u.id)} aria-label={`Dismiss ${u.name}`}>
                    <Close size={16} />
                  </button>
                </>
              ) : (
                <>
                  <span className="upload__pct tabular">{Math.round(u.progress * 100)}%</span>
                  <span className="upload__bar" aria-hidden="true">
                    <span style={{ transform: `scaleX(${u.progress})` }} />
                  </span>
                </>
              )}
            </li>
          ))}
        </ul>
      )}

      {files.length === 0 && uploads.length === 0 ? (
        <p className="panel__empty">
          Nothing shared yet. Photos, PDFs, documents, text and video up to 25 MB can go here, or drop them on the chat.
        </p>
      ) : (
        <ul className="files__list">
          {newestFirst.map((file) => (
            <li key={file.id}>
              <FileRow file={file} roomId={roomId} token={token} onPreview={onPreview} onError={onError} />
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
