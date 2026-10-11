// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #6492 round 9 — a free-identifier CALL inside a linked PROVIDER threw
// ReferenceError even when the realm object had the binding.
//
// The test262 harness provider is compiled as an ES module (the prefix plus its
// `export const __h_<name> = <name>;` aliases), so every global the harness
// references but does not declare — `$DONE`, `$ERROR` — is symbol-less and a
// CALL of one took the unconditional ReferenceError in `undeclared-callee.ts`
// (#4650). Instrumenting `__throw_reference_error` in the real runner showed
// the realm object DID have the property at that moment:
//
//   [DBG refError] $DONE is not defined  hasSandbox=true
//                  sandboxHasDONE=true  sandboxDONEtype=function
//
// §9.1.1.4 throws only when the binding is ABSENT.
// `tryEmitLinkedProviderFreeGlobalCall` asks `__extern_has(globalThis, name)`
// first and keeps the ReferenceError on the absent arm.
//
// Measured on the real runner (linked lane, 138-row #6492 set, 2026-09-17):
// 40 -> 44 pass, 0 losses — three `asyncHelpers-asyncTest-*` rows plus
// `proxytrapshelper-default.js`. Honest lane unchanged (505-row harness +
// global-code + eval-code control slice, 0 flips).
//
// ## Why this asserts on the WAT and not on a verdict
//
// The obvious behavioural test — build a harness provider in-process and run a
// body against it — was written first and PASSED ON THE PRE-FIX TREE, all three
// cases. That seam does not seed the runner's realm, so the provider it builds
// never reaches the defective path; a green verdict there is not evidence of
// anything. The lowering is the thing that changed, so the lowering is what is
// asserted, with a non-provider control compiled from the identical source.
import { describe, expect, it } from "vitest";

import { compile } from "../src/index.js";

/** A module-goal unit that CALLS a global it does not declare. */
const SOURCE = "export const seen = 1;\nexport function go() {\n  return $DONE(seen);\n}\n";

const OPTIONS = {
  allowJs: true,
  fileName: "provider.js",
  emitWat: true,
  skipSemanticDiagnostics: true,
} as const;

async function watOf(extra: Record<string, unknown>): Promise<string> {
  const result = await compile(SOURCE, { ...OPTIONS, ...extra } as never);
  expect(result.success, (result.errors ?? []).map((e) => e.message).join("; ")).toBe(true);
  return (result as { wat?: string }).wat ?? "";
}

describe("#6492 r9 — a linked provider resolves a free global CALL against the realm", () => {
  it("guards the call with __extern_has when the unit is a link provider", async () => {
    const wat = await watOf({ exportsConsumedByWasm: true });
    expect(wat).toContain("__extern_has");
    expect(wat).toContain("__call_function");
    // The absent arm is kept — a genuinely unbound callee must still throw, or
    // every `assert.throws(ReferenceError, …)` over one flips.
    expect(wat).toContain("__throw_reference_error");
  });

  it("leaves an ordinary host module byte-identical (no provider role, no guard)", async () => {
    const wat = await watOf({});
    expect(wat).not.toContain("__extern_has");
    expect(wat).toContain("__throw_reference_error");
  });

  // No standalone case here, deliberately. Standalone defines its OWN
  // wasm-native `__extern_has`, so the marker above proves nothing there; and
  // `exportsConsumedByWasm` legitimately changes standalone codegen by other
  // routes (`standalone-link-boundary.ts`), so byte-identity against a
  // non-provider standalone compile fails for reasons unrelated to this arm.
  // The standalone/honest no-op is covered where it is actually measurable:
  // `tests/issue-3451-linked-harness-lane.test.ts` asserts the honest lane's
  // per-row binary is unchanged, and `isLinkedProviderHostUnit` returns false
  // for `standalone`/`wasi`/`strictNoHostImports` before anything is emitted.
});
