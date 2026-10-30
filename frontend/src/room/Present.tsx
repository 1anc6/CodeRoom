import { useEffect, useRef } from "react";
import type { RoomOut } from "../api/types";
import { Close, Present as PresentIcon } from "../components/Icons";
import { formatClock } from "../lib/format";
import { QrCode, joinLink } from "./QrCode";

interface PresentProps {
  code: string;
  room: RoomOut;
  onClose: () => void;
}

/**
 * The code made large enough for the back of the room: for a projector, a shared screen or a
 * phone held up across the table. People can type the code or scan the QR code to join.
 */
export function Present({ code, room, onClose }: PresentProps) {
  const closeRef = useRef<HTMLButtonElement>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  const link = joinLink(code);

  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    closeRef.current?.focus();
    const onKey = (event: KeyboardEvent) => event.key === "Escape" && onClose();
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("keydown", onKey);
      if (document.fullscreenElement) void document.exitFullscreen().catch(() => undefined);
      previous?.focus();
    };
  }, [onClose]);

  const canFullscreen = typeof document.documentElement.requestFullscreen === "function";

  return (
    <div className="present" role="dialog" aria-modal="true" aria-labelledby="present-title" ref={rootRef}>
      <div className="present__bar">
        {canFullscreen && (
          <button
            type="button"
            className="btn btn--small btn--quiet"
            onClick={() =>
              document.fullscreenElement
                ? void document.exitFullscreen()
                : void rootRef.current?.requestFullscreen().catch(() => undefined)
            }
          >
            <PresentIcon size={16} />
            Full screen
          </button>
        )}
        <button ref={closeRef} type="button" className="icon-btn" onClick={onClose} aria-label="Close">
          <Close size={20} />
        </button>
      </div>

      <div className="present__body">
        <div className="present__words">
          <p className="present__eyebrow">Join the room</p>
          <h2 id="present-title" className="present__code tabular" aria-label={`Room code ${code.split("").join(" ")}`}>
            {code}
          </h2>
          <p className="present__how">
            Go to <strong>{window.location.host}</strong> and type the code, or scan to come straight in.
          </p>
          <p className="present__when tabular">
            {room.locked ? "Locked: nobody new can join right now." : `Open until ${formatClock(room.expires_at)}`}
          </p>
        </div>
        <QrCode value={link} label={`QR code linking to ${link}`} className="present__qr" />
      </div>
    </div>
  );
}
