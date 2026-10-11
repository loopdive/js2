// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #6859 — an async function's identifier parameter lives in an IMMUTABLE frame
// field snapshotted at activation, so an assignment before a suspension was
// lost after it (`x ||= d; await p; return x` answered the argument), and a
// nested closure's write (`new Promise((r) => (resolve = r))`) never reached
// the post-await read at all. Assigned parameters now ride the frame as
// live-initialized spills (cell-boxed when a nested function references them).

import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { compileProject } from "../src/index.js";
import { buildCompiledImports } from "../src/runtime.js";

const ENTRY = fileURLToPath(new URL("./fixtures/issue-6859/entry.js", import.meta.url));

describe("#6859 — an assigned async parameter survives the suspension", () => {
  it("reads the assigned value after the await", async () => {
    const result = await compileProject(ENTRY, { allowJs: true, skipSemanticDiagnostics: true, target: "gc" });
    expect(result.success, result.errors.map((error) => error.message).join("\n")).toBe(true);
    const imports = buildCompiledImports(result, {}) as Record<string, unknown> & WebAssembly.Imports;
    const { instance } = await WebAssembly.instantiate(result.binary, imports);
    (imports.setInstance as ((i: WebAssembly.Instance) => void) | undefined)?.(instance);
    (imports.__setInstance as ((i: WebAssembly.Instance) => void) | undefined)?.(instance);
    (instance.exports.__module_init as (() => void) | undefined)?.();
    const rows = instance.exports.rows as () => Promise<string>;
    // Parent: "1,undefined,-1,8" — the pre-assignment argument, `undefined`, and the
    // closure-written `resolve` still undefined. The last row (a read-only
    // parameter) is the anti-vacuity control and is 8 on both.
    await expect(rows()).resolves.toBe("2,3,5,8");
  });
});
