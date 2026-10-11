// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #6847 — hono's `parseSigned` shape: an async for-of over `Object.entries`
// with a destructured head, guard-clause `continue`s and an `await` in the
// body. Three defects in the async CFG for-of region:
//   1. any `continue` rejected the region (→ synchronous pass-through, the
//      awaited Promise bound and coerced to `false`);
//   2. a body whose only non-linear construct is the for-of was built and then
//      discarded (same pass-through);
//   3. a destructured head's TDZ flags were plain resume-fn locals, reset on
//      re-entry → "key is not defined" in the state after the suspension.

import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { compileProject } from "../src/index.js";
import { buildCompiledImports } from "../src/runtime.js";

const ENTRY = fileURLToPath(new URL("./fixtures/issue-6847/entry.js", import.meta.url));

async function compileEntry(): Promise<WebAssembly.Exports> {
  const result = await compileProject(ENTRY, { allowJs: true, skipSemanticDiagnostics: true, target: "gc" });
  expect(result.success, result.errors.map((error) => error.message).join("\n")).toBe(true);
  const imports = buildCompiledImports(result, {}) as Record<string, unknown> & WebAssembly.Imports;
  const { instance } = await WebAssembly.instantiate(result.binary, imports);
  (imports.setInstance as ((i: WebAssembly.Instance) => void) | undefined)?.(instance);
  (imports.__setInstance as ((i: WebAssembly.Instance) => void) | undefined)?.(instance);
  (instance.exports.__module_init as (() => void) | undefined)?.();
  return instance.exports;
}

type LoopExport = (obj: Record<string, string>) => Promise<string>;

describe("#6847 — async for-of with continue guards and a destructured head", () => {
  it("runs a body whose only non-linear construct is the for-of", async () => {
    const forOfOnly = (await compileEntry()).forOfOnly as LoopExport;
    // Parent: {"a":false,"b":false,"c":false} — every `ok` was the Promise.
    await expect(forOfOnly({ a: "xy", b: "", c: "z" })).resolves.toBe('{"a":"xy","b":false,"c":false}');
  });

  it("keeps destructured head names readable after the suspension", async () => {
    const destructuredAcrossAwait = (await compileEntry()).destructuredAcrossAwait as LoopExport;
    // Parent: ReferenceError: key is not defined.
    await expect(destructuredAcrossAwait({ a: "xy", b: "", c: "z" })).resolves.toBe('{"a":"xy","c":false}');
  });

  it("lowers guard-clause `continue`s and still rejects for the right reason", async () => {
    const continueGuards = (await compileEntry()).continueGuards as LoopExport;
    // Parent: every surviving key mapped to `false`. `c` (one-char suffix) and
    // `e` (failing check) must STILL be `false` — the anti-vacuity half: the
    // fix delivers the real verdict, it does not make every check pass.
    await expect(continueGuards({ a: "choco.ok", b: "nodot", c: "x.y", d: "skip.ok", e: "plain.z" })).resolves.toBe(
      '{"a":"choco","c":false,"e":false}',
    );
  });
});
