import { describe, expect, it } from "vitest";
import { compileToWasm } from "./equivalence/helpers.js";

async function run(body: string) {
  const exports = await compileToWasm(`export function test(): number { ${body} }`);
  return (exports.test as () => number)();
}

describe("#2668 inline array length result", () => {
  it("grows an initially empty inferred array to an ordinary length", async () => {
    expect(await run('var a = []; Object.defineProperty(a, "length", { value: 2 }); return a.length;')).toBe(2);
  });
  it("sets a large length on a nonempty array", async () => {
    expect(
      await run('const a = [7]; Object.defineProperty(a, "length", { value: 2147483647 }); return a.length;'),
    ).toBe(2147483647);
  });
  for (const length of [2147483647, 2147483648, 4294967295]) {
    it(`retains unsigned logical length ${length} without materializing the discarded result`, async () => {
      expect(await run(`var a = []; Object.defineProperty(a, "length", { value: ${length} }); return a.length;`)).toBe(
        length,
      );
    });
  }
  it("preserves ordinary growth and existing elements", async () => {
    expect(
      await run('const a = [7]; Object.defineProperty(a, "length", { value: 3 }); return a.length * 10 + a[0];'),
    ).toBe(37);
  });
  it("preserves receiver identity when the return value is consumed", async () => {
    expect(
      await run('const a = [7]; const b = Object.defineProperty(a, "length", { value: 2 }); return a === b ? 1 : 0;'),
    ).toBe(1);
  });
  it("still rejects invalid lengths", async () => {
    expect(
      await run(
        'const a = [7]; try { Object.defineProperty(a, "length", { value: 4294967296 }); } catch (e) { return a.length; } return 0;',
      ),
    ).toBe(1);
  });
});
