// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * #3912 — `fast: true` (the whole gc-native lane) could not stringify a number.
 *
 * `fast` sets `nativeStrings` but neither `wasi` nor `standalone`. The
 * number-format family in `collectPrimitiveMethodImports`'s finalize block was
 * gated on `wasi || standalone` while the string family was gated on
 * `nativeStrings`, so `fast` was the ONE reachable config that paired a HOST
 * `env.number_toString` with NATIVE string helpers. The two disagree about
 * representation, and six of nine number→string operations trapped at runtime
 * on a module that compiled and instantiated cleanly.
 *
 * Two things are asserted here, matching the two halves of the fix:
 *
 *  1. **the gate** — a `fast` module must not import ANY `env.number_*`
 *     formatter, i.e. `usesNativeNumberFormat` now keys on `ctx.nativeStrings`;
 *  2. **the consumer** — `compileNativeTemplateExpression`'s numeric spans must
 *     unbox the native formatter's externref with `any.convert_extern` +
 *     `ref.cast`, never with the JS-host `__str_from_extern` bridge (which
 *     silently yields the EMPTY string for a native-string box, so `` `v${3}` ``
 *     evaluated to "v").
 *
 * ## Two testing hazards this file deliberately works around
 *
 * **Constant folding masks the runtime path.** `String(3.5)` written as a
 * LITERAL folds at compile time and returns the correct answer without the
 * runtime formatter ever running — a 12-case matrix once reported all-pass for
 * exactly that reason. Every case below therefore binds its value to a `const`
 * and reads it back through an identifier.
 *
 * **A returned string can be confounded by fast-mode string marshalling.**
 * Every case returns a NUMBER (`.length` / `.charCodeAt(i)`), so a wrong string
 * representation shows up as a wrong number rather than as a marshalling
 * artifact at the test boundary.
 *
 * ## Scope: integers only, on purpose
 *
 * Every value here is an integer. Under `fast`, `mapTsTypeToWasm` lowers every
 * `number` to an i32, so a non-integer is truncated at its BINDING — long before
 * any formatter sees it (`const n = 3.5; String(n)` is `"3"`). That is #3907 /
 * #3917 and it is a different defect in a different file; mixing it in here
 * would make this file fail for a reason it does not own. The non-integer cases
 * belong with #3907's fix.
 */
import { describe, it, expect } from "vitest";
import { compile, type CompileOptions } from "../src/index.js";
import { buildImports } from "../src/runtime.js";

type Mode = "fast" | "standalone" | "standalone+fast" | "host";

const MODE_OPTIONS: Record<Mode, CompileOptions> = {
  host: {},
  fast: { fast: true },
  standalone: { target: "standalone" },
  "standalone+fast": { target: "standalone", fast: true },
};

/** Compile `body` as the whole of `test()` and call it; the body returns a number. */
async function runNumber(body: string, mode: Mode): Promise<number> {
  const source = `export function test(): number {\n${body}\n}`;
  const result = await compile(source, { fileName: "test.ts", ...MODE_OPTIONS[mode] });
  if (!result.success) {
    throw new Error(`[${mode}] compile failed: ${result.errors.map((e) => e.message).join("; ")}`);
  }
  const imports = buildImports(result.imports, undefined, result.stringPool);
  const instance = new WebAssembly.Instance(new WebAssembly.Module(result.binary), imports as never);
  imports.setInstance?.(instance);
  return (instance.exports as Record<string, () => number>).test!();
}

/** `env` imports of the compiled module, read off the binary (not the WAT). */
async function envImports(source: string, mode: Mode): Promise<string[]> {
  const result = await compile(source, { fileName: "test.ts", ...MODE_OPTIONS[mode] });
  expect(result.success, result.errors.map((e) => e.message).join("; ")).toBe(true);
  return WebAssembly.Module.imports(new WebAssembly.Module(result.binary))
    .filter((i) => i.module === "env")
    .map((i) => i.name);
}

/**
 * The nine number→string operations from #3912's table. `expected` is the
 * numeric probe result; the comment on each is the string being measured.
 */
const NINE_OPERATIONS: ReadonlyArray<{ name: string; body: string; expected: number }> = [
  // "3" — charCode of the only character
  { name: "(n).toString()", body: `const n = 3; return n.toString().charCodeAt(0);`, expected: 51 },
  // "42"
  { name: "String(n)", body: `const n = 42; return String(n).length;`, expected: 2 },
  // "3.00"
  { name: "n.toFixed(2)", body: `const n = 3; return n.toFixed(2).length;`, expected: 4 },
  // "ff" — charCode of 'f'
  { name: "n.toString(16)", body: `const n = 255; return n.toString(16).charCodeAt(0);`, expected: 102 },
  // "1,22,333"
  { name: 'arr.join(",")', body: `const a = [1, 22, 333]; return a.join(",").length;`, expected: 8 },
  // "v3" — the #3912 consumer fix; was "v" (length 1) with the gate change alone
  { name: "template `v${n}`", body: "const n = 3; return `v${n}`.length;", expected: 2 },
  // "v3"
  { name: '"v" + n', body: `const n = 3; return ("v" + n).length;`, expected: 2 },
  // sorted [1, 9, 10] — sort() is a ToString comparison, so it exercises the
  // formatter even though the observable result is numeric
  { name: "arr.sort()", body: `const a = [10, 9, 1]; return a.sort()[0];`, expected: 1 },
];

describe("#3912 — fast mode can stringify a number", () => {
  describe("the gate: a fast module has no host number formatter", () => {
    it("fast mode imports no env.number_* formatter", async () => {
      const imports = await envImports(
        `export function test(): number {
           const n = 255;
           return n.toString().length + n.toString(16).length + n.toFixed(2).length;
         }`,
        "fast",
      );
      expect(imports.filter((n) => n.startsWith("number_"))).toEqual([]);
    });

    it("host mode still imports the host number formatter", async () => {
      // The gate must have widened, not inverted: JS-host mode keeps env.number_*.
      const imports = await envImports(
        `export function test(): number { const n = 3; return n.toString().length; }`,
        "host",
      );
      expect(imports).toContain("number_toString");
    });
  });

  for (const mode of ["fast", "standalone", "standalone+fast"] as const) {
    describe(`operations under ${mode}`, () => {
      for (const op of NINE_OPERATIONS) {
        it(op.name, async () => {
          await expect(runNumber(op.body, mode)).resolves.toBe(op.expected);
        });
      }
    });
  }

  describe("the consumer: template numeric spans do not use the host bridge", () => {
    it("an interpolated number contributes its digits, not the empty string", async () => {
      // Regression for the exact symptom of the `standaloneNativeStrings`
      // branch in compileNativeTemplateExpression: `__str_from_extern` yields
      // EMPTY for a native-string box, so this read was NaN (index past end).
      for (const mode of ["fast", "standalone", "standalone+fast"] as const) {
        await expect(runNumber("const n = 7; return `v${n}`.charCodeAt(1);", mode), mode).resolves.toBe(55); // '7'
      }
    });

    it("i32-, f64- and string-typed spans all round-trip in one template", async () => {
      // `k` is i32-lowered under fast and f64-lowered elsewhere; `s` is a
      // native string span that must stay on the passthrough arm.
      const body = "const k = 12; const s = 'ab'; return `${s}-${k}-${s}`.length;"; // "ab-12-ab"
      for (const mode of ["fast", "standalone", "standalone+fast", "host"] as const) {
        await expect(runNumber(body, mode), mode).resolves.toBe(8);
      }
    });
  });

  describe("host mode is unchanged", () => {
    for (const op of NINE_OPERATIONS) {
      it(op.name, async () => {
        await expect(runNumber(op.body, "host")).resolves.toBe(op.expected);
      });
    }
  });

  /**
   * The ninth operation, `JSON.stringify`, is NOT fixed by #3912 and is not
   * claimed here. It was measured byte-identically before and after this change
   * (a `dereferencing a null pointer` trap under `fast` in every shape), so it
   * is neither caused nor cured by the number-format gate. It is a THIRD
   * instance of the same between-family gate mismatch, in the JSON family:
   * `call-namespace-static.ts` gates the native JSON codec on
   * `ctx.standalone || ctx.wasi`, so a `fast` module gets the HOST
   * `env.JSON_stringify` — a real JS string — while its consumers expect a
   * native `$AnyString`. Traced to the instruction:
   *
   *     call $JSON_stringify        ;; host import -> externref (JS string)
   *     any.convert_extern
   *     ref.test (ref $AnyString)   ;; 0 — it is a host string
   *     (if ... (else ref.null $AnyString))   ;; <- taken
   *     struct.get $AnyString 0     ;; <- TRAPS on the null
   *
   * This test pins the CURRENT behaviour so the day it changes is visible.
   * Delete it and fold JSON.stringify into NINE_OPERATIONS when that gate is
   * fixed.
   */
  it("JSON.stringify is still host-gated under fast (documents the open gap)", async () => {
    const imports = await envImports(
      `export function test(): number { const o = { a: 42 }; return JSON.stringify(o).length; }`,
      "fast",
    );
    expect(imports).toContain("JSON_stringify");
  });
});
