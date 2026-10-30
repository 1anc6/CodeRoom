import { useEffect, type CSSProperties } from "react";

/** Inline style giving a `.rise` element its place in its section's entrance sequence. */
export function stagger(index: number): CSSProperties {
  return { "--i": index } as CSSProperties;
}

/**
 * Marks each `[data-reveal]` section `is-seen` the first time it scrolls into view, which lets its
 * `.rise` children enter in sequence. Without IntersectionObserver everything is shown at once.
 */
export function useReveal(): void {
  useEffect(() => {
    const sections = Array.from(document.querySelectorAll<HTMLElement>("[data-reveal]"));
    if (!("IntersectionObserver" in window)) {
      sections.forEach((s) => s.classList.add("is-seen"));
      return;
    }
    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (entry.isIntersecting) {
            entry.target.classList.add("is-seen");
            observer.unobserve(entry.target);
          }
        }
      },
      { threshold: 0.15, rootMargin: "0px 0px -8% 0px" },
    );
    sections.forEach((s) => observer.observe(s));
    return () => observer.disconnect();
  }, []);
}
