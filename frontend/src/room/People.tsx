import { useEffect, useState } from "react";
import type { MemberOut, RoomSession } from "../api/types";
import { Clock, Close, Lock, Unlock } from "../components/Icons";
import { initials, tintFor } from "../lib/format";
import { CopyCode } from "./CopyCode";
import { joinLink } from "./QrCode";

interface PeopleProps {
  session: RoomSession;
  members: MemberOut[];
  isHost: boolean;
  onRemove: (participantId: string) => Promise<void>;
  onExtend: (minutes: number) => Promise<void>;
  onLock: (locked: boolean) => Promise<void>;
}

const EXTEND_MINUTES = 30;

export function People({ session, members, isHost, onRemove, onExtend, onLock }: PeopleProps) {
  const meId = session.participant.id;
  const locked = session.room.locked;
  // Me first, then whoever is here now, then the rest by name.
  const sorted = [...members].sort((a, b) => {
    if (a.id === meId) return -1;
    if (b.id === meId) return 1;
    if (a.online !== b.online) return a.online ? -1 : 1;
    return a.display_name.localeCompare(b.display_name);
  });
  const here = members.filter((m) => m.online).length;

  // Removing someone takes a second tap on the same button.
  const [confirming, setConfirming] = useState<string | null>(null);
  const [busy, setBusy] = useState<"extend" | "lock" | null>(null);

  useEffect(() => {
    if (!confirming) return;
    const timer = window.setTimeout(() => setConfirming(null), 4000);
    return () => window.clearTimeout(timer);
  }, [confirming]);

  async function run(kind: "extend" | "lock", action: () => Promise<void>) {
    setBusy(kind);
    await action();
    setBusy(null);
  }

  return (
    <section className="panel people" aria-labelledby="people-title">
      <div className="panel__head">
        <h2 id="people-title" className="panel__title">
          People
        </h2>
        <span className="panel__count tabular">
          {here} here{members.length > here ? `, ${members.length - here} away` : ""}
        </span>
      </div>

      {members.length === 0 ? (
        <p className="panel__empty">Finding who's here…</p>
      ) : (
        <ul className="people__list">
          {sorted.map((m) => (
            <li key={m.id} className="person">
              <span className="avatar" style={{ background: tintFor(m.id) }} aria-hidden="true">
                {initials(m.display_name)}
              </span>
              <span className="person__name">
                <span className="person__label">
                  {m.display_name}
                  {m.id === meId && <span className="person__you"> (you)</span>}
                </span>
                {m.is_host && <span className="person__host">Host</span>}
              </span>
              <span className="person__state">
                <span className={`dot${m.online ? " dot--on" : ""}`} aria-hidden="true" />
                {m.online ? "here" : "away"}
              </span>
              {isHost && m.id !== meId && (
                <button
                  type="button"
                  className={`person__remove${confirming === m.id ? " is-confirming" : ""}`}
                  onClick={() => {
                    if (confirming !== m.id) return setConfirming(m.id);
                    setConfirming(null);
                    void onRemove(m.id);
                  }}
                  aria-label={confirming === m.id ? `Confirm: remove ${m.display_name}` : `Remove ${m.display_name}`}
                  title={confirming === m.id ? "Tap again to remove" : `Remove ${m.display_name}`}
                >
                  {confirming === m.id ? "Remove" : <Close size={14} />}
                </button>
              )}
            </li>
          ))}
        </ul>
      )}

      <div className="people__foot">
        {isHost && (
          <div className="people__tools" role="group" aria-label="Room controls">
            <button
              type="button"
              className="btn btn--small btn--quiet"
              onClick={() => run("extend", () => onExtend(EXTEND_MINUTES))}
              disabled={busy !== null}
              title={`Add ${EXTEND_MINUTES} minutes before the room closes`}
            >
              <Clock size={16} />+{EXTEND_MINUTES} min
            </button>
            <button
              type="button"
              className={`btn btn--small btn--quiet${locked ? " is-on" : ""}`}
              aria-pressed={locked}
              onClick={() => run("lock", () => onLock(!locked))}
              disabled={busy !== null}
              title={locked ? "Let new people join with the code again" : "Stop anyone new joining, even with the code"}
            >
              {locked ? <Lock size={16} /> : <Unlock size={16} />}
              {locked ? "Locked" : "Lock"}
            </button>
          </div>
        )}
        {locked ? (
          <p className="people__note">Locked, so nobody new can join.</p>
        ) : (
          <CopyCode
            code={session.code}
            value={joinLink(session.code)}
            className="people__invite"
            label="Copy invite link"
            ariaLabel="Copy the join link"
          />
        )}
      </div>
    </section>
  );
}
