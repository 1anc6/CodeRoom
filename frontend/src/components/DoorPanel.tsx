import { useEffect, useId, useRef, useState, type FormEvent } from "react";
import { useNavigate } from "react-router-dom";
import { ApiError, createRoom, joinRoom } from "../api/client";
import { lastName, rememberName, saveSession } from "../session";
import { CodeInput, ROOM_CODE_RULE, isValidRoomCode } from "./CodeInput";
import { ArrowRight } from "./Icons";

export type DoorMode = "create" | "join";

const LIFETIMES: Array<[minutes: number, label: string]> = [
  [30, "30 min"],
  [60, "1 hour"],
  [120, "2 hours"],
  [480, "8 hours"],
];
const DEFAULT_LIFETIME = 120;

interface DoorPanelProps {
  mode: DoorMode;
  onModeChange: (mode: DoorMode) => void;
  /** Bumped by the page to move focus into the panel (e.g. from "Have a code?"). */
  focusRequest?: number;
  initialCode?: string;
  hint?: string | null;
  className?: string;
}

function friendlyError(error: unknown, mode: DoorMode): string {
  if (!(error instanceof ApiError)) return "Something went wrong. Try again.";
  if (error.status === 404) return "No open room has that code. Check it with whoever made the room.";
  if (error.status === 409) {
    return mode === "create" ? "That code is already in use. Choose another." : "That room is full. Twenty people is the limit.";
  }
  if (error.status === 429) {
    const wait = error.retryAfter ? ` in ${Math.ceil(error.retryAfter)} seconds` : " in a minute";
    return mode === "join" ? `Too many wrong codes. Try again${wait}.` : `Too many rooms started from here. Try again${wait}.`;
  }
  return error.message;
}

/** Name first, then either a new room or a code. This is the product's front door. */
export function DoorPanel({ mode, onModeChange, focusRequest, initialCode = "", hint, className = "" }: DoorPanelProps) {
  const navigate = useNavigate();
  const uid = useId();
  const [name, setName] = useState(lastName);
  const [code, setCode] = useState(initialCode);
  const [lifetime, setLifetime] = useState(DEFAULT_LIFETIME);
  const [ownCode, setOwnCode] = useState(false);
  const [chosen, setChosen] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [touched, setTouched] = useState(false);
  const nameRef = useRef<HTMLInputElement>(null);
  const codeRef = useRef<HTMLInputElement>(null);
  const chosenRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!focusRequest) return;
    if (mode === "join" && name.trim()) codeRef.current?.focus();
    else nameRef.current?.focus();
    // Only explicit focus requests move focus, not typing or mode changes.
  }, [focusRequest]);

  const trimmed = name.trim();
  const nameMissing = touched && !trimmed;
  const codeIncomplete = touched && mode === "join" && !isValidRoomCode(code);
  const chosenIncomplete = touched && mode === "create" && ownCode && !isValidRoomCode(chosen);

  async function submit(event: FormEvent) {
    event.preventDefault();
    setTouched(true);
    setError(null);
    if (!trimmed) {
      nameRef.current?.focus();
      return;
    }
    if (mode === "join" && !isValidRoomCode(code)) {
      codeRef.current?.focus();
      return;
    }
    if (mode === "create" && ownCode && !isValidRoomCode(chosen)) {
      chosenRef.current?.focus();
      return;
    }
    setBusy(true);
    try {
      const session =
        mode === "create" ? await createRoom(trimmed, lifetime, ownCode ? chosen : undefined) : await joinRoom(code, trimmed);
      rememberName(trimmed);
      saveSession(session);
      navigate(`/room/${session.room.id}`);
    } catch (err) {
      setError(friendlyError(err, mode));
      setBusy(false);
    }
  }

  function switchTo(next: DoorMode) {
    if (next === mode) return;
    setError(null);
    setTouched(false);
    onModeChange(next);
  }

  return (
    <form className={`door ${className}`} data-ui onSubmit={submit} noValidate aria-label="Start or join a room">
      <div className="door__switch" role="group" aria-label="What would you like to do?">
        <button type="button" aria-pressed={mode === "create"} onClick={() => switchTo("create")}>
          Start a room
        </button>
        <button type="button" aria-pressed={mode === "join"} onClick={() => switchTo("join")}>
          Join with a code
        </button>
      </div>

      {hint && <p className="door__hint">{hint}</p>}

      <div className="door__field">
        <label htmlFor={`${uid}-name`}>Your name</label>
        <input
          ref={nameRef}
          id={`${uid}-name`}
          className="door__input"
          value={name}
          maxLength={32}
          autoComplete="nickname"
          placeholder="How the room will see you"
          aria-invalid={nameMissing || undefined}
          aria-describedby={nameMissing ? `${uid}-name-err` : undefined}
          onChange={(e) => setName(e.target.value)}
        />
        {nameMissing && (
          <p className="door__field-error" id={`${uid}-name-err`}>
            Add a name so people know who's talking.
          </p>
        )}
      </div>

      {mode === "join" ? (
        <div className="door__field">
          <label htmlFor={`${uid}-code`}>Room code</label>
          <CodeInput
            ref={codeRef}
            id={`${uid}-code`}
            value={code}
            onChange={(v) => {
              setCode(v);
              setError(null);
            }}
            invalid={codeIncomplete || Boolean(error)}
            describedBy={codeIncomplete ? `${uid}-code-err` : undefined}
          />
          {codeIncomplete && (
            <p className="door__field-error" id={`${uid}-code-err`}>
              {ROOM_CODE_RULE}
            </p>
          )}
        </div>
      ) : (
        <>
          <fieldset className="door__field door__lifetime">
            <legend>Room stays open for</legend>
            <div className="door__chips">
              {LIFETIMES.map(([minutes, label]) => (
                <label key={minutes} className="chip">
                  <input
                    type="radio"
                    name={`${uid}-lifetime`}
                    value={minutes}
                    checked={lifetime === minutes}
                    onChange={() => setLifetime(minutes)}
                  />
                  <span>{label}</span>
                </label>
              ))}
            </div>
          </fieldset>

          <div className="door__own">
            <label className="door__check">
              <input
                type="checkbox"
                checked={ownCode}
                onChange={(e) => {
                  setOwnCode(e.target.checked);
                  setError(null);
                }}
              />
              <span>Choose my own code</span>
            </label>
          </div>

          {ownCode && (
            <div className="door__field">
              <label htmlFor={`${uid}-own`}>Your room code</label>
              <CodeInput
                ref={chosenRef}
                id={`${uid}-own`}
                value={chosen}
                onChange={(v) => {
                  setChosen(v);
                  setError(null);
                }}
                invalid={chosenIncomplete || Boolean(error)}
                describedBy={chosenIncomplete ? `${uid}-own-err` : undefined}
              />
              <p className={chosenIncomplete ? "door__field-error" : "door__field-hint"} id={`${uid}-own-err`}>
                {chosenIncomplete ? ROOM_CODE_RULE : "Letters and digits only, no spaces. Capitals don't matter."}
              </p>
            </div>
          )}
        </>
      )}

      <div className="door__error" role="alert" aria-live="assertive">
        {error}
      </div>

      <button className="btn door__submit" type="submit" disabled={busy}>
        {busy ? (mode === "create" ? "Opening room…" : "Checking code…") : mode === "create" ? "Create room" : "Join room"}
        {!busy && <ArrowRight size={18} />}
      </button>

      <p className="door__note">
        {mode === "create"
          ? ownCode
            ? "People type your code to join. No account needed."
            : "You'll get a five-digit code to read out. No account needed."
          : "Ask whoever made the room for its code."}
      </p>
    </form>
  );
}
