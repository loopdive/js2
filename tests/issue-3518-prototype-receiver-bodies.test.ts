// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import { readFileSync } from "node:fs";
import ts from "typescript";
import { describe, expect, it } from "vitest";
import {
  BUILTIN_BRAND_BASE,
  BUILTIN_BRAND_COUNT,
  builtinBrandOffsetOf,
} from "../src/runtime/contracts/builtin-brands.js";
import {
  buildPrototypeBrandOffsetDefinition,
  buildPrototypeReceiverConsultBody,
} from "../src/runtime/wasmgc/values/prototype-receiver-bodies.js";
import {
  applyPrototypeReceiverExtraction,
  prototypeReceiverReceipt,
  prototypeReceiverReceiptPath,
} from "./helpers/prototype-receiver-extraction.js";
const read = (p: string) => readFileSync(new URL(`../${p}`, import.meta.url), "utf8");
const receipt = prototypeReceiverReceipt();
const current = read(receipt.path);
const original = applyPrototypeReceiverExtraction(current, true);
interface Scenario {
  absent?: boolean;
  wrapper?: boolean;
  noFind?: boolean;
  noStrings?: boolean;
  noBoxes?: boolean;
  noSymbols?: boolean;
  noOptional?: boolean;
  missing?: string;
  callable?: boolean;
  changing?: boolean;
}
/** Compare the actual old and current adapters' complete instructions and binding effects. */
function capture(source: string, scenario: Scenario, receiver = false) {
  const fn = { locals: [] as unknown[], body: [] as unknown[] };
  const has = { body: [] as unknown[] };
  const get = { body: [] as unknown[] };
  const effects: string[] = [];
  const ctx = {
    nativeProtoTypeIdx: scenario.noOptional ? undefined : 10,
    objectRuntimeTypes: scenario.wrapper ? { objectTypeIdx: 11, propEntryTypeIdx: 12 } : undefined,
    anyStrTypeIdx: scenario.noStrings ? -1 : 13,
    nativeBoxNumberTypeIdx: scenario.noBoxes ? -1 : 14,
    nativeBoxBooleanTypeIdx: scenario.noBoxes ? -1 : 15,
    symbolTypeIdx: scenario.noSymbols ? -1 : 16,
    vecPropBaseTypeIdx: scenario.noOptional ? undefined : 17,
    mapTypeIdx: scenario.noOptional ? -1 : 18,
    errorStructTypeIdx: scenario.noOptional ? -1 : 19,
    structMap: new Map(
      scenario.noOptional
        ? []
        : [
            ["__StandaloneRegExp", 20],
            ["__Date", 21],
            ["$Promise", 22],
          ],
    ),
    funcMap: new Map([
      ...(scenario.noFind ? [] : [["__obj_find", 30] as const]),
      ["__is_closure_prop_carrier", 31],
      ["brand", 32],
      ["hasK", 33],
      ["getK", 34],
    ]),
  };
  if (scenario.missing) ctx.funcMap.delete(scenario.missing);
  const literal = () => {
    effects.push("literal");
    if (scenario.changing) {
      ctx.symbolTypeIdx = 46;
      ctx.nativeBoxNumberTypeIdx = 44;
      ctx.nativeBoxBooleanTypeIdx = 45;
      ctx.structMap.set("$Promise", 42);
    }
    return scenario.callable ? { kind: "callable" as const, funcIdx: 40 } : { kind: "global" as const, globalIdx: 41 };
  };
  const bindings = {
    findFn: (_: unknown, name: string) => {
      effects.push(`find:${name}`);
      return scenario.absent ? undefined : name === "hasR" ? has : name === "getR" ? get : fn;
    },
    PROTOIDX_BRAND_OFF: "brand",
    PROTOIDX_HAS_K: "hasK",
    PROTOIDX_GET_K: "getK",
    PROTOIDX_HAS_R: "hasR",
    PROTOIDX_GET_R: "getR",
    WRAPPER_PRIMITIVE_KEY: "[[PrimitiveValue]]",
    ENTRY_VALUE: 1,
    I31_HEAP_TYPE: -20,
    BUILTIN_BRAND_BASE,
    BUILTIN_BRAND_COUNT,
    ...Object.fromEntries(
      Object.entries({
        OBJ: "Object",
        ARR: "Array",
        FUN: "Function",
        REGEXP: "RegExp",
        DATE: "Date",
        ERROR: "Error",
        PROMISE: "Promise",
        STRING: "String",
        NUMBER: "Number",
        BOOLEAN: "Boolean",
        SYMBOL: "Symbol",
      }).map(([k, v]) => [`${k}_OFF`, builtinBrandOffsetOf(v)]),
    ),
    MAP_KIND_FIELD: 4,
    COLLECTION_KIND_OFFSETS: ["Map", "Set", "WeakMap", "WeakSet"].map((v, i) => [i, builtinBrandOffsetOf(v)]),
    nativeStringLiteralMaterialization: literal,
    nativeStringLiteralInstrs: () => {
      const m = literal();
      return m.kind === "global" ? [{ op: "global.get", index: m.globalIdx }] : [{ op: "call", funcIdx: m.funcIdx }];
    },
    buildPrototypeBrandOffsetDefinition,
    buildPrototypeReceiverConsultBody,
  };
  const start = source.indexOf("function fillBrandOffBody(");
  const end = source.indexOf("/**\n * The `$NativeProto` brand head", start);
  if (start < 0 || end < start) throw new Error("missing actual adapters");
  const js = ts.transpileModule(source.slice(start, end), {
    compilerOptions: { target: ts.ScriptTarget.ES2022 },
  }).outputText;
  new Function(...Object.keys(bindings), `${js}\nreturn ${receiver ? "fillRecvConsultBodies" : "fillBrandOffBody"};`)(
    ...Object.values(bindings),
  )(ctx);
  return { fn, has, get, effects };
}
describe("prototype receiver extraction", () => {
  it("replays every byte of the signed source and current adapter", () => {
    expect(applyPrototypeReceiverExtraction(original, false)).toBe(current);
    expect(original).toContain("ctx.symbolTypeIdx");
  });
  const scenarios: [string, Scenario][] = [
    ["all bare", {}],
    ["wrapper", { wrapper: true }],
    ["absent", { absent: true }],
    ["no find", { wrapper: true, noFind: true }],
    ["no string", { wrapper: true, noStrings: true }],
    ["no boxes", { wrapper: true, noBoxes: true }],
    ["no symbol", { wrapper: true, noSymbols: true }],
    ["no optional", { noOptional: true }],
    ["no closure helper", { missing: "__is_closure_prop_carrier" }],
    ["callable literal", { wrapper: true, callable: true }],
    ["late carrier registration", { wrapper: true, changing: true }],
    ["late callable registration", { wrapper: true, changing: true, callable: true }],
  ];
  for (const [name, scenario] of scenarios)
    it(`matches complete classifier: ${name}`, () =>
      expect(capture(current, scenario)).toEqual(capture(original, scenario)));
  for (const absent of [false, true])
    it(`preserves original receiver in both consults, absent=${absent}`, () =>
      expect(capture(current, { absent }, true)).toEqual(capture(original, { absent }, true)));
  for (const missing of ["brand", "hasK", "getK"])
    it(`preserves partial missing consult: ${missing}`, () =>
      expect(capture(current, { missing }, true)).toEqual(capture(original, { missing }, true)));
  it("rejects altered live source", () =>
    expect(() => applyPrototypeReceiverExtraction(current + "\n", true)).toThrow("source mismatch"));
  it("rejects altered donor", () =>
    expect(() => applyPrototypeReceiverExtraction(original + "\n", false)).toThrow("source mismatch"));
  it("rejects altered receipt", () =>
    expect(() => prototypeReceiverReceipt((p) => read(p) + (p === prototypeReceiverReceiptPath ? " " : ""))).toThrow(
      "receipt mismatch",
    ));
  it("rejects changed builder", () =>
    expect(() => prototypeReceiverReceipt((p) => read(p) + (p === receipt.modules[0].path ? " " : ""))).toThrow(
      "builder mismatch",
    ));
  it("refuses wrong literal response", () => {
    const recipe = buildPrototypeBrandOffsetDefinition({
      wrapper: {
        types: { objectTypeIdx: 1, propEntryTypeIdx: 2 },
        findOwn: 3,
        anyString: 4,
        boxNumber: 5,
        boxBoolean: 6,
      },
    });
    expect(recipe.next().value).toEqual({ kind: "wrapper-key" });
    expect(() => recipe.next({ kind: "remaining-carriers", resources: {} as never })).toThrow(
      "expected wrapper literal",
    );
  });
  it("refuses wrong remaining-carrier response", () => {
    const recipe = buildPrototypeBrandOffsetDefinition({});
    expect(recipe.next().value).toEqual({ kind: "remaining-carriers" });
    expect(() => recipe.next({ kind: "wrapper-key", materialization: { kind: "global", globalIdx: 1 } })).toThrow(
      "expected remaining carriers",
    );
  });
});
