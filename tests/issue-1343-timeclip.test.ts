/**
 * #1343 Slice 4 (partial) — TimeClip on Date construction.
 *
 * Per ECMAScript §21.4.1.31 TimeClip: a millisecond timestamp whose magnitude
 * exceeds 8.64e15 (or which is non-finite) yields the Invalid Date sentinel.
 * Without TimeClip, `new Date(8.64e15 + 1).toISOString()` quietly produced a
 * formatted string instead of the spec-mandated RangeError; multi-arg
 * `new Date(Infinity, ...)` saturated through `i64.trunc_sat_f64_s` and built
 * a bogus epoch-relative timestamp.
 *
 * Fix lives in `src/codegen/expressions/new-super.ts` — the two `new Date(...)`
 * codegen paths (1-arg ms, multi-arg y/m/d/h/m/s/ms) now both fold to the
 * `i64.MIN` Invalid sentinel when a non-finite f64 or out-of-range ms shows up.
 * `toISOString` and the runtime `_formatDate` helper then take the RangeError
 * branch (`mode === _DATE_FMT_ISO && invalid`).
 */
import { describe, expect, it } from "vitest";
import { compileToWasm } from "./equivalence/helpers.js";

describe("issue #1343 Slice 4 — TimeClip on Date construction", () => {
  it("toISOString throws RangeError when 1-arg ms exceeds +8.64e15", async () => {
    const source = `
      export function test(): string {
        const d = new Date(8.64e15 + 1);
        try {
          return d.toISOString();
        } catch (e: any) {
          return "threw: " + (e.name ?? "Error");
        }
      }
    `;
    const exports = await compileToWasm(source);
    expect(exports.test!()).toBe("threw: RangeError");
  });

  it("toISOString throws RangeError when 1-arg ms is below -8.64e15", async () => {
    const source = `
      export function test(): string {
        const d = new Date(-8.64e15 - 1);
        try {
          return d.toISOString();
        } catch (e: any) {
          return "threw: " + (e.name ?? "Error");
        }
      }
    `;
    const exports = await compileToWasm(source);
    expect(exports.test!()).toBe("threw: RangeError");
  });

  it("toISOString throws RangeError when 1-arg ms is +Infinity", async () => {
    const source = `
      export function test(): string {
        const d = new Date(Infinity);
        try {
          return d.toISOString();
        } catch (e: any) {
          return "threw: " + (e.name ?? "Error");
        }
      }
    `;
    const exports = await compileToWasm(source);
    expect(exports.test!()).toBe("threw: RangeError");
  });

  it("toISOString throws RangeError when multi-arg year is Infinity", async () => {
    const source = `
      export function test(): string {
        const d = new Date(Infinity, 1, 70, 0, 0, 0);
        try {
          return d.toISOString();
        } catch (e: any) {
          return "threw: " + (e.name ?? "Error");
        }
      }
    `;
    const exports = await compileToWasm(source);
    expect(exports.test!()).toBe("threw: RangeError");
  });

  it("toISOString throws RangeError when multi-arg year is NaN", async () => {
    const source = `
      export function test(): string {
        const d = new Date(NaN, 1, 1);
        try {
          return d.toISOString();
        } catch (e: any) {
          return "threw: " + (e.name ?? "Error");
        }
      }
    `;
    const exports = await compileToWasm(source);
    expect(exports.test!()).toBe("threw: RangeError");
  });

  it("valid Date still formats correctly post-TimeClip", async () => {
    const source = `
      export function test(): string {
        const d = new Date(1999, 9, 10, 10, 10, 10, 10);
        return d.toISOString();
      }
    `;
    const exports = await compileToWasm(source);
    expect(exports.test!()).toBe("1999-10-10T10:10:10.010Z");
  });

  it("valid 1-arg ms Date still formats correctly post-TimeClip", async () => {
    const source = `
      export function test(): string {
        const d = new Date(0);
        return d.toISOString();
      }
    `;
    const exports = await compileToWasm(source);
    expect(exports.test!()).toBe("1970-01-01T00:00:00.000Z");
  });

  it("boundary value 8.64e15 itself is valid", async () => {
    const source = `
      export function test(): string {
        const d = new Date(8.64e15);
        return d.toISOString();
      }
    `;
    const exports = await compileToWasm(source);
    // 8.64e15 ms = Sep 13, 275760 — the +0.. extended-year ISO format.
    // We accept either V8's canonical "+275760-..." form or the runtime's chosen form.
    const out = exports.test!() as string;
    expect(out).toMatch(/^\+275760-09-13T00:00:00\.000Z$/);
  });
});
