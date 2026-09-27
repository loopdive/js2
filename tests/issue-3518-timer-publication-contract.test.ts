// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import ts from "typescript";
import { describe, expect, it } from "vitest";
import * as contract from "../src/runtime/contracts/timer-capability.js";
import * as compatibility from "../src/timer-capability-contract.js";

const donor = JSON.parse(
  readFileSync(new URL("./fixtures/issue-3518-timer-publication-donor.json", import.meta.url), "utf8"),
) as { function: string; constants: string; functionSha256: string };
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

// These are donor publication traces, not proof of the future native dispatcher producer.
describe("canonical standalone timer publication contract", () => {
  it("retains all nine exact constants through the compatibility facade", () => {
    expect(Object.keys(compatibility)).toHaveLength(9);
    const exports: Record<string, unknown> = {};
    new Function(
      "exports",
      ts.transpileModule(donor.constants, { compilerOptions: { module: ts.ModuleKind.CommonJS } }).outputText,
    )(exports);
    expect(Object.fromEntries(Object.entries(compatibility))).toEqual(Object.fromEntries(Object.entries(exports)));
    for (const [name, value] of Object.entries(compatibility)) {
      expect(contract[name as keyof typeof compatibility]).toBe(value);
    }
    expect(createHash("sha256").update(donor.function).digest("hex")).toBe(donor.functionSha256);
    expect(start).toBeGreaterThan(0);
    expect(currentFunction).toContain("planStandaloneTimerCallbackExports");
  });

  it("preserves the donor body outside the extracted publication planning", () => {
    const helperStart = donor.function.indexOf("  const publishFamily =");
    const helperEnd = donor.function.indexOf("  const bindingsTableIdx", helperStart);
    expect(helperStart).toBeGreaterThan(0);
    expect(helperEnd).toBeGreaterThan(helperStart);
    const oldBody = donor.function.slice(0, helperStart) + donor.function.slice(helperEnd);
    const normalize = (body: string, marker: string) => {
      const from = body.indexOf(marker);
      const to = body.indexOf("  // These names", from);
      expect(from).toBeGreaterThan(0);
      expect(to).toBeGreaterThan(from);
      return body.slice(0, from) + "  <publication-plan>\n" + body.slice(to);
    };
    expect(normalize(currentFunction, "  const targets =")).toBe(normalize(oldBody, "  publishFamily("));
  });

  it.each([
    [
      "marker table index",
      "const markerTableIdx = bindingsTableIdx + 1;",
      "const markerTableIdx = bindingsTableIdx + 2;",
    ],
    ["element dispatcher", "funcIndices: [funcIdx]", "funcIndices: [funcIdx + 1]"],
  ])("detects a changed %s in the publication trace", (_name, before, after) => {
    expect(currentFunction).toContain(before);
    const original = context([]);
    const altered = context([]);
    publisher(donor.function, true, 17)(original);
    publisher(currentFunction.replace(before, after), true, 17)(altered);
    expect(altered).not.toEqual(original);
  });

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

  it.each(Array.from({ length: 16 }, (_, mask) => mask))(
    "preserves donor table/global/export traces for occupancy %i",
    (mask) => {
      const names = families.flatMap(([, logical, physical], index) =>
        mask & (1 << index) ? [logical, physical, physical + "$$", physical + "invalid"] : [],
      );
      const oldContext = context(names);
      const newContext = context(names);
      const oldPublish = publisher(donor.function, true, 17);
      const newPublish = publisher(currentFunction, true, 17);
      oldPublish(oldContext);
      newPublish(newContext);
      expect(newContext).toEqual(oldContext);
      expect(newContext.mod.tables).toHaveLength(3);
      expect(newContext.mod.elements).toEqual([
        { tableIdx: 3, offset: [{ op: "i32.const", value: 0 }], funcIndices: [17] },
      ]);
      expect(newContext.mod.globals[1]).toEqual({
        name: families[1][1],
        type: { kind: "i32" },
        mutable: false,
        init: [{ op: "i32.const", value: 0x5a400001 }],
      });
      const receipt = structuredClone(newContext);
      oldPublish(oldContext);
      newPublish(newContext);
      expect(newContext).toEqual(receipt);
      expect(oldContext).toEqual(receipt);
    },
  );

  it.each(["disabled", "missing dispatcher", "missing handle"] as const)(
    "preserves %s control before publication",
    (control) => {
      const outcomes = [donor.function, currentFunction].map((source) => {
        const ctx = context([families[0][1]]);
        ctx.requiresStandaloneTimerCallbackDispatch = control !== "disabled";
        const before = structuredClone(ctx);
        const publish = publisher(
          source,
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
        return ctx;
      });
      expect(outcomes[1]).toEqual(outcomes[0]);
    },
  );
});
