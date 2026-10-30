import { useMemo, useState } from "react";
import { Link, useLocation } from "react-router-dom";
import { Wordmark } from "../components/Brand";
import { DoorPanel, type DoorMode } from "../components/DoorPanel";
import { ArrowRight } from "../components/Icons";
import { ThemeToggle } from "../components/ThemeToggle";
import { parseServerTime } from "../lib/format";
import { stagger } from "../lib/stagger";
import { loadSession } from "../session";

interface LandingState {
  mode?: DoorMode;
  hint?: string;
  /** A code from a join link (/j/CODE), filled in for whoever opened it. */
  code?: string;
}

export function Landing() {
  const location = useLocation();
  const incoming = (location.state ?? {}) as LandingState;
  const [mode, setMode] = useState<DoorMode>(incoming.mode ?? "create");
  const [focusRequest, setFocusRequest] = useState(0);

  // A room this tab is already in, if it hasn't closed.
  const current = useMemo(() => {
    const session = loadSession();
    if (!session) return null;
    return parseServerTime(session.room.expires_at) > Date.now() ? session : null;
  }, []);

  function openJoin() {
    setMode("join");
    setFocusRequest((n) => n + 1);
    const still = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    document.getElementById("door")?.scrollIntoView({ behavior: still ? "auto" : "smooth", block: "center" });
  }

  return (
    <div className="landing">
      <header className="topbar">
        <Wordmark />
        <div className="topbar__end">
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
          <ThemeToggle />
        </div>
      </header>

      <main>
        <section className="hero" aria-labelledby="hero-title">
          <div className="hero__copy">
            <h1 id="hero-title" className="hero__title rise">
              <span>Five digits.</span>
              <span>
                One <span className="hero__accent">room.</span>
              </span>
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
              initialCode={incoming.code}
            />
          </div>
        </section>
      </main>

      <footer className="landing__foot">
        <span>Rooms close on their own. Nothing is kept.</span>
        <span className="tabular">{new Date().getFullYear()}</span>
      </footer>
    </div>
  );
}
