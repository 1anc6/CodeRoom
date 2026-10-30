import { useEffect, useState } from "react";
import { Check, Copy } from "../components/Icons";

/** Copies the room code, with a plain fallback where the clipboard API isn't allowed (plain http). */
export function CopyCode({ code, className = "", label = "Copy" }: { code: string; className?: string; label?: string }) {
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    if (!copied) return;
    const timer = window.setTimeout(() => setCopied(false), 1800);
    return () => window.clearTimeout(timer);
  }, [copied]);

  async function copy() {
    try {
      await navigator.clipboard.writeText(code);
    } catch {
      const area = document.createElement("textarea");
      area.value = code;
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
    <button type="button" className={`copy-btn ${className}`} onClick={copy} aria-label={`Copy room code ${code}`}>
      {copied ? <Check size={16} /> : <Copy size={16} />}
      <span aria-live="polite">{copied ? "Copied" : label}</span>
    </button>
  );
}
