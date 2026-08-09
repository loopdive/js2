// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #4027 — a DELIBERATE IR deferral must demote the one function to legacy, not
// hard-fail the whole compile.
//
// `classifyIrFailure` is explicit that "unknown throws are compiler
// invariants": an untyped `Error` becomes `unexpected-internal-throw`, which
// `formatIrPathFallbackDiagnostic` reports as a hard error. So a deferral site
// that throws a bare `Error` silently converts its own documented
// "clean throw → legacy" contract into a whole-program abort.
//
// This is the SIXTH recorded instance of that exact mistake (#3565 found four,
// #3784 a fifth), which is why these rungs check behaviour rather than the
// error text: the failure mode is a fatal error where a warning was intended.
//
// `src/ir/from-ast.ts` still contains ~194 other bare `throw new Error(...)`
// sites. An unknown number are deferrals with the same latent defect; they are
// NOT audited here. See the issue file — this fixes the ones on the ESLint
// frontier and the one they explicitly claim to mirror.

import { describe, expect, it } from "vitest";

import { compile } from "../src/index.js";

/** Sources whose IR lowering hits a documented deferral. */
// `marker` is matched against the demotion WARNING text. It tracks
// `demoteToLegacy`'s own wording ("… not in slice 9"), which is the stable part
// of the message across both the numeric and class arms — the leading
// `throw <kind>` varies with the value type, and the outcome CODE
// (`throw-value-unsupported`) is not carried in the user-visible string. The
// assertion exists so a deferral cannot become SILENT: demoting without a
// warning would hide an IR coverage gap from the #2855 ratchet.
const deferrals: { name: string; source: string; marker: string }[] = [
  {
    // `lowerThrowStatement`'s numeric deferral: "Slice 9 defers — fall back to
    // legacy by throwing here so the function compilation aborts cleanly and
    // the legacy path takes over." Four lines of ordinary TypeScript that did
    // not compile at all.
    name: "throw of a numeric value",
    source: `export function f(): number { throw 42; }`,
    marker: "not in slice 9",
  },
  {
    // The same deferral reached through a conditional, so the function has a
    // normal return path too — this is the shape real code hits.
    name: "numeric throw alongside a normal return",
    source: `export function g(n: number): number {
  if (n < 0) { throw -1; }
  return n;
}`,
    marker: "not in slice 9",
  },
];

// NOTE: the sibling `bare 'throw' (no expression)` arm is retyped by the same
// change but is NOT covered here. `throw;` is a SyntaxError in JavaScript, so
// no valid source reaches it; a rung written for it would compile some other
// construct entirely and pass on both sides — a test that looks like coverage
// and is not. An earlier draft of this file did exactly that before it was
// checked against the unfixed base.

describe("#4027 — documented IR deferrals demote to legacy instead of aborting", () => {
  for (const { name, source, marker } of deferrals) {
    it(`compiles a function with a ${name}`, async () => {
      const result = await compile(source, { target: "gc", experimentalIR: true });

      // The regression: these produced `severity: "error"` and `success: false`.
      const hard = result.errors.filter((e) => e.severity === "error");
      expect(hard.map((e) => e.message)).toEqual([]);
      expect(result.success).toBe(true);
      expect(result.binary.byteLength).toBeGreaterThan(0);

      // Where a deferral genuinely fires it must still be VISIBLE — demoting
      // silently would hide IR coverage gaps from the #2855 ratchet.
      if (marker !== "") {
        const warnings = result.errors.filter((e) => e.severity === "warning");
        expect(warnings.some((e) => e.message.includes(marker))).toBe(true);
      }
    });
  }

  it("still runs correctly after demoting to the legacy body", async () => {
    // Demotion must produce a WORKING function, not merely a compiling one.
    const result = await compile(
      `export function pick(n: number): number {
  if (n < 0) { throw 7; }
  return n * 2;
}`,
      { target: "gc", experimentalIR: true },
    );
    expect(result.success, result.errors.map((e) => e.message).join(" | ")).toBe(true);

    const imports = { ...(result.importObject as Record<string, Record<string, unknown>>) };
    for (const imp of WebAssembly.Module.imports(new WebAssembly.Module(result.binary))) {
      const mod = (imports[imp.module] ??= {});
      if (mod[imp.name] !== undefined) continue;
      if (imp.kind === "function") mod[imp.name] = () => undefined;
      else if (imp.kind === "global") mod[imp.name] = new WebAssembly.Global({ value: "externref" }, undefined);
    }
    const { instance } = await WebAssembly.instantiate(result.binary, imports as WebAssembly.Imports);
    expect((instance.exports as { pick: (n: number) => number }).pick(21)).toBe(42);
  });
});
