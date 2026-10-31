import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";

export interface MenuAction {
  label: string;
  icon: ReactNode;
  run: () => void;
}

interface MessageMenuProps {
  /** The bubble the menu belongs to. */
  anchor: HTMLElement;
  /** The person's own messages sit on the right, so their menu lines up to the right too. */
  mine: boolean;
  actions: MenuAction[];
  onClose: () => void;
}

const EDGE = 8;

/**
 * The actions a tap on a message opens, as in chat apps. It sits just above its bubble (below it when
 * there's no room) and closes on a tap elsewhere, on Escape, or when the conversation scrolls.
 */
export function MessageMenu({ anchor, mine, actions, onClose }: MessageMenuProps) {
  const ref = useRef<HTMLDivElement>(null);
  const [place, setPlace] = useState<{ top: number; left: number } | null>(null);

  // Measured before paint, so the menu never flashes in the wrong place.
  useLayoutEffect(() => {
    const menu = ref.current;
    if (!menu) return;
    const { offsetWidth: width, offsetHeight: height } = menu;
    const box = anchor.getBoundingClientRect();
    // A long message can run off the top or bottom of the screen, so the menu goes beside the part that shows.
    const shownTop = Math.max(box.top, EDGE);
    const shownBottom = Math.min(box.bottom, window.innerHeight - EDGE);
    const above = shownTop - height - EDGE;
    const preferred = above >= EDGE ? above : shownBottom + EDGE;
    // Never past the bottom of the screen: with no clear space beside the message, it sits at the bottom.
    const top = Math.max(EDGE, Math.min(preferred, window.innerHeight - height - EDGE));
    const left = mine ? box.right - width : box.left;
    setPlace({ top, left: Math.min(Math.max(left, EDGE), window.innerWidth - width - EDGE) });
  }, [anchor, mine]);

  useEffect(() => {
    ref.current?.querySelector<HTMLButtonElement>("button")?.focus({ preventScroll: true });

    function onPointerDown(event: PointerEvent) {
      const target = event.target as Node;
      // A tap on the message itself is left to its click, which opens or closes the menu.
      if (!ref.current?.contains(target) && !anchor.contains(target)) onClose();
    }
    function onKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") onClose();
    }
    document.addEventListener("pointerdown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [anchor, onClose]);

  return createPortal(
    <div
      ref={ref}
      role="menu"
      aria-label="Message actions"
      className="msg-menu"
      style={place ? { top: place.top, left: place.left } : { top: 0, left: 0, visibility: "hidden" }}
    >
      {actions.map((action) => (
        <button
          key={action.label}
          type="button"
          role="menuitem"
          className="msg-menu__item"
          onClick={() => {
            onClose();
            action.run();
          }}
        >
          {action.icon}
          {action.label}
        </button>
      ))}
    </div>,
    document.body,
  );
}
