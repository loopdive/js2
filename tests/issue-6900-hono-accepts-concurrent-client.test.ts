// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// hono upstream-suite clusters, reduced to a two-file untyped fixture:
//
// - #6900 `accepts.sort(cmp)` on an untyped receiver first-matches the ambient
//   `Uint8ClampedArray_sort` import; a compiled array has no host `sort`, so the
//   call answered undefined (`Cannot read properties of null (reading 'find')`).
// - #6901 a class field declared without an initializer read `null`, not
//   `undefined` (`new Response(body, { status: null })` threw a RangeError).
// - #6902 `(opt?.fetch || fetch)(url)` called the RIGHT operand unconditionally.
// - #6860 an inline async arrow passed to a tagged-template call-of-call
//   (`test.each\`…\`(name, body)`) took the host-callback bridge and ran
//   synchronously; and a self-recursive async arrow's resume fn lost the
//   `const run = …` → `__self` alias, so the recursive call ran on the wrong
//   closure (hono `createPool` with concurrency 1 never drained).
//
// Anti-vacuity: `pick({})` (fallback operand) and the const-bound `each` body
// answer the same on the parent and the fix.

import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { compileProject } from "../src/index.js";
import { buildCompiledImports } from "../src/runtime.js";

const ENTRY = fileURLToPath(new URL("./fixtures/issue-6900-hono/entry.js", import.meta.url));

async function instantiate(): Promise<WebAssembly.Exports> {
  const result = await compileProject(ENTRY, { allowJs: true, skipSemanticDiagnostics: true, target: "gc" });
  expect(result.success, result.errors.map((error) => error.message).join("\n")).toBe(true);
  const imports = buildCompiledImports(result, {}) as Record<string, unknown> & WebAssembly.Imports;
  const { instance } = await WebAssembly.instantiate(result.binary, imports);
  (imports.setInstance as ((i: WebAssembly.Instance) => void) | undefined)?.(instance);
  (imports.__setInstance as ((i: WebAssembly.Instance) => void) | undefined)?.(instance);
  (instance.exports.__module_init as (() => void) | undefined)?.();
  return instance.exports;
}

describe("hono accepts / context / client / concurrent shapes", () => {
  it("sort on an untyped receiver, uninitialized fields, logical callee", async () => {
    const exports = await instantiate();
    // Parent: the `.sort(...).find` row throws; with only the sort fixed the
    // field rows read "object,object" and the logical callee answers fallback:u.
    expect((exports.syncRows as () => string)()).toBe("a,undefined,undefined,1,201,custom:u,fallback:u");
  });

  it("drives an inline tagged-template async body and a self-recursive async arrow", async () => {
    const exports = await instantiate();
    // Parent: "each:NaN" (synchronous pass-through) and the concurrency-1 pool
    // never settles (the recursive `run` re-entered the wrong closure).
    const settled = await Promise.race([
      (exports.asyncRows as () => Promise<string>)(),
      new Promise<string>((resolve) => setTimeout(() => resolve("timeout"), 10_000)),
    ]);
    expect(settled).toBe("123,each:2,bound:2");
  });
});
