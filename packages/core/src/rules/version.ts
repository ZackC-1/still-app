/** Dotted-numeric version string, e.g. "1.4.0". */
export const VERSION_RE = /^\d+(\.\d+)*$/;

/** Compare dotted-numeric versions component-wise. Returns -1 (a<b), 0 (equal), or 1 (a>b). */
export function compareVersions(a: string, b: string): -1 | 0 | 1 {
  const pa = a.split(".");
  const pb = b.split(".");
  const len = Math.max(pa.length, pb.length);
  for (let i = 0; i < len; i++) {
    const na = Number.parseInt(pa[i] ?? "0", 10) || 0;
    const nb = Number.parseInt(pb[i] ?? "0", 10) || 0;
    if (na !== nb) return na < nb ? -1 : 1;
  }
  return 0;
}
