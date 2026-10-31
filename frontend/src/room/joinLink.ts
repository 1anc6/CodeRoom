/** The link that opens CodeRoom with this room's code filled in. */
export function joinLink(code: string): string {
  return `${window.location.origin}/j/${encodeURIComponent(code)}`;
}
