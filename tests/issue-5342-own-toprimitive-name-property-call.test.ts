// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #5342 cause B — calling an object literal's OWN `toString` / `valueOf`
// property answered `null`, silently:
//
//   const _ = { toString: fn };
//   _.toString('x');            // null   (want fn('x'))
//
// Not the Object.prototype fallback it looks like. `{ toString: fn }` types
// that one field `eqref` on purpose (#4394) so the ToPrimitive dispatchers can
// `ref.test` the stored closure without an externref round-trip. The
// callable-property dispatcher admitted only `externref`, `ref` and `ref_null`
// carriers, so for an `eqref` field EVERY arm of the method-call ladder
// declined and the call fell through to calls.ts's graceful tail — compile the
// callee, `drop`, push `ref.null.extern`. Green compile, no diagnostic, wrong
// answer.
//
// lodash's `_.toString(value)` is exactly this shape and every one of its
// direct method calls returned `null`, including `_.toString('x')`.
//
// The fix admits the `eqref` carrier into the same wrapper-dispatch branch,
// skipping only the `any.convert_extern` that the externref carrier needs.
//
// Untyped `.js` two-file fixtures: the property name has to come from a real
// import so the field keeps its published shape rather than a test-local one.

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join as joinPath } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { compileProject, type CompileResult } from "../src/index.js";
import { buildCompiledImports } from "../src/runtime.js";

const roots: string[] = [];
afterAll(() => {
  while (roots.length > 0) rmSync(roots.pop()!, { recursive: true, force: true });
});

async function compileFixture(files: Record<string, string>, entry: string): Promise<CompileResult> {
  const root = mkdtempSync(joinPath(tmpdir(), "js2-5342b-"));
  roots.push(root);
  for (const [name, source] of Object.entries(files)) {
    const target = joinPath(root, name);
    mkdirSync(joinPath(target, ".."), { recursive: true });
    writeFileSync(target, source);
  }
  return compileProject(joinPath(root, entry), {
    allowJs: true,
    skipSemanticDiagnostics: true,
    target: "gc",
    platform: "node",
  });
}

async function instantiate(result: CompileResult): Promise<WebAssembly.Exports> {
  const imports = buildCompiledImports(result, {}) as Record<string, unknown> & WebAssembly.Imports;
  const { instance } = await WebAssembly.instantiate(result.binary, imports);
  (imports.setInstance as ((i: WebAssembly.Instance) => void) | undefined)?.(instance);
  (imports.__setInstance as ((i: WebAssembly.Instance) => void) | undefined)?.(instance);
  (instance.exports.__module_init as (() => void) | undefined)?.();
  return instance.exports;
}

const DEP = `
export function conv(value) { return value === undefined ? 'undef' : 'v:' + value; }
`;

const MAIN = `
import { conv } from './dep.js';

const own = { toString: conv, valueOf: conv, plain: conv };
const bare = { n: 1 };
const local = { valueOf: function () { return 41; } };

export function ownToString() { return own.toString('x'); }
export function ownValueOf() { return own.valueOf('y'); }
export function ownPlain() { return own.plain('z'); }
export function inheritedToString() { return bare.toString(); }
export function implicitToPrimitive() { return local + 1; }
export function localValueOfCalled() { return local.valueOf(); }
`;

describe("#5342 own toString/valueOf callable property", () => {
  it("calls the own property instead of answering null", async () => {
    const result = await compileFixture({ "dep.js": DEP, "main.js": MAIN }, "main.js");
    expect(result.success, result.errors.map((e) => e.message).join("\n")).toBe(true);
    const exports = await instantiate(result);

    // Before the fix both of these answered `null`.
    expect((exports.ownToString as () => string)()).toBe("v:x");
    expect((exports.ownValueOf as () => string)()).toBe("v:y");

    // Control: a property whose name is NOT an Object.prototype member keeps
    // the `externref` carrier and always worked — it proves the fixture and
    // the harness, so a null from the two above is the defect, not the setup.
    expect((exports.ownPlain as () => string)()).toBe("v:z");

    // Anti-vacuity, both directions: an object with NO own `toString` must
    // still reach Object.prototype, and an own `valueOf` must still be the one
    // ToPrimitive picks — that implicit dispatch is the whole reason the field
    // is `eqref` (#4394), and admitting the carrier to the EXPLICIT call path
    // must not disturb it.
    expect((exports.inheritedToString as () => string)()).toBe("[object Object]");
    expect((exports.localValueOfCalled as () => number)()).toBe(41);
    expect((exports.implicitToPrimitive as () => number)()).toBe(42);
  });
});
