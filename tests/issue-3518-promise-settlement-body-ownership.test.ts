// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import ts from "typescript";
import { describe, expect, it } from "vitest";
import * as bodies from "../src/runtime/wasmgc/promise/settlement-bodies.js";
import type { Instr } from "../src/wasm/model/instructions.js";
import { promiseRejectionDispatcher } from "../src/codegen/registry/promise-rejection-dispatch.js";

const root = resolve(import.meta.dirname, "..");
const schedulerPath = "src/codegen/async-scheduler.ts";
const read = (path: string) => readFileSync(resolve(root, path), "utf8");
const parse = (text: string) => ts.createSourceFile("receipt.ts", text, ts.ScriptTarget.Latest, true);
function fn(text: string, name: string): ts.FunctionDeclaration {
  const found = parse(text).statements.filter(
    (node): node is ts.FunctionDeclaration => ts.isFunctionDeclaration(node) && node.name?.text === name,
  );
  assert.equal(found.length, 1, "mandatory function " + name);
  assert(found[0]!.body, "mandatory implementation " + name);
  return found[0]!;
}
// Calibration executes exactly the selected CURRENT adapter declarations with
// controlled dependencies. It is not a production-caller witness; source-pair
// execution lives in the companion file.
function adapters(undefinedInstructions: (ctx: any) => Instr[]) {
  const names = [
    "bindPromiseHookResources",
    "bindPromiseSettleResources",
    "bindIdentityReactionResources",
    "buildDenoPromiseHookCall",
  ];
  const declarations = names
    .map((name) =>
      fn(read(schedulerPath), name)
        .getText()
        .replace(/^export /, ""),
    )
    .join("\n");
  const js = ts.transpileModule(declarations, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None },
  }).outputText;
  return new Function(
    "canonicalUndefinedExternInstrs",
    "buildPromiseHookInstructions",
    "DENO_PROMISE_HOOK_DISPATCH",
    "promiseRejectionDispatcher",
    js + "\nreturn { " + names.join(",") + " };",
  )(undefinedInstructions, bodies.buildDenoPromiseHookCall, "__v8x_dispatch_promise_hook", promiseRejectionDispatcher);
}
const resource = {
  promiseTypeIdx: 11,
  callbackTypeIdx: 12,
  enqueueFuncIdx: 13,
  resolveHook: undefined,
  unhandledHeadGlobalIdx: -1,
  unhandledNodeTypeIdx: -1,
};
describe("native Promise settlement canonical ownership (not full runtime closure)", () => {
  it("does not allocate undefined when dispatcher is absent, even with parent operands", () => {
    let calls = 0;
    const adapter = adapters(() => {
      calls++;
      throw new Error("must not allocate");
    });
    const ctx = { funcMap: new Map() };
    expect(adapter.buildDenoPromiseHookCall(ctx, 0, [], [])).toEqual([]);
    expect(adapter.buildDenoPromiseHookCall(ctx, 0, [])).toEqual([]);
    expect(calls).toBe(0);
  });
  it("captures settlement fields after resolve preparation, retaining earlier type arguments", () => {
    const state = { ...resource };
    const events: string[] = [];
    const ctx = {
      funcMap: {
        get(name: string) {
          events.push("lookup");
          if (name === "__v8x_deno_promise_reject_dispatch") return undefined;
          return 20;
        },
      },
    };
    const adapter = adapters(() => {
      events.push("undefined");
      state.enqueueFuncIdx = 99;
      state.unhandledHeadGlobalIdx = 31;
      state.unhandledNodeTypeIdx = 32;
      return [{ op: "ref.null.extern" }];
    });
    const bound = adapter.bindPromiseSettleResources(ctx, state, 11, 12);
    expect(events).toEqual(["lookup", "undefined", "lookup"]);
    expect(bound).toMatchObject({
      promiseTypeIdx: 11,
      callbackTypeIdx: 12,
      enqueueFuncIdx: 99,
      unhandledHeadGlobalIdx: 31,
      unhandledNodeTypeIdx: 32,
    });
    expect(bound.resolveHook.dispatchFuncIdx).toBe(20);
  });
  it("captures the identity target before distinct before/after preparation and never shares their mutable nodes", () => {
    const events: string[] = [];
    let target = 17;
    let dispatch = 20;
    const ctx = {
      funcMap: {
        get() {
          events.push("lookup");
          return dispatch++;
        },
      },
    };
    const adapter = adapters(() => {
      events.push("undefined");
      target = 99;
      return [{ op: "global.get", index: target }];
    });
    const bound = adapter.bindIdentityReactionResources(ctx, 11, target);
    expect(events).toEqual(["lookup", "undefined", "lookup", "undefined"]);
    expect(bound.settleFuncIdx).toBe(17);
    expect(bound.beforeHook.dispatchFuncIdx).toBe(20);
    expect(bound.afterHook.dispatchFuncIdx).toBe(21);
    expect(bound.beforeHook.parentExternInstrs[0]).not.toBe(bound.afterHook.parentExternInstrs[0]);
    const result = bodies.buildIdentityWrapperBody(bound);
    expect(result.filter((n) => n.op === "call").map((n) => n.funcIdx)).toEqual([20, 17, 21]);
  });
  it("preserves supplied parent conversion without undefined allocation", () => {
    const adapter = adapters(() => {
      throw new Error("unexpected allocation");
    });
    const parent: Instr[] = [{ op: "local.get", index: 8 }];
    const promise: Instr[] = [{ op: "local.get", index: 9 }];
    const got = adapter.buildDenoPromiseHookCall(
      { funcMap: new Map([["__v8x_dispatch_promise_hook", 20]]) },
      0,
      promise,
      parent,
    );
    expect(got).toEqual([
      { op: "f64.const", value: 0 },
      ...promise,
      { op: "extern.convert_any" },
      ...parent,
      { op: "extern.convert_any" },
      { op: "call", funcIdx: 20 },
    ]);
    expect(parent).toEqual([{ op: "local.get", index: 8 }]);
  });
  it.each([
    [-1, -1],
    [-1, 3],
    [3, -1],
    [3, 4],
  ])("preserves independent negative tracking fields %i/%i", (head, node) => {
    const got = bodies.buildNoteUnhandledRejection({ unhandledHeadGlobalIdx: head, unhandledNodeTypeIdx: node }, [
      { op: "local.get", index: 0 },
    ]);
    expect(got.length).toBe(head < 0 || node < 0 ? 0 : 6);
    const settled = bodies.buildPromiseSettleBody(
      { ...resource, unhandledHeadGlobalIdx: head, unhandledNodeTypeIdx: node },
      2,
    );
    expect(settled.some((n) => n.op === "if" && n.then.some((i) => i.op === "global.set"))).toBe(
      head >= 0 && node >= 0,
    );
  });
  it("emits resolve hook before the one-shot guard and detaches before the callback loop", () => {
    const got = bodies.buildPromiseSettleBody(
      { ...resource, resolveHook: { dispatchFuncIdx: 20, parentExternInstrs: [{ op: "ref.null.extern" }] } },
      1,
    );
    expect(got.findIndex((n) => n.op === "call")).toBeLessThan(got.findIndex((n) => n.op === "if"));
    expect(got.findIndex((n) => n.op === "struct.set" && n.fieldIdx === 2)).toBeLessThan(
      got.findIndex((n) => n.op === "block"),
    );
    expect(got.at(-1)).toEqual({ op: "local.get", index: 1 });
  });
});
