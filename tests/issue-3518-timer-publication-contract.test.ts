// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import { readFileSync } from "node:fs";
import ts from "typescript";
import { describe, expect, it } from "vitest";
import * as contract from "../src/runtime/contracts/timer-capability.js";
const current = readFileSync(new URL("../src/codegen/closure-exports.ts", import.meta.url), "utf8");
const start = current.indexOf("export function publishStandaloneTimerCallbackDispatch(");
const currentFunction = current.slice(start, current.indexOf("\n}\n", start) + 2);
const families = [
  ["dispatch", "__\0js2_timer_callback_dispatch_0", "$t0"],
  ["manifest", "__\0js2_timer_callback_manifest", "$tm"],
  ["marker", "__\0js2_timer_callback_marker", "$tt"],
  ["bindings", "__\0js2_timer_callback_bindings", "$tu"],
] as const;

type Desc = { kind: "func" | "global" | "table"; index: number };
type Context = {
  requiresStandaloneTimerCallbackDispatch: boolean;
  numImportGlobals: number;
  mod: {
    imports: { desc: { kind: string } }[];
    tables: unknown[];
    elements: unknown[];
    globals: unknown[];
    exports: { name: string; desc: Desc }[];
  };
};
function context(names: readonly string[]): Context {
  return {
    requiresStandaloneTimerCallbackDispatch: true,
    numImportGlobals: 3,
    mod: {
      imports: [{ desc: { kind: "table" } }, { desc: { kind: "func" } }, { desc: { kind: "table" } }],
      tables: [{ elementType: "externref", min: 2 }],
      elements: [],
      globals: [{ name: "user", type: { kind: "i32" }, mutable: false, init: [{ op: "i32.const", value: 4 }] }],
      exports: names.map((name, index) => ({ name, desc: { kind: "func", index: 100 + index } })),
    },
  };
}
function publisher(source: string, available: boolean, index: number | undefined) {
  const published = new WeakSet<object>();
  const functions = new WeakMap<object, Map<number, object>>();
  const target = {};
  const js = ts.transpileModule(source, {
    compilerOptions: { target: ts.ScriptTarget.ESNext, module: ts.ModuleKind.CommonJS },
  }).outputText;
  const exports: { publishStandaloneTimerCallbackDispatch?: (ctx: Context) => void } = {};
  new Function(
    "exports",
    "publishedStandaloneTimerCallbackManifests",
    "publishedClosureHostBridgeFuncs",
    "CLOSURE_HOST_BRIDGE_ORDINAL",
    "definedFuncHandleOf",
    ...Object.keys(contract),
    js,
  )(exports, published, functions, { directCall0: 0 }, () => index, ...Object.values(contract));
  return (ctx: Context) => {
    if (available) functions.set(ctx, new Map([[0, target]]));
    exports.publishStandaloneTimerCallbackDispatch!(ctx);
  };
}

describe("canonical standalone timer publication contract", () => {
  it("emits eight aliases with no collisions", () => {
    expect(contract.planStandaloneTimerCallbackExports([])).toEqual(
      families.flatMap(([family, logical, physical]) => [
        { family, name: logical },
        { family, name: physical },
      ]),
    );
  });

  it("fills physical holes and adds the terminal alias without changing occupied names", () => {
    const occupied = [families[0][1], "$t0$", "$t0$$$", "$t0not-a-suffix"];
    expect(contract.planStandaloneTimerCallbackExports(occupied).filter((row) => row.family === "dispatch")).toEqual([
      { family: "dispatch", name: "$t0" },
      { family: "dispatch", name: "$t0$$" },
      { family: "dispatch", name: "$t0$$$$" },
    ]);
    expect(occupied).toEqual([families[0][1], "$t0$", "$t0$$$", "$t0not-a-suffix"]);
  });

  it.each(["disabled", "missing dispatcher", "missing handle"] as const)(
    "refuses or skips publication when %s",
    (control) => {
      const ctx = context([families[0][1]]);
      ctx.requiresStandaloneTimerCallbackDispatch = control !== "disabled";
      const before = structuredClone(ctx);
      const publish = publisher(
        currentFunction,
        control !== "missing dispatcher",
        control === "missing handle" ? undefined : 17,
      );
      if (control === "disabled") publish(ctx);
      else
        expect(() => publish(ctx)).toThrow(
          control === "missing handle"
            ? "standalone timer callback dispatcher lost its compiler-owned function handle"
            : "standalone timer callback dispatcher was requested but __call_fn_0 was not emitted",
        );
      expect(ctx).toEqual(before);
    },
  );
});
