/**
 * Tijdzone-hulpjes zonder externe dependency. Workers draaien in UTC;
 * Notion wil een ISO-string met offset zodat de tijd klopt in de UI.
 */

function parts(date: Date, timeZone: string): Record<string, number> {
  const fmt = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
  const out: Record<string, number> = {};
  for (const p of fmt.formatToParts(date)) {
    if (p.type !== "literal") out[p.type] = Number(p.value);
  }
  return out;
}

function pad(n: number, width = 2): string {
  return String(Math.abs(n)).padStart(width, "0");
}

/** Offset in minuten van `timeZone` t.o.v. UTC op het gegeven moment. */
export function offsetMinutes(date: Date, timeZone: string): number {
  const p = parts(date, timeZone);
  const asUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
  const truncated = Math.floor(date.getTime() / 1000) * 1000;
  return Math.round((asUtc - truncated) / 60000);
}

/** `2026-10-08T14:03:00+02:00` */
export function toZonedIso(date: Date, timeZone: string): string {
  const p = parts(date, timeZone);
  const off = offsetMinutes(date, timeZone);
  const sign = off < 0 ? "-" : "+";
  return (
    `${p.year}-${pad(p.month)}-${pad(p.day)}T${pad(p.hour)}:${pad(p.minute)}:${pad(p.second)}` +
    `${sign}${pad(Math.trunc(Math.abs(off) / 60))}:${pad(Math.abs(off) % 60)}`
  );
}

/** `08-10-2026 14:03` (Nederlandse notatie). */
export function formatNl(date: Date, timeZone: string): string {
  const p = parts(date, timeZone);
  return `${pad(p.day)}-${pad(p.month)}-${p.year} ${pad(p.hour)}:${pad(p.minute)}`;
}

export function minutesBetween(a: string, b: Date): number {
  return (b.getTime() - new Date(a).getTime()) / 60000;
}
