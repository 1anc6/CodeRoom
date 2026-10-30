import type { MemberOut, RoomSession } from "../api/types";
import { initials, tintFor } from "../lib/format";
import { CopyCode } from "./CopyCode";

interface PeopleProps {
  session: RoomSession;
  members: MemberOut[];
}

export function People({ session, members }: PeopleProps) {
  const meId = session.participant.id;
  // Me first, then whoever is here now, then the rest by name.
  const sorted = [...members].sort((a, b) => {
    if (a.id === meId) return -1;
    if (b.id === meId) return 1;
    if (a.online !== b.online) return a.online ? -1 : 1;
    return a.display_name.localeCompare(b.display_name);
  });
  const here = members.filter((m) => m.online).length;

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
              </span>
              <span className="person__state">
                <span className={`dot${m.online ? " dot--on" : ""}`} aria-hidden="true" />
                {m.online ? "here" : "away"}
              </span>
            </li>
          ))}
        </ul>
      )}

      <div className="invite">
        <h3 className="invite__title">Bring someone in</h3>
        <p className="invite__text">Read out this code. Anyone who types it can join until the room closes.</p>
        <div className="invite__code tabular" aria-hidden="true">
          {session.code.split("").map((d, i) => (
            <span key={i}>{d}</span>
          ))}
        </div>
        <CopyCode code={session.code} className="invite__copy" label="Copy code" />
      </div>
    </section>
  );
}
