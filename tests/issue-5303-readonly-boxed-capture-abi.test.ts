// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * Issue #5303 — a READ-ONLY capture whose value type is itself a GC reference
 * was forwarded as the declaring frame's ref CELL instead of the cell's value.
 *
 * Setup. A nested `function` declaration is lifted with its captures as leading
 * parameters. When a sibling mutates one of those bindings, the declaring frame
 * boxes its slot into a `__boxed_<name>` ref cell and re-aims `localMap` at it.
 * Read-only capturers still want the VALUE — the cell belongs to the frame that
 * needed write-through, not to their ABI — so both capture-forwarding sites
 * (the direct-call prepend in `call-identifier.ts`, the closure-reification
 * prepend in `funcref-as-closure.ts`) unwrap it with a `struct.get`.
 *
 * The defect. Both sites decided "the consumer wants the value" by asking
 * whether the expected type was a NON-reference (f64 / i32 / externref). That is
 * only a proxy, and it answers "no" for a read-only capture whose own value type
 * is a GC reference — an array of arrays, `(ref $vec-of-vec)`. The cell was then
 * forwarded where the value was wanted:
 *
 *   - closure reification passed the raw cell → `RuntimeError: illegal cast`;
 *   - the direct call "coerced" cell→value with a guarded `ref.test`/`ref.cast`
 *     `if` that can only ever yield null, and if the callee's reserved signature
 *     was later rewritten to the cell the module stopped validating outright
 *     (`call[13] expected type (ref null 92), found if of type (ref null 84)`).
 *
 * Measured on moment@2.30.1, whose `isoDates` / `isoTimes` are exactly this
 * shape: every admitted upstream test failed, 0/10, six of six modules rejected
 * by `WebAssembly.compile`. With the fix, 4/10.
 *
 * The fixture is untyped `.js` behind a two-file project on purpose. Annotating
 * the receiver `: any` routes the call through a different arm and the test then
 * passes identically with and without the fix.
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { compileProject } from "../src/index.js";
import { buildCompiledImports } from "../src/runtime.js";

const roots: string[] = [];
afterAll(() => {
  while (roots.length > 0) rmSync(roots.pop()!, { recursive: true, force: true });
});

/**
 * `table` is a read-only array-of-arrays, so its value type is a GC reference.
 *
 * `early` and `caller` are declared BEFORE the `var table` initializer, so the
 * write-after-declaration analysis records `table` as a MUTABLE capture for
 * them. `callee` is declared AFTER it and captures `table` read-only. `pick`
 * hands `early` out as a VALUE without capturing `table` itself, which is the
 * shape whose transitive promotion boxes the declaring frame's slot — after
 * `callee`'s capture ABI has already been published.
 *
 * Measured on the parent commit (68246a740c): 1 failed | 1 passed. With the
 * fix: 2 passed. Only the first case reproduces on the parent; the second is a
 * value guard that keeps the unwrap honest (a cell forwarded where the value
 * belongs can also arrive as a silent `null` rather than a trap).
 */
const MODULE_SOURCE = `
var api = (function () {
  function pick() {
    return early;
  }

  function hold() {
    return callee;
  }

  function early(i) {
    return table[i][0];
  }

  function caller(i) {
    return table[i][0] + callee(i);
  }

  var table = [
    [10, 20],
    [30, 40],
  ];

  function callee(i) {
    return table[i][1];
  }

  return { caller: caller, pick: pick, hold: hold, callee: callee };
})();

export function readThroughCall(i) {
  return api.caller(i);
}

export function readThroughClosure(i) {
  return api.pick()(i);
}

export function holdCallee() {
  return api.hold();
}
`;

const ENTRY_SOURCE = `
import { holdCallee, readThroughCall, readThroughClosure } from "./mod.js";

export function viaCall(i: number): number {
  return readThroughCall(i);
}

export function viaClosure(i: number): number {
  return readThroughClosure(i);
}

export function keepCallee(): unknown {
  return holdCallee();
}
`;

async function instantiate(): Promise<WebAssembly.Exports> {
  const root = mkdtempSync(join(tmpdir(), "js2-5303-"));
  roots.push(root);
  mkdirSync(root, { recursive: true });
  writeFileSync(join(root, "mod.js"), MODULE_SOURCE);
  writeFileSync(join(root, "entry.ts"), ENTRY_SOURCE);
  const result = await compileProject(join(root, "entry.ts"), {
    allowJs: true,
    skipSemanticDiagnostics: true,
    target: "gc",
    platform: "node",
    deferTopLevelInit: true,
  });
  expect(result.success, result.errors.map((error) => error.message).join("\n")).toBe(true);
  // The direct-call half of the defect is a VALIDATION failure, so assert the
  // binary is accepted before anything runs — a `.validate()` here names the
  // right defect instead of surfacing as an opaque instantiation error.
  expect(WebAssembly.validate(result.binary)).toBe(true);
  const imports = buildCompiledImports(result, {}) as Record<string, unknown> & WebAssembly.Imports;
  const { instance } = await WebAssembly.instantiate(result.binary, imports);
  (imports.setInstance as ((i: WebAssembly.Instance) => void) | undefined)?.(instance);
  (imports.__setInstance as ((i: WebAssembly.Instance) => void) | undefined)?.(instance);
  (instance.exports.__module_init as (() => void) | undefined)?.();
  return instance.exports;
}

describe("#5303 read-only capture of a GC-reference value behind a boxed slot", () => {
  it("forwards the cell's value, not the cell, through a direct sibling call", async () => {
    // On the parent commit this reifies `caller` with the raw ref cell as its
    // `table` capture argument and traps: `RuntimeError: illegal cast` in
    // `__fn_tramp_caller_2`.
    const exports = await instantiate();
    // table[1][0] + table[1][1] === 30 + 40.
    expect((exports.viaCall as (i: number) => number)(1)).toBe(70);
    expect((exports.viaCall as (i: number) => number)(0)).toBe(30);
  });

  it("forwards the cell's value, not the cell, through closure reification", async () => {
    // Value guard rather than a parent-commit repro: `early`'s own capture of
    // `table` is MUTABLE, so it legitimately takes the cell and this path is
    // correct on both sides. It fails if the fix over-corrects and starts
    // unwrapping a consumer that really does want the cell.
    const exports = await instantiate();
    expect((exports.viaClosure as (i: number) => number)(1)).toBe(30);
    expect((exports.viaClosure as (i: number) => number)(0)).toBe(10);
  });
});
