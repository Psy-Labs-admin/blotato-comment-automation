/** Pure duration parsing, safe to import from deterministic workflow code (no dependencies). */
const UNIT_MS: Record<string, number> = { s: 1_000, m: 60_000, h: 3_600_000, d: 86_400_000 };

export function parseDuration(s: string): number {
  const m = /^(\d+)\s*([smhd])$/.exec(s.trim());
  if (!m) throw new Error(`invalid duration "${s}" (expected e.g. 30s, 15m, 72h, 7d)`);
  return Number(m[1]) * UNIT_MS[m[2]];
}
