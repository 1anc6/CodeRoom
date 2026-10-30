import { useEffect, useState } from "react";
import type { RoomSession } from "../api/types";
import { Wordmark } from "../components/Brand";
import { Door } from "../components/Icons";
import { formatClock, formatRemaining, parseServerTime } from "../lib/format";
import { CopyCode } from "./CopyCode";
import type { Connection } from "./useRoom";
import { useNow } from "./useNow";

const CONNECTION_TEXT: Record<Connection, string> = {
  connecting: "Connecting",
  live: "Live",
  reconnecting: "Reconnecting",
  ended: "Closed",
};

interface RoomHeaderProps {
  session: RoomSession;
  connection: Connection;
  onLeave: () => Promise<void>;
}

/**
 * One bar: the room's code as the page title, its connection and closing time, and the way out.
 * The time left runs along its bottom edge.
 */
export function RoomHeader({ session, connection, onLeave }: RoomHeaderProps) {
  const now = useNow(1000);
  const created = parseServerTime(session.room.created_at);
  const expires = parseServerTime(session.room.expires_at);
  const remaining = Math.max(0, expires - now);
  const fraction = expires > created ? remaining / (expires - created) : 0;
  const closingSoon = remaining < 10 * 60 * 1000;

  const [confirming, setConfirming] = useState(false);
  const [leaving, setLeaving] = useState(false);

  useEffect(() => {
    if (!confirming) return;
    const timer = window.setTimeout(() => setConfirming(false), 5000);
    return () => window.clearTimeout(timer);
  }, [confirming]);

  async function leave() {
    setLeaving(true);
    await onLeave();
    setLeaving(false);
    setConfirming(false);
  }

  return (
    <header className={`room-header${confirming ? " is-confirming" : ""}${closingSoon ? " is-soon" : ""}`}>
      <div className="room-header__brand">
        <Wordmark />
      </div>

      <div className="room-header__title">
        <h1 className="room-header__code tabular">
          <span className="room-header__label">Room</span> {session.code}
        </h1>
        <CopyCode code={session.code} className="room-header__copy" />
      </div>

      <p className="room-header__status">
        <span className={`conn conn--${connection}`} role="status">
          <span className="conn__dot" aria-hidden="true" />
          {CONNECTION_TEXT[connection]}
        </span>
        <span className="room-header__left tabular">
          {closingSoon ? "Closing in " : "Closes in "}
          {formatRemaining(remaining)}
        </span>
        <span className="room-header__at tabular">at {formatClock(session.room.expires_at)}</span>
      </p>

      <div className="room-header__end">
        {confirming ? (
          <span className="leave-confirm">
            <button type="button" className="btn btn--small" onClick={leave} disabled={leaving}>
              {leaving ? "Leaving…" : "Yes, leave"}
            </button>
            <button type="button" className="btn btn--small btn--quiet" onClick={() => setConfirming(false)}>
              Stay
            </button>
          </span>
        ) : (
          <button type="button" className="btn btn--small btn--quiet" onClick={() => setConfirming(true)}>
            <Door size={16} />
            Leave
          </button>
        )}
      </div>

      <div
        className="room-header__bar"
        role="progressbar"
        aria-label="Time left in this room"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={Math.round(fraction * 100)}
      >
        <span style={{ transform: `scaleX(${fraction})` }} />
      </div>
    </header>
  );
}
