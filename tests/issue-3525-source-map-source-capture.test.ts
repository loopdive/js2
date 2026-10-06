// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import { describe, expect, it } from "vitest";
import { inspect } from "node:util";
import { ts } from "../src/ts-api.js";
import * as sourceApi from "../src/ir/program-source.js";
import { buildIrUnitInventory, type IrUnitInventory } from "../src/ir/identity.js";
import { buildIrPlanningIdentityContext } from "../src/ir/planning-identity.js";
import type {
  IrPreparedSourceMap,
  IrSourceMapTextProjection,
  IrSourceMapTextStage,
} from "../src/shared/contracts/ir-unit-inventory.js";
import type { IrSiteId } from "../src/ir/core/nodes.js";
import { PositionMap } from "../src/position-map.js";
import { applyDefineSubstitutionsWithMap } from "../src/compiler/define-substitution.js";
import { sourceInput, sourcePacket, typedOptions } from "./helpers/typed-program-fixtures.js";
import { prepareTypedIrProgram } from "../src/ir/program-prepare-ir.js";
import { encodePreparedIrProgram, decodePreparedIrProgram } from "../src/ir/program-codec.js";
import { acceptPreparedIrProgram, emitAcceptedIrProgram } from "../src/ir/program-consumer.js";
import { emitBinary } from "../src/emit/binary.js";

type Request = {
  kind: "capture-source-map";
  sources: { sourceFile: ts.SourceFile; projection: IrSourceMapTextProjection }[];
};
type Projection =
  | { kind: "source"; site: IrSiteId }
  | {
      kind: "generated-text";
      sourceId: string;
      analyzed: { start: number; end: number };
      stageIndex: number;
      editIndex: number;
    }
  | { kind: "unmapped"; sourceId: string; unitId?: string; detail: string };
type Projector = { readonly sourceMap: IrPreparedSourceMap; project(node: ts.Node): Projection };
const SIMPLE = "export function calculate(value:number):number { return value+2; }";
const FILES = {
  "./left.ts": "export function same(value:number):number { const inner=(n:number):number=>n+1; return inner(value); }",
  "./right.ts": "export function same(value:number):number { return value*2; }",
  "./entry.ts":
    'import {same as left} from "./left"; import {same as right} from "./right"; export {same as renamed} from "./left"; export let visits:number=1; export function calculate(value:number):number{return left(value)+right(value)+visits;}',
  "./empty.ts": "",
  "./types.ts": "export interface Only { value:number; }",
};
function fixture(
  files: Record<string, string> = { "./entry.ts": SIMPLE },
  projections?: ReadonlyMap<string, IrSourceMapTextProjection>,
) {
  const input = sourceInput(files);
  const inventory = buildIrUnitInventory(input.sourceFiles, { entrySource: input.entrySource, checker: input.checker });
  const identity = buildIrPlanningIdentityContext(inventory);
  const sources = inventory.sources.map((row) => identity.sourceFileBySourceId.get(row.id)!);
  const request: Request = {
    kind: "capture-source-map",
    sources: sources.map((sf) => ({
      sourceFile: sf,
      projection: projections?.get(sf.fileName) ?? { originalText: sf.text, analyzedText: sf.text, stages: [] },
    })),
  };
  return { input, inventory, identity, sources, request };
}
function capture(
  f: ReturnType<typeof fixture>,
  request: unknown = f.request,
  sources: readonly ts.SourceFile[] = f.sources,
  inventory: IrUnitInventory = f.inventory,
): IrPreparedSourceMap {
  const api = Reflect.get(sourceApi, "capturePreparedSourceMapInput");
  expect(typeof api, "actual source-associated catalog API").toBe("function");
  return Reflect.apply(api, undefined, [sources, inventory, request]);
}
function projector(f: ReturnType<typeof fixture>, request: unknown = f.request): Projector {
  const api = Reflect.get(sourceApi, "createPreparedSourceMapProjector");
  expect(typeof api, "actual request-local node projector API").toBe("function");
  return Reflect.apply(api, undefined, [f.sources, f.inventory, request]);
}
function rejected(run: () => unknown): void {
  let error: unknown;
  try {
    run();
  } catch (caught) {
    error = caught;
  }
  expect(error).toBeInstanceOf(Error);
  if (!(error instanceof Error)) throw new Error("source projection did not refuse");
  expect(error.message).toMatch(
    /source map|source-map|source origin|planning identity|IR planning identity|invalid preparation data/i,
  );
}
function nodes(sf: ts.SourceFile): ts.Node[] {
  const result: ts.Node[] = [];
  const visit = (n: ts.Node) => {
    result.push(n);
    ts.forEachChild(n, visit);
  };
  visit(sf);
  return result;
}
function find<T extends ts.Node>(sf: ts.SourceFile, predicate: (n: ts.Node) => n is T): T {
  const n = nodes(sf).find(predicate);
  if (!n || !predicate(n)) throw new Error("actual node absent");
  return n;
}
function point(f: ReturnType<typeof fixture>, p: Projector, node: ts.Node) {
  const observed = p.project(node);
  expect(observed.kind).toBe("source");
  if (observed.kind !== "source" || observed.site.origin?.kind !== "source")
    throw new Error("actual source point absent");
  const sf = node.getSourceFile();
  const start = node.getStart(sf),
    end = node.getEnd();
  let parent: ts.Node | undefined = node;
  let donor;
  while (parent) {
    donor = f.identity.unitIdByDeclaration.get(parent);
    if (donor) break;
    parent = parent.parent;
  }
  donor ??= f.identity.moduleInitUnitIdBySourceFile.get(sf);
  expect(donor).toBeDefined();
  const pos = sf.getLineAndCharacterOfPosition(start);
  expect(observed.site).toEqual({
    line: pos.line + 1,
    column: pos.character,
    origin: {
      kind: "source",
      point: {
        sourceId: f.identity.sourceIdBySourceFile.get(sf),
        donorUnitId: donor,
        analyzed: { start, end },
        original: { start, end },
        mapping: "exact",
      },
    },
  });
  return observed.site.origin.point;
}
function snapshot(x: unknown) {
  return inspect(x, { depth: null, maxArrayLength: null, maxStringLength: null, sorted: true });
}
function expectedCatalog(f: ReturnType<typeof fixture>) {
  return f.inventory.sources.map((row) => ({
    sourceId: row.id,
    sourceKey: row.sourceKey,
    originalFileName: row.originalFileName,
    mapName: row.sourceKey,
    projection: f.request.sources.find((s) => s.sourceFile === f.identity.sourceFileBySourceId.get(row.id))!.projection,
  }));
}

describe("genuine source-associated catalog and node projection precursor", () => {
  it("joins every actual scanner source in inventory order, independent of request ordering", () => {
    const f = fixture(FILES);
    const before = snapshot(f.inventory);
    const request = { ...f.request, sources: [...f.request.sources].reverse() };
    const catalog = capture(f, request, [...f.sources].reverse());
    expect(catalog.sources).toEqual(expectedCatalog(f));
    expect(Object.hasOwn(catalog, "derivedSources")).toBe(false);
    expect(snapshot(f.inventory)).toBe(before);
    expect(Object.isFrozen(catalog)).toBe(true);
    expect(Object.isFrozen(catalog.sources)).toBe(true);
    for (const row of catalog.sources) {
      expect(Object.isFrozen(row.projection)).toBe(true);
      expect(row.projection.originalText).toBe(f.identity.sourceFileBySourceId.get(row.sourceId)!.text);
    }
  });
  it("retains distinct same-spelling lexical donors, nested arrow support and real module initialization", () => {
    const f = fixture(FILES),
      p = projector(f);
    const same = [];
    for (const sf of f.sources) {
      for (const n of nodes(sf)) {
        if (ts.isReturnStatement(n) || ts.isParameter(n) || ts.isBinaryExpression(n)) same.push(point(f, p, n));
      }
    }
    const ids = new Set(same.map((row) => row.donorUnitId));
    expect(ids.size).toBeGreaterThan(2);
    const left = f.sources.find((sf) => sf.fileName.endsWith("left.ts"))!;
    const arrow = find(left, ts.isArrowFunction);
    const arrowPoint = point(f, p, arrow.body);
    expect(arrowPoint.donorUnitId).toBe(f.identity.unitIdByDeclaration.get(arrow));
    expect(f.identity.unitByUnitId.get(arrowPoint.donorUnitId)!.terminal).toBe(false);
    const variable = find(f.input.entrySource, ts.isVariableDeclaration);
    point(f, p, variable.initializer!);
    expect(p.sourceMap.sources).toEqual(expectedCatalog(f));
  });
  it("keeps empty/type-only sources without manufacturing an executable donor", () => {
    const f = fixture(FILES),
      p = projector(f);
    for (const sf of f.sources.filter((sf) => sf.fileName.endsWith("empty.ts") || sf.fileName.endsWith("types.ts"))) {
      expect(f.identity.moduleInitUnitIdBySourceFile.has(sf)).toBe(false);
      expect(
        p.sourceMap.sources.find((row) => row.sourceId === f.identity.sourceIdBySourceFile.get(sf))!.projection
          .originalText,
      ).toBe(sf.text);
    }
    const sf = f.sources.find((s) => s.fileName.endsWith("types.ts"))!;
    const n = find(sf, ts.isInterfaceDeclaration);
    expect(p.project(n).kind).toBe("unmapped");
  });
  it.each([
    "foreign-source",
    "missing-source",
    "duplicate-source",
    "missing-row",
    "duplicate-row",
    "extra-row",
    "cloned-inventory",
  ])("refuses %s reference population after an authentic healthy catalog", (kind) => {
    const f = fixture();
    capture(f);
    let sources = [...f.sources],
      inventory = f.inventory;
    const request = { ...f.request, sources: [...f.request.sources] };
    const foreign = ts.createSourceFile(f.sources[0]!.fileName, f.sources[0]!.text, ts.ScriptTarget.Latest, true);
    if (kind === "foreign-source") sources = [foreign];
    if (kind === "missing-source") sources = [];
    if (kind === "duplicate-source") sources.push(sources[0]!);
    if (kind === "missing-row") request.sources = [];
    if (kind === "duplicate-row") request.sources.push(request.sources[0]!);
    if (kind === "extra-row") request.sources.push({ sourceFile: foreign, projection: request.sources[0]!.projection });
    if (kind === "cloned-inventory") inventory = { ...inventory };
    rejected(() => capture(f, request, sources, inventory));
    expect(capture(f).sources).toEqual(expectedCatalog(f));
  });
  it.each(["removed-declaration", "changed-declaration-range"])(
    "refuses %s between genuine scanner inventory and factory construction",
    (kind) => {
      const f = fixture(),
        sf = f.sources[0]!,
        declaration = find(sf, ts.isFunctionDeclaration);
      capture(f);
      const statements = sf.statements,
        end = declaration.end;
      if (kind === "removed-declaration")
        Reflect.set(sf, "statements", ts.factory.createNodeArray(statements.filter((n) => n !== declaration)));
      else Reflect.set(declaration, "end", end - 1);
      try {
        rejected(() => projector(f));
      } finally {
        Reflect.set(sf, "statements", statements);
        Reflect.set(declaration, "end", end);
      }
      point(f, projector(f), find(sf, ts.isBinaryExpression));
    },
  );
  it.each(["foreign-node", "forged-original", "stale-range", "stale-text"])(
    "refuses %s rather than borrowing captured AST authority",
    (kind) => {
      const f = fixture(),
        p = projector(f),
        sf = f.sources[0]!,
        n = find(sf, ts.isBinaryExpression);
      point(f, p, n);
      if (kind === "foreign-node" || kind === "forged-original") {
        const foreign = ts.createSourceFile(sf.fileName, sf.text, ts.ScriptTarget.Latest, true);
        const clone = find(foreign, ts.isBinaryExpression);
        if (kind === "forged-original") {
          ts.setOriginalNode(clone, n);
          Reflect.set(clone, "parent", n.parent);
        }
        rejected(() => p.project(clone));
      } else if (kind === "stale-range") {
        const end = n.end;
        Reflect.set(n, "end", end - 1);
        try {
          rejected(() => p.project(n));
        } finally {
          Reflect.set(n, "end", end);
        }
      } else {
        const text = sf.text;
        Reflect.set(sf, "text", text + " ");
        try {
          rejected(() => p.project(n));
        } finally {
          Reflect.set(sf, "text", text);
        }
      }
      point(f, projector(f), n);
    },
  );
  it("captures actual define passes and reverse causal spans across UTF-16/CRLF text", () => {
    const original = "// 😀\r\nexport function calculate(value:number):number { return LONG_TOKEN + X; }";
    const stages: IrSourceMapTextStage[] = [];
    const rewritten = applyDefineSubstitutionsWithMap(original, { LONG_TOKEN: "12345", X: "9" }, (stage) =>
      stages.push(stage),
    );
    expect(stages).toHaveLength(2);
    expect(stages[0]!.inputText).toBe(original);
    expect(stages[1]!.inputText).toBe(stages[0]!.outputText);
    expect(stages[1]!.outputText).toBe(rewritten.source);
    const f = fixture({ "./entry.ts": rewritten.source });
    f.request.sources[0]!.projection = { originalText: original, analyzedText: rewritten.source, stages };
    const p = projector(f);
    for (const [text, token] of [
      ["12345", "LONG_TOKEN"],
      ["9", "X"],
    ]) {
      const n = nodes(f.sources[0]!).find((n) => ts.isNumericLiteral(n) && n.text === text)!;
      const got = p.project(n);
      expect(got.kind).toBe("source");
      if (got.kind !== "source" || got.site.origin?.kind !== "source") throw new Error("define cause absent");
      const offset = original.indexOf(token!);
      expect(got.site.origin.point.original).toEqual({ start: offset, end: offset + token!.length });
      expect(got.site.origin.point.mapping).toBe("rewrite");
      const pos = f.sources[0]!.getLineAndCharacterOfPosition(n.getStart());
      expect([got.site.line, got.site.column]).toEqual([pos.line + 1, pos.character]);
    }
  });
  it("distinguishes a genuine captured inserted expression from an unproved crossed span", () => {
    const original = SIMPLE;
    const start = original.indexOf("value+2");
    const inserted = "1+";
    const analyzed = original.slice(0, start) + inserted + original.slice(start);
    const stage = new PositionMap([
      { origStart: start, origEnd: start, newLength: inserted.length },
    ]).captureSourceMapStage("imports", original, analyzed);
    const f = fixture({ "./entry.ts": analyzed });
    f.request.sources[0]!.projection = { originalText: original, analyzedText: analyzed, stages: [stage] };
    const p = projector(f);
    const literal = nodes(f.sources[0]!).find((n) => ts.isNumericLiteral(n) && n.text === "1")!;
    expect(p.project(literal)).toEqual({
      kind: "generated-text",
      sourceId: f.inventory.sources[0]!.id,
      analyzed: { start: literal.getStart(), end: literal.getEnd() },
      stageIndex: 0,
      editIndex: 0,
    });
    const crossed = find(f.sources[0]!, ts.isBinaryExpression);
    const gap = p.project(crossed);
    expect(gap.kind).toBe("unmapped");
    if (gap.kind !== "unmapped") throw new Error("crossed insertion did not retain gap");
    expect(gap.detail.length).toBeGreaterThan(0);
  });
  it.each(["removed", "inserted", "order", "unknown", "undefined"])(
    "refuses malformed %s stage DATA without minting points",
    (kind) => {
      const original = "export function calculate():number{return LONG + X;}";
      const stages: IrSourceMapTextStage[] = [];
      const result = applyDefineSubstitutionsWithMap(original, { LONG: "123", X: "4" }, (s) => stages.push(s));
      const f = fixture({ "./entry.ts": result.source });
      const projection = { originalText: original, analyzedText: result.source, stages };
      f.request.sources[0]!.projection = projection;
      capture(f);
      const bad = structuredClone(projection);
      if (kind === "removed") Reflect.set(bad.stages[0]!.edits[0]!, "removed", "wrong");
      if (kind === "inserted") Reflect.set(bad.stages[0]!.edits[0]!, "inserted", "999");
      if (kind === "order") bad.stages.reverse();
      if (kind === "unknown") Reflect.set(bad.stages[0]!, "unknown", 1);
      if (kind === "undefined") Reflect.set(bad, "unknown", undefined);
      rejected(() =>
        capture(f, { kind: "capture-source-map", sources: [{ sourceFile: f.sources[0], projection: bad }] }),
      );
      expect(capture(f).sources[0]!.projection).toEqual(projection);
    },
  );
  it.each(["request-getter", "row-getter", "projection-getter", "foreign-array"])(
    "rejects %s before invoking hostile hooks",
    (kind) => {
      const f = fixture();
      capture(f);
      let hooks = 0;
      let request: unknown = f.request;
      if (kind === "request-getter")
        request = {
          get kind() {
            hooks++;
            return "capture-source-map";
          },
          sources: f.request.sources,
        };
      if (kind === "row-getter")
        request = {
          kind: "capture-source-map",
          sources: [
            {
              get sourceFile() {
                hooks++;
                return f.sources[0];
              },
              projection: f.request.sources[0]!.projection,
            },
          ],
        };
      if (kind === "projection-getter")
        request = {
          kind: "capture-source-map",
          sources: [
            {
              sourceFile: f.sources[0],
              get projection() {
                hooks++;
                return f.request.sources[0]!.projection;
              },
            },
          ],
        };
      if (kind === "foreign-array") {
        const sources = [...f.request.sources];
        const proto = Object.create(Array.prototype);
        Object.defineProperty(proto, Symbol.iterator, {
          value: () => {
            hooks++;
            return [][Symbol.iterator]();
          },
        });
        Object.setPrototypeOf(sources, proto);
        request = { kind: "capture-source-map", sources };
      }
      rejected(() => capture(f, request));
      expect(hooks).toBe(0);
      expect(capture(f).sources).toEqual(expectedCatalog(f));
    },
  );
  it("detaches projection data and freezes exposed catalog without recapturing mutated input", () => {
    const f = fixture(),
      p = projector(f);
    const n = find(f.sources[0]!, ts.isBinaryExpression);
    const before = point(f, p, n);
    Reflect.set(f.request.sources[0]!.projection, "originalText", "different");
    expect(point(f, p, n)).toEqual(before);
    expect(Reflect.set(p.sourceMap.sources[0]!.projection, "originalText", "different")).toBe(false);
    expect(p.sourceMap.sources[0]!.projection.originalText).toBe(SIMPLE);
  });
});

describe("unchanged genuine no-map capture and numeric execution", () => {
  it.each(["wasmgc", "linear"] as const)(
    "%s original multi-source preparation/codec/binary semantics stay exact",
    async (backend) => {
      const files = {
        "./math.ts": "export function twice(value:number):number{return value*2;}",
        "./entry.ts":
          'import {twice} from "./math"; export function calculate(value:number):number{return twice(value)+2;}',
      };
      const first = sourcePacket(files),
        second = sourcePacket(files);
      expect(snapshot(first.packet)).toBe(snapshot(second.packet));
      const outputs = [];
      for (const data of [first, second]) {
        const result = prepareTypedIrProgram(data.packet, {
          ...typedOptions,
          policy: { backend, target: "host" },
          runtimePolicies: [{ backend, target: "host" }],
        });
        if (result.kind !== "prepared") throw new Error(JSON.stringify(result));
        expect(Object.hasOwn(result.program, "sourceMap")).toBe(false);
        const wire = encodePreparedIrProgram(result.program);
        expect(encodePreparedIrProgram(decodePreparedIrProgram(wire))).toBe(wire);
        const accepted = acceptPreparedIrProgram(result.program, {
          backend,
          target: "host",
          moduleName: "source-capture-no-map",
          sharedExceptionTag: false,
          utf8Storage: false,
          sourceMap: false,
        });
        if (accepted.kind !== "accepted") throw new Error(JSON.stringify(accepted));
        const emitted = emitAcceptedIrProgram(accepted);
        expect(emitted.module.imports).toEqual([]);
        const binary = emitBinary(emitted.module);
        const { instance } = await WebAssembly.instantiate(new Uint8Array(binary));
        const call = instance.exports.calculate;
        if (typeof call !== "function") throw new Error("numeric export absent");
        const values = [3, -2, 0].map((x) => call(x));
        expect(values).toEqual([8, -2, 2]);
        outputs.push({ wire, binary, values });
      }
      expect(outputs[0]).toEqual(outputs[1]);
    },
  );
});

describe("scanner lexical donor and bounded module-init projection controls", () => {
  it("keeps computed object-method keys in their scanner outer donor and method bodies in distinct indexed donors", () => {
    const text =
      "export function choose(key: string): number { const a = { [key](value: number): number { return value + 1; } }; const b = { [(() => key)()](value: number): number { return value + 2; } }; return 0; }";
    const f = fixture({ "./entry.ts": text }),
      sf = f.sources[0]!;
    const choose = find(sf, ts.isFunctionDeclaration),
      methods = nodes(sf).filter(ts.isMethodDeclaration),
      arrow = find(sf, ts.isArrowFunction);
    expect(methods).toHaveLength(2);
    const owner = f.identity.unitIdByDeclaration.get(choose)!;
    const methodIds = methods.map((method) => f.identity.unitIdByDeclaration.get(method)!);
    const arrowId = f.identity.unitIdByDeclaration.get(arrow)!;
    expect(new Set([owner, ...methodIds, arrowId]).size).toBe(4);
    for (const id of [...methodIds, arrowId]) expect(f.identity.unitByUnitId.get(id)!.lexicalOwnerId).toBe(owner);
    console.log(
      "SCANNER_COMPUTED_DONORS",
      JSON.stringify({ sourceId: f.identity.sourceIdBySourceFile.get(sf), owner, methodIds, arrowId }),
    );
    const p = projector(f);
    const assertDonor = (node: ts.Node, donorUnitId: typeof owner) => {
      const result = p.project(node);
      expect(result.kind).toBe("source");
      if (result.kind !== "source" || result.site.origin?.kind !== "source")
        throw new Error("computed-key source projection absent");
      const start = node.getStart(sf),
        end = node.getEnd(),
        loc = sf.getLineAndCharacterOfPosition(start);
      expect(result.site).toEqual({
        line: loc.line + 1,
        column: loc.character,
        origin: {
          kind: "source",
          point: {
            sourceId: f.identity.sourceIdBySourceFile.get(sf),
            donorUnitId,
            analyzed: { start, end },
            original: { start, end },
            mapping: "exact",
          },
        },
      });
    };
    const first = methods[0]!,
      second = methods[1]!;
    if (!ts.isComputedPropertyName(first.name)) throw new Error("actual computed method name absent");
    assertDonor(first.name.expression, owner);
    assertDonor(arrow.body, arrowId);
    for (const [method, id] of [
      [first, methodIds[0]!],
      [second, methodIds[1]!],
    ] as const) {
      const body = method.body!;
      let binary: ts.BinaryExpression | undefined;
      const visit = (node: ts.Node): void => {
        if (ts.isBinaryExpression(node)) binary = node;
        ts.forEachChild(node, visit);
      };
      visit(body);
      if (!binary) throw new Error("actual method body expression absent");
      assertDonor(binary, id);
    }
  });
  it("projects a genuine module-init anchor and retains the later real statement as an explicit unmapped coverage gap", () => {
    const text = "let total: number = 1;\ntotal = total + 2;\nexport function read(): number { return total; }";
    const f = fixture({ "./entry.ts": text }),
      sf = f.sources[0]!,
      population = f.identity.moduleInitPopulationBySourceFile.get(sf)!;
    expect(population).toHaveLength(2);
    expect(ts.isVariableStatement(population[0]!)).toBe(true);
    expect(ts.isExpressionStatement(population[1]!)).toBe(true);
    const id = f.identity.moduleInitUnitIdBySourceFile.get(sf)!,
      unit = f.identity.unitByUnitId.get(id)!;
    expect(unit.declarationStart).toBe(population[0]!.getStart(sf));
    expect(unit.declarationEnd).toBe(population[0]!.getEnd());
    console.log(
      "SCANNER_MODULE_INIT_POPULATION",
      JSON.stringify({
        sourceId: unit.sourceId,
        unitId: id,
        anchor: { start: unit.declarationStart, end: unit.declarationEnd },
        population: population.map((n) => ({ start: n.getStart(sf), end: n.getEnd(), kind: ts.SyntaxKind[n.kind] })),
      }),
    );
    const declaration = find(sf, ts.isVariableDeclaration),
      p = projector(f);
    point(f, p, declaration.initializer!);
    const later = population[1]!;
    if (!ts.isExpressionStatement(later)) throw new Error("actual second module-init expression absent");
    const observed = p.project(later.expression);
    expect(observed.kind).toBe("unmapped");
    if (observed.kind !== "unmapped") throw new Error("module-init anchor limitation concealed");
    expect(observed.sourceId).toBe(f.identity.sourceIdBySourceFile.get(sf));
    expect(observed.unitId).toBe(id);
    expect(observed.detail.length).toBeGreaterThan(0);
    point(f, p, declaration.initializer!);
    console.log(
      "SCANNER_MODULE_INIT_GAP",
      JSON.stringify({
        sourceId: unit.sourceId,
        unitId: id,
        anchor: { start: unit.declarationStart, end: unit.declarationEnd },
        later: { start: later.expression.getStart(sf), end: later.expression.getEnd() },
        observed,
      }),
    );
  });
});

describe("finite genuine SourceFile ancestry trust", () => {
  it("refuses a real scanned SourceFile self-parent before walking and permits a fresh healthy projector after restoration", () => {
    const f = fixture(),
      sf = f.sources[0]!,
      node = find(sf, ts.isBinaryExpression);
    point(f, projector(f), node);
    const parent = sf.parent;
    expect(parent).toBeUndefined();
    Reflect.set(sf, "parent", sf);
    try {
      rejected(() => projector(f));
    } finally {
      Reflect.set(sf, "parent", parent);
    }
    expect(sf.parent).toBe(parent);
    point(f, projector(f), node);
  });
});

describe("finite genuine scanner declaration ancestry", () => {
  it("refuses attached and removed indexed declaration self-parents before planning ancestry and restores fresh healthy projection", () => {
    for (const removed of [false, true]) {
      const f = fixture(),
        sf = f.sources[0]!,
        declaration = find(sf, ts.isFunctionDeclaration),
        expression = find(sf, ts.isBinaryExpression);
      const id = f.identity.unitIdByDeclaration.get(declaration)!;
      expect(f.identity.declarationByUnitId.get(id)).toBe(declaration);
      point(f, projector(f), expression);
      const parent = declaration.parent,
        statements = sf.statements;
      expect(parent).toBe(sf);
      if (removed)
        Reflect.set(sf, "statements", ts.factory.createNodeArray(statements.filter((node) => node !== declaration)));
      Reflect.set(declaration, "parent", declaration);
      try {
        rejected(() => projector(f));
      } finally {
        Reflect.set(declaration, "parent", parent);
        Reflect.set(sf, "statements", statements);
      }
      expect(declaration.parent).toBe(parent);
      expect(sf.statements).toBe(statements);
      point(f, projector(f), expression);
    }
  });
});
