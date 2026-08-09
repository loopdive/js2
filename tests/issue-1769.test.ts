import { describe, expect, it } from "vitest";

import { compile } from "../src/index.js";
import { buildImports } from "../src/runtime.js";

async function compileAndGetExports(source: string, fileName = "issue-1769.ts"): Promise<Record<string, Function>> {
  const result = await compile(source, { fileName });
  expect(result.success, result.errors.map((e) => e.message).join("\n")).toBe(true);
  await expect(WebAssembly.compile(result.binary)).resolves.toBeInstanceOf(WebAssembly.Module);
  const imports = buildImports(result.imports, undefined, result.stringPool);
  const { instance } = await WebAssembly.instantiate(result.binary, imports);
  return instance.exports as Record<string, Function>;
}

describe("#1769 nullable primitive union lowering and narrowing", () => {
  it("preserves number | null sentinels and unboxes after a direct guard", async () => {
    const exports = await compileAndGetExports(`
      export function direct(flag: boolean): number {
        const output = new Uint8Array(1);
        output[0] = 7;
        let append: number | null = null;
        if (flag) append = 93;
        if (append !== null) {
          output[0] = append;
          return append + output[0];
        }
        return output[0];
      }
    `);

    expect(exports.direct(false)).toBe(7);
    expect(exports.direct(true)).toBe(186);
  });

  it("narrows number | undefined through const aliases for calls and early returns", async () => {
    const exports = await compileAndGetExports(`
      function bump(value: number): number {
        return value + 1;
      }

      export function viaAlias(flag: boolean): number {
        let value: number | undefined = undefined;
        if (flag) value = 10;
        const ready = value !== undefined;
        if (ready) {
          return bump(value);
        }
        return -5;
      }

      export function afterEarlyReturn(flag: boolean): number {
        let value: number | undefined = undefined;
        if (flag) value = 6;
        if (value === undefined) return -1;
        return value;
      }
    `);

    expect(exports.viaAlias(false)).toBe(-5);
    expect(exports.viaAlias(true)).toBe(11);
    expect(exports.afterEarlyReturn(false)).toBe(-1);
    expect(exports.afterEarlyReturn(true)).toBe(6);
  });

  it("narrows boolean | null through a negated guard alias", async () => {
    const exports = await compileAndGetExports(`
      function score(value: boolean): number {
        return value ? 1 : 2;
      }

      export function boolAlias(flag: boolean): number {
        let value: boolean | null = null;
        if (flag) value = false;
        const missing = value === null;
        if (!missing) {
          return score(value);
        }
        return 9;
      }
    `);

    expect(exports.boolAlias(false)).toBe(9);
    expect(exports.boolAlias(true)).toBe(2);
  });

  it("preserves string and bigint nullable primitive sentinels", async () => {
    const exports = await compileAndGetExports(`
      export function stringValue(flag: boolean): string {
        let value: string | null = null;
        if (flag) value = "ready";
        if (value !== null) {
          return value;
        }
        return "missing";
      }

      export function bigintValue(flag: boolean): bigint {
        let value: bigint | null = null;
        if (flag) value = 4n;
        if (value !== null) {
          return value + 2n;
        }
        return 0n;
      }
    `);

    expect(exports.stringValue(false)).toBe("missing");
    expect(exports.stringValue(true)).toBe("ready");
    expect(exports.bigintValue(false)).toBe(0n);
    expect(exports.bigintValue(true)).toBe(6n);
  });

  it("uses loose nullish guards for mixed number | null | undefined locals", async () => {
    const exports = await compileAndGetExports(`
      export function mixed(mode: number): number {
        let value: number | null | undefined = undefined;
        if (mode === 1) value = null;
        if (mode === 2) value = 4;
        if (value != null) {
          return value * 3;
        }
        return -1;
      }
    `);

    expect(exports.mixed(0)).toBe(-1);
    expect(exports.mixed(1)).toBe(-1);
    expect(exports.mixed(2)).toBe(12);
  });

  it("keeps loop-carried nullable updates narrowed after continue", async () => {
    const exports = await compileAndGetExports(`
      export function loopUpdates(): number {
        let current: number | null = null;
        let total = 0;
        for (let i = 0; i < 4; i++) {
          if (current === null) {
            current = i;
            continue;
          }
          total = total + current;
          current = i;
        }
        return total;
      }
    `);

    expect(exports.loopUpdates()).toBe(3);
  });

  it("preserves an inferred nullable primitive sentinel across a JS function return", async () => {
    const exports = await compileAndGetExports(
      `
        function readInt(ok) {
          if (!ok) return null;
          return 7;
        }

        export function classify(ok) {
          var value = readInt(ok);
          return value == null ? -1 : value;
        }
      `,
      "issue-1712-nullable-return.js",
    );

    expect(exports.classify(false)).toBe(-1);
    expect(exports.classify(true)).toBe(7);
  });

  it("keeps unguarded nullable primitive uses as hard diagnostics", async () => {
    const unguarded = await compile(
      `
        export function badReturn(): number {
          let value: number | null = null;
          return value;
        }
      `,
      { fileName: "issue-1769-negative.ts" },
    );
    expect(unguarded.success).toBe(false);
    expect(unguarded.errors.map((e) => e.message).join("\n")).toMatch(/not assignable|possibly/);

    const partialGuard = await compile(
      `
        export function badPartial(mode: number): number {
          let value: number | null | undefined = undefined;
          if (mode === 1) value = null;
          if (value !== null) {
            return value;
          }
          return -1;
        }
      `,
      { fileName: "issue-1769-negative.ts" },
    );
    expect(partialGuard.success).toBe(false);
    expect(partialGuard.errors.map((e) => e.message).join("\n")).toMatch(/not assignable|possibly/);
  });
});
