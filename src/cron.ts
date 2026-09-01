function fieldMatch(expr: string, value: number, min: number, max: number): boolean {
  for (const part of expr.split(",")) {
    if (part === "*") return true;
    if (part.startsWith("*/")) {
      const step = Number(part.slice(2));
      if (step > 0 && (value - min) % step === 0) return true;
      continue;
    }
    const n = Number(part);
    if (n === value && n >= min && n <= max) return true;
  }
  return false;
}

export function cronMatches(cron: string, at: Date, timeZone: string): boolean {
  const parts = cron.trim().split(/\s+/);
  if (parts.length !== 5) return false;
  const fmt = new Intl.DateTimeFormat("en-US", {
    timeZone,
    minute: "numeric",
    hour: "numeric",
    day: "numeric",
    month: "numeric",
    weekday: "short",
    hourCycle: "h23",
  });
  const bag: Record<string, string> = {};
  for (const p of fmt.formatToParts(at)) {
    if (p.type !== "literal") bag[p.type] = p.value;
  }
  const minute = Number(bag.minute);
  const hour = Number(bag.hour);
  const day = Number(bag.day);
  const month = Number(bag.month);
  const dowMap: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
  const dow = dowMap[bag.weekday] ?? 0;
  return (
    fieldMatch(parts[0], minute, 0, 59) &&
    fieldMatch(parts[1], hour, 0, 23) &&
    fieldMatch(parts[2], day, 1, 31) &&
    fieldMatch(parts[3], month, 1, 12) &&
    fieldMatch(parts[4], dow, 0, 6)
  );
}

/**
 * Next minute at or after `from` that this cron matches, scanning forward.
 * Bounded at 62 days so a monthly schedule resolves and a nonsense expression
 * returns null instead of spinning.
 */
export function cronNextRun(cron: string, from: Date, timeZone: string): Date | null {
  const parts = cron.trim().split(/\s+/);
  if (parts.length !== 5) return null;
  const cursor = new Date(from.getTime());
  cursor.setUTCSeconds(0, 0);
  cursor.setUTCMinutes(cursor.getUTCMinutes() + 1);
  const limit = 62 * 24 * 60;
  for (let i = 0; i < limit; i++) {
    if (cronMatches(cron, cursor, timeZone)) return new Date(cursor.getTime());
    cursor.setUTCMinutes(cursor.getUTCMinutes() + 1);
  }
  return null;
}
