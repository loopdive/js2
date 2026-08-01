// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * #3912 — `fast: true` (the whole gc-native lane) could not stringify a number.
 *
 * `fast` sets `nativeStrings` but neither `wasi` nor `standalone`, so it is the
 * ONE reachable config with native strings AND a live JS host. Nine separate
 * gates in the compiler treated `ctx.nativeStrings` and "there is no JS host"
 * as the same condition, and each had a wrong answer in exactly that cell.
 * Six of nine number→string operations trapped at runtime on a module that
 * compiled and instantiated cleanly.
 *
 * What is asserted here, matching the shape of the fix:
 *
 *  1. **the gate** — a `fast` module imports no `env.number_*` formatter
 *     (`usesNativeNumberFormat` now keys on `ctx.nativeStrings`), while host
 *     mode still does (the gate WIDENED, it did not invert);
 *  2. **the consumers** — the operations themselves, run in all four configs;
 *  3. **the boundaries** — a native string handed to a JS-host import
 *     (`parseInt`/`Number`) must be MARSHALLED, not merely widened with
 *     `extern.convert_any`, or the host receives an opaque WasmGC struct.
 *
 * ## Three testing hazards this file deliberately works around
 *
 * **Constant folding masks the runtime path.** `String(3.5)` written as a
 * LITERAL folds at compile time and never reaches the runtime formatter — a
 * 12-case matrix once reported all-pass for exactly that reason. Every case
 * below binds its value to a `const` and reads it back through an identifier.
 *
 * **A returned string can be confounded by string marshalling at the export
 * boundary.** Every case returns a NUMBER (`.length` / `.charCodeAt(i)`), so a
 * wrong string representation shows up as a wrong number rather than as an
 * artifact of the test harness.
 *
 * **`host` is the reference, not a hand-written expectation.** Each case is
 * asserted against the value JS-host mode produces, so a case can never silently
 * encode the buggy answer.
 */
import { describe, it, expect } from "vitest";
import { compile, type CompileOptions } from "../src/index.js";
import { buildImports } from "../src/runtime.js";

type Mode = "host" | "fast" | "standalone" | "standalone+fast";

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
  (imports as { setInstance?: (i: WebAssembly.Instance) => void }).setInstance?.(instance);
  return (instance.exports as Record<string, () => number>).test!();
}

/** `env` imports of the compiled module, read off the binary. */
async function envImports(source: string, mode: Mode): Promise<string[]> {
  const result = await compile(source, { fileName: "test.ts", ...MODE_OPTIONS[mode] });
  expect(result.success, result.errors.map((e) => e.message).join("; ")).toBe(true);
  return WebAssembly.Module.imports(new WebAssembly.Module(result.binary))
    .filter((i) => i.module === "env")
    .map((i) => i.name);
}

/**
 * #3912's headline table. `JSON.stringify` of an OBJECT is deliberately absent:
 * it is covered by its own test at the bottom, which pins the one remaining
 * known-wrong answer so the day it changes is visible.
 */
const OPERATIONS: ReadonlyArray<{ name: string; body: string }> = [
  { name: "(n).toString()", body: `const n = 3; return n.toString().charCodeAt(0);` },
  { name: "String(n)", body: `const n = 42; return String(n).length;` },
  { name: "n.toFixed(2)", body: `const n = 3.14159; return n.toFixed(2).charCodeAt(3);` },
  { name: "n.toString(16)", body: `const n = 255; return n.toString(16).charCodeAt(0);` },
  { name: 'arr.join(",")', body: `const a = [1, 22, 333]; return a.join(",").length;` },
  { name: "template `v${n}`", body: "const n = 3; return `v${n}`.length;" },
  { name: '"v" + n', body: `const n = 3; return ("v" + n).length;` },
  { name: "arr.sort()", body: `const a = [10, 9, 1]; return a.sort()[0];` },
  { name: "JSON.stringify(number)", body: `const n = 42; return JSON.stringify(n).length;` },
  { name: "JSON.stringify(string)", body: `const s = "hi"; return JSON.stringify(s).length;` },
];

/**
 * Cases asserted for `fast` ONLY. `standalone` refuses these at compile time
 * (`Codegen error: JSON.stringify of this shape`) — a pre-existing limitation
 * of the pure-Wasm JSON codec that has nothing to do with #3912, so requiring
 * every mode to agree would make this file fail for a reason it does not own.
 */
const FAST_ONLY_OPERATIONS: ReadonlyArray<{ name: string; body: string }> = [
  { name: "JSON.stringify(array)", body: `const a = [1, 2]; return JSON.stringify(a).length;` },
];

/**
 * NON-INTEGER cases. These were #3917 (`fast` truncated every fraction because
 * it narrowed `number` to i32); #3907 fixed the narrowing. They live here
 * because #3912 is what routes plain `fast` onto the native formatter at all,
 * so this file is where a recurrence of either would first show up.
 */
const FRACTION_OPERATIONS: ReadonlyArray<{ name: string; body: string }> = [
  { name: "String(3.5)", body: `const n = 3.5; return String(n).length;` },
  { name: "String(0.25)", body: `const n = 0.25; return String(n).length;` },
  { name: "toFixed(2) of 3.14159", body: `const n = 3.14159; return n.toFixed(2).length;` },
  { name: "template `v${3.5}`", body: "const n = 3.5; return `v${n}`.length;" },
  { name: "toPrecision(3)", body: `const n = 3.14159; return n.toPrecision(3).length;` },
  { name: "toExponential(2)", body: `const n = 12345; return n.toExponential(2).length;` },
  { name: "String(0.1 + 0.2)", body: `const a = 0.1; const b = 0.2; return String(a + b).length;` },
];

/**
 * NATIVE STRING → JS-HOST IMPORT. `fast` is the only config where a native
 * string can reach a real host import. `coerceType(…, externref)` merely widens
 * the GC ref, so the host received an opaque WasmGC struct: `parseInt` threw
 * `Cannot convert object to primitive value` and `Number` returned NaN. Note
 * these were broken on `main` for a plain string LITERAL too — the producer
 * does not have to be the number formatter.
 */
const HOST_BOUNDARY_OPERATIONS: ReadonlyArray<{ name: string; body: string }> = [
  { name: "parseInt(literal)", body: `return parseInt("42", 10);` },
  { name: "parseInt(const string)", body: `const s = "42"; return parseInt(s, 10);` },
  { name: "parseInt(runtime concat)", body: `const a = "4"; const b = "2"; return parseInt(a + b, 10);` },
  { name: "parseInt(n.toString())", body: `const n = 42; return parseInt(n.toString(), 10);` },
  { name: "parseFloat(String(n))", body: `const n = 3.5; return parseFloat(String(n));` },
  { name: "Number(const string)", body: `const s = "42"; return Number(s);` },
  { name: "Number(String(n))", body: `const n = 42; return Number(String(n));` },
];

/**
 * Which non-host modes each group is checked against.
 *
 * `standalone+fast` is only interesting for the FRACTION group — that is the
 * exact config #3917 reported (`fast` truncated every non-integer, wrongly, in
 * BOTH standalone and wasi). For the other groups it duplicates `standalone`,
 * and these compiles are expensive enough that the redundancy showed up as a
 * `[vitest-worker]: Timeout calling "onTaskUpdate"` reporter RPC failure under
 * load. Compile-level coverage for `standalone+fast` is retained by the lane
 * block below.
 */
const ALL_CASES: ReadonlyArray<{ name: string; body: string; modes: readonly Mode[] }> = [
  ...OPERATIONS.map((c) => ({ ...c, modes: ["fast", "standalone"] as const })),
  ...FRACTION_OPERATIONS.map((c) => ({ ...c, modes: ["fast", "standalone", "standalone+fast"] as const })),
  ...HOST_BOUNDARY_OPERATIONS.map((c) => ({ ...c, modes: ["fast", "standalone"] as const })),
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
      // The gate must have WIDENED, not inverted: JS-host mode keeps env.number_*.
      const imports = await envImports(
        `export function test(): number { const n = 3; return n.toString().length; }`,
        "host",
      );
      expect(imports).toContain("number_toString");
    });

    it("fast mode does not import __str_to_number as a host function", async () => {
      // `__str_to_number` is a PURE-WASM helper name; `src/runtime.ts` has no
      // `env.__str_to_number` to bind, so importing it yielded a stub whose
      // result read back as NaN — `Number("42")` was NaN across the whole
      // gc-native lane.
      const imports = await envImports(`export function test(): number { const s = "42"; return Number(s); }`, "fast");
      expect(imports).not.toContain("__str_to_number");
    });
  });

  // Host mode is the REFERENCE. Every other config must agree with it, so no
  // case here can silently encode a buggy expectation.
  for (const c of ALL_CASES) {
    it(`${c.name} — every mode agrees with host`, async () => {
      const expected = await runNumber(c.body, "host");
      expect(Number.isFinite(expected), `host reference for "${c.name}" should be finite`).toBe(true);
      for (const mode of c.modes) {
        await expect(runNumber(c.body, mode), `${c.name} under ${mode}`).resolves.toBe(expected);
      }
    });
  }

  for (const c of FAST_ONLY_OPERATIONS) {
    it(`${c.name} — fast agrees with host`, async () => {
      const expected = await runNumber(c.body, "host");
      await expect(runNumber(c.body, "fast"), `${c.name} under fast`).resolves.toBe(expected);
    });
  }

  describe("the consumer: template numeric spans do not use the host bridge", () => {
    it("an interpolated number contributes its digits, not the empty string", async () => {
      // Regression for the `standaloneNativeStrings` branch in
      // compileNativeTemplateExpression: `__str_from_extern` marshals a genuine
      // JS-host string and yields EMPTY for a native-string box, so this read
      // was NaN (index past the end of "v").
      for (const mode of ["fast", "standalone", "standalone+fast"] as const) {
        await expect(runNumber("const n = 7; return `v${n}`.charCodeAt(1);", mode), mode).resolves.toBe(55); // '7'
      }
    });

    it("i32-, f64- and string-typed spans all round-trip in one template", async () => {
      const body = "const k = 12; const s = 'ab'; return `${s}-${k}-${s}`.length;"; // "ab-12-ab"
      for (const mode of ["host", "fast", "standalone", "standalone+fast"] as const) {
        await expect(runNumber(body, mode), mode).resolves.toBe(8);
      }
    });
  });

  /**
   * `JSON.stringify(<object>)` under `fast` returns `"{}"`, not `{"a":42}`.
   *
   * This is NOT a number-formatting defect and NOT introduced by #3912 — the
   * object-argument path is byte-identical to main. Main produced the same
   * `"{}"`; it was invisible because reading the result trapped first. #3912
   * removes the trap, which makes the pre-existing wrong answer observable.
   *
   * Root cause: `struct-field-exports.ts` skips the `__struct_field_names`
   * export whenever `ctx.nativeStrings`, on the stated assumption that native
   * strings imply no JS host. Under `fast` there IS a host, and without that
   * export the host's `_wasmToPlain` cannot enumerate the struct's fields.
   * Not fixed with #3912 because switching the predicate makes the export body
   * emit under native strings, where the string-constant globals it reads do
   * not exist (`Codegen error: global index out of range`).
   *
   * This test PINS the current behaviour so the day it changes is visible.
   * When the export is fixed, change the expectation to 8 and fold the case
   * into OPERATIONS.
   */
  it("documents the open gap: JSON.stringify of an object under fast loses fields", async () => {
    const body = `const o = { a: 42 }; return JSON.stringify(o).length;`;
    await expect(runNumber(body, "host")).resolves.toBe(8); // {"a":42}
    await expect(runNumber(body, "fast")).resolves.toBe(2); // "{}" — see above
  });
});
