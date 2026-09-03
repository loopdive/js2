// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// (#5276) A for-head `var` at module scope used to capture its module-global
// index BEFORE compiling the initializer and push the `global.set` AFTER it.
// Compiling `a[0]` registers the bounds-check error path's string constant,
// `addStringConstantGlobals` runs `fixupModuleGlobalIndices`, and that fixup
// shifts `ctx.moduleGlobals`, every already-emitted `global.get/set` and ~20
// cached index maps — but it cannot reach a number sitting in a caller's local
// whose instruction has not been pushed yet. The head then wrote `global.set N`
// while every other reference to the same variable read `global.get N+1`: the
// initializer landed in the PRECEDING global and the loop variable kept its
// default. Sixth instance of the staleness family documented inside
// `fixupModuleGlobalIndices` (#2023, #2001, #3032, #3933, #4648) — and the
// first one that is a value in flight on the stack rather than a cache.
//
// Both cases run twice: once on the default two-pass module-init route and once
// with the pass-1 skip seam of #5480 (`JS2WASM_ENABLE_MODULE_INIT_DISCOVERY_STATIC`)
// enabled, which is the route the gap-6a census (#3523, "gap-6a v2 repair
// record", family A) measured the regression on. **The assertions must hold
// with the seam OFF too** — pass 1 was believed to mask the bug by compiling
// the whole initializer once, so a later retirement of pass 1 must not be able
// to silently un-pin this. Measured on `origin/main` 2026-09-02 with the fix
// reverted, both routes fail identically: case 1 reads 4 instead of 2 (WAT
// `global.set 4` in the head against `global.get 5` everywhere else) and case 2
// refuses to instantiate with
// `global.set[0] expected type f64, found call of type (ref extern)`.
import { afterEach, describe, expect, it } from "vitest";

import { compile } from "../src/index.js";
import { buildImports, instantiateWasm } from "../src/runtime.js";

// Register the statement/expression delegates used by generateModule.
import "../src/codegen/expressions.js";

const SEAM_ENV = "JS2WASM_ENABLE_MODULE_INIT_DISCOVERY_STATIC";
const ROUTES: readonly { readonly name: string; readonly seam: boolean }[] = [
  { name: "default two-pass route", seam: false },
  { name: "pass-1 skip seam (#5480)", seam: true },
];

afterEach(() => {
  Reflect.deleteProperty(process.env, SEAM_ENV);
});

async function readExport(source: string, seam: boolean, fileName: string): Promise<unknown> {
  if (seam) process.env[SEAM_ENV] = "1";
  else Reflect.deleteProperty(process.env, SEAM_ENV);
  const result = await compile(source, { fileName, skipSemanticDiagnostics: true, target: "gc" });
  expect(result.success, result.success ? "" : result.errors.map((e) => e.message).join("\n")).toBe(true);
  const imports = buildImports(result.imports, {}, result.stringPool);
  // Pre-fix, the string-variable shape threw right here: the off-by-one wrote
  // the initializer's `(ref extern)` into the neighbouring f64 global.
  const { instance } = await instantiateWasm(result.binary, imports.env, imports.string_constants);
  imports.setInstance?.(instance);
  const exports = instance.exports as { __module_init?: () => void; read?: () => unknown };
  exports.__module_init?.();
  return exports.read?.();
}

describe("#5276 — a for-head module global is written through its LIVE index, not the one captured before the initializer", () => {
  for (const route of ROUTES) {
    it(`counts the loop the initializer sizes (${route.name})`, async () => {
      const source = `var a = [1, 2];
var n = 0;
for (var j = a[0]; j <= 2; j++) { n = n + 1; }
export function read(): number { return n; }
`;
      // j = 1, so the body runs for j = 1 and j = 2. Pre-fix the head stored
      // a[0] into the PRECEDING global (`n`), j kept its 0 default, and the
      // extra iteration plus the stray 1 read 4.
      expect(await readExport(source, route.seam, "issue-5276-numeric.ts")).toBe(2);
    });

    it(`instantiates a string-typed for-head variable (${route.name})`, async () => {
      const source = `var a = ["x", "y"];
var out = 0;
for (var s = a[0] + ""; s.length < 3; s = s + "z") { out = out + 1; }
export function read(): number { return out; }
`;
      expect(await readExport(source, route.seam, "issue-5276-string.ts")).toBe(2);
    });
  }
});
