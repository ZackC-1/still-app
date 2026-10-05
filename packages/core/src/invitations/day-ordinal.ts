// Local calendar day ordinals for the invitation ledger.
//
// A "day of use" is a local calendar date, not a 24-hour window, so daylight-saving changes never
// split or merge a day. The ordinal is the number of days from 1970-01-01 to that local date in
// the proleptic Gregorian calendar. Only the date matters: the time zone decides which date an
// instant falls on, and nothing else. The ledger accepts an ordinal only when it is greater than
// the last accepted one, so travelling west or rolling the clock back never earns another day.

/** Days from 1970-01-01 to the given civil date (month 1-12). Pure arithmetic, no time zone. */
export function civilDayOrdinal(year: number, month: number, day: number): number {
  const y = month <= 2 ? year - 1 : year;
  const era = Math.floor(y / 400);
  const yoe = y - era * 400;
  const mp = (month + 9) % 12;
  const doy = Math.floor((153 * mp + 2) / 5) + day - 1;
  const doe = yoe * 365 + Math.floor(yoe / 4) - Math.floor(yoe / 100) + doy;
  return era * 146097 + doe - 719468;
}

/**
 * The local calendar day ordinal of an instant, or null when it cannot be read (an invalid instant
 * or time zone, or a date before 1970). `timeZone` is an IANA name; omit it to use the device's
 * current zone. A null ordinal contributes no day and never resets one.
 */
export function localDayOrdinal(epochMs: number, timeZone?: string): number | null {
  if (!Number.isSafeInteger(epochMs) || epochMs < 0) return null;
  try {
    const parts = new Intl.DateTimeFormat("en-US", {
      timeZone, calendar: "gregory", numberingSystem: "latn", year: "numeric", month: "numeric", day: "numeric",
    }).formatToParts(new Date(epochMs));
    const part = (type: string) => Number(parts.find(p => p.type === type)?.value);
    const year = part("year"), month = part("month"), day = part("day");
    if (![year, month, day].every(Number.isInteger)) return null;
    // Intl reports era-relative years; before year 1 there is no positive ordinal anyway.
    if (parts.some(p => p.type === "era")) return null;
    const ordinal = civilDayOrdinal(year, month, day);
    return ordinal >= 0 ? ordinal : null;
  } catch {
    return null;
  }
}
