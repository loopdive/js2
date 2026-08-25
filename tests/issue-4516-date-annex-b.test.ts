/**
 * #4516 — the six ES5 Annex B Date residuals in standalone mode.
 */
import { describe, expect, it } from "vitest";
import { compileToWasm } from "./equivalence/helpers.js";

describe("issue #4516 — Annex B Date compatibility", () => {
  it("Date.prototype.toGMTString is the toUTCString function object", async () => {
    const exports = await compileToWasm(`
export function test(): number {
  return Date.prototype.toGMTString === Date.prototype.toUTCString ? 1 : 0;
}
`);
    expect(exports.test!()).toBe(1);
  });

  it("publishes the legacy methods with their ES5 descriptors", async () => {
    const exports = await compileToWasm(`
export function test(): number {
  const g = Object.getOwnPropertyDescriptor(Date.prototype, "toGMTString")!;
  const s = Object.getOwnPropertyDescriptor(Date.prototype, "setYear")!;
  return g.writable && !g.enumerable && g.configurable &&
    s.writable && !s.enumerable && s.configurable && s.value.length === 1 ? 1 : 0;
}
`);
    expect(exports.test!()).toBe(1);
  });

  it("setYear truncates fractional years before applying the 1900 offset", async () => {
    const exports = await compileToWasm(`
export function test(): number {
  const d = new Date(0);
  d.setYear(98.9);
  return d.getUTCFullYear();
}
`);
    expect(exports.test!()).toBe(1998);
  });

  it("setYear preserves abrupt ToNumber completion for objects and Symbols", async () => {
    const exports = await compileToWasm(`
export function test(): number {
  const d = new Date(0);
  let score = 0;
  try {
    d.setYear({ valueOf: function(): number { throw new RangeError("stop"); } } as any);
  } catch (e) {
    if (e instanceof RangeError) score += 1;
  }
  try {
    d.setYear(Symbol(""));
  } catch (e) {
    if (e instanceof TypeError) score += 2;
  }
  return score;
}
`);
    expect(exports.test!()).toBe(3);
  });
});
