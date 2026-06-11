import { describe, expect, it } from "vitest";
import { compileToWasm } from "./equivalence/helpers.js";

const temporalDecl = "declare const Temporal: any;";

describe("issue #661 - minimal native Temporal API", () => {
  it("constructs PlainDate and exposes ISO date fields", async () => {
    const exports = await compileToWasm(`
      ${temporalDecl}
      export function test(): number {
        const date = new Temporal.PlainDate(2025, 6, 7);
        return date.year * 10000 + date.month * 100 + date.day;
      }
    `);
    expect(exports.test!()).toBe(20250607);
  });

  it("parses, formats, compares, and offsets PlainDate values", async () => {
    const exports = await compileToWasm(`
      ${temporalDecl}
      export function shifted(): string {
        return Temporal.PlainDate.from("2025-06-07")
          .add({ days: 10 })
          .subtract(new Temporal.Duration(0, 0, 0, 3))
          .toString();
      }
      export function equal(): number {
        const a = Temporal.PlainDate.from("2025-06-07");
        const b = new Temporal.PlainDate(2025, 6, 7);
        return a.equals(b) ? 1 : 0;
      }
    `);
    expect(exports.shifted!()).toBe("2025-06-14");
    expect(exports.equal!()).toBe(1);
  });

  it("parses, formats, compares, and wraps PlainTime arithmetic", async () => {
    const exports = await compileToWasm(`
      ${temporalDecl}
      export function wrapped(): string {
        return Temporal.PlainTime.from("23:59:59.999999999")
          .add({ nanoseconds: 2 })
          .toString();
      }
      export function equal(): number {
        return new Temporal.PlainTime(13, 37).equals(Temporal.PlainTime.from("13:37:00")) ? 1 : 0;
      }
    `);
    expect(exports.wrapped!()).toBe("00:00:00.000000001");
    expect(exports.equal!()).toBe(1);
  });

  it("constructs, parses, formats, and adds Durations", async () => {
    const exports = await compileToWasm(`
      ${temporalDecl}
      export function parsed(): string {
        return Temporal.Duration.from("P1Y2M3W4DT5H6M7.00800901S").toString();
      }
      export function added(): string {
        // Duration.add/subtract reject calendar units (years/months/weeks)
        // per the spec (no relativeTo support) — test262
        // built-ins/Temporal/Duration/prototype/subtract/no-calendar-units.
        return new Temporal.Duration(0, 0, 0, 2).add({ hours: 3, days: 4 }).toString();
      }
      export function calendarUnitsThrow(): number {
        try {
          new Temporal.Duration(1, 0, 0, 2).add({ months: 3, days: 4 });
        } catch (e) {
          return 1;
        }
        return 0;
      }
    `);
    expect(exports.parsed!()).toBe("P1Y2M3W4DT5H6M7.00800901S");
    expect(exports.added!()).toBe("P6DT3H");
    expect(exports.calendarUnitsThrow!()).toBe(1);
  });

  it("provides deterministic Temporal.Now.plainDateISO", async () => {
    const exports = await compileToWasm(`
      ${temporalDecl}
      export function today(): string {
        return Temporal.Now.plainDateISO().toString();
      }
    `);
    expect(exports.today!()).toBe("2026-06-07");
  });
});
