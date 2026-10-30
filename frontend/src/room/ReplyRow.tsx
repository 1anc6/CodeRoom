import { useRef, useState, type PointerEvent, type ReactNode } from "react";
import { Reply } from "../components/Icons";

// How far a row follows the finger, and how far it must travel to count as "reply".
const MAX_SHIFT = 72;
const TRIGGER = 52;

interface ReplyRowProps {
  id?: string;
  className: string;
  mine: boolean;
  /** Who the reply button names to screen readers ("Reply to Maya"). */
  label: string;
  /** Missing for things that can't be quoted yet, such as a message still sending. */
  onReply?: () => void;
  children: ReactNode;
}

/**
 * One line of the conversation that can be replied to, the way chat apps do it: swipe it to the
 * right on a touch screen, or use the reply button that shows on hover and keyboard focus.
 */
export function ReplyRow({ id, className, mine, label, onReply, children }: ReplyRowProps) {
  const [shift, setShift] = useState(0);
  const shiftRef = useRef(0);
  const gesture = useRef<{ x: number; y: number; pointer: number; horizontal: boolean | null } | null>(null);

  function move(value: number) {
    shiftRef.current = value;
    setShift(value);
  }

  function onPointerDown(event: PointerEvent<HTMLDivElement>) {
    if (!onReply || event.pointerType === "mouse") return;
    gesture.current = { x: event.clientX, y: event.clientY, pointer: event.pointerId, horizontal: null };
  }

  function onPointerMove(event: PointerEvent<HTMLDivElement>) {
    const g = gesture.current;
    if (!g || g.pointer !== event.pointerId) return;
    const dx = event.clientX - g.x;
    const dy = event.clientY - g.y;
    if (g.horizontal === null) {
      if (Math.abs(dx) < 8 && Math.abs(dy) < 8) return;
      // Decide once: a mostly-sideways drag to the right is a reply, anything else is a scroll.
      g.horizontal = dx > 0 && Math.abs(dx) > Math.abs(dy) * 1.4;
      if (!g.horizontal) {
        gesture.current = null;
        return;
      }
      event.currentTarget.setPointerCapture(event.pointerId);
    }
    // Resistance past the trigger point, so the row eases to a stop instead of following forever.
    const eased = dx < TRIGGER ? dx : TRIGGER + (dx - TRIGGER) * 0.3;
    move(Math.max(0, Math.min(MAX_SHIFT, eased)));
  }

  function onPointerEnd() {
    if (gesture.current?.horizontal && shiftRef.current >= TRIGGER) {
      navigator.vibrate?.(8);
      onReply?.();
    }
    gesture.current = null;
    move(0);
  }

  const progress = Math.min(1, shift / TRIGGER);

  return (
    <div
      id={id}
      className={`row ${mine ? "row--mine " : ""}${shift ? "is-swiping " : ""}${className}`}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerEnd}
      onPointerCancel={onPointerEnd}
    >
      <div className="row__content" style={shift ? { transform: `translateX(${shift}px)` } : undefined}>
        {onReply && (
          <span
            className="row__hint"
            aria-hidden="true"
            style={{ opacity: progress, transform: `translateY(-50%) scale(${0.6 + progress * 0.4})` }}
          >
            <Reply size={18} />
          </span>
        )}
        {children}
      </div>
      {onReply && (
        <button type="button" className="row__reply" onClick={onReply} aria-label={label} title="Reply">
          <Reply size={16} />
        </button>
      )}
    </div>
  );
}
