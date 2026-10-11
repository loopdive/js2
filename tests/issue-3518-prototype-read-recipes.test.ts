// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import { applyResumeMainComposition, readBeforeResumeMain } from "./helpers/resume-main-composition.js";
import { readBeforePrototypeReceiver as readMergedSource } from "./helpers/prototype-receiver-extraction.js";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import ts from "typescript";
import { describe, expect, it } from "vitest";
import { buildPrototypeKeyNormalizationBody } from "../src/runtime/wasmgc/values/prototype-key-normalization-body.js";
import {
  buildPrototypeGetBody,
  buildPrototypeHasBody,
  type PrototypeReadRecipe,
  type PrototypeReadResources,
} from "../src/runtime/wasmgc/values/prototype-read-bodies.js";
import { applyPrototypeReadExtraction, prototypeReadReceipt } from "./helpers/prototype-read-extraction.js";

const read = (path: string) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");
const sha = (text: string) => createHash("sha256").update(text).digest("hex");
const receipt = prototypeReadReceipt();
// Preserve signed35 assertions by inverting main before replaying the extraction.
const current = applyPrototypeReadExtraction(readBeforeResumeMain(receipt.path), false);
const original = applyPrototypeReadExtraction(current, true);
interface Scenario {
  absent?: boolean;
  noStrings?: boolean;
  noEquals?: boolean;
  noBoxes?: boolean;
  noSymbols?: boolean;
  noUndefined?: boolean;
  changing?: boolean;
  callableLiteral?: boolean;
  emptyParents?: boolean;
}
const resources: PrototypeReadResources = {
  objectTypeIdx: 11,
  propEntryTypeIdx: 12,
  companionIdx: 21,
  objFindIdx: 22,
  callAccessorGetIdx: 23,
  brandBase: 100,
  brandCount: 50,
  objectOffset: 0,
  entryFlagsField: 2,
  entryGetterField: 4,
  entryValueField: 1,
  accessorFlag: 8,
  anyStr: 30,
  flattenIdx: 31,
  equalsIdx: 32,
};
/** Mocked construction comparison, not a native execution claim. */
function capture(source: string, helper: string, scenario: Scenario) {
  const calls: string[] = [];
  const fn: { locals?: unknown; body?: unknown } = {};
  let parents = scenario.emptyParents
    ? []
    : [
        [104, 105],
        [102, 103],
        [106, 100],
        [99, 102],
        [103, 151],
      ];
  let undefinedReads = 0;
  const ctx = {
    anyStrTypeIdx: scenario.noStrings ? -1 : 30,
    nativeBoxNumberTypeIdx: scenario.noBoxes ? -1 : 33,
    symbolTypeIdx: scenario.noSymbols ? -1 : 34,
    undefinedGlobalIdx: undefined as number | undefined,
    nativeStrHelpers: {
      get(name: string) {
        calls.push(name);
        return name === "__str_flatten" ? 31 : scenario.noEquals ? undefined : 32;
      },
    },
  };
  const literal = () => {
    calls.push("constructor");
    if (scenario.changing)
      parents = [
        [104, 109],
        [102, 107],
      ];
    return scenario.callableLiteral ? { kind: "callable", funcIdx: 45 } : { kind: "global", globalIdx: 44 };
  };
  const bindings = {
    findFn: () => {
      calls.push("find");
      return scenario.absent ? undefined : fn;
    },
    PROTOIDX_NORM_KEY: "norm",
    PROTOIDX_HAS_K: "has",
    PROTOIDX_GET_K: "get",
    I31_HEAP_TYPE: -20,
    BUILTIN_BRAND_BASE: 100,
    BUILTIN_BRAND_COUNT: 50,
    OBJ_OFF: 0,
    ENTRY_FLAGS: 2,
    ENTRY_GET: 4,
    ENTRY_VALUE: 1,
    FLAG_ACCESSOR: 8,
    nativeProtoParentBrands: () => {
      calls.push("parents");
      return new Map(parents as [number, number][]);
    },
    nativeStringLiteralMaterialization: literal,
    nativeStringLiteralInstrs: () => {
      const value = literal();
      return value.kind === "global"
        ? [{ op: "global.get", index: value.globalIdx }]
        : [{ op: "call", funcIdx: value.funcIdx }];
    },
    undefinedExternInstrs: () => {
      calls.push(`undefined:${++undefinedReads}`);
      if (scenario.noUndefined) return undefined;
      ctx.undefinedGlobalIdx = 50 + (scenario.changing ? undefinedReads : 0);
      return [{ op: "global.get", index: ctx.undefinedGlobalIdx }, { op: "extern.convert_any" }];
    },
    buildPrototypeKeyNormalizationBody,
    buildPrototypeGetBody,
    buildPrototypeHasBody,
  };
  const js = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
  const run = new Function(...Object.keys(bindings), `${js}\nreturn ${helper};`)(...Object.values(bindings));
  run(ctx, { ...resources, unboxNumberIdx: 41, numberToStringIdx: 42 });
  return { fn, calls };
}
function instructionObjects(value: unknown, seen = new Set<object>()) {
  if (typeof value !== "object" || value === null) return seen;
  if ("op" in value) {
    expect(seen.has(value)).toBe(false);
    seen.add(value);
  }
  for (const nested of Object.values(value)) instructionObjects(nested, seen);
  return seen;
}
function materialize(recipe: PrototypeReadRecipe) {
  const requests: string[] = [];
  let step = recipe.next();
  let count = 0;
  while (!step.done) {
    requests.push(step.value.kind);
    switch (step.value.kind) {
      case "constructor-literal":
        step = recipe.next({ kind: "constructor-literal", materialization: { kind: "global", globalIdx: 44 } });
        break;
      case "parent-links":
        step = recipe.next({
          kind: "parent-links",
          links: [
            [104, 105],
            [102, 103],
          ],
        });
        break;
      case "undefined":
        step = recipe.next({ kind: "undefined", globalIdx: 50 + ++count });
        break;
    }
  }
  return { body: step.value, requests };
}
describe("prototype read extraction", () => {
  it("reconstructs the complete signed donor and replays every current byte", () => {
    expect(receipt.base).toBe("50f57b7141a3aed493741d79a88a9c2c41675aac");
    expect(sha(original)).toBe(receipt.baseSha256);
    expect(sha(current)).toBe(receipt.afterSha256);
    expect(applyPrototypeReadExtraction(original, false)).toBe(current);
  });
  for (const helper of ["fillNormKeyBody", "fillHasKBody", "fillGetKBody"]) {
    it.each([
      {},
      { absent: true },
      { noStrings: true },
      { noEquals: true },
      { noBoxes: true, noSymbols: true },
      { noUndefined: true },
      { changing: true },
      { callableLiteral: true },
      { emptyParents: true },
    ] satisfies Scenario[])(`${helper} preserves complete donor definitions and acquisitions: %j`, (scenario) => {
      expect(capture(receipt.spans[1]!.after, helper, scenario)).toStrictEqual(
        capture(receipt.spans[1]!.before, helper, scenario),
      );
    });
  }
  it("mints distinct instructions within and between parent and miss arms", () => {
    const first = materialize(buildPrototypeGetBody(resources));
    const second = materialize(buildPrototypeGetBody(resources));
    const seen = instructionObjects(first.body);
    instructionObjects(second.body, seen);
    expect(seen.size).toBeGreaterThan(150);
    expect(first.requests).toEqual(["constructor-literal", "parent-links", "undefined", "undefined"]);
  });
  it("Has only requests parent links and never emits the accessor call", () => {
    const result = materialize(buildPrototypeHasBody(resources));
    expect(result.requests).toEqual(["parent-links"]);
    expect(JSON.stringify(result.body)).not.toContain(`"funcIdx":${resources.callAccessorGetIdx}`);
  });
  it("rejects the wrong response kind rather than silently constructing a body", () => {
    const recipe = buildPrototypeGetBody(resources);
    expect(recipe.next().value).toEqual({ kind: "constructor-literal" });
    expect(() => recipe.next({ kind: "undefined", globalIdx: 1 })).toThrow("expected constructor literal");
  });
  it.each(["missing", "altered", "duplicated"])("refuses %s extracted span after positive reconstruction", (kind) => {
    expect(sha(applyPrototypeReadExtraction(current, true))).toBe(receipt.baseSha256);
    const span = receipt.spans[1]!.after;
    const replacement =
      kind === "missing"
        ? receipt.spans[1]!.before
        : kind === "duplicated"
          ? span + span
          : span.replace("buildPrototypeGetBody(", "changedPrototypeGetBody(");
    expect(() => applyPrototypeReadExtraction(current.replace(span, replacement), true)).toThrow("span missing");
  });
  it("authenticates each actual builder instead of accepting a receipt alone", () => {
    for (const module of receipt.modules)
      expect(() =>
        applyPrototypeReadExtraction(
          current,
          true,
          (path) => read(path) + (path === module.path ? "\n// mutation\n" : ""),
        ),
      ).toThrow("builder mismatch");
  });
});

describe("prototype read extraction composes outside current main", () => {
  const path = "src/codegen/proto-index-store.ts";
  const raw = readMergedSource(path);
  const beforeExtraction = applyPrototypeReadExtraction(raw, true);
  const prior = applyResumeMainComposition(path, beforeExtraction, true);
  it("replays both independent receipts to every actual current byte", () => {
    expect(sha(prior)).toBe(receipt.baseSha256);
    expect(prior).toBe(original);
    expect(readBeforeResumeMain(path)).toBe(prior);
    expect(applyPrototypeReadExtraction(applyResumeMainComposition(path, prior, false), false)).toBe(raw);
    expect(sha(raw)).toBe("8a0db9ef59e5ee5746f24d5b762354b2f4411f3920040da2d53c5574143f14f0");
  });
  it("retains main Symbol wrapper routing alongside extracted recipes", () => {
    for (const source of [raw, beforeExtraction]) {
      expect(source).toContain('const SYMBOL_OFF = builtinBrandOffsetOf("Symbol")!;');
      expect(source).toContain("then: ret(SYMBOL_OFF)");
    }
    expect(prior).not.toContain("then: ret(SYMBOL_OFF)");
    expect(raw).toContain("buildPrototypeGetBody(prototypeReadResources(ctx, deps, true))");
  });
  it("refuses reversed or repeated inverse order", () => {
    expect(() => applyResumeMainComposition(path, raw, true)).toThrow(/resume-main/);
    expect(() => applyPrototypeReadExtraction(beforeExtraction, true)).toThrow(/prototype read extraction span/);
  });
  it.each(["symbol", "outside"])("does not hide %s changes outside extraction spans", (kind) => {
    const changed =
      kind === "symbol" ? raw.replace("then: ret(SYMBOL_OFF)", "then: ret(OBJ_OFF)") : raw + "\n// unrelated edit\n";
    expect(changed).not.toBe(raw);
    expect(() => applyResumeMainComposition(path, applyPrototypeReadExtraction(changed, true), true)).toThrow(
      /resume-main/,
    );
  });
});
