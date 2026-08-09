// #3477 — bare-string RangeError throws at indexed/number-method construction
// sites now throw real RangeError INSTANCES.
//
// Root cause: several RangeError gates in indexed built-in construction
// (`new ArrayBuffer(-1)`, resizable ArrayBuffer maxByteLength, DataView bounds,
// `new Array(-1)`) and the computed-access Number.prototype.toString(radix) /
// toFixed(digits) gates emitted a BARE STRING via the shared `$exc` tag
// (`[...stringConstantExternrefInstrs(msg), {op:"throw",tagIdx}]`) instead of a
// real Error instance. Under the authentic oracle-v8 harness,
// `assert.throws(RangeError, fn)` checks `e instanceof RangeError` (constructor
// identity), so a bare string fails → host FAIL. Same `instanceof`-guard family
// as #3422 (313-flip TypeError win) / #3175 (the dot-access toString/toFixed
// twins already fixed).
//
// Fix: route every site through `buildThrowJsErrorInstrs(ctx, "RangeError", …)`
// (src/codegen/js-errors.ts, the #3175/#3191 real-instance builder). These
// assertions are the regression guard: before the fix each returns 2
// (bare-string caught), after it returns 1 (RangeError instance caught).
import { describe, it, expect } from "vitest";
import { compile } from "../src/index.js";
import { buildImports } from "../src/runtime.js";

async function runTest(src: string): Promise<unknown> {
  const result = await compile(src);
  if (!result.success) {
    throw new Error(`Compile failed:\n${result.errors.map((e) => `  L${e.line}: ${e.message}`).join("\n")}`);
  }
  const imports = buildImports(result.imports, undefined, result.stringPool);
  const { instance } = await WebAssembly.instantiate(result.binary, imports);
  imports.setExports?.(instance.exports as Record<string, Function>);
  return (instance.exports as any).test();
}

// Each case: try the throwing construction; return 1 iff the caught value is a
// real RangeError instance, 2 if it's a non-RangeError (the old bare-string), 0
// if it did not throw at all.
const RANGEERR_CASES: Array<[string, string]> = [
  ["new ArrayBuffer(-1)", "const b = new ArrayBuffer(-1);"],
  ["new Array(-1)", "const a = new Array(-1);"],
  ['(5)["toString"](40)', 'const n: number = 5; const s = n["toString"](40);'],
  ['(5)["toFixed"](200)', 'const n: number = 5; const s = n["toFixed"](200);'],
];

describe("#3477 indexed/number-method RangeError gates throw real instances", () => {
  for (const [label, body] of RANGEERR_CASES) {
    it(`${label} throws a RangeError instance (not a bare string)`, async () => {
      const src = `
        export function test(): number {
          try { ${body} return 0; }
          catch (e) { return e instanceof RangeError ? 1 : 2; }
        }`;
      expect(await runTest(src)).toBe(1);
    });
  }
});
