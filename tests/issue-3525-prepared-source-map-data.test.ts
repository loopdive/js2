// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { PositionMap, type SourceEdit } from "../src/position-map.js";
import { applyDefineSubstitutionsWithMap } from "../src/compiler/define-substitution.js";
import { analyzeMultiSource } from "../src/checker/index.js";
import { prepareIrProgramSources, captureTypedIrProgramInput } from "../src/ir/program-source.js";
import { prepareTypedIrProgram } from "../src/ir/program-prepare-ir.js";
import { ownTypedIrProgramInput } from "../src/ir/program/input.js";
import * as validation from "../src/ir/program/validation.js";
import { encodePreparedIrProgram, decodePreparedIrProgram } from "../src/ir/program-codec.js";
import { copyIrPreparationData } from "../src/ir/analysis/alloc-registry.js";
import { PreparedIrProgramInvariantError, preparedIrDataMismatch } from "../src/ir/program.js";
import type { TypedIrProgramInput } from "../src/ir/program/input-contracts.js";
import type { IrInstr } from "../src/ir/core/nodes.js";
import { forEachInstrDeep, type IrFunction } from "../src/ir/core/nodes.js";
import { ts } from "../src/ts-api.js";
import { sourceInput } from "./helpers/typed-program-fixtures.js";
import { buildIrUnitInventory } from "../src/ir/identity.js";
import { buildIrPlanningIdentityContext } from "../src/ir/planning-identity.js";
import { makeIrPromiseDelayResolver } from "../src/ir/promise-delay.js";
import { collectIrPromiseDelayOwners, buildIrPromiseDelayLoweringPlans } from "../src/ir/promise-delay-lowering.js";
import { lowerFunctionAstToIr } from "../src/ir/from-ast.js";
import { assertPreparedIrProgramPopulation } from "../src/ir/program/population.js";
import type { ProgramAbiDerivedUnitRecord } from "../src/ir/program/abi.js";
import type { IrUnitId } from "../src/shared/contracts/ir-identity.js";

// Pure projection/catalog fixtures. Manually attached origins do NOT prove frontend-produced coverage.
interface Span {
  start: number;
  end: number;
}
interface Stage {
  producer: string;
  inputText: string;
  outputText: string;
  edits: readonly { input: Span; removed: string; inserted: string; kind: string }[];
}
const FILES = {
  "./entry.ts":
    "// 😀 UTF-16 donor\nexport function choose(value:number):number { return value > 0 ? value + 2 : value - 3; }\n",
  "./empty.ts": "",
};
const OPTIONS = {
  policy: { backend: "wasmgc", target: "host" },
  runtimePolicies: [
    { backend: "wasmgc", target: "host" },
    { backend: "linear", target: "host" },
  ],
  controls: {
    gvnMode: "off",
    ownership: false,
    escape: false,
    verifyIntermediateAllocations: false,
    verifyDominanceNaive: false,
  },
} as const;
function stage(map: PositionMap, input: string, output: string): Stage {
  const method = Reflect.get(map, "captureSourceMapStage");
  expect(typeof method, "requested-only PositionMap capture API exists").toBe("function");
  return Reflect.apply(method, map, ["define", input, output]);
}
function check(input: TypedIrProgramInput): void {
  const fn = Reflect.get(validation, "assertPreparedSourceMap");
  expect(typeof fn, "source-map admission API exists").toBe("function");
  Reflect.apply(fn, undefined, [input]);
}
function fixture(files: Record<string, string> = FILES, async = false) {
  const ast = analyzeMultiSource(files, "./entry.ts");
  expect(ast.syntacticDiagnostics).toEqual([]);
  const source = prepareIrProgramSources({
    sourceFiles: ast.sourceFiles,
    entrySource: ast.entryFile,
    checker: ast.checker,
    policy: OPTIONS.policy,
    deferTopLevelInit: false,
  });
  if (source.kind !== "prepared") throw new Error(`genuine source preparation refused: ${JSON.stringify(source)}`);
  let input = copyIrPreparationData(captureTypedIrProgramInput(source));
  if (async) {
    const result = prepareTypedIrProgram(input, { ...OPTIONS, runtimePolicies: [OPTIONS.policy] });
    if (result.kind !== "prepared") throw new Error(`genuine async prepare refused: ${JSON.stringify(result)}`);
    expect(Object.hasOwn(result.program, "sourceMap")).toBe(false);
    console.log(
      "AUTHENTIC_NO_MAP_ASYNC",
      JSON.stringify({
        encoded: encodePreparedIrProgram(result.program),
        functions: result.program.ir.functions.map((fn) => ({
          unitId: fn.unitId,
          name: fn.name,
          states: fn.asyncPlan?.states.map((state) => ({
            id: state.id,
            exit: state.terminator.kind,
            updates: state.updates?.length ?? 0,
          })),
        })),
        derivedUnits: result.program.derivedUnits,
      }),
    );
    const mutableIr = structuredClone(result.program.ir);
    const mutableDerived = structuredClone(result.program.derivedUnits);
    expect(preparedIrDataMismatch(result.program.ir, mutableIr)).toBeUndefined();
    expect(preparedIrDataMismatch(result.program.derivedUnits, mutableDerived)).toBeUndefined();
    input = { ...input, ir: mutableIr, derivedUnits: mutableDerived };
    expect(input.ir.functions.filter((fn) => fn.asyncPlan !== undefined).length).toBeGreaterThan(0);
  }
  const catalog = {
    schema: "prepared-ir-source-map-v1",
    sources: input.inventory.sources.map((s) => {
      const file = ast.sourceFiles.find((f) => f.fileName === s.originalFileName);
      if (!file) throw new Error("missing authentic inventory/source join");
      return {
        sourceId: s.id,
        sourceKey: s.sourceKey,
        originalFileName: s.originalFileName,
        mapName: s.sourceKey,
        projection: { originalText: file.text, analyzedText: file.text, stages: [] as Stage[] },
      };
    }),
  };
  Object.defineProperty(input, "sourceMap", { value: catalog, enumerable: true, writable: true, configurable: true });
  const sites: object[] = [];
  for (const fn of input.ir.functions) {
    let owner = fn.unitId;
    const seen = new Set();
    while (input.derivedUnits.some((d) => d.id === owner)) {
      if (seen.has(owner)) throw new Error("derived owner cycle");
      seen.add(owner);
      owner = input.derivedUnits.find((d) => d.id === owner)!.parentId;
    }
    const unit = input.inventory.allUnits.find((u) => u.id === owner);
    if (!unit) throw new Error("missing genuine function owner");
    const point = {
      sourceId: unit.sourceId,
      donorUnitId: unit.id,
      analyzed: { start: unit.declarationStart, end: unit.declarationEnd },
      original: { start: unit.declarationStart, end: unit.declarationEnd },
      mapping: "exact",
    };
    const site = { line: unit.line, column: unit.column - 1, origin: { kind: "source", point } };
    const stamp = (value: object): void => {
      Object.defineProperty(value, "site", {
        value: copyIrPreparationData(site),
        enumerable: true,
        writable: true,
        configurable: true,
      });
      sites.push(value);
    };
    const body = (instrs: readonly IrInstr[]): void => {
      for (const instr of instrs) {
        stamp(instr);
        if (instr.kind === "if") {
          body(instr.then);
          body(instr.else);
        }
      }
    };
    for (const block of fn.blocks) {
      body(block.instrs);
      stamp(block.terminator);
    }
    if (async && fn.asyncPlan) {
      for (const state of fn.asyncPlan!.states) {
        body(state.body);
        for (const update of state.updates ?? []) stamp(update);
        stamp(state.terminator);
      }
    }
  }
  return { ast, source, input, catalog, sites };
}
function dataSite(target: object) {
  const descriptor = Object.getOwnPropertyDescriptor(target, "site");
  if (!descriptor || !("value" in descriptor)) throw new Error("missing owned data fixture site");
  return descriptor.value;
}
function invalid(action: () => unknown): void {
  let caught: unknown;
  try {
    action();
  } catch (error) {
    caught = error;
  }
  expect(caught).toBeInstanceOf(PreparedIrProgramInvariantError);
  expect(Reflect.get(caught as object, "code")).toBe("invalid-prepared-data");
  expect((caught as Error).message).toContain("source map:");
}
function prepare(input: TypedIrProgramInput) {
  const result = prepareTypedIrProgram(input, OPTIONS);
  if (result.kind !== "prepared") throw new Error(`typed preparation refused ${JSON.stringify(result)}`);
  return result.program;
}

describe("requested source-map data/projection/codec contract", () => {
  it("retains exact genuine BEFORE no-map canonical bytes and absent optional fields", () => {
    const { source } = fixture();
    const input = captureTypedIrProgramInput(source);
    expect(Object.hasOwn(input, "sourceMap")).toBe(false);
    const program = prepare(input);
    expect(Object.hasOwn(program, "sourceMap")).toBe(false);
    const encoded = encodePreparedIrProgram(program);
    expect(Buffer.byteLength(encoded)).toBe(11725);
    expect(createHash("sha256").update(encoded).digest("hex")).toBe(
      "d970557793cf577bda61e6f62e9b5a190ff581309d29fe28041b511e8822ae5c",
    );
    const decoded = decodePreparedIrProgram(encoded);
    expect(encodePreparedIrProgram(decoded)).toBe(encoded);
    expect(preparedIrDataMismatch(program, decoded)).toBeUndefined();
  });
  it("captures exact UTF-16 replacement, deletion and ordered equal-position insertions", () => {
    const input = "a😀bcZ";
    const output = "aXY😀c";
    const map = new PositionMap([
      { origStart: 1, origEnd: 1, newLength: 1 },
      { origStart: 1, origEnd: 1, newLength: 1 },
      { origStart: 3, origEnd: 4, newLength: 0 },
      { origStart: 5, origEnd: 6, newLength: 0 },
    ]);
    const actual = stage(map, input, output);
    expect(actual).toEqual({
      producer: "define",
      inputText: input,
      outputText: output,
      edits: [
        { input: { start: 1, end: 1 }, removed: "", inserted: "X", kind: "generated-insertion" },
        { input: { start: 1, end: 1 }, removed: "", inserted: "Y", kind: "generated-insertion" },
        { input: { start: 3, end: 4 }, removed: "b", inserted: "", kind: "replacement" },
        { input: { start: 5, end: 6 }, removed: "Z", inserted: "", kind: "replacement" },
      ],
    });
    expect(Object.isFrozen(actual)).toBe(true);
    expect(Object.isFrozen(actual.edits)).toBe(true);
  });
  it("captures a real replacement whose removed span contains a UTF-16 surrogate pair", () => {
    expect(stage(new PositionMap([{ origStart: 1, origEnd: 3, newLength: 1 }]), "a😀bcZ", "aYbcZ")).toEqual({
      producer: "define",
      inputText: "a😀bcZ",
      outputText: "aYbcZ",
      edits: [{ input: { start: 1, end: 3 }, removed: "😀", inserted: "Y", kind: "replacement" }],
    });
  });
  it("captures empty/identity and omits actual no-op edits", () => {
    expect(stage(PositionMap.identity(), "", "").edits).toEqual([]);
    expect(stage(new PositionMap([{ origStart: 0, origEnd: 1, newLength: 1 }]), "x", "x").edits).toEqual([]);
  });
  it("refuses composite stages instead of inventing intermediate replacement text", () => {
    expect(stage(PositionMap.identity(), "ab", "ab").edits).toEqual([]);
    const composed = new PositionMap([{ origStart: 0, origEnd: 1, newLength: 2 }]).compose(
      new PositionMap([{ origStart: 0, origEnd: 2, newLength: 1 }]),
    );
    expect(() => stage(composed, "ab", "cd")).toThrow();
  });
  it.each(
    (
      [
        [{ origStart: -1, origEnd: 1, newLength: 1 }],
        [{ origStart: 0.5, origEnd: 1, newLength: 1 }],
        [{ origStart: 0, origEnd: 9, newLength: 0 }],
        [
          { origStart: 0, origEnd: 2, newLength: 1 },
          { origStart: 1, origEnd: 2, newLength: 1 },
        ],
        [{ origStart: 0, origEnd: 1, newLength: -1 }],
      ] satisfies SourceEdit[][]
    ).map((edits) => ({ edits })),
  )("refuses malformed single-stage edit $edits", ({ edits }) => {
    expect(stage(PositionMap.identity(), "ab", "ab").edits).toEqual([]);
    expect(() => stage(new PositionMap(edits), "ab", "x")).toThrow();
  });
  it("captures each real ordered define pass, retaining no-map result shape", () => {
    const stages: Stage[] = [];
    const source = "LONGER + B;";
    const plain = applyDefineSubstitutionsWithMap(source, { LONGER: "B", B: "2" });
    const captured = Reflect.apply(applyDefineSubstitutionsWithMap, undefined, [
      source,
      { LONGER: "B", B: "2" },
      (s: Stage) => stages.push(s),
    ]);
    expect(captured.source).toBe("2 + 2;");
    expect(Object.keys(captured)).toEqual(["source", "positionMap"]);
    expect(stages).toEqual([
      {
        producer: "define",
        inputText: source,
        outputText: "B + B;",
        edits: [{ input: { start: 0, end: 6 }, removed: "LONGER", inserted: "B", kind: "replacement" }],
      },
      {
        producer: "define",
        inputText: "B + B;",
        outputText: "2 + 2;",
        edits: [
          { input: { start: 0, end: 1 }, removed: "B", inserted: "2", kind: "replacement" },
          { input: { start: 4, end: 5 }, removed: "B", inserted: "2", kind: "replacement" },
        ],
      },
    ]);
    expect(captured.source).toBe(plain.source);
    expect(captured.positionMap.toInputOffset(captured.source.length)).toBe(
      plain.positionMap.toInputOffset(plain.source.length),
    );
  });
  it("validates exact ordered catalog and every genuine nested instruction/terminator data site", () => {
    const f = fixture();
    expect(f.catalog.sources.map((s) => s.mapName)).toEqual(["empty.ts", "entry.ts"]);
    expect(f.sites.length).toBeGreaterThan(4);
    expect(f.input.ir.functions[0]!.blocks[0]!.instrs.some((i) => i.kind === "if")).toBe(true);
    check(f.input);
    const owned = ownTypedIrProgramInput(f.input).input;
    expect(Reflect.get(owned, "sourceMap")).toEqual(f.catalog);
    expect(owned).not.toBe(f.input);
  });
  it("copies an explicitly attached data catalog through typed ownership, prepare and codec", () => {
    const f = fixture();
    const owned = ownTypedIrProgramInput(f.input).input;
    expect(Reflect.get(owned, "sourceMap")).toEqual(f.catalog);
    expect(Reflect.get(owned, "sourceMap")).not.toBe(f.catalog);
    const program = prepare(f.input);
    expect(Reflect.get(program, "sourceMap")).toEqual(f.catalog);
    const encoded = encodePreparedIrProgram(program);
    const decoded = decodePreparedIrProgram(encoded);
    expect(encodePreparedIrProgram(decoded)).toBe(encoded);
    expect(preparedIrDataMismatch(program, decoded)).toBeUndefined();
    expect(Reflect.get(decoded, "sourceMap")).toEqual(f.catalog);
    expect(Object.isFrozen(Reflect.get(decoded, "sourceMap"))).toBe(true);
  });
  it.each(["undefined", "schema", "order", "duplicate", "mapName", "sourceKey", "text", "stageReplay"])(
    "rejects claimed catalog corruption %s after a healthy data witness",
    (fault) => {
      const f = fixture();
      check(f.input);
      if (fault === "undefined") Object.defineProperty(f.input, "sourceMap", { value: undefined });
      else if (fault === "schema") f.catalog.schema = "v9";
      else if (fault === "order") f.catalog.sources.reverse();
      else if (fault === "duplicate") f.catalog.sources.push(f.catalog.sources[0]!);
      else if (fault === "mapName") f.catalog.sources[1]!.mapName = "./entry.ts";
      else if (fault === "sourceKey") f.catalog.sources[1]!.sourceKey = "other.ts";
      else if (fault === "text") f.catalog.sources[1]!.projection.analyzedText += "x";
      else
        f.catalog.sources[1]!.projection.stages.push({
          producer: "define",
          inputText: "x",
          outputText: "y",
          edits: [],
        });
      invalid(() => check(f.input));
      check(fixture().input);
    },
  );
  it.each(["missing", "line", "foreignSource", "foreignUnit", "fraction", "range", "unknownRole", "owner"])(
    "rejects site corruption %s after a healthy nested data witness",
    (fault) => {
      const f = fixture();
      check(f.input);
      const branch = f.input.ir.functions[0]!.blocks[0]!.instrs.find((i) => i.kind === "if");
      if (!branch || branch.kind !== "if") throw new Error("missing genuine nested branch");
      const target = branch.then[0]!;
      const site = dataSite(target);
      if (fault === "missing") Reflect.deleteProperty(target, "site");
      else if (fault === "line") site.line++;
      else if (fault === "foreignSource") site.origin.point.sourceId = "foreign";
      else if (fault === "foreignUnit") site.origin.point.donorUnitId = "foreign";
      else if (fault === "fraction") site.origin.point.analyzed.start += 0.5;
      else if (fault === "range") site.origin.point.original.end = 99999;
      else
        Object.defineProperty(target, "site", {
          value: {
            origin: {
              kind: "generated",
              phase: "frontend",
              role: fault === "unknownRole" ? "invented" : "implicit-return",
              ownerUnitId: "foreign",
            },
          },
          enumerable: true,
          configurable: true,
        });
      invalid(() => check(f.input));
      check(fixture().input);
    },
  );
  it("projects exact points through a genuine literal deletion stage (explicit data fixture)", () => {
    const f = fixture();
    const row = f.catalog.sources[1]!;
    const analyzed = row.projection.analyzedText;
    row.projection.originalText = "ab" + analyzed;
    row.projection.stages.push({
      producer: "define",
      inputText: "ab" + analyzed,
      outputText: analyzed,
      edits: [{ input: { start: 0, end: 2 }, removed: "ab", inserted: "", kind: "replacement" }],
    });
    for (const target of f.sites) {
      const point = dataSite(target).origin.point;
      point.original.start += 2;
      point.original.end += 2;
    }
    check(f.input);
    dataSite(f.sites[0]!).origin.point.original.start--;
    invalid(() => check(f.input));
    check(fixture().input);
  });
  it.each(["terminator", "inlinedDuplicate", "contributorPrimary", "extraField", "column", "undefinedOrigin"])(
    "rejects complete-site corruption %s",
    (fault) => {
      const f = fixture();
      check(f.input);
      const target = f.input.ir.functions[0]!.blocks[0]!.terminator;
      const site = dataSite(target);
      if (fault === "terminator") Reflect.deleteProperty(target, "site");
      else if (fault === "inlinedDuplicate")
        site.origin.inlinedAt = [copyIrPreparationData(site.origin.point), copyIrPreparationData(site.origin.point)];
      else if (fault === "contributorPrimary") site.origin.contributors = [copyIrPreparationData(site.origin.point)];
      else if (fault === "extraField") site.origin.point.unrecognized = true;
      else if (fault === "column") site.column++;
      else site.origin = undefined;
      invalid(() => check(f.input));
      check(fixture().input);
    },
  );
  it.each(["\r\n", "\r", "\u2028", "\u2029"])(
    "joins genuine TypeScript UTF-16 coordinates across line separator %j",
    (separator) => {
      const text = `// 😀${separator}export function choose(value:number):number{return value+2;}`;
      const f = fixture({ "./entry.ts": text });
      check(f.input);
      const unit = f.input.inventory.terminalUnits[0]!;
      const location = f.ast.entryFile.getLineAndCharacterOfPosition(unit.declarationStart);
      expect(location).toEqual({ line: 1, character: 0 });
      expect(dataSite(f.sites[0]!).line).toBe(2);
      expect(dataSite(f.sites[0]!).column).toBe(0);
      dataSite(f.sites[0]!).column = 1;
      invalid(() => check(f.input));
    },
  );
  it.each([
    "catalogGetter",
    "originGetter",
    "arrayGetter",
    "symbol",
    "hiddenUnknown",
    "arrayExtra",
    "hole",
    "undefined",
    "prototype",
    "cycle",
  ])("refuses plain-data shape corruption %s without executing getters", (fault) => {
    const f = fixture();
    check(f.input);
    let getters = 0;
    const getter = () => {
      getters++;
      return f.catalog.sources;
    };
    if (fault === "catalogGetter")
      Object.defineProperty(f.catalog, "sources", { get: getter, enumerable: true, configurable: true });
    else if (fault === "originGetter")
      Object.defineProperty(dataSite(f.sites[0]!), "origin", { get: getter, enumerable: true, configurable: true });
    else if (fault === "arrayGetter")
      Object.defineProperty(f.catalog.sources, 0, { get: getter, enumerable: true, configurable: true });
    else if (fault === "symbol") Object.defineProperty(f.catalog, Symbol("unknown"), { value: true });
    else if (fault === "hiddenUnknown") Object.defineProperty(f.catalog, "unknown", { value: true });
    else if (fault === "arrayExtra") Object.defineProperty(f.catalog.sources, "unknown", { value: true });
    else if (fault === "hole") Reflect.deleteProperty(f.catalog.sources, "0");
    else if (fault === "undefined") Object.defineProperty(f.catalog.sources, 0, { value: undefined });
    else if (fault === "prototype") Object.setPrototypeOf(f.catalog, { foreign: true });
    else Object.defineProperty(f.catalog, "cycle", { value: f.catalog, enumerable: true });
    invalid(() => check(f.input));
    expect(getters).toBe(0);
    check(fixture().input);
  });
  it("requires actual async body and exit origins in a genuine source-derived plan (data fixture)", () => {
    const f = fixture(
      { "./entry.ts": "export async function task(value:number):Promise<number>{return await(value+2);}" },
      true,
    );
    const plans = f.input.ir.functions.filter((fn) => fn.asyncPlan !== undefined).map((fn) => fn.asyncPlan!);
    expect(plans).toHaveLength(1);
    expect(plans[0]!.states.length).toBeGreaterThan(0);
    check(f.input);
    const last = plans[0]!.states.at(-1)!.terminator;
    expect(Reflect.deleteProperty(last, "site")).toBe(true);
    invalid(() => check(f.input));
  });
});

// Ordinary foreign array prototypes are invalid plain data, even when inherited
// methods hide malformed rows. These are data-validator controls, not Proxy tests.
describe("requested source-map data foreign-array contracts", () => {
  it.each([
    "catalogForeignArray",
    "catalogEntries",
    "catalogEntriesGetter",
    "stagesIterator",
    "editsIterator",
    "contributorsIterator",
    "inlinedMethods",
  ])("rejects %s before inherited methods or getters run", (fault) => {
    const f = fixture();
    check(f.input);
    let methodCalls = 0;
    let getterCalls = 0;
    const empty = () => {
      methodCalls++;
      return [][Symbol.iterator]();
    };
    const proto = Object.create(Array.prototype);
    if (fault === "catalogForeignArray") Object.setPrototypeOf(f.catalog.sources, proto);
    else if (fault === "catalogEntries" || fault === "catalogEntriesGetter") {
      f.catalog.sources[0]!.mapName = "malformed-hidden-map-name";
      if (fault === "catalogEntriesGetter")
        Object.defineProperty(proto, "entries", {
          get() {
            getterCalls++;
            return empty;
          },
        });
      else Object.defineProperty(proto, "entries", { value: empty });
      Object.setPrototypeOf(f.catalog.sources, proto);
    } else if (fault === "stagesIterator") {
      f.catalog.sources[1]!.projection.stages.push({
        producer: "foreign",
        inputText: "unrelated",
        outputText: "unrelated",
        edits: [],
      });
      Object.defineProperty(proto, Symbol.iterator, { value: empty });
      Object.setPrototypeOf(f.catalog.sources[1]!.projection.stages, proto);
    } else if (fault === "editsIterator") {
      const text = f.catalog.sources[1]!.projection.analyzedText;
      const edits = [{ input: { start: 0, end: 1 }, removed: "wrong", inserted: "wrong", kind: "replacement" }];
      Object.defineProperty(proto, Symbol.iterator, { value: empty });
      Object.setPrototypeOf(edits, proto);
      f.catalog.sources[1]!.projection.stages.push({ producer: "define", inputText: text, outputText: text, edits });
    } else {
      const site = dataSite(f.sites[0]!);
      const points = [copyIrPreparationData(site.origin.point)];
      Object.defineProperty(proto, Symbol.iterator, { value: empty });
      if (fault === "inlinedMethods") {
        Object.defineProperty(proto, "map", {
          value() {
            methodCalls++;
            return [];
          },
        });
        Object.defineProperty(proto, "at", {
          get() {
            getterCalls++;
            return () => {
              methodCalls++;
              return site.origin.point;
            };
          },
        });
        site.origin.inlinedAt = points;
      } else site.origin.contributors = points;
      Object.setPrototypeOf(points, proto);
    }
    let caught: unknown;
    try {
      check(f.input);
    } catch (error) {
      caught = error;
    }
    console.log(
      "ARRAY_PROTO_OBSERVATION",
      JSON.stringify({
        fault,
        methodCalls,
        getterCalls,
        refused: caught !== undefined,
        error: caught instanceof Error ? { name: caught.name, message: caught.message } : null,
      }),
    );
    check(fixture().input);
    invalid(() => {
      if (caught !== undefined) throw caught;
    });
    expect(methodCalls).toBe(0);
    expect(getterCalls).toBe(0);
  });
});

// Planned host-executor lowering is genuine; catalogs, sites and donor rows below are DATA ONLY.
const DELAY_SOURCE = `export function delay(ms: number, value: number): Promise<number> {
  return new Promise<number>((resolve) => {
    setTimeout(() => resolve(value), ms);
  });
}`;
type MapPick = Pick<TypedIrProgramInput, "inventory" | "ir" | "derivedUnits" | "startup" | "sourceMap">;
function donorCheck(input: MapPick): void {
  validation.assertPreparedSourceMap(input);
}
function donorFixture() {
  const original = sourceInput({ "./entry.ts": DELAY_SOURCE, "./peer.ts": DELAY_SOURCE });
  const inventory = buildIrUnitInventory(original.sourceFiles, {
    entrySource: original.entrySource,
    checker: original.checker,
  });
  const identity = buildIrPlanningIdentityContext(inventory);
  const native = prepareIrProgramSources({ ...original, promiseDelayProjection: "standalone-native" });
  if (native.kind !== "prepared") throw new Error(`native delay source refusal ${JSON.stringify(native)}`);
  expect(preparedIrDataMismatch(inventory, native.inventory)).toBeUndefined();
  const functions: IrFunction[] = [];
  const derived: ProgramAbiDerivedUnitRecord[] = [];
  const rows: { unitId: IrUnitId; donorUnitId: IrUnitId }[] = [];
  const populations: {
    owner: IrUnitId;
    executor: IrUnitId;
    timer: IrUnitId;
    lifted: IrUnitId[];
    derived: IrUnitId[];
  }[] = [];
  for (const file of original.sourceFiles) {
    const owner = file.statements.find(ts.isFunctionDeclaration);
    if (!owner) throw new Error("actual delay declaration missing");
    const ownerId = identity.unitIdByDeclaration.get(owner);
    if (!ownerId) throw new Error("actual delay identity missing");
    const owners = collectIrPromiseDelayOwners(
      file,
      new Set([ownerId]),
      makeIrPromiseDelayResolver(original.checker),
      identity,
    );
    const plans = buildIrPromiseDelayLoweringPlans(owners, new Set([ownerId]), identity, "host-executor");
    expect(plans.constructions.size).toBe(1);
    const plan = [...plans.constructions.values()][0]!;
    const executorId = identity.unitIdByDeclaration.get(plan.executor);
    const timerId = identity.unitIdByDeclaration.get(plan.timerCallback);
    if (
      !executorId ||
      !timerId ||
      plan.executorTarget.binding.kind !== "unit" ||
      plan.timerTarget.binding.kind !== "unit"
    )
      throw new Error("actual planned arrow identity missing");
    const lowered = lowerFunctionAstToIr(owner, {
      ownerUnitId: ownerId,
      funcName: owner.name!.text,
      checker: original.checker,
      identityContext: identity,
      promiseDelays: plans,
      returnTypeOverride: { kind: "extern", className: "Promise" },
    });
    expect(lowered.lifted.map((fn) => fn.unitId)).toEqual([
      plan.timerTarget.binding.unitId,
      plan.executorTarget.binding.unitId,
    ]);
    expect(lowered.liftedUnitProvenance.map((record) => record.id)).toEqual([
      plan.executorTarget.binding.unitId,
      plan.timerTarget.binding.unitId,
    ]);
    const ownerUnit = inventory.allUnits.find((unit) => unit.id === ownerId)!;
    const executor = inventory.allUnits.find((unit) => unit.id === executorId)!;
    const timer = inventory.allUnits.find((unit) => unit.id === timerId)!;
    expect(executor.lexicalOwnerId).toBe(ownerId);
    expect(timer.lexicalOwnerId).toBe(executorId);
    expect(executor.terminalOwnerId).toBe(ownerId);
    expect(timer.terminalOwnerId).toBe(ownerId);
    for (const record of lowered.liftedUnitProvenance) {
      if ("sourceUnit" in record) throw new Error("planned target unexpectedly used original identity");
      // Same exact ownership completion as the frontend, attached here solely as DATA.
      derived.push({ ...record, sourceId: ownerUnit.sourceId, terminalOwnerId: ownerId });
      const donor = record.id === plan.executorTarget.binding.unitId ? executorId : timerId;
      expect(record.id === plan.executorTarget.binding.unitId || record.id === plan.timerTarget.binding.unitId).toBe(
        true,
      );
      rows.push({ unitId: record.id, donorUnitId: donor });
      expect(record.id).not.toBe(donor);
    }
    functions.push(lowered.main, ...lowered.lifted);
    populations.push({
      owner: ownerId,
      executor: executorId,
      timer: timerId,
      lifted: lowered.lifted.map((fn) => fn.unitId),
      derived: lowered.liftedUnitProvenance.map((record) => record.id),
    });
  }
  expect(native.ir.functions).toHaveLength(2);
  expect(native.derivedUnits).toEqual([]);
  const input = {
    inventory,
    ir: { functions: structuredClone(functions) },
    derivedUnits: structuredClone(derived),
    startup: structuredClone(native.startup),
    sourceMap: {
      schema: "prepared-ir-source-map-v1" as const,
      sources: inventory.sources.map((source) => {
        const file = original.sourceFiles.find((item) => item.fileName === source.originalFileName)!;
        return {
          sourceId: source.id,
          sourceKey: source.sourceKey,
          originalFileName: source.originalFileName,
          mapName: source.sourceKey,
          projection: { originalText: file.text, analyzedText: file.text, stages: [] },
        };
      }),
      derivedSources: structuredClone(rows),
    },
  };
  expect(preparedIrDataMismatch(functions, input.ir.functions)).toBeUndefined();
  expect(preparedIrDataMismatch(derived, input.derivedUnits)).toBeUndefined();
  assertPreparedIrProgramPopulation(input);
  const stamp = (target: object, donorId: string): void => {
    const donor = inventory.allUnits.find((unit) => unit.id === donorId)!;
    Object.defineProperty(target, "site", {
      enumerable: true,
      configurable: true,
      writable: true,
      value: {
        line: donor.line,
        column: donor.column - 1,
        origin: {
          kind: "source",
          point: {
            sourceId: donor.sourceId,
            donorUnitId: donor.id,
            analyzed: { start: donor.declarationStart, end: donor.declarationEnd },
            original: { start: donor.declarationStart, end: donor.declarationEnd },
            mapping: "exact",
          },
        },
      },
    });
  };
  for (const fn of input.ir.functions) {
    const donor = rows.find((row) => row.unitId === fn.unitId)?.donorUnitId ?? fn.unitId;
    for (const block of fn.blocks) {
      for (const instr of block.instrs) forEachInstrDeep(instr, (child) => stamp(child, donor));
      stamp(block.terminator, donor);
    }
  }
  console.log(
    "AUTHENTIC_PLANNED_DELAY_DATA",
    JSON.stringify({
      source: DELAY_SOURCE,
      inventory,
      populations,
      functions: functions.map((fn) => fn.unitId),
      derived,
      rows,
      nativeFunctions: native.ir.functions.map((fn) => fn.unitId),
      nativeDerived: native.derivedUnits,
    }),
  );
  return { original, native, input, populations, stamp };
}

describe("source-map derived donor table DATA joins from genuine planned lowering", () => {
  it("retains the genuine unannotated closure refusal without donor-table coverage credit", () => {
    const input = sourceInput({
      "./entry.ts": "export function outer(value:number):number { const step=(x:number)=>x+1; return step(value); }",
    });
    const result = prepareIrProgramSources(input);
    expect(result.kind).toBe("unsupported");
    if (result.kind !== "unsupported") throw new Error("unannotated closure unexpectedly admitted");
    expect(result.code).toBe("body-shape-rejected");
    expect(result.detail).toContain("closure must have a return type annotation");
  });
  it("retains original source-lifted arrow identity without a derived donor grant", () => {
    const f = fixture({
      "./entry.ts":
        "export function outer(value:number):number { const step=(x:number):number=>x+1; return step(value); }",
    });
    const arrows = f.input.inventory.allUnits.filter((unit) => unit.kind === "arrow-function");
    expect(arrows).toHaveLength(1);
    expect(f.input.ir.functions.some((fn) => fn.unitId === arrows[0]!.id && fn.sourceUnit === true)).toBe(true);
    expect(f.input.derivedUnits).toEqual([]);
    expect(Object.hasOwn(f.catalog, "derivedSources")).toBe(false);
    donorCheck(f.input);
  });
  it("joins actual original arrows to distinct allocated targets in provenance order, not function order", () => {
    const f = donorFixture();
    donorCheck(f.input);
    expect(f.input.sourceMap.derivedSources.map((row) => row.unitId)).toEqual(
      f.input.derivedUnits.map((row) => row.id),
    );
    expect(f.input.ir.functions).toHaveLength(6);
    expect(f.input.sourceMap.derivedSources).toHaveLength(4);
  });
  it("retains genuine default Promise refusal and certified native two-body zero-derived omission", () => {
    const f = donorFixture();
    const defaultResult = prepareIrProgramSources(f.original);
    expect(defaultResult.kind).toBe("unsupported");
    if (defaultResult.kind !== "unsupported") throw new Error("default delay unexpectedly admitted");
    expect(defaultResult.code).toBe("unknown-class-construction");
    expect(defaultResult.stage).toBe("build");
    expect(Object.hasOwn(f.native, "sourceMap")).toBe(false);
    expect(f.native.ir.functions).toHaveLength(2);
    expect(f.native.derivedUnits).toEqual([]);
    const nativeInput = {
      ...f.input,
      ir: structuredClone(f.native.ir),
      derivedUnits: [],
      sourceMap: { ...f.input.sourceMap, derivedSources: undefined },
    };
    Reflect.deleteProperty(nativeInput.sourceMap, "derivedSources");
    for (const fn of nativeInput.ir.functions)
      for (const block of fn.blocks) {
        for (const instr of block.instrs) forEachInstrDeep(instr, (child) => f.stamp(child, fn.unitId));
        f.stamp(block.terminator, fn.unitId);
      }
    donorCheck(nativeInput);
  });
  it.each([
    "duplicate",
    "empty",
    "undefined",
    "missing",
    "missing-row",
    "nonexistent",
    "swapped",
    "sibling",
    "order",
    "source",
    "parent",
    "role",
    "terminal",
    "unused",
  ])("refuses %s donor-table ownership contradiction after a fresh healthy witness", (mutation) => {
    const f = donorFixture();
    donorCheck(f.input);
    const rows = f.input.sourceMap.derivedSources;
    const first = rows[0]!;
    const record = f.input.derivedUnits[0]!;
    switch (mutation) {
      case "duplicate":
        rows.push({ ...first });
        break;
      case "empty":
        rows.length = 0;
        break;
      case "undefined":
        Reflect.set(f.input.sourceMap, "derivedSources", undefined);
        break;
      case "missing":
        Reflect.deleteProperty(f.input.sourceMap, "derivedSources");
        break;
      case "missing-row":
        rows.splice(0, 1);
        break;
      case "nonexistent":
        first.unitId = f.populations[0]!.owner;
        break;
      case "swapped":
        [rows[0]!.donorUnitId, rows[1]!.donorUnitId] = [rows[1]!.donorUnitId, rows[0]!.donorUnitId];
        break;
      case "sibling":
        first.donorUnitId = f.populations[1]!.executor;
        break;
      case "order":
        rows.reverse();
        break;
      case "source":
        Reflect.set(record, "sourceId", f.input.inventory.sources.find((source) => source.id !== record.sourceId)!.id);
        break;
      case "parent":
        Reflect.set(record, "parentId", f.populations[1]!.owner);
        break;
      case "role":
        Reflect.set(record, "role", "async-state-helper");
        break;
      case "terminal":
        Reflect.set(record, "terminalOwnerId", f.populations[1]!.owner);
        break;
      case "unused": {
        const fn = f.input.ir.functions.find((item) => item.unitId === first.unitId)!;
        for (const block of fn.blocks) {
          for (const instr of block.instrs) forEachInstrDeep(instr, (child) => f.stamp(child, record.parentId));
          f.stamp(block.terminator, record.parentId);
        }
        break;
      }
    }
    invalid(() => donorCheck(f.input));
    donorCheck(donorFixture().input);
  });
});

// Additional graph guards are DATA mutations, not executable mixed-body producer witnesses.
function derivedNestedDataFixture() {
  const f = donorFixture();
  donorCheck(f.input);
  const scalar = fixture();
  const actual = scalar.input.ir.functions
    .flatMap((fn) => fn.blocks.flatMap((block) => block.instrs))
    .find((instr) => instr.kind === "if");
  if (!actual || actual.kind !== "if") throw new Error("genuine scalar nested instruction absent");
  const branch = structuredClone(actual);
  expect(preparedIrDataMismatch(actual, branch)).toBeUndefined();
  const row = f.input.sourceMap.derivedSources[0]!;
  const fn = f.input.ir.functions.find((item) => item.unitId === row.unitId)!;
  forEachInstrDeep(branch, (instr) => f.stamp(instr, row.donorUnitId));
  const block = fn.blocks[0]!;
  Reflect.set(block, "instrs", [...block.instrs, branch]);
  donorCheck(f.input);
  return { f, branch };
}
describe("derived donor-table nested graph guards DATA only", () => {
  it("rejects a real nested instruction self-cycle with controlled invariant before restoring healthy data", () => {
    const { f, branch } = derivedNestedDataFixture();
    const originalThen = branch.then;
    let caught: unknown;
    Reflect.set(branch, "then", [branch]);
    try {
      donorCheck(f.input);
    } catch (error) {
      caught = error;
    } finally {
      Reflect.set(branch, "then", originalThen);
    }
    donorCheck(f.input);
    donorCheck(donorFixture().input);
    console.log(
      "DERIVED_NESTED_CYCLE_REFUSAL",
      JSON.stringify({
        name: caught instanceof Error ? caught.name : typeof caught,
        message: caught instanceof Error ? caught.message : String(caught),
        code: caught && typeof caught === "object" ? Reflect.get(caught, "code") : undefined,
        restored: true,
      }),
    );
    expect(caught).toBeInstanceOf(PreparedIrProgramInvariantError);
    expect(Reflect.get(caught as object, "code")).toBe("invalid-prepared-data");
    expect((caught as Error).message).toContain("source map:");
  });
  it("permits a shared acyclic nested buffer without treating alias reuse as a cycle", () => {
    const { f, branch } = derivedNestedDataFixture();
    const originalElse = branch.else;
    expect(branch.then.length).toBeGreaterThan(0);
    Reflect.set(branch, "else", branch.then);
    expect(branch.then).toBe(branch.else);
    donorCheck(f.input);
    Reflect.set(branch, "else", originalElse);
    donorCheck(f.input);
    donorCheck(donorFixture().input);
  });
});
