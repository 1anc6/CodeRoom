import { useMemo, useState, type CSSProperties } from "react";
import { formatRemaining } from "../lib/format";
import { Check, Copy, Download } from "./Icons";

const STAGES = [
  {
    name: "Open",
    clause: ["First, open", "a room."],
    detail: "Give your name and choose how long it lasts, from half an hour to eight hours. The code appears at once.",
  },
  {
    name: "Share",
    clause: ["Then read out", "the five digits."],
    detail: "Say them across the table, write them on the board, text them. Whoever types them in joins under a name they pick.",
  },
  {
    name: "Talk",
    clause: ["Now talk and", "pass files around."],
    detail: "Messages arrive as they're sent. Drop in photos, PDFs, slides or a short video, up to 25 MB each.",
  },
  {
    name: "Close",
    clause: ["Finally, it", "closes itself."],
    detail: "When time is up everyone is let out together, and the messages and files are deleted within about a minute.",
  },
];

const SAMPLE_CODE = "48213";
const TWO_HOURS = 2 * 60 * 60 * 1000;

/** True-size crops of the room screen, one for each stage of a room's life. */
function Fragment({ stage, closesAt }: { stage: number; closesAt: string }) {
  switch (stage) {
    case 0:
      return (
        <div className="frag frag--header" data-ui>
          <div className="frag__code-row">
            <span className="frag__label">Room code</span>
            <span className="frag__code tabular">{SAMPLE_CODE}</span>
            <span className="frag__copy">
              <Copy size={16} /> Copy
            </span>
          </div>
          <div className="frag__timer">
            <span>Closes in {formatRemaining(TWO_HOURS)}</span>
            <span className="frag__muted">at {closesAt}</span>
          </div>
          <div className="frag__bar">
            <span style={{ width: "100%" }} />
          </div>
          <div className="frag__member">
            <span className="avatar" style={{ background: "#E7DCCB" }}>
              AO
            </span>
            <span>Ada Okafor</span>
            <span className="frag__you">you</span>
            <span className="dot dot--on" aria-label="online" />
          </div>
        </div>
      );
    case 1:
      return (
        <div className="frag frag--join" data-ui>
          <span className="frag__label">Your name</span>
          <span className="frag__input">Maya</span>
          <span className="frag__label">Room code</span>
          <span className="frag__cells tabular">
            {SAMPLE_CODE.split("").map((d, i) => (
              <span key={i}>{d}</span>
            ))}
          </span>
          <span className="frag__button">Join room</span>
        </div>
      );
    case 2:
      return (
        <div className="frag frag--chat" data-ui>
          <div className="frag__msg">
            <span className="frag__who">Maya</span>
            <p>Got the whiteboard? I missed the last part.</p>
          </div>
          <div className="frag__msg frag__msg--mine">
            <p>Sending it now, plus the slides.</p>
          </div>
          <div className="frag__file">
            <span className="frag__thumb" aria-hidden="true">
              JPG
            </span>
            <span className="frag__file-text">
              <strong>whiteboard-week6.jpg</strong>
              <span className="frag__muted">2.4 MB · Ada</span>
            </span>
            <Download size={18} />
          </div>
          <div className="frag__file">
            <span className="frag__thumb" aria-hidden="true">
              PDF
            </span>
            <span className="frag__file-text">
              <strong>lecture-6-slides.pdf</strong>
              <span className="frag__progress">
                <span style={{ width: "64%" }} />
              </span>
            </span>
            <span className="frag__muted tabular">64%</span>
          </div>
        </div>
      );
    default:
      return (
        <div className="frag frag--closed" data-ui>
          <span className="frag__closed-mark">
            <Check size={18} />
          </span>
          <strong>This room has closed.</strong>
          <p>Its messages and two files are being deleted. Nobody can get back in, and {SAMPLE_CODE} is free for a new room.</p>
          <span className="frag__button frag__button--quiet">Open a new room</span>
        </div>
      );
  }
}

export function Stages() {
  const [stage, setStage] = useState(0);
  const closesAt = useMemo(
    () => new Intl.DateTimeFormat(undefined, { hour: "numeric", minute: "2-digit" }).format(Date.now() + TWO_HOURS),
    [],
  );
  const current = STAGES[stage];

  return (
    <section className="stages" id="stages" aria-labelledby="stages-title">
      <h2 className="visually-hidden" id="stages-title">
        How a room goes
      </h2>
      <div className="stages__words" aria-live="polite">
        <div className="stages__copy" key={stage}>
          <p className="stages__clause">
            {current.clause[0]}
            <br />
            {current.clause[1]}
          </p>
          <p className="stages__detail">{current.detail}</p>
        </div>
      </div>
      <div className="stages__stage">
        <div className="stages__frag" key={stage}>
          <Fragment stage={stage} closesAt={closesAt} />
        </div>
      </div>
      <div className="stages__control">
        <label htmlFor="stage-range" className="visually-hidden">
          Stage of a room's life
        </label>
        <div className="stages__slider" style={{ "--f": stage / (STAGES.length - 1) } as CSSProperties}>
          <span className="stages__fill" aria-hidden="true" />
          <input
            id="stage-range"
            type="range"
            min={0}
            max={STAGES.length - 1}
            step={1}
            value={stage}
            aria-valuetext={`${current.name}: ${current.clause.join(" ")}`}
            onChange={(e) => setStage(Number(e.target.value))}
          />
        </div>
        <ol className="stages__names">
          {STAGES.map((s, i) => (
            <li key={s.name}>
              <button type="button" aria-current={i === stage ? "step" : undefined} onClick={() => setStage(i)}>
                {s.name}
              </button>
            </li>
          ))}
        </ol>
      </div>
    </section>
  );
}
