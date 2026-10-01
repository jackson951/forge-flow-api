const UNIT_MS = { s: 1_000, m: 60_000, h: 3_600_000, d: 86_400_000 } as const;

/** Parses the duration format accepted by the env schema ("900s", "15m", "12h", "7d"). */
export function parseDurationMs(value: string): number {
  const match = /^(\d+)([smhd])$/.exec(value);
  if (!match) throw new Error(`Invalid duration "${value}"`);
  return Number(match[1]) * UNIT_MS[match[2] as keyof typeof UNIT_MS];
}
