import type { CSSProperties } from "react";

/** Inline style giving a `.rise` element its place in the first screen's entrance sequence. */
export function stagger(index: number): CSSProperties {
  return { "--i": index } as CSSProperties;
}
