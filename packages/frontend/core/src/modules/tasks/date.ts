const pad = (n: number) => String(n).padStart(2, '0');

/** Local calendar day of an epoch-ms timestamp, as `YYYY-MM-DD`. */
export function localDay(ms: number): string {
  const d = new Date(ms);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/** `YYYY-MM-DD` plus `days` calendar days (DST-safe). */
export function addDays(day: string, days: number): string {
  const [y, m, d] = day.split('-').map(Number);
  return localDay(new Date(y, m - 1, d + days).getTime());
}

/** Milliseconds from `ms` to the next local midnight (always > 0). */
export function msUntilNextLocalMidnight(ms: number): number {
  const d = new Date(ms);
  const next = new Date(d.getFullYear(), d.getMonth(), d.getDate() + 1);
  return next.getTime() - ms;
}
