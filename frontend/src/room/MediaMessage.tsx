import { useState } from "react";
import type { FileOut } from "../api/types";
import { Play } from "../components/Icons";
import { formatClock, formatDuration } from "../lib/format";
import { useLazyFileUrl } from "./fileUrls";

interface MediaMessageProps {
  file: FileOut;
  kind: "image" | "video";
  roomId: string;
  token: string;
  /** The sender's name, shown above the first item someone else sends in a run. */
  name?: string;
  onPreview: (file: FileOut) => void;
  onLoad: () => void;
}

/**
 * A shared photo or video shown in the conversation itself, like media in a chat app.
 * A click opens it full size, where videos have their controls.
 */
export function MediaMessage({ file, kind, roomId, token, name, onPreview, onLoad }: MediaMessageProps) {
  const [buttonEl, setButtonEl] = useState<HTMLButtonElement | null>(null);
  const url = useLazyFileUrl(roomId, token, file, buttonEl, true);
  const [duration, setDuration] = useState<number | null>(null);

  function onMetadata(seconds: number) {
    // Some recordings (a browser's own WebM, for one) report no length, which shows as Infinity.
    setDuration(Number.isFinite(seconds) ? seconds : null);
    onLoad();
  }

  return (
    <div className="shared shared--media">
      {name && <span className="shared__who">{name}</span>}
      <button
        ref={setButtonEl}
        type="button"
        className="photo"
        onClick={() => onPreview(file)}
        aria-label={`Open ${file.name}`}
      >
        {url && kind === "image" && <img src={url} alt="" onLoad={onLoad} />}
        {url && kind === "video" && (
          <video
            src={url}
            muted
            playsInline
            preload="metadata"
            aria-hidden="true"
            tabIndex={-1}
            onLoadedMetadata={(e) => onMetadata(e.currentTarget.duration)}
          />
        )}
        {!url && <span className="photo__placeholder" aria-hidden="true" />}
        {kind === "video" && (
          <span className="photo__play" aria-hidden="true">
            <Play size={22} />
          </span>
        )}
        <span className="photo__time tabular">
          {kind === "video" && duration !== null && `${formatDuration(duration)} · `}
          {formatClock(file.created_at)}
        </span>
      </button>
    </div>
  );
}
