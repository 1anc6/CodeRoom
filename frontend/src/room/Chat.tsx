import { Fragment, useEffect, useLayoutEffect, useMemo, useRef, useState, type DragEvent, type ReactNode } from "react";
import type { FileOut, RoomSession } from "../api/types";
import { ArrowUp, Paperclip, Retry } from "../components/Icons";
import { formatClock, initials, parseServerTime, tintFor } from "../lib/format";
import { ACCEPT } from "./Files";
import { FileRow } from "./FileRow";
import { MAX_MESSAGE_LENGTH, type ChatMessage, type Connection } from "./useRoom";

type Item = { kind: "msg"; at: number; message: ChatMessage } | { kind: "file"; at: number; file: FileOut };

const GROUP_GAP_MS = 5 * 60 * 1000;
const URL_PATTERN = /(https?:\/\/[^\s<>"']+[^\s<>"'.,;:!?)\]])/g;

/** Message text with web addresses turned into links. Content is always rendered as text. */
function withLinks(text: string): ReactNode[] {
  return text.split(URL_PATTERN).map((part, i) =>
    i % 2 === 1 ? (
      <a key={i} href={part} target="_blank" rel="noopener noreferrer nofollow">
        {part}
      </a>
    ) : (
      <Fragment key={i}>{part}</Fragment>
    ),
  );
}

interface ChatProps {
  session: RoomSession;
  connection: Connection;
  messages: ChatMessage[];
  files: FileOut[];
  historyLoaded: boolean;
  hasOlder: boolean;
  loadingOlder: boolean;
  onLoadOlder: () => Promise<void>;
  onSend: (text: string) => void;
  onRetry: (clientId: string) => void;
  onUpload: (files: File[]) => void;
  onPreview: (file: FileOut) => void;
  onError: (message: string) => void;
}

export function Chat({
  session,
  connection,
  messages,
  files,
  historyLoaded,
  hasOlder,
  loadingOlder,
  onLoadOlder,
  onSend,
  onRetry,
  onUpload,
  onPreview,
  onError,
}: ChatProps) {
  const meId = session.participant.id;
  const roomId = session.room.id;
  const live = connection === "live";

  const [draft, setDraft] = useState("");
  const [dragging, setDragging] = useState(false);
  const [unseen, setUnseen] = useState(0);
  const listRef = useRef<HTMLDivElement>(null);
  const textRef = useRef<HTMLTextAreaElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const atBottomRef = useRef(true);
  const restoreFromBottomRef = useRef<number | null>(null);
  const dragDepth = useRef(0);

  // Files only join the timeline once history is in, so they sit among the right messages.
  const items = useMemo<Item[]>(() => {
    const oldest = messages.find((m) => !m.state);
    const from = hasOlder && oldest ? parseServerTime(oldest.created_at) : -Infinity;
    const list: Item[] = [
      ...messages.map((message) => ({ kind: "msg" as const, at: parseServerTime(message.created_at), message })),
      ...(historyLoaded
        ? files
            .map((file) => ({ kind: "file" as const, at: parseServerTime(file.created_at), file }))
            .filter((item) => item.at >= from)
        : []),
    ];
    return list.sort((a, b) => a.at - b.at);
  }, [messages, files, historyLoaded, hasOlder]);

  const lastItem = items.at(-1);
  const lastKey = lastItem ? (lastItem.kind === "msg" ? lastItem.message.id : lastItem.file.id) : "";
  const firstKey = items[0] ? (items[0].kind === "msg" ? items[0].message.id : items[0].file.id) : "";

  function scrollToBottom(smooth = false) {
    const list = listRef.current;
    if (list) list.scrollTo({ top: list.scrollHeight, behavior: smooth ? "smooth" : "auto" });
  }

  // Older messages were added above: keep the view where it was.
  useLayoutEffect(() => {
    const list = listRef.current;
    if (list && restoreFromBottomRef.current !== null) {
      list.scrollTop = list.scrollHeight - restoreFromBottomRef.current;
      restoreFromBottomRef.current = null;
    }
  }, [firstKey]);

  // Something new at the bottom: follow it if we were already there or it's ours.
  useLayoutEffect(() => {
    if (!lastItem) return;
    const mine =
      (lastItem.kind === "msg" && lastItem.message.participant_id === meId) ||
      (lastItem.kind === "file" && lastItem.file.participant_id === meId);
    if (atBottomRef.current || mine) {
      scrollToBottom();
      setUnseen(0);
    } else {
      setUnseen((n) => n + 1);
    }
    // Only a change of the newest item matters here, not every re-render.
  }, [lastKey]);

  useEffect(() => {
    if (historyLoaded) scrollToBottom();
  }, [historyLoaded]);

  function onScroll() {
    const list = listRef.current;
    if (!list) return;
    atBottomRef.current = list.scrollHeight - list.scrollTop - list.clientHeight < 80;
    if (atBottomRef.current && unseen) setUnseen(0);
  }

  async function loadOlder() {
    const list = listRef.current;
    if (list) restoreFromBottomRef.current = list.scrollHeight - list.scrollTop;
    await onLoadOlder();
  }

  function autosize() {
    const el = textRef.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, 168)}px`;
  }

  useEffect(autosize, [draft]);

  function send() {
    const text = draft.trim();
    if (!text || !live || text.length > MAX_MESSAGE_LENGTH) return;
    onSend(text);
    setDraft("");
    atBottomRef.current = true;
    textRef.current?.focus();
  }

  function hasFiles(e: DragEvent) {
    return Array.from(e.dataTransfer.types).includes("Files");
  }

  const remaining = MAX_MESSAGE_LENGTH - draft.length;

  return (
    <section
      className={`chat${dragging ? " is-dragging" : ""}`}
      aria-label="Conversation"
      onDragEnter={(e) => {
        if (!hasFiles(e)) return;
        e.preventDefault();
        dragDepth.current += 1;
        setDragging(true);
      }}
      onDragOver={(e) => {
        if (hasFiles(e)) e.preventDefault();
      }}
      onDragLeave={() => {
        dragDepth.current = Math.max(0, dragDepth.current - 1);
        if (dragDepth.current === 0) setDragging(false);
      }}
      onDrop={(e) => {
        if (!hasFiles(e)) return;
        e.preventDefault();
        dragDepth.current = 0;
        setDragging(false);
        if (live && e.dataTransfer.files.length) onUpload(Array.from(e.dataTransfer.files));
      }}
    >
      <div className="chat__scroll" ref={listRef} onScroll={onScroll}>
        <div className="chat__inner" role="log" aria-live="polite" aria-relevant="additions">
          {hasOlder && (
            <button type="button" className="chat__older btn btn--small btn--quiet" onClick={loadOlder} disabled={loadingOlder}>
              {loadingOlder ? "Loading…" : "Show earlier messages"}
            </button>
          )}

          {!historyLoaded && <p className="chat__loading">Loading the conversation…</p>}

          {historyLoaded && !hasOlder && items.length > 0 && (
            <p className="chat__start">
              Room opened at {formatClock(session.room.created_at)}. It closes at {formatClock(session.room.expires_at)}, and
              everything here goes with it.
            </p>
          )}

          {historyLoaded && items.length === 0 && (
            <div className="chat__empty">
              <h2>It's quiet in here.</h2>
              <p>
                Read out <strong className="tabular">{session.code}</strong> so people can join, then say hello. Files you
                share show up here too.
              </p>
            </div>
          )}

          {items.map((item, index) => {
            const prev = items[index - 1];
            if (item.kind === "file") {
              const mine = item.file.participant_id === meId;
              return (
                <div key={`f-${item.file.id}`} className={`shared${mine ? " shared--mine" : ""}`}>
                  <span className="shared__who">
                    {mine ? "You" : item.file.display_name} shared a file · {formatClock(item.file.created_at)}
                  </span>
                  <FileRow
                    file={item.file}
                    roomId={roomId}
                    token={session.token}
                    onPreview={onPreview}
                    onError={onError}
                    variant="card"
                    showSender={false}
                  />
                </div>
              );
            }

            const m = item.message;
            const mine = m.participant_id === meId;
            const startsGroup =
              !prev ||
              prev.kind !== "msg" ||
              prev.message.participant_id !== m.participant_id ||
              item.at - prev.at > GROUP_GAP_MS;

            return (
              <div
                key={m.clientId ?? m.id}
                className={`msg${mine ? " msg--mine" : ""}${startsGroup ? " msg--first" : ""}${m.state ? ` is-${m.state}` : ""}`}
              >
                {!mine && (
                  <span className="msg__avatar" aria-hidden="true">
                    {startsGroup && (
                      <span className="avatar" style={{ background: tintFor(m.participant_id) }}>
                        {initials(m.display_name)}
                      </span>
                    )}
                  </span>
                )}
                <div className="msg__body">
                  {startsGroup && (
                    <span className="msg__meta">
                      {!mine && <strong>{m.display_name}</strong>}
                      <span>{m.state === "pending" ? "Sending…" : formatClock(m.created_at)}</span>
                    </span>
                  )}
                  <p className="msg__bubble">{withLinks(m.content)}</p>
                  {m.state === "failed" && m.clientId && (
                    <button type="button" className="msg__retry" onClick={() => onRetry(m.clientId!)}>
                      <Retry size={14} />
                      {m.error ?? "Not sent."} Try again
                    </button>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      </div>

      {unseen > 0 && (
        <button
          type="button"
          className="chat__jump btn btn--small"
          onClick={() => {
            scrollToBottom(true);
            setUnseen(0);
          }}
        >
          {unseen === 1 ? "1 new message" : `${unseen} new messages`}
        </button>
      )}

      <form
        className="composer"
        onSubmit={(e) => {
          e.preventDefault();
          send();
        }}
      >
        <button
          type="button"
          className="icon-btn composer__attach"
          onClick={() => fileInputRef.current?.click()}
          disabled={!live}
          aria-label="Share files"
          title="Share files"
        >
          <Paperclip size={20} />
        </button>
        <input
          ref={fileInputRef}
          type="file"
          multiple
          accept={ACCEPT}
          hidden
          onChange={(e) => {
            if (e.target.files?.length) onUpload(Array.from(e.target.files));
            e.target.value = "";
          }}
        />
        <label htmlFor="composer-text" className="visually-hidden">
          Message
        </label>
        <textarea
          id="composer-text"
          ref={textRef}
          className="composer__text"
          rows={1}
          value={draft}
          placeholder={live ? "Write to the room" : "Reconnecting, hold on…"}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
              e.preventDefault();
              send();
            }
          }}
          onPaste={(e) => {
            const pasted = Array.from(e.clipboardData.files);
            if (pasted.length && live) {
              e.preventDefault();
              onUpload(pasted);
            }
          }}
        />
        {remaining < 400 && (
          <span className={`composer__count tabular${remaining < 0 ? " is-over" : ""}`} aria-live="polite">
            {remaining}
          </span>
        )}
        <button
          type="submit"
          className="composer__send"
          disabled={!live || !draft.trim() || remaining < 0}
          aria-label="Send message"
        >
          <ArrowUp size={20} />
        </button>
      </form>

      {dragging && (
        <div className="chat__drop" aria-hidden="true">
          <span>Drop to share with the room</span>
        </div>
      )}
    </section>
  );
}
