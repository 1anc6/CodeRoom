import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Navigate, useNavigate, useParams } from "react-router-dom";
import type { FileOut, RoomSession } from "../api/types";
import { Wordmark } from "../components/Brand";
import { Close } from "../components/Icons";
import { Chat } from "../room/Chat";
import { Files } from "../room/Files";
import { releaseRoomUrls } from "../room/fileUrls";
import { People } from "../room/People";
import { Present } from "../room/Present";
import { Preview } from "../room/Preview";
import { RoomHeader } from "../room/RoomHeader";
import { useRoom, type EndReason } from "../room/useRoom";
import { clearSession, loadSession } from "../session";

type Panel = "chat" | "files" | "people";

export function RoomPage() {
  const { roomId } = useParams();
  const session = useMemo(() => loadSession(), []);

  if (!session || session.room.id !== roomId) {
    return (
      <Navigate
        to="/"
        replace
        state={{ mode: "join", hint: "Type the room's code to come in. Each browser tab joins as its own person." }}
      />
    );
  }
  return <Room session={session} />;
}

function Room({ session }: { session: RoomSession }) {
  const room = useRoom(session);
  // The session with the room as it stands now (the host may have extended or locked it).
  const live = useMemo(() => ({ ...session, room: room.room }), [session, room.room]);
  const [presenting, setPresenting] = useState(false);
  const [panel, setPanel] = useState<Panel>("chat");
  const [side, setSide] = useState<Exclude<Panel, "chat">>("files");
  const [preview, setPreview] = useState<FileOut | null>(null);
  const [unread, setUnread] = useState(0);
  const seenCount = useRef(0);

  const closePreview = useCallback(() => setPreview(null), []);
  const closePresent = useCallback(() => setPresenting(false), []);
  const people = (
    <People
      session={live}
      members={room.members}
      isHost={room.isHost}
      onPresent={() => setPresenting(true)}
      onRemove={room.removeMember}
      onExtend={room.extend}
      onLock={room.setLocked}
    />
  );
  const showError = room.flash;

  useEffect(() => () => releaseRoomUrls(session.room.id), [session.room.id]);

  // Count other people's messages that arrive while this tab is in the background.
  useEffect(() => {
    const fresh = room.messages.slice(seenCount.current);
    seenCount.current = room.messages.length;
    if (document.hidden && fresh.some((m) => m.participant_id !== session.participant.id && !m.state)) {
      setUnread((n) => n + fresh.filter((m) => m.participant_id !== session.participant.id).length);
    }
  }, [room.messages, session.participant.id]);

  useEffect(() => {
    const onVisible = () => document.visibilityState === "visible" && setUnread(0);
    document.addEventListener("visibilitychange", onVisible);
    return () => document.removeEventListener("visibilitychange", onVisible);
  }, []);

  useEffect(() => {
    document.title = room.endReason ? "CodeRoom" : `${unread ? `(${unread}) ` : ""}Room ${session.code} · CodeRoom`;
    return () => {
      document.title = "CodeRoom";
    };
  }, [unread, session.code, room.endReason]);

  if (room.endReason) return <RoomEnded reason={room.endReason} code={session.code} />;

  const peopleHere = room.members.filter((m) => m.online).length;
  const tabs: Array<[Panel, string]> = [
    ["chat", "Chat"],
    ["files", `Files ${room.files.length || ""}`.trim()],
    ["people", `People ${peopleHere || ""}`.trim()],
  ];

  return (
    <div className="room" data-panel={panel} data-side={side}>
      <RoomHeader
        session={live}
        connection={room.connection}
        onLeave={room.leave}
        onPresent={() => setPresenting(true)}
      />

      <nav className="room__tabs" aria-label="Room sections">
        {tabs.map(([id, label]) => (
          <button key={id} type="button" aria-pressed={panel === id} onClick={() => setPanel(id)}>
            {label}
          </button>
        ))}
      </nav>

      <div className="room__body">
        <div className="room__people">{people}</div>

        <div className="room__chat">
          <Chat
            session={live}
            connection={room.connection}
            messages={room.messages}
            files={room.files}
            historyLoaded={room.historyLoaded}
            hasOlder={room.hasOlder}
            loadingOlder={room.loadingOlder}
            onLoadOlder={room.loadOlder}
            onSend={room.sendMessage}
            onRetry={room.retryMessage}
            onUpload={room.uploadFiles}
            onPreview={setPreview}
            onError={showError}
            typingNames={room.typingNames}
            onTyping={room.notifyTyping}
          />
        </div>

        <div className="room__side">
          <nav className="room__sidetabs" aria-label="Side panel">
            <button type="button" aria-pressed={side === "files"} onClick={() => setSide("files")}>
              Files
            </button>
            <button type="button" aria-pressed={side === "people"} onClick={() => setSide("people")}>
              People
            </button>
          </nav>
          <div className="room__files">
            <Files
              roomId={session.room.id}
              token={session.token}
              files={room.files}
              uploads={room.uploads}
              disabled={room.connection === "ended"}
              onUpload={room.uploadFiles}
              onDismissUpload={room.dismissUpload}
              onPreview={setPreview}
              onError={showError}
              onDownloadAll={room.downloadAll}
            />
          </div>
          <div className="room__side-people">{people}</div>
        </div>
      </div>

      {room.notice && (
        <div className="toast" role="status">
          <span>{room.notice}</span>
          <button type="button" className="icon-btn icon-btn--small" onClick={room.dismissNotice} aria-label="Dismiss">
            <Close size={16} />
          </button>
        </div>
      )}

      {presenting && <Present code={session.code} room={room.room} onClose={closePresent} />}

      <Preview file={preview} roomId={session.room.id} token={session.token} onClose={closePreview} onError={showError} />
    </div>
  );
}

const ENDED: Record<EndReason, { title: string; body: (code: string) => string }> = {
  expired: {
    title: "This room has closed.",
    body: (code) =>
      `Its time ran out. Messages and files are being deleted, nobody can get back in, and ${code} is free for a new room.`,
  },
  left: {
    title: "You've left the room.",
    body: (code) =>
      `Your place in it is gone. While it's still open you can come back as a new arrival with the code ${code}.`,
  },
  removed: {
    title: "You've been asked to leave.",
    body: () => "Whoever opened the room removed you from it. If you think that was a mistake, ask them for the code again.",
  },
  invalid: {
    title: "This room isn't open to this tab.",
    body: () => "The session saved here no longer works. If the room is still open, join again with its code.",
  },
};

function RoomEnded({ reason, code }: { reason: EndReason; code: string }) {
  const navigate = useNavigate();
  const copy = ENDED[reason];

  useEffect(() => {
    clearSession();
  }, []);

  return (
    <div className="ended">
      <header className="ended__top">
        <Wordmark />
      </header>
      <main className="ended__main">
        <div className="ended__card">
          <span className="ended__code tabular" aria-hidden="true">
            {code.split("").map((d, i) => (
              <span key={i}>{d}</span>
            ))}
          </span>
          <h1>{copy.title}</h1>
          <p>{copy.body(code)}</p>
          <div className="ended__actions">
            <button type="button" className="btn" onClick={() => navigate("/", { state: { mode: "create" } })}>
              Open a new room
            </button>
            <button
              type="button"
              className="btn btn--quiet"
              onClick={() => navigate("/", { state: { mode: "join" } })}
            >
              Join with a code
            </button>
          </div>
        </div>
      </main>
    </div>
  );
}
