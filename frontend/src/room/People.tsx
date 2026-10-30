import { useEffect, useState, type CSSProperties } from "react";
import type { MemberOut, RoomSession } from "../api/types";
import { Clock, Close, Lock, QrCode as QrIcon, Unlock } from "../components/Icons";
import { initials, tintFor } from "../lib/format";
import { CopyCode } from "./CopyCode";
import { joinLink } from "./QrCode";

interface PeopleProps {
  session: RoomSession;
  members: MemberOut[];
  isHost: boolean;
  onPresent: () => void;
  onRemove: (participantId: string) => Promise<void>;
  onExtend: (minutes: number) => Promise<void>;
  onLock: (locked: boolean) => Promise<void>;
}

const EXTEND_MINUTES = 30;

export function People({ session, members, isHost, onPresent, onRemove, onExtend, onLock }: PeopleProps) {
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
          In the room
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
                {m.display_name}
                {m.id === meId && <span className="person__you"> (you)</span>}
                {m.is_host && <span className="person__host">host</span>}
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

      {isHost && (
        <div className="host-tools" aria-label="Room controls" role="group">
          <h3 className="host-tools__title">Your room</h3>
          <button
            type="button"
            className="btn btn--small btn--quiet host-tools__btn"
            onClick={() => run("extend", () => onExtend(EXTEND_MINUTES))}
            disabled={busy !== null}
          >
            <Clock size={16} />
            Add {EXTEND_MINUTES} minutes
          </button>
          <button
            type="button"
            className={`btn btn--small btn--quiet host-tools__btn${locked ? " is-on" : ""}`}
            aria-pressed={locked}
            onClick={() => run("lock", () => onLock(!locked))}
            disabled={busy !== null}
          >
            {locked ? <Lock size={16} /> : <Unlock size={16} />}
            {locked ? "Locked to newcomers" : "Lock the room"}
          </button>
          <p className="host-tools__note">
            {locked ? "Nobody new can join, even with the code." : "Lock it once everyone's in."}
          </p>
        </div>
      )}

      <div className="invite">
        <h3 className="invite__title">Bring someone in</h3>
        <p className="invite__text">
          {locked
            ? "The room is locked, so nobody new can join until it's unlocked."
            : "Read out this code, or share the link. Anyone who has it can join until the room closes."}
        </p>
        <div
          className="invite__code tabular"
          style={{ "--cols": Math.min(session.code.length, 6) } as CSSProperties}
          aria-hidden="true"
        >
          {session.code.split("").map((d, i) => (
            <span key={i}>{d}</span>
          ))}
        </div>
        <div className="invite__actions">
          <CopyCode code={session.code} className="invite__copy" label="Code" />
          <CopyCode
            code={session.code}
            value={joinLink(session.code)}
            className="invite__copy"
            label="Link"
            ariaLabel="Copy the join link"
          />
        </div>
        <button type="button" className="btn btn--small btn--quiet invite__present" onClick={onPresent}>
          <QrIcon size={16} />
          Show code and QR
        </button>
      </div>
    </section>
  );
}
