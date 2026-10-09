import { describe, expect, it } from "vitest";
import { formatNl, offsetMinutes, toZonedIso, weekdayNl } from "../src/time";

describe("time", () => {
  it("geeft zomertijd-offset voor Amsterdam", () => {
    const d = new Date("2026-10-08T12:03:00Z");
    expect(offsetMinutes(d, "Europe/Amsterdam")).toBe(120);
    expect(toZonedIso(d, "Europe/Amsterdam")).toBe("2026-10-08T14:03:00+02:00");
    expect(formatNl(d, "Europe/Amsterdam")).toBe("08-10-2026 14:03");
  });

  it("geeft wintertijd-offset voor Amsterdam", () => {
    const d = new Date("2026-01-15T23:30:00Z");
    expect(toZonedIso(d, "Europe/Amsterdam")).toBe("2026-01-16T00:30:00+01:00");
  });

  it("kan ook negatieve offsets", () => {
    const d = new Date("2026-07-01T12:00:00Z");
    expect(toZonedIso(d, "America/New_York")).toBe("2026-07-01T08:00:00-04:00");
  });

  it("geeft de Nederlandse weekdag in de juiste tijdzone", () => {
    expect(weekdayNl(new Date("2026-10-09T08:00:00Z"), "Europe/Amsterdam")).toBe("vrijdag");
    // 23:30 UTC op vrijdag is al zaterdag in Amsterdam.
    expect(weekdayNl(new Date("2026-10-09T23:30:00Z"), "Europe/Amsterdam")).toBe("zaterdag");
  });
});
