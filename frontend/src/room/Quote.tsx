import { useState } from "react";
import type { FileOut, ReplyOut } from "../api/types";
import { useLazyFileUrl } from "./fileUrls";

interface QuoteProps {
  reply: ReplyOut;
  meId: string;
  files: FileOut[];
  roomId: string;
  token: string;
  /** Without it the quote is static (the composer's preview); with it, a click jumps to the original. */
  onJump?: (reply: ReplyOut) => void;
}

/** What a quoted file reads as: its kind for photos and videos, its name for anything else. */
function quotedText(reply: ReplyOut): string {
  if (reply.kind === "file" && reply.mime_type?.startsWith("image/")) return "Photo";
  if (reply.kind === "file" && reply.mime_type?.startsWith("video/")) return "Video";
  return reply.text;
}

/** The quoted message or file at the top of a reply, and above the composer while writing one. */
export function Quote({ reply, meId, files, roomId, token, onJump }: QuoteProps) {
  const who = reply.participant_id === meId ? "You" : reply.display_name;
  const file = reply.kind === "file" ? files.find((f) => f.id === reply.id) : undefined;
  const media = file && /^(image|video)\//.test(file.mime_type) ? file : undefined;

  const body = (
    <>
      <span className="quote__text">
        <span className="quote__name">{who}</span>
        <span className="quote__line">{quotedText(reply)}</span>
      </span>
      {media && <QuoteThumb file={media} roomId={roomId} token={token} />}
    </>
  );

  if (!onJump) return <div className="quote">{body}</div>;
  return (
    <button
      type="button"
      className="quote"
      onClick={() => onJump(reply)}
      aria-label={`Replying to ${who}: ${quotedText(reply)}. Show the original.`}
    >
      {body}
    </button>
  );
}

function QuoteThumb({ file, roomId, token }: { file: FileOut; roomId: string; token: string }) {
  const [el, setEl] = useState<HTMLSpanElement | null>(null);
  const url = useLazyFileUrl(roomId, token, file, el, true);
  const video = file.mime_type.startsWith("video/");
  return (
    <span ref={setEl} className="quote__thumb" aria-hidden="true">
      {url && (video ? <video src={url} muted playsInline preload="metadata" /> : <img src={url} alt="" />)}
    </span>
  );
}
