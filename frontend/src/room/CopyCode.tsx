import { useEffect, useState } from "react";
import { Check, Copy } from "../components/Icons";

interface CopyCodeProps {
  code: string;
  /** What to copy, when it isn't the code itself (e.g. the join link). */
  value?: string;
  className?: string;
  label?: string;
  ariaLabel?: string;
}

/** Copies the room code (or its link), with a plain fallback where the clipboard API isn't allowed (plain http). */
export function CopyCode({ code, value = code, className = "", label = "Copy", ariaLabel }: CopyCodeProps) {
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    if (!copied) return;
    const timer = window.setTimeout(() => setCopied(false), 1800);
    return () => window.clearTimeout(timer);
  }, [copied]);

  async function copy() {
    try {
      await navigator.clipboard.writeText(value);
    } catch {
      const area = document.createElement("textarea");
      area.value = value;
      area.setAttribute("readonly", "");
      area.style.position = "fixed";
      area.style.opacity = "0";
      document.body.appendChild(area);
      area.select();
      document.execCommand("copy");
      area.remove();
    }
    setCopied(true);
  }

  return (
    <button type="button" className={`copy-btn ${className}`} onClick={copy} aria-label={ariaLabel ?? `Copy room code ${code}`}>
      {copied ? <Check size={16} /> : <Copy size={16} />}
      <span aria-live="polite">{copied ? "Copied" : label}</span>
    </button>
  );
}
