import { useCallback, useEffect, useRef, useState } from "react";
import { ApiError, getFiles, getMessages, leaveRoom, roomSocketUrl, uploadFile } from "../api/client";
import type { FileOut, MemberOut, MessageOut, ReplyOut, RoomSession, ServerFrame } from "../api/types";
import { makeId, parseServerTime } from "../lib/format";

export const MAX_MESSAGE_LENGTH = 4000;
export const MAX_FILE_BYTES = 25 * 1024 * 1024;

export type Connection = "connecting" | "live" | "reconnecting" | "ended";
export type EndReason = "left" | "expired" | "invalid";

export interface ChatMessage extends MessageOut {
  clientId?: string;
  state?: "pending" | "failed";
  error?: string;
}

export interface Upload {
  id: string;
  name: string;
  size: number;
  progress: number;
  state: "uploading" | "failed";
  error?: string;
}

// Close codes after which reconnecting would not help (see the README's WebSocket section).
const CLOSE_LEFT = 1000;
const CLOSE_UNAUTHORIZED = 4401;
const CLOSE_EXPIRED = 4410;
const CLOSE_TOO_MANY = 4429;
const PING_INTERVAL_MS = 25_000;

function endReasonForStatus(status: number): EndReason | null {
  if (status === 410) return "expired";
  if (status === 401 || status === 403 || status === 404) return "invalid";
  return null;
}

function appendUnique(list: ChatMessage[], incoming: MessageOut[]): ChatMessage[] {
  const seen = new Set(list.map((m) => m.id));
  const fresh = incoming.filter((m) => !seen.has(m.id));
  return fresh.length ? [...list, ...fresh] : list;
}

/**
 * Everything a room screen needs: history, live events, members and their presence, files and
 * uploads, and the moment the room ends. One WebSocket per mounted room, reconnected with backoff.
 */
export function useRoom(session: RoomSession) {
  const roomId = session.room.id;
  const token = session.token;

  const [connection, setConnection] = useState<Connection>("connecting");
  const [endReason, setEndReason] = useState<EndReason | null>(null);
  const [members, setMembers] = useState<MemberOut[]>([]);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [historyLoaded, setHistoryLoaded] = useState(false);
  const [hasOlder, setHasOlder] = useState(false);
  const [loadingOlder, setLoadingOlder] = useState(false);
  const [files, setFiles] = useState<FileOut[]>([]);
  const [uploads, setUploads] = useState<Upload[]>([]);
  const [notice, setNotice] = useState<string | null>(null);

  const socketRef = useRef<WebSocket | null>(null);
  const messagesRef = useRef<ChatMessage[]>([]);
  messagesRef.current = messages;
  const endedRef = useRef(false);

  const end = useCallback((reason: EndReason) => {
    endedRef.current = true;
    setEndReason((current) => current ?? reason);
    setConnection("ended");
    socketRef.current?.close();
  }, []);

  const flash = useCallback((text: string) => setNotice(text), []);

  useEffect(() => {
    if (!notice) return;
    const timer = window.setTimeout(() => setNotice(null), 4500);
    return () => window.clearTimeout(timer);
  }, [notice]);

  const failRequest = useCallback(
    (error: unknown) => {
      if (error instanceof ApiError) {
        const reason = endReasonForStatus(error.status);
        if (reason) {
          end(reason);
          return;
        }
        flash(error.message);
      } else {
        flash("Something went wrong. Try again.");
      }
    },
    [end, flash],
  );

  /** The newest confirmed message id, used to fetch anything missed while disconnected. */
  const lastConfirmedId = useCallback((): string | undefined => {
    const list = messagesRef.current;
    for (let i = list.length - 1; i >= 0; i--) {
      if (!list[i].state) return list[i].id;
    }
    return undefined;
  }, []);

  const catchUp = useCallback(async () => {
    const after = lastConfirmedId();
    try {
      let page = await getMessages(roomId, token, after ? { after, limit: 100 } : { limit: 50 });
      setMessages((list) => appendUnique(list, page.messages));
      // Keep paging forward until we're level with the server.
      let cursor = page.messages.at(-1)?.id;
      while (after && page.has_more && cursor) {
        page = await getMessages(roomId, token, { after: cursor, limit: 100 });
        setMessages((list) => appendUnique(list, page.messages));
        cursor = page.messages.at(-1)?.id;
      }
      if (!after) setHasOlder(page.has_more);
      setHistoryLoaded(true);
    } catch (error) {
      failRequest(error);
    }
  }, [roomId, token, lastConfirmedId, failRequest]);

  const handleFrame = useCallback(
    (frame: ServerFrame) => {
      switch (frame.type) {
        case "ready":
          setConnection("live");
          setMembers(frame.participants);
          void catchUp();
          break;
        case "message.new": {
          const { message, client_id } = frame;
          setMessages((list) => {
            if (client_id) {
              const index = list.findIndex((m) => m.clientId === client_id);
              if (index !== -1) {
                const next = list.slice();
                next[index] = { ...message };
                return next;
              }
            }
            return list.some((m) => m.id === message.id) ? list : [...list, message];
          });
          break;
        }
        case "error":
          if (frame.client_id) {
            setMessages((list) =>
              list.map((m) => (m.clientId === frame.client_id ? { ...m, state: "failed", error: frame.detail } : m)),
            );
          } else {
            flash(frame.detail);
          }
          break;
        case "participant.joined":
          setMembers((list) =>
            list.some((m) => m.id === frame.participant.id) ? list : [...list, { ...frame.participant, online: false }],
          );
          break;
        case "participant.left":
          setMembers((list) => list.filter((m) => m.id !== frame.participant_id));
          break;
        case "presence":
          setMembers((list) => list.map((m) => (m.id === frame.participant_id ? { ...m, online: frame.online } : m)));
          break;
        case "file.ready":
          setFiles((list) => (list.some((f) => f.id === frame.file.id) ? list : [...list, frame.file]));
          break;
        case "room.expired":
          end("expired");
          break;
        case "pong":
          break;
      }
    },
    [catchUp, end, flash],
  );

  // Initial files, then the live connection (which loads message history once it's ready).
  useEffect(() => {
    endedRef.current = false;
    let disposed = false;
    let attempts = 0;
    let retryTimer: number | undefined;
    let pingTimer: number | undefined;

    getFiles(roomId, token)
      .then((list) => !disposed && setFiles(list.files))
      .catch((error) => !disposed && failRequest(error));

    const connect = () => {
      if (disposed || endedRef.current) return;
      const ws = new WebSocket(roomSocketUrl(roomId));
      socketRef.current = ws;

      ws.onopen = () => {
        ws.send(JSON.stringify({ type: "auth", token }));
        pingTimer = window.setInterval(() => {
          if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: "ping" }));
        }, PING_INTERVAL_MS);
      };
      ws.onmessage = (event) => {
        let frame: ServerFrame;
        try {
          frame = JSON.parse(event.data as string) as ServerFrame;
        } catch {
          return;
        }
        if (frame.type === "ready") attempts = 0;
        handleFrame(frame);
      };
      ws.onclose = (event) => {
        window.clearInterval(pingTimer);
        if (socketRef.current === ws) socketRef.current = null;
        if (disposed || endedRef.current) return;
        if (event.code === CLOSE_EXPIRED) return end("expired");
        if (event.code === CLOSE_UNAUTHORIZED) return end("invalid");
        if (event.code === CLOSE_LEFT) return end("left");
        if (event.code === CLOSE_TOO_MANY) {
          flash("This room is open in too many tabs. Close one and this tab will reconnect.");
          attempts = Math.max(attempts, 4);
        }
        setConnection("reconnecting");
        const delay = Math.min(15_000, 1000 * 2 ** attempts) + Math.random() * 400;
        attempts += 1;
        retryTimer = window.setTimeout(connect, delay);
      };
    };

    connect();

    // A tab coming back to the foreground reconnects at once instead of waiting out the backoff.
    const onVisible = () => {
      if (document.visibilityState === "visible" && !socketRef.current && !endedRef.current) {
        window.clearTimeout(retryTimer);
        attempts = 0;
        connect();
      }
    };
    document.addEventListener("visibilitychange", onVisible);

    return () => {
      disposed = true;
      window.clearTimeout(retryTimer);
      window.clearInterval(pingTimer);
      document.removeEventListener("visibilitychange", onVisible);
      socketRef.current?.close();
      socketRef.current = null;
    };
  }, [roomId, token, handleFrame, failRequest, end, flash]);

  // The room closes at its expiry time even if the server's notice is missed.
  useEffect(() => {
    const remaining = parseServerTime(session.room.expires_at) - Date.now();
    if (remaining <= 0) {
      end("expired");
      return;
    }
    // setTimeout can't wait longer than ~24.8 days; rooms last at most 8 hours.
    const timer = window.setTimeout(() => end("expired"), remaining);
    return () => window.clearTimeout(timer);
  }, [session.room.expires_at, end]);

  const transmit = useCallback((clientId: string, content: string, replyTo: ReplyOut | null): boolean => {
    const ws = socketRef.current;
    if (!ws || ws.readyState !== WebSocket.OPEN) return false;
    const reply_to = replyTo ? { kind: replyTo.kind, id: replyTo.id } : undefined;
    ws.send(JSON.stringify({ type: "message.send", content, client_id: clientId, reply_to }));
    return true;
  }, []);

  const sendMessage = useCallback(
    (raw: string, replyTo: ReplyOut | null = null) => {
      const content = raw.trim();
      if (!content || content.length > MAX_MESSAGE_LENGTH) return;
      const clientId = makeId();
      const sent = transmit(clientId, content, replyTo);
      setMessages((list) => [
        ...list,
        {
          id: `pending-${clientId}`,
          clientId,
          participant_id: session.participant.id,
          display_name: session.participant.display_name,
          content,
          created_at: new Date().toISOString(),
          reply_to: replyTo,
          state: sent ? "pending" : "failed",
          error: sent ? undefined : "Not connected. Tap to retry.",
        },
      ]);
    },
    [transmit, session.participant.id, session.participant.display_name],
  );

  const retryMessage = useCallback(
    (clientId: string) => {
      const message = messagesRef.current.find((m) => m.clientId === clientId);
      if (!message) return;
      const sent = transmit(clientId, message.content, message.reply_to);
      setMessages((list) =>
        list.map((m) =>
          m.clientId === clientId
            ? { ...m, state: sent ? "pending" : "failed", error: sent ? undefined : "Still not connected." }
            : m,
        ),
      );
    },
    [transmit],
  );

  const loadOlder = useCallback(async () => {
    const oldest = messagesRef.current.find((m) => !m.state);
    if (!oldest || loadingOlder) return;
    setLoadingOlder(true);
    try {
      const page = await getMessages(roomId, token, { before: oldest.id, limit: 50 });
      setMessages((list) => {
        const seen = new Set(list.map((m) => m.id));
        return [...page.messages.filter((m) => !seen.has(m.id)), ...list];
      });
      setHasOlder(page.has_more);
    } catch (error) {
      failRequest(error);
    } finally {
      setLoadingOlder(false);
    }
  }, [roomId, token, loadingOlder, failRequest]);

  const uploadFiles = useCallback(
    async (picked: File[]) => {
      // One at a time: the server allows ten uploads a minute per person.
      for (const file of picked) {
        const id = makeId();
        if (file.size > MAX_FILE_BYTES) {
          setUploads((list) => [
            ...list,
            { id, name: file.name, size: file.size, progress: 0, state: "failed", error: "Larger than 25 MB" },
          ]);
          continue;
        }
        setUploads((list) => [...list, { id, name: file.name, size: file.size, progress: 0, state: "uploading" }]);
        try {
          const stored = await uploadFile(roomId, token, file, (progress) =>
            setUploads((list) => list.map((u) => (u.id === id ? { ...u, progress } : u))),
          );
          setFiles((list) => (list.some((f) => f.id === stored.id) ? list : [...list, stored]));
          setUploads((list) => list.filter((u) => u.id !== id));
        } catch (error) {
          if (error instanceof ApiError && endReasonForStatus(error.status) && error.status !== 404) {
            failRequest(error);
            return;
          }
          const message = error instanceof ApiError ? error.message : "Upload failed.";
          setUploads((list) => list.map((u) => (u.id === id ? { ...u, state: "failed", error: message } : u)));
        }
      }
    },
    [roomId, token, failRequest],
  );

  const dismissUpload = useCallback((id: string) => {
    setUploads((list) => list.filter((u) => u.id !== id));
  }, []);

  const leave = useCallback(async () => {
    try {
      await leaveRoom(roomId, token);
    } catch (error) {
      // An expired or already-revoked session has left in effect.
      if (!(error instanceof ApiError && endReasonForStatus(error.status))) {
        failRequest(error);
        return;
      }
    }
    end("left");
  }, [roomId, token, end, failRequest]);

  return {
    connection,
    endReason,
    members,
    messages,
    historyLoaded,
    hasOlder,
    loadingOlder,
    files,
    uploads,
    notice,
    flash,
    dismissNotice: () => setNotice(null),
    sendMessage,
    retryMessage,
    loadOlder,
    uploadFiles,
    dismissUpload,
    leave,
  };
}

export type RoomState = ReturnType<typeof useRoom>;
