import qrcode from "qrcode-generator";
import { useMemo } from "react";

/**
 * A QR code drawn as one SVG path. It is always dark on light, whatever the theme, because that's
 * what phone cameras read most reliably; the quiet zone around it is part of the drawing.
 */
export function QrCode({ value, label, className = "" }: { value: string; label: string; className?: string }) {
  const { size, path } = useMemo(() => {
    const qr = qrcode(0, "M");
    qr.addData(value);
    qr.make();
    const count = qr.getModuleCount();
    let d = "";
    for (let row = 0; row < count; row++) {
      for (let col = 0; col < count; col++) {
        if (qr.isDark(row, col)) d += `M${col + 4} ${row + 4}h1v1h-1z`;
      }
    }
    return { size: count + 8, path: d };
  }, [value]);

  return (
    <svg className={`qr ${className}`} viewBox={`0 0 ${size} ${size}`} role="img" aria-label={label} shapeRendering="crispEdges">
      <rect width={size} height={size} fill="#fcfbfa" />
      <path d={path} fill="#2a2724" />
    </svg>
  );
}

/** The link that opens CodeRoom with this room's code filled in. */
export function joinLink(code: string): string {
  return `${window.location.origin}/j/${encodeURIComponent(code)}`;
}
