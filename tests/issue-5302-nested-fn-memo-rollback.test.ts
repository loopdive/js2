// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #5302 — a rolled-back speculative compile left `fctx.nestedFnClosureMemos`
// pointing at a truncated local slot.
//
// `emitMemoizedNestedFnClosure` gives each capture-carrying nested function
// declaration ONE per-activation memo local, typed `ref_null <closureStruct>`,
// and caches its slot in `fctx.nestedFnClosureMemos` so every later reference
// yields the same closure instance (JS `f === f`). `snapshotLocals` /
// `restoreLocals` did not cover that map — so a probe that allocated the memo
// local and then rolled back had the slot truncated out of `fctx.locals` while
// the map kept pointing at it. The slot was re-allocated at an unrelated type
// (in the reproducer, the `externref` temp holding the cached `Boolean`
// global), and the committed re-compile took the cache-hit branch and baked
// `local.get`/`local.set <stale slot>` at the closure-struct type:
//
//   CompileError: local.set[0] expected type (ref null 20),
//                 found ref.as_non_null of type (ref extern)
//
// Same defect family as #1847 (locals vector), #2029 (`localMap` re-points) and
// #3032 (`boxedTdzFlags` / `tdzFlagLocals`) — one map later.
//
// The trigger is a CHAINED method call on `arr.map(nestedFnWithCaptures)`:
// `doc.map(printDoc).filter(Boolean)` in prettier's `src/document/debug.js`,
// which made six prettier upstream unit files fail `WebAssembly.compile`
// wholesale. Splitting the chain into two statements is already valid, which
// is what hid this.
//
// The sources are plain untyped `.js` behind a two-file project, matching how
// the upstream suites feed package code in — annotating the receiver `: any`
// routes to a different arm and passes with and without the fix.

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import type ts from "typescript";
import { compileProject } from "../src/index.js";
import { createCodegenContext } from "../src/codegen/index.js";
import { allocLocal } from "../src/codegen/context/locals.js";
import { rollbackSpeculative, snapshotSpeculative } from "../src/codegen/context/speculative.js";
import type { CodegenContext, FunctionContext } from "../src/codegen/context/types.js";
import { createEmptyModule } from "../src/ir/types.js";
import { instantiateWithRuntime } from "./equivalence/helpers.js";

const roots: string[] = [];
afterAll(() => {
  while (roots.length > 0) rmSync(roots.pop()!, { recursive: true, force: true });
});

const ENTRY = `import { run } from "./mod.js";\nexport function test(): number { return (run as unknown as () => number)(); }`;

async function compileModule(moduleSource: string) {
  const root = mkdtempSync(join(tmpdir(), "js2-fnmemo-"));
  roots.push(root);
  mkdirSync(root, { recursive: true });
  writeFileSync(join(root, "mod.js"), moduleSource);
  writeFileSync(join(root, "entry.ts"), ENTRY);
  const result = await compileProject(join(root, "entry.ts"), {
    allowJs: true,
    skipSemanticDiagnostics: true,
    target: "gc",
    platform: "node",
  });
  expect(result.success, result.errors.map((error) => error.message).join("\n")).toBe(true);
  return result;
}

/** Compile, then assert the engine ACCEPTS the module — the failure was validation-only. */
async function validate(moduleSource: string): Promise<void> {
  const result = await compileModule(moduleSource);
  await expect(WebAssembly.compile(result.binary)).resolves.toBeInstanceOf(WebAssembly.Module);
}

async function runModule(moduleSource: string): Promise<unknown> {
  const result = await compileModule(moduleSource);
  const instance = await instantiateWithRuntime(result);
  return (instance.exports as Record<string, () => unknown>).test();
}

const NESTED = `  const memo = [];
  function inner(x) { memo.push(x); return String(x); }
  const doc = ["a", "b"];`;

describe("#5302 memo slot for a capture-carrying nested fn survives a rolled-back probe", () => {
  it("emits valid wasm for arr.map(nestedFn).filter(Boolean)", async () => {
    await validate(`export function run() {\n${NESTED}\n  return doc.map(inner).filter(Boolean).length;\n}`);
  });

  it("emits valid wasm for arr.map(nestedFn).join(sep)", async () => {
    await validate(`export function run() {\n${NESTED}\n  return doc.map(inner).join(",").length;\n}`);
  });

  it("emits valid wasm for arr.map(nestedFn).map(nestedFn)", async () => {
    await validate(`export function run() {\n${NESTED}\n  return doc.map(inner).map(inner).length;\n}`);
  });

  it("emits valid wasm for arr.map(nestedFn).filter(arrow)", async () => {
    await validate(`export function run() {\n${NESTED}\n  return doc.map(inner).filter((v) => v).length;\n}`);
  });

  // prettier's `printDocToDebug` shape verbatim: a RECURSIVE nested declaration
  // used as its own `.map` callback, with the result chained.
  it("emits valid wasm for a recursive nested fn mapped over its own input", async () => {
    await validate(`export function outerFn(doc) {
  const used = [];
  return inner(doc);
  function inner(d) {
    if (typeof d === "string") return JSON.stringify(d);
    if (Array.isArray(d)) {
      const printed = d.map(inner).filter(Boolean);
      used.push(printed.length);
      return printed.length === 1 ? printed[0] : "[" + printed.join(", ") + "]";
    }
    return "?";
  }
}
export function run() { return outerFn(["a", ["b", "c"]]).length; }`);
  });

  // Behaviour parity: the chained form (invalid wasm before this fix) must agree
  // with the two-statement form, which already compiled and ran.
  it("agrees with the two-statement form the probe never rolled back", async () => {
    const chained = await runModule(
      `export function run() {\n${NESTED}\n  return doc.map(inner).join("").length * 10 + memo.length * 100;\n}`,
    );
    const split = await runModule(
      `export function run() {\n${NESTED}\n  const m = doc.map(inner);\n  return m.join("").length * 10 + memo.length * 100;\n}`,
    );
    expect(chained).toBe(split);
    expect(chained).toBe(220);
  });

  // Identity: the memo local exists so every reference is the SAME closure.
  it("keeps one closure instance per activation across the chained call", async () => {
    expect(
      await runModule(`export function run() {
  const memo = [];
  function inner(x) { memo.push(x); return String(x); }
  const same = inner === inner ? 1 : 0;
  return ["a", "b"].map(inner).filter(Boolean).length * 0 + same + memo.length * 10;
}`),
    ).toBe(21);
  });

  // The memoized closure copies its captures at the first DYNAMIC reference,
  // not at a prologue hoist — a fresh slot must not change that timing.
  it("copies captures at the first dynamic reference", async () => {
    expect(
      await runModule(`export function run() {
  let n = 0;
  const seen = [];
  function inner(x) { seen.push(x + n); return x; }
  n = 5;
  const out = [1, 2, 3].map(inner).filter(Boolean);
  return out.length * 1000 + seen[0] * 10 + seen[2];
}`),
    ).toBe(3068);
  });
});

// Pin the snapshot/restore contract itself, in the style of
// tests/issue-1919-speculative-compile.test.ts — the end-to-end cases above can
// only reach it through whichever probe site happens to fire today.
function makeFctx(): FunctionContext {
  return {
    name: "test",
    params: [],
    locals: [],
    localMap: new Map<string, number>(),
    returnType: null,
    body: [],
    blockDepth: 0,
    breakStack: [],
    continueStack: [],
    labelMap: new Map(),
    savedBodies: [],
  } as unknown as FunctionContext;
}

function makeCtx(): CodegenContext {
  return createCodegenContext(createEmptyModule(), {} as unknown as ts.TypeChecker);
}

describe("#5302 rollbackSpeculative unwinds nestedFnClosureMemos with the slot", () => {
  it("drops a memo entry the probe added", () => {
    const ctx = makeCtx();
    const fctx = makeFctx();
    const snap = snapshotSpeculative(ctx, fctx);
    const slot = allocLocal(fctx, "__fnmemo_inner_0", { kind: "ref_null", typeIdx: 24 });
    (fctx.nestedFnClosureMemos ??= new Map()).set("inner", slot);
    rollbackSpeculative(ctx, fctx, snap);
    expect(fctx.locals.length).toBe(0);
    expect(fctx.nestedFnClosureMemos?.get("inner")).toBeUndefined();
  });

  it("keeps a memo entry that existed before the probe", () => {
    const ctx = makeCtx();
    const fctx = makeFctx();
    const kept = allocLocal(fctx, "__fnmemo_outer_0", { kind: "ref_null", typeIdx: 7 });
    (fctx.nestedFnClosureMemos ??= new Map()).set("outer", kept);
    const snap = snapshotSpeculative(ctx, fctx);
    const probed = allocLocal(fctx, "__fnmemo_inner_1", { kind: "ref_null", typeIdx: 24 });
    fctx.nestedFnClosureMemos.set("inner", probed);
    rollbackSpeculative(ctx, fctx, snap);
    expect(fctx.nestedFnClosureMemos?.get("outer")).toBe(kept);
    expect(fctx.nestedFnClosureMemos?.get("inner")).toBeUndefined();
  });

  it("restores a memo entry the probe RE-POINTED at a fresh slot", () => {
    const ctx = makeCtx();
    const fctx = makeFctx();
    const original = allocLocal(fctx, "__fnmemo_inner_0", { kind: "ref_null", typeIdx: 24 });
    (fctx.nestedFnClosureMemos ??= new Map()).set("inner", original);
    const snap = snapshotSpeculative(ctx, fctx);
    fctx.nestedFnClosureMemos.set("inner", allocLocal(fctx, "__fnmemo_inner_1", { kind: "ref_null", typeIdx: 24 }));
    rollbackSpeculative(ctx, fctx, snap);
    expect(fctx.nestedFnClosureMemos?.get("inner")).toBe(original);
  });

  it("leaves the map absent when the frame never memoized a closure", () => {
    const ctx = makeCtx();
    const fctx = makeFctx();
    const snap = snapshotSpeculative(ctx, fctx);
    rollbackSpeculative(ctx, fctx, snap);
    expect(fctx.nestedFnClosureMemos).toBeUndefined();
  });
});
