/**
 * #1440 — Date setters ToNumber coercion + Invalid-Date / NaN propagation.
 *
 * Per ECMA-262 §21.4.4, every Date.prototype.set* method coerces each
 * argument through ToNumber, propagates NaN by setting [[DateValue]] to
 * the Invalid-Date sentinel (and returning NaN), applies TimeClip on the
 * final time value, and reads the receiver's [[DateValue]] before any
 * user code in the arg list runs. setFullYear is special: an Invalid-
 * Date receiver is re-validated by treating t as +0 (§21.4.4.21).
 */
import { describe, expect, it } from "vitest";
import { compileToWasm } from "./equivalence/helpers.js";

describe("issue #1440 — Date setters ToNumber + Invalid-Date propagation", () => {
  describe("time-of-day setters: ToNumber coercion", () => {
    it("setHours(0, {valueOf}) — object arg with valueOf", async () => {
      const source = `
export function test(): number {
  const d = new Date(Date.UTC(2016, 6, 1));
  const arg: any = { valueOf: function() { return 2; } };
  return d.setHours(0, arg);
}
`;
      const exports = await compileToWasm(source);
      expect(exports.test!()).toBe(Date.UTC(2016, 6, 1, 0, 2));
    });

    it("setHours(0, null) — null coerces to 0", async () => {
      const source = `
export function test(): number {
  const d = new Date(Date.UTC(2016, 6, 1, 7, 30));
  return d.setHours(0, null as any);
}
`;
      const exports = await compileToWasm(source);
      expect(exports.test!()).toBe(Date.UTC(2016, 6, 1));
    });

    it("setHours(0, true) — true coerces to 1", async () => {
      const source = `
export function test(): number {
  const d = new Date(Date.UTC(2016, 6, 1));
  return d.setHours(0, true as any);
}
`;
      const exports = await compileToWasm(source);
      expect(exports.test!()).toBe(Date.UTC(2016, 6, 1, 0, 1));
    });

    it("setHours(0, false) — false coerces to 0", async () => {
      const source = `
export function test(): number {
  const d = new Date(Date.UTC(2016, 6, 1, 7, 30));
  return d.setHours(0, false as any);
}
`;
      const exports = await compileToWasm(source);
      expect(exports.test!()).toBe(Date.UTC(2016, 6, 1));
    });

    it("setHours(0, string) — string parsed to number", async () => {
      const source = `
export function test(): number {
  const d = new Date(Date.UTC(2016, 6, 1));
  return d.setHours(0, "  +00200.000E-0002\\t" as any);
}
`;
      const exports = await compileToWasm(source);
      expect(exports.test!()).toBe(Date.UTC(2016, 6, 1, 0, 2));
    });
  });

  describe("NaN propagation: Invalid Date sentinel", () => {
    it("setHours(NaN) → NaN; date becomes Invalid", async () => {
      const source = `
export function test(): number {
  const d = new Date(Date.UTC(2016, 6, 1));
  const r = d.setHours(NaN);
  return r;
}
`;
      const exports = await compileToWasm(source);
      expect(exports.test!()).toBeNaN();
    });

    it("setHours() with no arg → NaN", async () => {
      const source = `
export function test(): number {
  const d = new Date(Date.UTC(2016, 6, 1));
  return d.setHours();
}
`;
      const exports = await compileToWasm(source);
      expect(exports.test!()).toBeNaN();
    });

    it("setMinutes(NaN) → NaN; getTime() returns NaN afterwards", async () => {
      const source = `
export function test(): number {
  const d = new Date(Date.UTC(2016, 6, 1));
  d.setMinutes(NaN);
  return d.getTime();
}
`;
      const exports = await compileToWasm(source);
      expect(exports.test!()).toBeNaN();
    });

    it("setSeconds with secondary NaN arg → NaN", async () => {
      const source = `
export function test(): number {
  const d = new Date(Date.UTC(2016, 6, 1, 12));
  return d.setSeconds(10, NaN);
}
`;
      const exports = await compileToWasm(source);
      expect(exports.test!()).toBeNaN();
    });

    it("setTime(NaN) → NaN; date becomes Invalid", async () => {
      const source = `
export function test(): number {
  const d = new Date(Date.UTC(2016, 6, 1));
  d.setTime(NaN);
  return d.getTime();
}
`;
      const exports = await compileToWasm(source);
      expect(exports.test!()).toBeNaN();
    });

    it("setHours on Invalid Date stays Invalid", async () => {
      const source = `
export function test(): number {
  const d = new Date(NaN);
  return d.setHours(5);
}
`;
      const exports = await compileToWasm(source);
      expect(exports.test!()).toBeNaN();
    });
  });

  describe("setTime", () => {
    it("setTime(1234567890123) sets timestamp", async () => {
      const source = `
export function test(): number {
  const d = new Date(0);
  return d.setTime(1234567890123);
}
`;
      const exports = await compileToWasm(source);
      expect(exports.test!()).toBe(1234567890123);
    });

    it("setTime out-of-range → NaN", async () => {
      const source = `
export function test(): number {
  const d = new Date(0);
  return d.setTime(1e16);
}
`;
      const exports = await compileToWasm(source);
      expect(exports.test!()).toBeNaN();
    });
  });

  describe("calendar setters: setDate / setMonth / setFullYear", () => {
    it("setDate(20) replaces day-of-month", async () => {
      const source = `
export function test(): number {
  const d = new Date(Date.UTC(2016, 6, 15));
  return d.setDate(20);
}
`;
      const exports = await compileToWasm(source);
      expect(exports.test!()).toBe(Date.UTC(2016, 6, 20));
    });

    it("setMonth(11) replaces month (0-based)", async () => {
      const source = `
export function test(): number {
  const d = new Date(Date.UTC(2016, 6, 15));
  return d.setMonth(11);
}
`;
      const exports = await compileToWasm(source);
      expect(exports.test!()).toBe(Date.UTC(2016, 11, 15));
    });

    it("setMonth(2, 28) sets month and day", async () => {
      const source = `
export function test(): number {
  const d = new Date(Date.UTC(2016, 6, 15));
  return d.setMonth(2, 28);
}
`;
      const exports = await compileToWasm(source);
      expect(exports.test!()).toBe(Date.UTC(2016, 2, 28));
    });

    it("setFullYear(2020) replaces year", async () => {
      const source = `
export function test(): number {
  const d = new Date(Date.UTC(2016, 6, 15));
  return d.setFullYear(2020);
}
`;
      const exports = await compileToWasm(source);
      expect(exports.test!()).toBe(Date.UTC(2020, 6, 15));
    });

    it("setFullYear(2020, 0, 1) replaces all three", async () => {
      const source = `
export function test(): number {
  const d = new Date(Date.UTC(2016, 6, 15));
  return d.setFullYear(2020, 0, 1);
}
`;
      const exports = await compileToWasm(source);
      expect(exports.test!()).toBe(Date.UTC(2020, 0, 1));
    });

    it("setFullYear on Invalid Date re-validates (t treated as +0)", async () => {
      // Spec §21.4.4.21: if t is NaN, let t be +0; otherwise let t be LocalTime(t).
      // So an Invalid Date + setFullYear(2020) → 2020-01-01T00:00:00 UTC.
      const source = `
export function test(): number {
  const d = new Date(NaN);
  return d.setFullYear(2020);
}
`;
      const exports = await compileToWasm(source);
      expect(exports.test!()).toBe(Date.UTC(2020, 0, 1));
    });

    it("setMonth on Invalid Date stays Invalid", async () => {
      const source = `
export function test(): number {
  const d = new Date(NaN);
  return d.setMonth(5);
}
`;
      const exports = await compileToWasm(source);
      expect(exports.test!()).toBeNaN();
    });

    it("setDate on Invalid Date stays Invalid", async () => {
      const source = `
export function test(): number {
  const d = new Date(NaN);
  return d.setDate(10);
}
`;
      const exports = await compileToWasm(source);
      expect(exports.test!()).toBeNaN();
    });

    it("setDate(NaN) → Invalid Date", async () => {
      const source = `
export function test(): number {
  const d = new Date(Date.UTC(2016, 6, 15));
  return d.setDate(NaN);
}
`;
      const exports = await compileToWasm(source);
      expect(exports.test!()).toBeNaN();
    });

    it("setMonth({valueOf}) coerces via ToNumber", async () => {
      const source = `
export function test(): number {
  const d = new Date(Date.UTC(2016, 6, 15));
  const arg: any = { valueOf: function() { return 11; } };
  return d.setMonth(arg);
}
`;
      const exports = await compileToWasm(source);
      expect(exports.test!()).toBe(Date.UTC(2016, 11, 15));
    });

    it("legacy setYear(99) → 1999", async () => {
      const source = `
export function test(): number {
  const d = new Date(Date.UTC(2016, 6, 15));
  return d.setYear(99);
}
`;
      const exports = await compileToWasm(source);
      expect(exports.test!()).toBe(Date.UTC(1999, 6, 15));
    });

    it("legacy setYear(2020) does NOT add 1900 (≥100)", async () => {
      const source = `
export function test(): number {
  const d = new Date(Date.UTC(2016, 6, 15));
  return d.setYear(2020);
}
`;
      const exports = await compileToWasm(source);
      expect(exports.test!()).toBe(Date.UTC(2020, 6, 15));
    });
  });

  describe("UTC variants share implementations", () => {
    it("setUTCHours mirrors setHours", async () => {
      const source = `
export function test(): number {
  const d = new Date(Date.UTC(2016, 6, 1));
  return d.setUTCHours(5, 30);
}
`;
      const exports = await compileToWasm(source);
      expect(exports.test!()).toBe(Date.UTC(2016, 6, 1, 5, 30));
    });

    it("setUTCFullYear mirrors setFullYear", async () => {
      const source = `
export function test(): number {
  const d = new Date(Date.UTC(2016, 6, 15));
  return d.setUTCFullYear(2020, 0, 1);
}
`;
      const exports = await compileToWasm(source);
      expect(exports.test!()).toBe(Date.UTC(2020, 0, 1));
    });
  });

  describe("observable ordering: [[DateValue]] read before ToNumber", () => {
    it("valueOf callback observes original [[DateValue]]", async () => {
      // The receiver's [[DateValue]] must be sampled BEFORE the arg's
      // ToNumber callback runs (test262
      // date-value-read-before-tonumber-when-date-is-valid.js).
      const source = `
let observed: number = -1;
export function test(): number {
  const d = new Date(Date.UTC(2016, 6, 1));
  const arg: any = {
    valueOf: function() {
      observed = d.getTime();
      return 0;
    }
  };
  d.setMilliseconds(arg);
  return observed;
}
`;
      const exports = await compileToWasm(source);
      expect(exports.test!()).toBe(Date.UTC(2016, 6, 1));
    });
  });
});

describe("issue #1440 — extras", () => {
  it("setUTCMonth basic", async () => {
    const source = `
export function test(): number {
  const d = new Date(Date.UTC(2016, 6, 15));
  return d.setUTCMonth(11);
}
`;
    const exports = await compileToWasm(source);
    expect(exports.test!()).toBe(Date.UTC(2016, 11, 15));
  });
  it("setUTCDate basic", async () => {
    const source = `
export function test(): number {
  const d = new Date(Date.UTC(2016, 6, 15));
  return d.setUTCDate(20);
}
`;
    const exports = await compileToWasm(source);
    expect(exports.test!()).toBe(Date.UTC(2016, 6, 20));
  });
  it("setFullYear with NaN arg → Invalid Date", async () => {
    const source = `
export function test(): number {
  const d = new Date(Date.UTC(2016, 6, 15));
  return d.setFullYear(NaN);
}
`;
    const exports = await compileToWasm(source);
    expect(exports.test!()).toBeNaN();
  });
  it("setFullYear with secondary NaN → Invalid", async () => {
    const source = `
export function test(): number {
  const d = new Date(Date.UTC(2016, 6, 15));
  return d.setFullYear(2020, NaN);
}
`;
    const exports = await compileToWasm(source);
    expect(exports.test!()).toBeNaN();
  });
  it("setMonth preserves time-of-day", async () => {
    const source = `
export function test(): number {
  const d = new Date(Date.UTC(2016, 6, 15, 12, 30, 45, 123));
  return d.setMonth(2);
}
`;
    const exports = await compileToWasm(source);
    expect(exports.test!()).toBe(Date.UTC(2016, 2, 15, 12, 30, 45, 123));
  });
});
