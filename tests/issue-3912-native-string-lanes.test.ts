// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * #3912 follow-up — LANE COVERAGE for the `nativeStrings` ⇏ "there is a JS host"
 * conflation.
 *
 * ## Why this file exists
 *
 * #3912's own probe compared exactly two lanes, `fast` vs `host`, and that gap
 * let a real regression reach CI: `create-context.ts` derives `nativeStrings`
 * from FIVE options, not one —
 *
 *     nativeStrings = options.nativeStrings
 *                  ?? (fast || wasi || standalone || strictNoHostImports || utf8Storage)
 *
 * — so `usesNativeNumberFormat` (`wasi || standalone || nativeStrings`) is true
 * in SIX lanes. Three of them have no usable JS host:
 *
 *   - `wasi` / `standalone` — no JS runtime at all;
 *   - `strictNoHostImports` — a runtime exists but host imports are FORBIDDEN.
 *
 * Routing those onto the host-dependent `__str_to_extern` / `__str_from_extern`
 * bridge did not fail cleanly. `ensureNativeStringExternBridge` bakes the
 * funcidxs of `env.__str_from_mem` / `__str_to_mem` / `__str_extern_len` into
 * compiled helper bodies, and the strict gate then DROPS those imports — giving
 * a hard `absoluteFuncIndex: unresolved call target` codegen error rather than a
 * refusal. `hostStringBridgeUsable()` in `native-strings.ts` is the predicate
 * that now guards it.
 *
 * ## Why it is a separate file from issue-3912-fast-number-stringify.test.ts
 *
 * Not taste — a hard constraint. Vitest reports task updates over an RPC with a
 * ~60s window; a single test file whose total test time exceeds it dies with
 * `[vitest-worker]: Timeout calling "onTaskUpdate"` and exits NONZERO **while
 * reporting every assertion as passed**. Compiling this many modules in one file
 * crosses that line, and the `changed-root-tests` gate (#3008, run identically
 * in CI and in the pre-commit hook) would fail on it. Keep each #3912 test file
 * comfortably under ~60s of test time.
 */
import { describe, it, expect } from "vitest";
import { compile, type CompileOptions } from "../src/index.js";

/**
 * Lanes that imply `nativeStrings` WITHOUT being plain `fast`. `utf8Storage` is
 * included because it also implies `nativeStrings` — but unlike the other three
 * it keeps a live JS host, so it is expected to still use the bridge.
 */
const NATIVE_STRING_LANES: ReadonlyArray<[string, CompileOptions]> = [
  ["strictNoHostImports", { strictNoHostImports: true }],
  ["utf8Storage", { utf8Storage: true }],
  ["standalone", { target: "standalone" }],
  ["wasi", { target: "wasi" }],
];

/** `utf8Storage` has a JS host; the rest genuinely cannot use host imports. */
const laneHasUsableHost = (lane: string): boolean => lane === "utf8Storage";

const SHAPES: ReadonlyArray<[string, string]> = [
  // The exact shape of tests/fixtures/strict-mode/needs-host.ts — the CI failure.
  ["JSON.stringify(obj)", `export function main(o: object): string { return JSON.stringify(o); }`],
  ["parseInt(native string)", `export function test(): number { const s = "42"; return parseInt(s, 10); }`],
  ["Number(native string)", `export function test(): number { const s = "42"; return Number(s); }`],
  ["number->string", `export function test(): number { const n = 255; return n.toString(16).length; }`],
  ["String(n)", `export function test(): number { const n = 42; return String(n).length; }`],
  ["toFixed", `export function test(): number { const n = 3.14; return n.toFixed(2).length; }`],
  ["join", `export function test(): number { const a = [1, 22]; return a.join(",").length; }`],
];

function envImportsOf(binary: Uint8Array): string[] {
  return WebAssembly.Module.imports(new WebAssembly.Module(binary))
    .filter((i) => i.module === "env")
    .map((i) => i.name);
}

describe("#3912 — every nativeStrings-implying lane still builds", () => {
  // One test PER LANE, not per lane×shape: each vitest task costs a reporter
  // RPC, and these compiles are heavy. Coverage is identical — the shape name
  // travels in the assertion message so a failure still names the exact case.
  for (const [laneName, opts] of NATIVE_STRING_LANES) {
    it(`${laneName}: every shape compiles, and only a host-capable lane uses the bridge`, async () => {
      for (const [shapeName, src] of SHAPES) {
        const result = await compile(src, { fileName: "test.ts", ...opts });
        expect(result.success, `${laneName} / ${shapeName}: ${result.errors.map((e) => e.message).join("; ")}`).toBe(
          true,
        );
        if (laneHasUsableHost(laneName)) continue;
        // A lane with no usable host must DECLINE the native→host marshal and
        // keep its previous lowering, rather than emit imports the strict gate
        // drops out from under an already-compiled helper body.
        expect(
          envImportsOf(result.binary).filter((n) => n.startsWith("__str_")),
          `${laneName} / ${shapeName} must request no host string-bridge imports`,
        ).toEqual([]);
      }
    });
  }

  it("no nativeStrings lane imports an env.number_* formatter", async () => {
    // #3912's gate change is a strict improvement for these lanes: on `main`
    // they took the HOST number formatter despite having native strings, which
    // is the same host/native representation mismatch #3912 exists to remove.
    for (const [laneName, opts] of NATIVE_STRING_LANES) {
      const result = await compile(
        `export function test(): number { const n = 255; return n.toString(16).length + n.toFixed(2).length; }`,
        { fileName: "test.ts", ...opts },
      );
      expect(result.success, `${laneName} compile`).toBe(true);
      expect(
        envImportsOf(result.binary).filter((n) => n.startsWith("number_")),
        `${laneName} number formatter imports`,
      ).toEqual([]);
    }
  });

  /**
   * The counterpart assertion, kept here so both halves of the tradeoff sit
   * together: `fast` DOES still import the three `__str_*` bridge functions when
   * a native string has to reach a JS-host import, and that is correct.
   *
   * There is no pure-Wasm way to manufacture a JS string — the bridge copies
   * UTF-16 code units through linear memory — so any native→host string handoff
   * needs a host. This is also NOT new: on `main` before #3912, `` `v${n}` ``
   * and `console.log(s)` already imported all three under `fast`. #3912 routes
   * two more programs (`JSON.stringify`, `parseInt`) onto the same bridge; the
   * alternative was `extern.convert_any`, which hands the host an opaque WasmGC
   * struct and produced `Cannot convert object to primitive value` / NaN.
   *
   * Pinned so the tradeoff is visible rather than implied by the "no
   * `env.number_*`" gate assertion alone.
   */
  it("fast MAY import the env.__str_* bridge — a native→host handoff needs a host", async () => {
    const result = await compile(`export function test(): number { const s = "42"; return parseInt(s, 10); }`, {
      fileName: "test.ts",
      fast: true,
    });
    expect(result.success, result.errors.map((e) => e.message).join("; ")).toBe(true);
    // `__str_to_extern` is itself a DEFINED function; the three imports it is
    // built from are what actually appear in the import section.
    expect(envImportsOf(result.binary)).toEqual(
      expect.arrayContaining(["__str_from_mem", "__str_to_mem", "__str_extern_len"]),
    );
  });
});
