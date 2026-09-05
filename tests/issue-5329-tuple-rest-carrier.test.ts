// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #5329 — a TUPLE-typed rest parameter (`function (...args: [Error])`) is a
// carrier neither rest builder knew about, and both of their fallbacks were
// wrong in a way that could not be seen from the source.
//
// Most rest parameters lower to the canonical `{ length, data }` vec; an empty
// tuple rest (`...args: []`) lowers to a zero-field struct. A NON-EMPTY tuple
// rest lowers to a `__tuple_N` struct with one field per element, so:
//
//  - `compileRestClosureArguments` (calls-closures.ts) fell through to
//    `pushDefaultValue(ref …)` = `ref.null` + `ref.as_non_null`, and every
//    direct call trapped with "dereferencing a null pointer" before the body
//    ran;
//  - `classifyClosureDispatchRest` (closure-exports.ts) returned `undefined`,
//    which the caller could not distinguish from "there is no rest formal", so
//    the closure was admitted as an ordinary arity-N entry with the formal
//    dropped. The emitted `call_ref` was then one operand short and the WHOLE
//    module failed to validate:
//      `Compiling function #N:"__call_fn_0" failed: not enough arguments on the
//       stack for call_ref (need 2, got 1)`
//
// Production witness: jest's `packages/jest-jasmine2/src/queueRunner.ts`
// (`const next = function (...args: [Error]) {…}` plus a `next.fail` twin). It
// was the ONLY module of the 34 in the jest dogfood suite that failed Wasm
// validation, taking all 6 of its tests with it.
//
// The fix adds the carrier to the shared recognizer
// (`src/codegen/closures/tuple-rest-carrier.ts`) so both builders agree, and
// gives `classifyClosureDispatchRest` an explicit `"unsupported"` answer so a
// formal it cannot build is SKIPPED rather than silently dropped — an
// unbuildable carrier must never again cost the whole module its validity.
//
// WHY `.ts` AND NOT UNTYPED `.js`: the trigger IS the type annotation. There is
// no untyped spelling of a tuple rest, so the usual "untyped `.js` fixture"
// rule cannot apply here; an unannotated `...args` lowers to the vec carrier and
// was always correct. The two-file project shape is kept.
//
// DOCUMENTED RESIDUAL, asserted below: `.length` on a tuple reads NaN. That is
// a property-access gap on tuple structs generally — a plain
// `const t: [number, number] = [1, 2]; t.length` reads NaN too, with and
// without this change — not something this carrier introduced.

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { compileProject, type CompileResult } from "../src/index.js";
import { buildCompiledImports } from "../src/runtime.js";

const roots: string[] = [];
afterAll(() => {
  while (roots.length > 0) rmSync(roots.pop()!, { recursive: true, force: true });
});

async function compileFixture(files: Record<string, string>, entry: string): Promise<CompileResult> {
  const root = mkdtempSync(join(tmpdir(), "js2-5329-"));
  roots.push(root);
  for (const [name, source] of Object.entries(files)) {
    const target = join(root, name);
    mkdirSync(join(target, ".."), { recursive: true });
    writeFileSync(target, source);
  }
  return compileProject(join(root, entry), {
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
export function record(sink: number[], value: number): number {
  sink.push(value);
  return sink.length;
}
`;

// `queueRunner.ts`'s shape: a function EXPRESSION (so it is lifted into a
// closure and lands in the host dispatch table) with a tuple rest, a property
// assigned onto it that is a second tuple-rest function expression, and
// \`.apply(null, args)\` forwarding the whole tuple.
const ENTRY = `
import { record } from './dep.js';

const sink: number[] = [];

const next = function (...args: [number]) {
  const first = args[0];
  return record(sink, first);
};
(next as any).fail = function (...args: [number]) {
  return record(sink, args[0] * 10);
};

const twoWide = function (...args: [number, number]) {
  return args[0] * 100 + args[1];
};

const forwarder = function (...args: [number]) {
  return next.apply(null, args);
};

export function callDirect(): number { return next(7); }
export function callProperty(): number { return (next as any).fail(3); }
export function callTwoWide(): number { return twoWide(4, 5); }
export function callThroughApply(): number { return forwarder(9); }
export function callAsCallback(): number {
  const out = [1, 2, 3].map(next);
  return out[out.length - 1] as number;
}
export function sinkLength(): number { return sink.length; }
// Residual: \`.length\` on a tuple reads NaN, before and after this change.
export function restLength(): number {
  const widthOf = function (...args: [number]) { return args.length; };
  return widthOf(1);
}
`;

describe("#5329 tuple-typed rest parameter carrier", () => {
  it("produces a module that validates and calls the closure with its tuple", async () => {
    const result = await compileFixture({ "dep.ts": DEP, "main.ts": ENTRY }, "main.ts");
    // Before the fix this compile FAILED outright: `__call_fn_0` was emitted one
    // operand short and the emitted module was rejected by validation.
    expect(result.success).toBe(true);
    const exports = await instantiate(result);

    expect((exports.callDirect as () => number)()).toBe(1);
    expect((exports.callProperty as () => number)()).toBe(2);
    expect((exports.callTwoWide as () => number)()).toBe(405);
    expect((exports.callThroughApply as () => number)()).toBe(3);
  });

  it("keeps the closure reachable through the host dispatcher", async () => {
    const result = await compileFixture({ "dep.ts": DEP, "main.ts": ENTRY }, "main.ts");
    expect(result.success).toBe(true);
    const exports = await instantiate(result);

    // `Array.prototype.map` routes the closure through `__call_fn_N` — the
    // dispatcher whose arm used to be dropped. The last element is the third
    // `record` call in this instance, so it observes the growing sink.
    expect((exports.callAsCallback as () => number)()).toBe(3);
    expect((exports.sinkLength as () => number)()).toBe(3);
  });

  it("still reads NaN for a tuple's .length (documented residual)", async () => {
    const result = await compileFixture({ "dep.ts": DEP, "main.ts": ENTRY }, "main.ts");
    expect(result.success).toBe(true);
    const exports = await instantiate(result);
    // Not introduced here: a plain `const t: [number, number] = [1, 2]` reads
    // `t.length` as NaN too, unchanged by this fix. Asserted so the day the
    // tuple property-access gap is closed, this test says so.
    expect((exports.restLength as () => number)()).toBeNaN();
  });
});
