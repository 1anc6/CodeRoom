import { useMemo, useState } from "react";
import { Link, useLocation } from "react-router-dom";
import { Wordmark } from "../components/Brand";
import { DoorPanel, type DoorMode } from "../components/DoorPanel";
import { ArrowRight } from "../components/Icons";
import { Stages } from "../components/Stages";
import { parseServerTime } from "../lib/format";
import { stagger, useReveal } from "../lib/useReveal";
import { loadSession } from "../session";

interface LandingState {
  mode?: DoorMode;
  hint?: string;
}

const LIMITS: Array<[string, string, string]> = [
  ["How long", "You choose when you open it", "8 hours, 2 by default"],
  ["Who can come in", "Anyone who types the code", "20 people at a time"],
  ["Files", "Photos, PDFs, documents, text, video", "25 MB each, 100 MB a room"],
  ["Messages", "Plain text, delivered as you send", "4,000 characters each"],
  ["Accounts", "None, just a name for this room", "32 characters for the name"],
  ["Wrong codes", "Guessing is slowed down", "5 tries a minute"],
  ["Afterwards", "Access stops the moment it closes", "Deleted within about a minute"],
];

const PLACES = [
  {
    src: "/photos/lecture.jpg",
    width: 1200,
    height: 900,
    alt: "A mathematics lecture seen from the back rows, the boards covered in matrices",
    caption: "A lecture, with slides for the row behind you.",
  },
  {
    src: "/photos/chalkboard.jpg",
    width: 1920,
    height: 1275,
    alt: "A chalkboard on an easel, sums written in chalk, a sponge on its ledge",
    caption: "A board, photographed before it's wiped.",
  },
  {
    src: "/photos/study-table.jpg",
    width: 1425,
    height: 1085,
    alt: "Students in 1899 reading together around library tables under gas lamps",
    caption: "A study table in 1899. Some things don't change.",
  },
];

const KEPT: Array<[string, string]> = [
  ["Messages, files and names", "Until the room closes, plus about a minute while they're deleted."],
  ["The room code", "Never stored as written. The server keeps a keyed hash it can't turn back into digits."],
  ["Your place in the room", "A random token held by this browser tab. The server keeps only a hash of it."],
  ["The room's record", "Its id, times and status, kept as a tombstone with no messages, files or names."],
  ["Logs and backups", "Your host's own retention. Logs never contain messages, files, codes or tokens."],
];

export function Landing() {
  const location = useLocation();
  const incoming = (location.state ?? {}) as LandingState;
  const [mode, setMode] = useState<DoorMode>(incoming.mode ?? "create");
  const [focusRequest, setFocusRequest] = useState(0);
  const [closingMode, setClosingMode] = useState<DoorMode>("create");
  useReveal();

  // A room this tab is already in, if it hasn't closed.
  const current = useMemo(() => {
    const session = loadSession();
    if (!session) return null;
    return parseServerTime(session.room.expires_at) > Date.now() ? session : null;
  }, []);

  function openJoin() {
    setMode("join");
    setFocusRequest((n) => n + 1);
    document.getElementById("door")?.scrollIntoView({ behavior: "smooth", block: "center" });
  }

  const year = new Date().getFullYear();

  return (
    <div className="landing">
      <header className="topbar">
        <Wordmark />
        {current ? (
          <Link className="text-link topbar__action" to={`/room/${current.room.id}`}>
            Back to room <span className="tabular">{current.code}</span>
            <ArrowRight size={16} />
          </Link>
        ) : (
          <button type="button" className="text-link topbar__action" onClick={openJoin}>
            Have a code?
            <ArrowRight size={16} />
          </button>
        )}
      </header>

      <main>
        <section className="hero" data-reveal aria-labelledby="hero-title">
          <div className="hero__copy">
            <h1 id="hero-title" className="hero__title rise">
              Five digits.
              <br />
              One room.
            </h1>
            <p className="hero__lead rise" style={stagger(1)}>
              Open a room, read the code out loud, and chat and pass files with whoever types it in. When time runs
              out, the room and everything in it is gone.
            </p>
            <p className="hero__aside rise" style={stagger(2)}>
              Someone gave you a code?{" "}
              <button type="button" className="text-link" onClick={openJoin}>
                Join their room
              </button>
            </p>
          </div>
          <div className="hero__door rise" id="door" style={stagger(2)}>
            <DoorPanel
              mode={mode}
              onModeChange={setMode}
              focusRequest={focusRequest}
              hint={incoming.hint ?? null}
            />
          </div>
        </section>

        <Stages />

        <section className="places" id="places" data-reveal aria-labelledby="places-title">
          <div className="places__intro">
            <h2 id="places-title" className="rise">
              Said across
              <br />
              the table.
            </h2>
            <p className="rise" style={stagger(1)}>
              A long library table, the back row of a lecture, a board nobody has wiped yet. When the people you need are
              right there, five digits said out loud beats swapping numbers, emails or links.
            </p>
          </div>
          <figure className="places__main rise" style={stagger(1)}>
            <div className="places__frame">
              <img
                src="/photos/reading-room.jpg"
                width={1920}
                height={1281}
                alt="The main reading room of the Library of Congress: rings of lit desks under a domed ceiling"
              />
            </div>
            <figcaption>A reading room, where the person at the next desk is one code away.</figcaption>
          </figure>
          <div className="places__row">
            {PLACES.map((place, i) => (
              <figure className="rise" key={place.src} style={stagger(i)}>
                <div className="places__frame">
                  <img src={place.src} width={place.width} height={place.height} alt={place.alt} loading="lazy" />
                </div>
                <figcaption>{place.caption}</figcaption>
              </figure>
            ))}
          </div>
        </section>

        <section className="limits" id="limits" data-reveal aria-labelledby="limits-title">
          <h2 id="limits-title" className="limits__title rise">
            What a room holds
          </h2>
          <div className="limits__table rise" role="table" aria-labelledby="limits-title" style={stagger(1)}>
            <div className="limits__row limits__row--head" role="row">
              <span role="columnheader">
                <span className="visually-hidden">Topic</span>
              </span>
              <span role="columnheader">How it works</span>
              <span role="columnheader" className="limits__featured">
                The limit
              </span>
            </div>
            {LIMITS.map(([topic, how, limit]) => (
              <div className="limits__row" role="row" key={topic}>
                <span role="rowheader" className="limits__topic">
                  {topic}
                </span>
                <span role="cell" data-label="How it works">
                  {how}
                </span>
                <span role="cell" className="limits__featured" data-label="The limit">
                  {limit}
                </span>
              </div>
            ))}
          </div>
        </section>

        <section className="kept" id="kept" data-reveal aria-labelledby="kept-title">
          <div className="kept__intro">
            <h2 id="kept-title" className="rise">
              What's kept,
              <br />
              and for how long
            </h2>
            <p className="rise" style={stagger(1)}>
              CodeRoom is for passing things along, not for storing them. When a room closes, nobody can get back in and
              its contents are deleted.
            </p>
            <p className="kept__warning rise" style={stagger(2)}>
              A code is a door, not a lock: anyone who has it can walk in, and the server handles what you share (it isn't
              end-to-end encrypted). Share only what you'd hand to everyone who might hear the digits.
            </p>
          </div>
          <dl className="kept__list">
            {KEPT.map(([what, until], i) => (
              <div className="kept__item rise" key={what} style={stagger(i + 1)}>
                <dt>{what}</dt>
                <dd>{until}</dd>
              </div>
            ))}
          </dl>
        </section>

        <section className="closing" id="open" data-reveal aria-labelledby="closing-title">
          <div className="closing__copy">
            <h2 id="closing-title" className="rise">
              Open one
              <br />
              right now.
            </h2>
            <p className="rise" style={stagger(1)}>
              Pick a name and how long it lasts. The code appears the moment the room opens, ready to read out.
            </p>
          </div>
          <div className="closing__door rise" style={stagger(2)}>
            <DoorPanel mode={closingMode} onModeChange={setClosingMode} />
          </div>
        </section>
      </main>

      <footer className="footer">
        <span className="footer__what">CodeRoom, rooms that close on their own</span>
        <nav className="footer__links" aria-label="Page sections">
          <a href="#stages">How it works</a>
          <a href="#places">Where</a>
          <a href="#limits">Limits</a>
          <a href="#kept">Privacy</a>
        </nav>
        <span className="footer__year">{year}</span>
        <p className="footer__credits">
          Photographs, all public domain via Wikimedia Commons:{" "}
          <a href="https://commons.wikimedia.org/wiki/File:LOC_Main_Reading_Room_Highsmith.jpg">reading room</a> by Carol
          M. Highsmith;{" "}
          <a href="https://commons.wikimedia.org/wiki/File:Mathematics_lecture_at_the_Helsinki_University_of_Technology.jpg">
            lecture
          </a>{" "}
          by Tungsten;{" "}
          <a href="https://commons.wikimedia.org/wiki/File:Chalkboard_in_a_school_in_Afghanistan.jpg">chalkboard</a> by
          Francisco V. Govea II, U.S. Air Force;{" "}
          <a href="https://commons.wikimedia.org/wiki/File:Students_seated_around_tables,_studying,_at_Western_High_School,_Washington,_D.C._LCCN2002695161.tif">
            study table
          </a>{" "}
          by Frances Benjamin Johnston.
        </p>
      </footer>
    </div>
  );
}
