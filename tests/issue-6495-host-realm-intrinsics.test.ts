// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #6495 — a compiled module must not be able to mutate the HOST process's
// intrinsics.
//
// `__get_builtin(n)` resolves through the row's `globalSandbox` only when that
// sandbox was registered with `markCoherentBuiltinRealm`; otherwise it falls
// back to `(globalThis as any)[n]` — the test process's own constructor. Until
// 2026-09-17 the runner registered the sandbox only when a narrow SOURCE regex
// matched a literal `Object.defineProperty(Array.prototype, …)` in the test
// body, so a row whose intrinsic mutation happens inside the HARNESS
// (`verifyProperty` → `isConfigurable` → `delete obj[name]`) was unprotected:
// `__delete_property`'s plain-object arm removed array iteration from the test
// process, and in the linked lane the vitest worker then hung outright.
//
// The runner now marks EVERY row's sandbox coherent. These cases pin the
// property that matters — the host's own `Array.prototype` / `Object.prototype`
// survive a compiled program that deletes and redefines on them.

import { describe, expect, it } from "vitest";

import { compile } from "../src/index.js";
import { buildImports, markCoherentBuiltinRealm } from "../src/runtime.js";
import { createTestSandbox } from "./test262-runner.js";

// @ts-expect-error -- untyped runner helper
import { instantiateTest262Module } from "../scripts/test262-import-object.mjs";

async function runInRowRealm(source: string): Promise<void> {
  const result = await compile(source, {
    allowJs: true,
    fileName: "test.js",
    emitWat: false,
    skipSemanticDiagnostics: true,
  });
  if (!result.success) throw new Error(result.errors.map((e) => e.message).join("; "));
  const sandbox = createTestSandbox(console as unknown as Console, false);
  markCoherentBuiltinRealm(sandbox);
  const imports = buildImports(result.imports as never, { console }, result.stringPool as never, {
    globalSandbox: sandbox,
  });
  await instantiateTest262Module(result.binary, imports, { runDeferredInit: true });
}

describe("#6495 — a compiled module cannot reach the host realm's intrinsics", () => {
  it("leaves the host Array.prototype's Symbol.iterator in place after a delete", async () => {
    const before = Array.prototype[Symbol.iterator];
    await runInRowRealm(`delete Array.prototype[Symbol.iterator];`);
    expect(Array.prototype[Symbol.iterator]).toBe(before);
    // The host is still able to iterate — the failure mode this guards against
    // was a process that lost array iteration mid-run.
    expect([...[1, 2, 3]]).toEqual([1, 2, 3]);
  }, 120_000);

  it("leaves the host Object.prototype untouched after a define", async () => {
    const hadKey = Object.prototype.hasOwnProperty.call(Object.prototype, "__js2wasm6495");
    await runInRowRealm(`Object.defineProperty(Object.prototype, "__js2wasm6495", { value: 1, configurable: true });`);
    expect(Object.prototype.hasOwnProperty.call(Object.prototype, "__js2wasm6495")).toBe(hadKey);
  }, 120_000);

  // KNOWN RESIDUAL, deliberately not asserted here. A METHOD of an intrinsic
  // (`Array.prototype.forEach`) is reached by a further property read off the
  // realm-resolved prototype, and that read still hands back the HOST function
  // — `Object.defineProperty(Array.prototype.forEach, "name", …)` does clobber
  // the test process. Measured 2026-09-17; this is what the #1957 realm canary
  // reports as `Array.prototype.forEach.name:changed`, which still fires. There
  // is no test for it because the only way to observe it is to perform the
  // corruption, which would poison every later file in the vitest worker. See
  // the "Residual" section of plan/issues/6495-*.md.
});
