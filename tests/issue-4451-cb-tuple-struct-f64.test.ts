// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { compile, validateEmittedBinary } from "../src/index.js";
import { instantiateWithRuntime } from "./equivalence/helpers.js";

// Re-declared, not imported: the probe module runs its compile on import.
// Same convention as `tests/issue-4420-emitted-binary-validation.test.ts`.
const COMPILE_FILES_VALIDATE_PROBE_MARKER = "__JS2_COMPILE_FILES_VALIDATE_PROBE__";

/**
 * #4451 — a sibling of #4420, found by the same self-hosting sweep and NOT
 * fixed by it. `compileFiles("src/boundary-policy.ts")` reported success and
 * handed back bytes the engine rejects:
 *
 *   Compiling function #47:"__cb_0" failed:
 *     struct.new[1] expected type (ref null 26), found if of type f64
 *
 * `__cb_0` is the host callback wrapper for the comparator in
 * `buildExportBoundaryPolicies`:
 *
 *   Object.entries(signatures ?? {}).sort(([left], [right]) => left.localeCompare(right))
 *
 * Because the array comes from the host, the comparator is dispatched through
 * `__make_callback` and its two parameters arrive as externref — while their
 * declared type is the tuple `[string, ExportSignature]`. `__cb_0` therefore
 * opens with `buildTupleFromExternref` (src/codegen/type-coercion.ts), which
 * emits a runtime `ref.test` chain over EVERY known vec type and, in each arm,
 * a bounds-guarded read of each tuple element coerced into the matching slot.
 *
 * The `__vec_f64` arm is the defect. Its elements read as `f64`, and the
 * element→slot coercion matrix had no row for `f64 → (ref null $ExportSignature)`
 * — nor for the mirrors `ref → f64` / `externref ↔ i32`. With no row the raw
 * `f64` was simply left on the stack for `struct.new`, which makes the whole
 * MODULE invalid even though that arm is unreachable at run time (a
 * `[string, Sig]` pair is never a `__vec_f64`). The `(else NaN)` sentinel of the
 * out-of-bounds guard is what made the stray f64 visible in the WAT.
 *
 * Fixed at the element-type decision site rather than at `struct.new`: a
 * numeric element can never inhabit a GC-ref slot (nor a GC ref a numeric one),
 * so the slot now gets its own default (`ref.null`) — the same convention the
 * out-of-bounds arm and `buildTupleFromIterableFallback` already use.
 */

// The exact defect shape, reduced from `buildExportBoundaryPolicies`. Every
// ingredient is load-bearing: `Object.entries` hands the array to the HOST (so
// the comparator becomes a `__cb_N` wrapper taking externref rather than a
// native funcref sort), the comparator DESTRUCTURES its parameters (so they are
// lowered to a `__tuple_*` struct), and the second slot is a GC REFERENCE (so
// no numeric vec element can satisfy it).
const MINIMIZED_OBJECT_SLOT = `
  interface Sig {
    readonly result: string;
  }

  export function main(): string {
    const sigs: Record<string, Sig> = { b: { result: "B" }, a: { result: "A" } };
    let out = "";
    for (const [name, sig] of Object.entries(sigs).sort(([left], [right]) => (left < right ? -1 : 1))) {
      out += name + sig.result;
    }
    return out;
  }
`;

// Same construct with the reference slot held by an ARRAY instead of an
// interface. Identical codegen path — slot 1 is still a GC ref that the
// `__vec_f64` arm cannot produce — but this one also RUNS, so the fix can be
// checked for more than validator silence. (The interface-typed variant above
// was only compiled here because it then tripped a separate, pre-existing
// defect — one declared shape lowered to two struct types, so the value slot
// failed its `ref.cast` with "illegal cast". That is #4493, now fixed; the
// interface variant's runtime assertion lives in
// `tests/issue-4493-object-entries-struct-cast.test.ts`.)
//
// The record is declared already in sorted order deliberately: it keeps the
// assertion on what this fix governs — that BOTH tuple slots survive the
// externref→tuple conversion — instead of on comparator ordering.
const MINIMIZED_RUNNABLE = `
  export function main(): string {
    const sigs: Record<string, number[]> = { a: [1, 10], b: [2, 20] };
    let out = "";
    for (const [name, nums] of Object.entries(sigs).sort(([left], [right]) => (left < right ? -1 : 1))) {
      out += name + nums[0] + "/" + nums[1] + ";";
    }
    return out;
  }
`;

describe("#4451 — a numeric vec element vs. a GC-ref tuple slot", () => {
  it("emits a module the engine accepts (interface-typed slot)", async () => {
    const result = await compile(MINIMIZED_OBJECT_SLOT, {});
    expect(result.success, result.errors.map((e) => e.message).join("\n")).toBe(true);
    // Before the fix: `struct.new[1] expected type (ref null N), found if of
    // type f64` — reported by the engine, never by the compiler.
    expect(validateEmittedBinary(result.binary).detail ?? "").toBe("");
    expect(WebAssembly.validate(result.binary)).toBe(true);
  });

  it("emits a module the engine accepts (array-typed slot)", async () => {
    const result = await compile(MINIMIZED_RUNNABLE, {});
    expect(result.success, result.errors.map((e) => e.message).join("\n")).toBe(true);
    expect(validateEmittedBinary(result.binary).detail ?? "").toBe("");
    expect(WebAssembly.validate(result.binary)).toBe(true);
  });

  it("still carries both tuple slots through the conversion", async () => {
    const result = await compile(MINIMIZED_RUNNABLE, {});
    expect(result.success).toBe(true);
    const instance = await instantiateWithRuntime(result);
    // The key slot (externref) and the array slot (a GC ref) must BOTH arrive
    // intact — the repair must not null out a slot it can legitimately fill.
    expect((instance.exports.main as () => string)()).toBe("a1/10;b2/20;");
  });
});

describe("#4451 acceptance — self-compiling src/boundary-policy.ts", () => {
  // Out of process for the same reason as #4420's acceptance test: the fork
  // pool caps a worker at 512 MB (`VITEST_FORK_MAX_OLD_SPACE_SIZE`) and a real
  // source graph exhausts it, which surfaces as a worker crash — an
  // infrastructure failure, not a verdict. ~15 s wall on an 8-core container.
  it("returns success under the validate gate and yields a module WebAssembly.compile accepts", () => {
    const probe = fileURLToPath(new URL("./helpers/compile-files-validate-probe.ts", import.meta.url));
    const child = spawnSync(
      process.execPath,
      ["--max-old-space-size=2048", "--import", "tsx", probe, "src/boundary-policy.ts"],
      {
        cwd: fileURLToPath(new URL("..", import.meta.url)),
        encoding: "utf-8",
        maxBuffer: 64 * 1024 * 1024,
        timeout: 240_000,
      },
    );
    const marked = (child.stdout ?? "")
      .split("\n")
      .find((line) => line.startsWith(COMPILE_FILES_VALIDATE_PROBE_MARKER));
    expect(marked, `probe produced no verdict:\n${child.stderr ?? ""}`).toBeDefined();
    const report = JSON.parse(marked!.slice(COMPILE_FILES_VALIDATE_PROBE_MARKER.length)) as {
      success: boolean;
      binaryByteLength: number;
      engineAccepts: boolean;
      engineError: string | null;
      errors: { message: string }[];
    };
    // The engine's verdict is the ground truth; `success` is only trustworthy
    // because the #4420 gate derives it from that verdict.
    expect(report.engineError ?? "").toBe("");
    expect(report.engineAccepts).toBe(true);
    expect(report.success, report.errors.map((e) => e.message).join("\n")).toBe(true);
    expect(report.binaryByteLength).toBeGreaterThan(0);
  }, 300_000);
});
