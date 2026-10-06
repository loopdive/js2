// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #6848 — `Object.entries(form).forEach(cb)` where `cb` captures a binding
// typed `any` (hono `convertFormDataToBodyData`). The native reference-element
// HOF lowering declines such a callback by design (#4728), but no host arm
// claimed a call on a NATIVE vec receiver, so the call fell to the graceful
// fallback: receiver and callback evaluated and DROPPED, the callback never run.

import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { compileProject } from "../src/index.js";
import { buildCompiledImports } from "../src/runtime.js";

const ENTRY = fileURLToPath(new URL("./fixtures/issue-6848/entry.js", import.meta.url));
const LANE_SAFE = fileURLToPath(new URL("./fixtures/issue-6848/lane-safe.js", import.meta.url));

async function compileEntry(entry: string): Promise<{ exports: WebAssembly.Exports; importNames: string[] }> {
  const result = await compileProject(entry, { allowJs: true, skipSemanticDiagnostics: true, target: "gc" });
  expect(result.success, result.errors.map((error) => error.message).join("\n")).toBe(true);
  const imports = buildCompiledImports(result, {}) as Record<string, unknown> & WebAssembly.Imports;
  const { instance } = await WebAssembly.instantiate(result.binary, imports);
  (imports.setInstance as ((i: WebAssembly.Instance) => void) | undefined)?.(instance);
  (imports.__setInstance as ((i: WebAssembly.Instance) => void) | undefined)?.(instance);
  (instance.exports.__module_init as (() => void) | undefined)?.();
  const importNames = ((result.imports ?? []) as readonly { readonly name: string }[]).map((entry) => entry.name);
  return { exports: instance.exports, importNames };
}

describe("#6848 — a declined callback method on a native vec reaches the host", () => {
  it("runs the callbacks and returns their results", async () => {
    const { exports } = await compileEntry(ENTRY);
    const call = (name: string) => (exports[name] as () => unknown)();
    // Parent: the callback never ran — `{"obj.key1":"v1","obj.key2":"v2","x":"y"}`.
    expect(call("forEachRewritesKeys")).toBe('{"x":"y","obj":{"key1":"v1","key2":"v2"}}');
    // Parent: `dereferencing a null pointer` (the dropped call answered null).
    expect(call("filterReadsCapture")).toBe("1:x");
    // Parent: `false,false`.
    expect(call("someAndEvery")).toBe("true,false");
    // Parent: the seed, 0.
    expect(call("reduceFoldsCapture")).toBe(5);
  });

  // Anti-vacuity: a lane-safe callback keeps the native lowering — the host
  // method bridge must not appear for it.
  it("leaves a lane-safe callback on the native lowering", async () => {
    const { exports, importNames } = await compileEntry(LANE_SAFE);
    expect((exports.nativeForEach as () => string)()).toBe("a,b");
    expect(importNames).not.toContain("__extern_method_call");
  });
});
