// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #6846 — an `await` nested inside its statement (a call argument, a binary
// operand, an object-literal property, a destructured initializer) made the
// async planner decline the whole function to the synchronous pass-through,
// where `await` is an identity: the caller saw the Promise object.
//
// When everything the statement evaluated BEFORE the await is replay-safe, the
// planner now suspends on the await and recompiles the statement in the resume
// state with the delivered value substituted (`asyncAwaitValueLocals`).

import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { compileProject } from "../src/index.js";
import { buildCompiledImports } from "../src/runtime.js";

const ENTRY = fileURLToPath(new URL("./fixtures/issue-6846/entry.js", import.meta.url));
const EFFECT = fileURLToPath(new URL("./fixtures/issue-6846/effect.js", import.meta.url));

async function compileEntry(entry = ENTRY): Promise<WebAssembly.Exports> {
  const result = await compileProject(entry, { allowJs: true, skipSemanticDiagnostics: true, target: "gc" });
  expect(result.success, result.errors.map((error) => error.message).join("\n")).toBe(true);
  const imports = buildCompiledImports(result, {}) as Record<string, unknown> & WebAssembly.Imports;
  const { instance } = await WebAssembly.instantiate(result.binary, imports);
  (imports.setInstance as ((i: WebAssembly.Instance) => void) | undefined)?.(instance);
  (imports.__setInstance as ((i: WebAssembly.Instance) => void) | undefined)?.(instance);
  (instance.exports.__module_init as (() => void) | undefined)?.();
  return instance.exports;
}

type AsyncExport = () => Promise<unknown>;

describe("#6846 — a nested await that is its statement's first observable step", () => {
  it("delivers the settled value at every replay-safe nested position", async () => {
    const exports = await compileEntry();
    const call = (name: string) => (exports[name] as AsyncExport)();
    // Parent: `object:[object Promise]`, `x[object Promise]`,
    // `value is not iterable`, `[object Promise]1`, `[object Promise]`, and a
    // compile-time "async shape not supported" for the settled operand.
    await expect(call("callArgument")).resolves.toBe("string:v");
    await expect(call("binaryOperand")).resolves.toBe("xv");
    await expect(call("destructuredInitializer")).resolves.toBe(7);
    await expect(call("objectLiteralProperty")).resolves.toBe("v1");
    await expect(call("ambientCallee")).resolves.toBe("ok");
    await expect(call("settledOperand")).resolves.toBe("string:p");
  });

  // Soundness control: `count()` is evaluated before the await, so replaying
  // the statement after the resumption would run it a second time. That shape
  // must keep declining — `count` runs exactly once per call.
  it("never replays a statement whose pre-await work is observable", async () => {
    const exports = await compileEntry(EFFECT);
    const effectBeforeAwait = exports.effectBeforeAwait as AsyncExport;
    const callCount = exports.callCount as () => number;
    await effectBeforeAwait();
    expect(callCount()).toBe(1);
  });
});
