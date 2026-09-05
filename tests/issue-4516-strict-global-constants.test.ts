import { describe, expect, it } from "vitest";
import { compileToWasm } from "./equivalence/helpers.js";

describe("issue #4516 — strict writes to global value properties", () => {
  for (const name of ["NaN", "Infinity", "undefined"] as const) {
    it(`throws TypeError when strict code assigns ${name}`, async () => {
      const exports = await compileToWasm(`
export function test(): number {
  "use strict";
  try {
    ${name} = 12;
  } catch (e) {
    return e instanceof TypeError ? 1 : 0;
  }
  return 0;
}
`);
      expect(exports.test!()).toBe(1);
    });
  }

  it("still evaluates the RHS before throwing", async () => {
    const exports = await compileToWasm(`
let effects = 0;
export function test(): number {
  "use strict";
  try {
    NaN = (effects = 7);
  } catch (e) {
    return effects;
  }
  return 0;
}
`);
    expect(exports.test!()).toBe(7);
  });
});
