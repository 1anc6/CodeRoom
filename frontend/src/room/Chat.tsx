import { Fragment, useEffect, useLayoutEffect, useMemo, useRef, useState, type DragEvent, type ReactNode } from "react";
import type { FileOut, ReplyOut, RoomSession } from "../api/types";
import { ArrowUp, Close, Paperclip, Retry } from "../components/Icons";
import { formatClock, initials, parseServerTime, tintFor } from "../lib/format";
import { ACCEPT } from "./Files";
import { FileRow } from "./FileRow";
import { MediaMessage } from "./MediaMessage";
import { Quote } from "./Quote";
import { ReplyRow } from "./ReplyRow";
import { isPreviewable } from "./fileUrls";
import { MAX_MESSAGE_LENGTH, type ChatMessage, type Connection } from "./useRoom";

type Item = { kind: "msg"; at: number; message: ChatMessage } | { kind: "file"; at: number; file: FileOut };

const GROUP_GAP_MS = 5 * 60 * 1000;
const COMPOSER_MAX_HEIGHT = 168;
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

function senderOf(item: Item): string {
  return item.kind === "msg" ? item.message.participant_id : item.file.participant_id;
}

function rowId(kind: ReplyOut["kind"], id: string): string {
  return `${kind === "message" ? "m" : "f"}-${id}`;
}

function quoteMessage(m: ChatMessage): ReplyOut {
  return { kind: "message", id: m.id, participant_id: m.participant_id, display_name: m.display_name, text: m.content.slice(0, 200), mime_type: null };
}

function quoteFile(f: FileOut): ReplyOut {
  return { kind: "file", id: f.id, participant_id: f.participant_id, display_name: f.display_name, text: f.name, mime_type: f.mime_type };
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
  onSend: (text: string, replyTo: ReplyOut | null) => void;
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
  const [replyTo, setReplyTo] = useState<ReplyOut | null>(null);
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
    if (atBottomRef.current || senderOf(lastItem) === meId) {
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

  // Images load after they are placed, so a bottom-anchored view has to follow them down.
  function keepAtBottom() {
    if (atBottomRef.current) scrollToBottom();
  }

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
    el.style.height = `${Math.min(el.scrollHeight, COMPOSER_MAX_HEIGHT)}px`;
    // A scrollbar only once the text outgrows the box, not a stray one on a single line.
    el.style.overflowY = el.scrollHeight > COMPOSER_MAX_HEIGHT ? "auto" : "hidden";
  }

  useEffect(autosize, [draft]);

  function startReply(reply: ReplyOut) {
    setReplyTo(reply);
    textRef.current?.focus();
  }

  /** Brings the quoted original into view and marks it for a moment, as chat apps do. */
  function jumpTo(reply: ReplyOut) {
    const row = document.getElementById(rowId(reply.kind, reply.id));
    if (!row) {
      onError(hasOlder ? "That's further back. Show earlier messages to find it." : "That's no longer in the room.");
      return;
    }
    row.scrollIntoView({ block: "center", behavior: "smooth" });
    row.classList.remove("is-flash");
    void row.offsetWidth;
    row.classList.add("is-flash");
    window.setTimeout(() => row.classList.remove("is-flash"), 1600);
  }

  function send() {
    const text = draft.trim();
    if (!text || !live || text.length > MAX_MESSAGE_LENGTH) return;
    onSend(text, replyTo);
    setDraft("");
    setReplyTo(null);
    atBottomRef.current = true;
    textRef.current?.focus();
  }

  function hasFiles(e: DragEvent) {
    return Array.from(e.dataTransfer.types).includes("Files");
  }

  const remaining = MAX_MESSAGE_LENGTH - draft.length;
  const quoteProps = { meId, files, roomId, token: session.token };

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
            const sender = senderOf(item);
            const mine = sender === meId;
            const startsGroup = !prev || senderOf(prev) !== sender || item.at - prev.at > GROUP_GAP_MS;
            const name = item.kind === "msg" ? item.message.display_name : item.file.display_name;
            const avatar = !mine && (
              <span className="row__avatar" aria-hidden="true">
                {startsGroup && (
                  <span className="avatar" style={{ background: tintFor(sender) }}>
                    {initials(name)}
                  </span>
                )}
              </span>
            );
            const rowClass = startsGroup ? "is-first" : "";

            if (item.kind === "file") {
              const file = item.file;
              const kind = isPreviewable(file);
              return (
                <ReplyRow
                  key={`f-${file.id}`}
                  id={rowId("file", file.id)}
                  className={rowClass}
                  mine={mine}
                  label={`Reply to ${mine ? "your" : `${name}'s`} ${kind === "image" ? "photo" : kind === "video" ? "video" : "file"}`}
                  onReply={() => startReply(quoteFile(file))}
                >
                  {avatar}
                  {kind ? (
                    <MediaMessage
                      file={file}
                      kind={kind}
                      roomId={roomId}
                      token={session.token}
                      name={!mine && startsGroup ? name : undefined}
                      onPreview={onPreview}
                      onLoad={keepAtBottom}
                    />
                  ) : (
                    <div className="shared">
                      {!mine && startsGroup && <span className="shared__who">{name}</span>}
                      <FileRow
                        file={file}
                        roomId={roomId}
                        token={session.token}
                        onPreview={onPreview}
                        onError={onError}
                        variant="card"
                        showSender={false}
                      />
                    </div>
                  )}
                </ReplyRow>
              );
            }

            const m = item.message;
            const time = m.state === "pending" ? "Sending…" : m.state === "failed" ? "Not sent" : formatClock(m.created_at);
            return (
              <ReplyRow
                key={m.clientId ?? m.id}
                id={m.state ? undefined : rowId("message", m.id)}
                className={`${rowClass}${m.state ? ` is-${m.state}` : ""}`}
                mine={mine}
                label={`Reply to ${mine ? "your message" : name}`}
                onReply={m.state ? undefined : () => startReply(quoteMessage(m))}
              >
                {avatar}
                <div className="msg">
                  <div className={`bubble${m.reply_to ? " has-quote" : ""}`}>
                    {!mine && startsGroup && <span className="bubble__name">{name}</span>}
                    {m.reply_to && <Quote reply={m.reply_to} {...quoteProps} onJump={jumpTo} />}
                    <p className="bubble__text">
                      {withLinks(m.content)}
                      {/* Holds room on the last line for the time, which sits in the corner. */}
                      <span className="bubble__spacer" aria-hidden="true">
                        {time}
                      </span>
                    </p>
                    <span className="bubble__time tabular">{time}</span>
                  </div>
                  {m.state === "failed" && m.clientId && (
                    <button type="button" className="msg__retry" onClick={() => onRetry(m.clientId!)}>
                      <Retry size={14} />
                      {m.error ?? "Not sent."} Try again
                    </button>
                  )}
                </div>
              </ReplyRow>
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
        {replyTo && (
          <div className="composer__reply">
            <Quote reply={replyTo} {...quoteProps} />
            <button
              type="button"
              className="icon-btn icon-btn--small"
              onClick={() => {
                setReplyTo(null);
                textRef.current?.focus();
              }}
              aria-label="Cancel reply"
              title="Cancel reply"
            >
              <Close size={16} />
            </button>
          </div>
        )}
        <div className="composer__row">
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
          <div className="composer__field">
            <label htmlFor="composer-text" className="visually-hidden">
              {replyTo ? `Reply to ${replyTo.participant_id === meId ? "yourself" : replyTo.display_name}` : "Message"}
            </label>
            <textarea
              id="composer-text"
              ref={textRef}
              className="composer__text"
              rows={1}
              value={draft}
              placeholder={live ? (replyTo ? "Write a reply" : "Write to the room") : "Reconnecting, hold on…"}
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Escape" && replyTo) {
                  e.preventDefault();
                  setReplyTo(null);
                } else if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
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
          </div>
          <button
            type="submit"
            className="composer__send"
            disabled={!live || !draft.trim() || remaining < 0}
            aria-label={replyTo ? "Send reply" : "Send message"}
          >
            <ArrowUp size={20} />
          </button>
        </div>
      </form>

      {dragging && (
        <div className="chat__drop" aria-hidden="true">
          <span>Drop to share with the room</span>
        </div>
      )}
    </section>
  );
}
