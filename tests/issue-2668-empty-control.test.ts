import { expect, it } from "vitest";
import { compileToWasm } from "./equivalence/helpers.js";
it("baseline empty typed-array length control", async () => {
  const exports = await compileToWasm(
    'export function test(): number { const a: number[] = []; Object.defineProperty(a, "length", {value:2}); return a.length; }',
  );
  expect((exports.test as () => number)()).toBe(2);
});
