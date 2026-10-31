import {
  Fragment,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type DragEvent,
  type MouseEvent,
  type ReactNode,
} from "react";
import type { FileOut, ReplyOut, RoomSession } from "../api/types";
import { ArrowUp, Check, Close, Copy, Paperclip, Pencil, Reply, Retry } from "../components/Icons";
import { formatClock, initials, parseServerTime, tintFor } from "../lib/format";
import { ACCEPT } from "./Files";
import { FileRow } from "./FileRow";
import { MediaMessage } from "./MediaMessage";
import { MessageMenu, type MenuAction } from "./MessageMenu";
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

/** Copies text with the Clipboard API, or with the older selection method where that API is off (plain http on a LAN). */
async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    // Fall through to the older method.
  }
  const field = document.createElement("textarea");
  field.value = text;
  field.setAttribute("readonly", "");
  field.style.position = "fixed";
  field.style.opacity = "0";
  document.body.appendChild(field);
  field.select();
  const copied = document.execCommand("copy");
  field.remove();
  return copied;
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
  onEdit: (messageId: string, text: string) => void;
  onRetry: (clientId: string) => void;
  onUpload: (files: File[]) => void;
  onPreview: (file: FileOut) => void;
  onError: (message: string) => void;
  onNotice: (message: string) => void;
  /** Names of the others typing right now. */
  typingNames: string[];
  onTyping: () => void;
}

function typingText(names: string[]): string {
  if (names.length === 1) return `${names[0]} is typing…`;
  if (names.length === 2) return `${names[0]} and ${names[1]} are typing…`;
  return `${names.length} people are typing…`;
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
  typingNames,
  onTyping,
  onError,
  onNotice,
  onEdit,
}: ChatProps) {
  const meId = session.participant.id;
  const roomId = session.room.id;
  const live = connection === "live";

  const [draft, setDraft] = useState("");
  const [replyTo, setReplyTo] = useState<ReplyOut | null>(null);
  // While set, the composer saves a change to this message instead of sending a new one.
  const [editing, setEditing] = useState<ChatMessage | null>(null);
  // The message whose actions are open, and the bubble they belong to.
  const [menu, setMenu] = useState<{ message: ChatMessage; anchor: HTMLElement } | null>(null);
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
    setMenu(null);
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

  // Editing starts with the cursor at the end of the text, ready to change it.
  useEffect(() => {
    const el = textRef.current;
    if (editing && el) {
      el.focus();
      el.setSelectionRange(el.value.length, el.value.length);
    }
  }, [editing]);

  const closeMenu = useCallback(() => setMenu(null), []);

  function startReply(reply: ReplyOut) {
    if (editing) cancelEdit();
    setReplyTo(reply);
    textRef.current?.focus();
  }

  function startEdit(message: ChatMessage) {
    setReplyTo(null);
    setEditing(message);
    setDraft(message.content);
  }

  function cancelEdit() {
    setEditing(null);
    setDraft("");
    textRef.current?.focus();
  }

  /** A tap on a message opens its actions, as in chat apps. Links, buttons and selected text keep their own use. */
  function openMenu(event: MouseEvent<HTMLDivElement>, message: ChatMessage) {
    if ((event.target as HTMLElement).closest("a, button") || window.getSelection()?.toString()) return;
    const anchor = event.currentTarget;
    setMenu((open) => (open?.message.id === message.id ? null : { message, anchor }));
  }

  async function copyMessage(message: ChatMessage) {
    if (await copyText(message.content)) onNotice("Copied to clipboard.");
    else onError("Couldn't copy from here. Select the text and copy it instead.");
  }

  function actionsFor(message: ChatMessage): MenuAction[] {
    const actions: MenuAction[] = [];
    if (!message.state) {
      actions.push({ label: "Reply", icon: <Reply size={18} />, run: () => startReply(quoteMessage(message)) });
    }
    actions.push({ label: "Copy", icon: <Copy size={18} />, run: () => void copyMessage(message) });
    // Only the author can change their words, and only once the message has really been sent.
    if (!message.state && message.participant_id === meId) {
      actions.push({ label: "Edit", icon: <Pencil size={18} />, run: () => startEdit(message) });
    }
    return actions;
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
    if (editing) {
      // Saving an edit changes a message in place, so the view stays where it is.
      if (text !== editing.content) onEdit(editing.id, text);
      setEditing(null);
    } else {
      onSend(text, replyTo);
      setReplyTo(null);
      atBottomRef.current = true;
    }
    setDraft("");
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
            const stamp = m.edited_at ? `Edited ${time}` : time;
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
                  <div
                    className={`bubble${m.reply_to ? " has-quote" : ""}`}
                    onClick={(event) => openMenu(event, m)}
                  >
                    {!mine && startsGroup && <span className="bubble__name">{name}</span>}
                    {m.reply_to && <Quote reply={m.reply_to} {...quoteProps} onJump={jumpTo} />}
                    <p className="bubble__text">
                      {withLinks(m.content)}
                      {/* Holds room on the last line for the time, which sits in the corner. */}
                      <span className="bubble__spacer" aria-hidden="true">
                        {stamp}
                      </span>
                    </p>
                    <span className="bubble__time tabular">{stamp}</span>
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
        {editing && (
          <div className="composer__reply composer__edit">
            <span className="composer__edit-label">
              <Pencil size={16} />
              Editing your message
            </span>
            <button type="button" className="icon-btn icon-btn--small" onClick={cancelEdit} aria-label="Cancel edit" title="Cancel edit">
              <Close size={16} />
            </button>
          </div>
        )}
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
        <p className="composer__typing" aria-live="polite">
          {typingNames.length > 0 && typingText(typingNames)}
        </p>
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
              {editing ? "Edit message" : replyTo ? `Reply to ${replyTo.participant_id === meId ? "yourself" : replyTo.display_name}` : "Message"}
            </label>
            <textarea
              id="composer-text"
              ref={textRef}
              className="composer__text"
              rows={1}
              value={draft}
              placeholder={live ? (editing ? "Edit your message" : replyTo ? "Write a reply" : "Write to the room") : "Reconnecting, hold on…"}
              onChange={(e) => {
                setDraft(e.target.value);
                if (e.target.value.trim()) onTyping();
              }}
              onKeyDown={(e) => {
                if (e.key === "Escape" && editing) {
                  e.preventDefault();
                  cancelEdit();
                } else if (e.key === "Escape" && replyTo) {
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
            aria-label={editing ? "Save edit" : replyTo ? "Send reply" : "Send message"}
          >
            {editing ? <Check size={20} /> : <ArrowUp size={20} />}
          </button>
        </div>
      </form>

      {menu && (
        <MessageMenu
          anchor={menu.anchor}
          mine={menu.message.participant_id === meId}
          actions={actionsFor(menu.message)}
          onClose={closeMenu}
        />
      )}

      {dragging && (
        <div className="chat__drop" aria-hidden="true">
          <span>Drop to share with the room</span>
        </div>
      )}
    </section>
  );
}
