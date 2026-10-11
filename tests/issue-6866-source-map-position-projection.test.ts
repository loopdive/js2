// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import { describe, expect, it } from "vitest";
import { PreparedIrProgramInvariantError } from "../src/ir/program/errors.js";
import { createDerivedIrUnitId } from "../src/shared/contracts/identity-values.js";
import { ts } from "../src/ts-api.js";
import { buildIrUnitInventory } from "../src/ir/identity.js";
import { buildIrPlanningIdentityContext } from "../src/ir/planning-identity.js";
import { createPreparedSourceMapProjector } from "../src/ir/program-source.js";
import { sourceInput } from "./helpers/typed-program-fixtures.js";

const leaves = import.meta.glob("../src/ir/program/source-map-position.ts", { eager: true });
function factory() {
  const module = leaves["../src/ir/program/source-map-position.ts"] as Record<string, unknown> | undefined;
  const api = module?.createIrSourceMapPositionProjector;
  expect(typeof api, "requested position projector API must exist after registered producer controls").toBe("function");
  return api as (input: unknown) => { project(owner: unknown, origin: unknown): unknown };
}
// Independent character-offset oracle: scan the prefix, retaining UTF-16 code units.
// CRLF's LF still belongs to the preceding line; advance only after the pair.
function oracle(text: string, offset: number) {
  let line = 0,
    lineStart = 0;
  for (let index = 0; index < offset; index++) {
    const code = text.charCodeAt(index);
    if (code === 13 && text.charCodeAt(index + 1) === 10) {
      if (index + 1 < offset) {
        index++;
        line++;
        lineStart = index + 1;
      }
    } else if (code === 13 || code === 10 || code === 0x2028 || code === 0x2029) {
      line++;
      lineStart = index + 1;
    }
  }
  return { line, column: offset - lineStart };
}
function captured() {
  const input = sourceInput({
    "./donor.ts": "export function twice(n:number):number { return n*2; }",
    "./entry.ts":
      'import {twice} from "./donor";\r\n// 😀\rexport function main(n:number):number {\n const inner=(x:number)=>x+1;\u2028 return twice(inner(n));\u2029}\n',
  });
  const inventory = buildIrUnitInventory(input.sourceFiles, { entrySource: input.entrySource, checker: input.checker });
  const identity = buildIrPlanningIdentityContext(inventory);
  const sources = inventory.sources.map((row) => identity.sourceFileBySourceId.get(row.id)!);
  const projector = createPreparedSourceMapProjector(sources, inventory, {
    kind: "capture-source-map",
    sources: sources.map((sourceFile) => ({
      sourceFile,
      projection: { originalText: sourceFile.text, analyzedText: sourceFile.text, stages: [] },
    })),
  });
  const points: { owner: string; origin: unknown; text: string; file: string }[] = [];
  for (const source of sources) {
    const visit = (node: ts.Node) => {
      if (ts.isReturnStatement(node) || ts.isBinaryExpression(node)) {
        const result = projector.project(node);
        expect(result.kind).toBe("source");
        if (result.kind !== "source" || result.site.origin?.kind !== "source")
          throw new Error("genuine producer point absent");
        points.push({
          owner: result.site.origin.point.donorUnitId,
          origin: result.site.origin,
          text: source.text,
          file: inventory.sources.find((row) => row.originalFileName === source.fileName)!.sourceKey,
        });
      }
      ts.forEachChild(node, visit);
    };
    visit(source);
  }
  return { inventory, sourceMap: projector.sourceMap, derivedUnits: [], points };
}

describe("IR source-map position projection DATA and genuine producer controls", () => {
  it("CONTROL registers every UTF-16 newline boundary against actual SourceFile coordinates", () => {
    const text = "a😀\r\nb\rc\nd\u2028e\u2029";
    const source = ts.createSourceFile("oracle.ts", text, ts.ScriptTarget.Latest, true);
    let rows = 0;
    for (let offset = 0; offset <= text.length; offset++) {
      const observed = source.getLineAndCharacterOfPosition(offset);
      expect(oracle(text, offset)).toEqual({ line: observed.line, column: observed.character });
      rows++;
    }
    expect(rows).toBe(14);
  });
  it("CONTROL captures actual checker/scanner catalog and nonempty original node points", () => {
    const f = captured();
    expect(f.sourceMap.sources.length).toBe(2);
    expect(f.inventory.allUnits.length).toBeGreaterThanOrEqual(3);
    expect(f.points.length).toBeGreaterThanOrEqual(4);
    expect(new Set(f.points.map((row) => row.owner)).size).toBeGreaterThanOrEqual(3);
  });
  it("projects genuinely captured points using exact map names and original coordinates", () => {
    const f = captured();
    const p = factory()({ sourceMap: f.sourceMap, inventory: f.inventory, derivedUnits: f.derivedUnits });
    for (const row of f.points) {
      const origin = row.origin as { point: { original: { start: number } } };
      expect(p.project(row.owner, row.origin)).toEqual({
        file: row.file,
        ...oracle(row.text, origin.point.original.start),
      });
    }
  });
});

// DATA fixtures deliberately isolate the projection contract. They do not claim
// stage replay, real async plans, complete body coverage, startup issuance or publication.
function data(text = "a😀\r\nb\rc\nd\u2028e\u2029", analyzed = text) {
  const sourceId = "data-source",
    owner = "data-owner";
  return {
    sourceMap: {
      schema: "prepared-ir-source-map-v1",
      sources: [
        {
          sourceId,
          sourceKey: "data.ts",
          originalFileName: "/captured/data.ts",
          mapName: "data.ts",
          projection: { originalText: text, analyzedText: analyzed, stages: [] as unknown[] },
        },
      ],
    },
    inventory: {
      sources: [{ id: sourceId, sourceKey: "data.ts", originalFileName: "/captured/data.ts" }],
      allUnits: [
        {
          id: owner,
          sourceId,
          kind: "top-level-function",
          lexicalOwnerId: null as string | null,
          terminalOwnerId: owner,
          terminal: true,
          declarationStart: 0,
          declarationEnd: analyzed.length,
        },
      ],
    },
    derivedUnits: [] as Record<string, unknown>[],
  };
}
function point(start = 0, end = start, sourceId = "data-source", donorUnitId = "data-owner") {
  return { sourceId, donorUnitId, analyzed: { start, end }, original: { start, end }, mapping: "exact" };
}
function sourceOrigin(start = 0, end = start) {
  return { kind: "source", point: point(start, end) };
}
function reject(run: () => unknown, category?: RegExp) {
  let caught: unknown;
  try {
    run();
  } catch (error) {
    caught = error;
  }
  expect(caught).toBeInstanceOf(PreparedIrProgramInvariantError);
  if (!(caught instanceof PreparedIrProgramInvariantError)) throw new Error("expected typed position refusal");
  expect(caught.code).toBe("invalid-prepared-data");
  expect(caught.message).toMatch(/^source map position:/);
  if (category) expect(caught.message).toMatch(category);
}
function clone<T>(value: T): T {
  return structuredClone(value);
}

// Mutation cases use unknown at the adversarial boundary; no primitive coercion.
const catalogMutations: [string, (f: ReturnType<typeof data>) => void][] = [
  [
    "wrong schema",
    (f) => {
      f.sourceMap.schema = "wrong";
    },
  ],
  [
    "source count",
    (f) => {
      f.inventory.sources = [];
    },
  ],
  [
    "source identity",
    (f) => {
      f.inventory.sources[0]!.id = "foreign";
    },
  ],
  [
    "filename join",
    (f) => {
      f.inventory.sources[0]!.originalFileName = "elsewhere.ts";
    },
  ],
  [
    "source key join",
    (f) => {
      f.inventory.sources[0]!.sourceKey = "elsewhere.ts";
    },
  ],
  [
    "map name association",
    (f) => {
      f.sourceMap.sources[0]!.mapName = "elsewhere.ts";
    },
  ],
  [
    "late duplicate catalog",
    (f) => {
      f.sourceMap.sources.push(clone(f.sourceMap.sources[0]!));
      f.inventory.sources.push(clone(f.inventory.sources[0]!));
    },
  ],
  [
    "late duplicate unit",
    (f) => {
      f.inventory.allUnits.push(clone(f.inventory.allUnits[0]!));
    },
  ],
  [
    "unknown unit source",
    (f) => {
      f.inventory.allUnits[0]!.sourceId = "unknown";
    },
  ],
  [
    "unknown terminal owner",
    (f) => {
      f.inventory.allUnits[0]!.terminalOwnerId = "unknown";
    },
  ],
  [
    "wrong terminal owner",
    (f) => {
      f.inventory.allUnits[0]!.terminalOwnerId = "other";
    },
  ],
  [
    "invalid kind",
    (f) => {
      f.inventory.allUnits[0]!.kind = "invented";
    },
  ],
  [
    "negative declaration",
    (f) => {
      f.inventory.allUnits[0]!.declarationStart = -1;
    },
  ],
  [
    "unsafe declaration",
    (f) => {
      f.inventory.allUnits[0]!.declarationEnd = Number.MAX_SAFE_INTEGER + 1;
    },
  ],
  [
    "declaration exceeds analyzed text",
    (f) => {
      f.inventory.allUnits[0]!.declarationEnd++;
    },
  ],
  [
    "declaration reversed",
    (f) => {
      f.inventory.allUnits[0]!.declarationStart = 2;
      f.inventory.allUnits[0]!.declarationEnd = 1;
    },
  ],
  [
    "projection unknown field",
    (f) => {
      Object.assign(f.sourceMap.sources[0]!.projection, { legacy: true });
    },
  ],
  [
    "catalog unknown field",
    (f) => {
      Object.assign(f.sourceMap, { legacy: true });
    },
  ],
  [
    "input unknown field",
    (f) => {
      Object.assign(f, { legacy: true });
    },
  ],
  [
    "empty derived grants",
    (f) => {
      Object.assign(f.sourceMap, { derivedSources: [] });
    },
  ],
  [
    "source array hole",
    (f) => {
      Reflect.deleteProperty(f.sourceMap.sources, "0");
    },
  ],
  [
    "stage array hole",
    (f) => {
      f.sourceMap.sources[0]!.projection.stages = new Array(1);
    },
  ],
  [
    "stage array extra",
    (f) => {
      Object.assign(f.sourceMap.sources[0]!.projection.stages, { extra: true });
    },
  ],
  [
    "stage array symbol",
    (f) => {
      Object.assign(f.sourceMap.sources[0]!.projection.stages, { [Symbol("extra")]: true });
    },
  ],
  [
    "explicit undefined synthetic role",
    (f) => {
      Object.assign(f.inventory.allUnits[0]!, { syntheticRole: undefined });
    },
  ],
];
const originMutations: [string, (o: ReturnType<typeof sourceOrigin>) => void][] = [
  [
    "wrong kind",
    (o) => {
      o.kind = "invented";
    },
  ],
  [
    "wrong mapping",
    (o) => {
      o.point.mapping = "guessed";
    },
  ],
  [
    "unknown source",
    (o) => {
      o.point.sourceId = "unknown";
    },
  ],
  [
    "unknown donor",
    (o) => {
      o.point.donorUnitId = "unknown";
    },
  ],
  [
    "negative original",
    (o) => {
      o.point.original.start = -1;
    },
  ],
  [
    "fractional original",
    (o) => {
      o.point.original.start = 0.5;
    },
  ],
  [
    "NaN original",
    (o) => {
      o.point.original.start = NaN;
    },
  ],
  [
    "infinite original",
    (o) => {
      o.point.original.end = Infinity;
    },
  ],
  [
    "reversed original",
    (o) => {
      o.point.original.start = 2;
      o.point.original.end = 1;
    },
  ],
  [
    "original beyond EOF",
    (o) => {
      o.point.original.end = 100;
    },
  ],
  [
    "analyzed beyond EOF",
    (o) => {
      o.point.analyzed.end = 100;
    },
  ],
  [
    "span extra",
    (o) => {
      Object.assign(o.point.analyzed, { line: 1 });
    },
  ],
  [
    "point extra",
    (o) => {
      Object.assign(o.point, { line: 1 });
    },
  ],
  [
    "origin extra",
    (o) => {
      Object.assign(o, { line: 1 });
    },
  ],
  [
    "origin symbol",
    (o) => {
      Object.assign(o, { [Symbol("extra")]: true });
    },
  ],
  [
    "explicit undefined inlinedAt",
    (o) => {
      Object.assign(o, { inlinedAt: undefined });
    },
  ],
  [
    "empty contributors",
    (o) => {
      Object.assign(o, { contributors: [] });
    },
  ],
  [
    "empty inlinedAt",
    (o) => {
      Object.assign(o, { inlinedAt: [] });
    },
  ],
  [
    "duplicate primary contributor",
    (o) => {
      Object.assign(o, { contributors: [clone(o.point)] });
    },
  ],
  [
    "duplicate primary inline",
    (o) => {
      Object.assign(o, { inlinedAt: [clone(o.point)] });
    },
  ],
  [
    "late malformed contributor",
    (o) => {
      Object.assign(o, { contributors: [point(1), { ...point(2), sourceId: "unknown" }] });
    },
  ],
  [
    "duplicate contributor",
    (o) => {
      Object.assign(o, { contributors: [point(1), point(1)] });
    },
  ],
  [
    "cyclic inline donor",
    (o) => {
      Object.assign(o, { inlinedAt: [point(1)] });
    },
  ],
];

describe("DATA physical projection contract", () => {
  it.each(["", "a😀\r\nb\rc\nd\u2028e\u2029", "\r", "\r\n", "\n\n", "😀😀"])(
    "projects every UTF-16 offset including EOF for %j",
    (text) => {
      const f = data(text),
        p = factory()(f);
      const before = JSON.stringify(f);
      for (let offset = 0; offset <= text.length; offset++) {
        const o = sourceOrigin(offset),
          original = JSON.stringify(o);
        expect(p.project("data-owner", o)).toEqual({ file: "data.ts", ...oracle(text, offset) });
        expect(JSON.stringify(o)).toBe(original);
      }
      expect(JSON.stringify(f)).toBe(before);
    },
  );
  it("uses captured original text/start after rewrites without replaying a stage payload", () => {
    const f = data("first\r\n😀original\n", "tiny");
    // Payload validation/replay belongs to preparation, not this DATA leaf.
    f.sourceMap.sources[0]!.projection.stages = [null] as never[];
    const o = sourceOrigin();
    o.point.original = { start: 9, end: 12 };
    o.point.analyzed = { start: 1, end: 2 };
    o.point.mapping = "rewrite";
    expect(factory()(f).project("data-owner", o)).toEqual({ file: "data.ts", ...oracle("first\r\n😀original\n", 9) });
  });
  it.each(catalogMutations)("refuses catalog/index mutation: %s and restores healthy input", (_name, mutate) => {
    const f = data();
    const healthy = clone(f);
    mutate(f);
    reject(() => factory()(f));
    expect(factory()(healthy).project("data-owner", sourceOrigin())).toEqual({ file: "data.ts", line: 0, column: 0 });
  });
  it.each(originMutations)("refuses consumed origin mutation: %s and restores healthy origin", (_name, mutate) => {
    const p = factory()(data()),
      o = sourceOrigin();
    mutate(o);
    reject(() => p.project("data-owner", o));
    expect(p.project("data-owner", sourceOrigin())).toEqual({ file: "data.ts", line: 0, column: 0 });
  });
  it("snapshots consumed inputs and returns independent position records", () => {
    const f = data(),
      p = factory()(f);
    const first = p.project("data-owner", sourceOrigin(3)) as { file: string; line: number; column: number };
    first.file = "changed";
    first.line = 99;
    f.sourceMap.sources[0]!.projection.originalText = "changed";
    f.sourceMap.sources[0]!.mapName = "changed.ts";
    f.inventory.allUnits[0]!.id = "changed";
    expect(p.project("data-owner", sourceOrigin(3))).toEqual({ file: "data.ts", line: 0, column: 3 });
    reject(() => factory()(f));
  });
  it("ignores unused inventory fields without reading getters", () => {
    const f = data();
    let reads = 0;
    Object.defineProperty(f.inventory, "classes", {
      get() {
        reads++;
        throw new Error("unused");
      },
    });
    Object.defineProperty(f.inventory.allUnits[0]!, "displayName", {
      get() {
        reads++;
        throw new Error("unused");
      },
    });
    expect(factory()(f).project("data-owner", sourceOrigin())).toEqual({ file: "data.ts", line: 0, column: 0 });
    expect(reads).toBe(0);
  });
  it.each(["factory", "text", "unit", "array", "origin", "span"])(
    "refuses %s accessors without executing them",
    (kind) => {
      const f = data(),
        o = sourceOrigin();
      let reads = 0;
      const getter = {
        configurable: true,
        get() {
          reads++;
          throw new Error("read trap");
        },
      };
      if (kind === "factory") Object.defineProperty(f, "sourceMap", getter);
      if (kind === "text") Object.defineProperty(f.sourceMap.sources[0]!.projection, "originalText", getter);
      if (kind === "unit") Object.defineProperty(f.inventory.allUnits[0]!, "id", getter);
      if (kind === "array") Object.defineProperty(f.inventory.sources, "0", getter);
      if (kind === "origin") Object.defineProperty(o, "point", getter);
      if (kind === "span") Object.defineProperty(o.point.original, "start", getter);
      if (kind === "origin" || kind === "span") reject(() => factory()(f).project("data-owner", o));
      else reject(() => factory()(f));
      expect(reads).toBe(0);
    },
  );
  it.each(["owner", "sourceId", "offset", "text"])("refuses boxed/coercible %s without coercing it", (kind) => {
    const f = data(),
      o = sourceOrigin();
    let calls = 0;
    const boxed = Object.assign(new String("data-owner"), {
      [Symbol.toPrimitive]() {
        calls++;
        throw new Error("coercion");
      },
    });
    if (kind === "text") Object.assign(f.sourceMap.sources[0]!.projection, { originalText: boxed });
    if (kind === "sourceId") Object.assign(o.point, { sourceId: boxed });
    if (kind === "offset") Object.assign(o.point.original, { start: boxed });
    if (kind === "text") reject(() => factory()(f));
    else reject(() => factory()(f).project(kind === "owner" ? boxed : "data-owner", o));
    expect(calls).toBe(0);
  });
  it("admits empty populations while refusing every owner", () => {
    const p = factory()({
      sourceMap: { schema: "prepared-ir-source-map-v1", sources: [] },
      inventory: { sources: [], allUnits: [] },
      derivedUnits: [],
    });
    reject(() => p.project("absent", sourceOrigin()));
  });
});

function derived(
  parentId: string,
  role = "clone",
  ordinal = 0,
  sourceId = "data-source",
  terminalOwnerId = "data-owner",
) {
  return {
    id: createDerivedIrUnitId({ parentId: parentId as never, role, ordinal }),
    parentId,
    role,
    ordinal,
    sourceId,
    terminalOwnerId,
  };
}
function lineage() {
  const f = data();
  const lifted = derived("data-owner", "lifted-closure"),
    cloned = derived(lifted.id);
  f.derivedUnits.push(lifted, cloned);
  f.inventory.allUnits.push({
    ...f.inventory.allUnits[0]!,
    id: "donor",
    kind: "arrow-function",
    lexicalOwnerId: "data-owner",
    terminal: false,
  });
  Object.assign(f.sourceMap, { derivedSources: [{ unitId: lifted.id, donorUnitId: "donor" }] });
  return { f, lifted, cloned };
}
function multiSource() {
  const f = data();
  f.sourceMap.sources.push({
    sourceId: "other-source",
    sourceKey: "other.ts",
    originalFileName: "other.ts",
    mapName: "other.ts",
    projection: { originalText: "other\n😀source", analyzedText: "other\n😀source", stages: [] },
  });
  f.inventory.sources.push({ id: "other-source", sourceKey: "other.ts", originalFileName: "other.ts" });
  f.inventory.allUnits.push({
    id: "other-owner",
    sourceId: "other-source",
    kind: "top-level-function",
    lexicalOwnerId: null,
    terminalOwnerId: "other-owner",
    terminal: true,
    declarationStart: 0,
    declarationEnd: 14,
  });
  // Exact string length is 14 UTF-16 units.
  return f;
}
describe("DATA explicit lineage, donor joins and function generated origins", () => {
  it("allows clones of lifted owners through the inherited donor grant", () => {
    const { f, lifted, cloned } = lineage(),
      p = factory()(f);
    const o = { kind: "source", point: point(2, 3, "data-source", "donor") };
    expect(p.project(lifted.id, o)).toEqual({ file: "data.ts", line: 0, column: 2 });
    expect(p.project(cloned.id, o)).toEqual({ file: "data.ts", line: 0, column: 2 });
    reject(() => p.project("data-owner", o));
    // A lexical child cannot donate to its parent without a lifting grant.
    reject(() => p.project("donor", sourceOrigin()));
  });
  it("accepts out-of-order explicit derived parents without guessing ID ancestry", () => {
    const f = data(),
      first = derived("data-owner"),
      second = derived(first.id);
    f.derivedUnits = [second, first];
    expect(factory()(f).project(second.id, sourceOrigin())).toEqual({ file: "data.ts", line: 0, column: 0 });
  });
  it.each([
    "id",
    "parent",
    "source",
    "terminal",
    "ordinal",
    "role",
    "collision",
    "grant-role",
    "grant-donor",
    "grant-chain",
    "grant-duplicate",
    "grant-order",
  ])("refuses invalid derived lineage/grant %s", (kind) => {
    const { f, lifted, cloned } = lineage();
    const grants = (f.sourceMap as typeof f.sourceMap & { derivedSources: { unitId: string; donorUnitId: string }[] })
      .derivedSources;
    if (kind === "id") lifted.id = "noncanonical" as never;
    if (kind === "parent") lifted.parentId = "missing";
    if (kind === "source") lifted.sourceId = "missing";
    if (kind === "terminal") lifted.terminalOwnerId = "missing";
    if (kind === "ordinal") lifted.ordinal = -1;
    if (kind === "role") lifted.role = "";
    if (kind === "collision") f.derivedUnits.push(clone(cloned));
    if (kind === "grant-role") grants[0]!.unitId = cloned.id;
    if (kind === "grant-donor") grants[0]!.donorUnitId = "data-owner";
    if (kind === "grant-chain") f.inventory.allUnits[1]!.lexicalOwnerId = "missing-class";
    if (kind === "grant-duplicate") grants.push(clone(grants[0]!));
    if (kind === "grant-order") {
      const next = derived("data-owner", "lifted-closure", 1);
      f.derivedUnits.push(next);
      grants.unshift({ unitId: next.id, donorUnitId: "donor" });
    }
    reject(() => factory()(f));
  });
  it("permits two lifted targets granting the same original donor", () => {
    const { f } = lineage(),
      next = derived("data-owner", "lifted-closure", 1);
    f.derivedUnits.push(next);
    (f.sourceMap as typeof f.sourceMap & { derivedSources: unknown[] }).derivedSources.push({
      unitId: next.id,
      donorUnitId: "donor",
    });
    expect(factory()(f).project(next.id, { kind: "source", point: point(0, 1, "data-source", "donor") })).toEqual({
      file: "data.ts",
      line: 0,
      column: 0,
    });
  });
  it("projects cross-source primary coordinates joined by the outermost inline owner", () => {
    const f = multiSource(),
      p = factory()(f);
    const primary = point(8, 9, "other-source", "other-owner"),
      frame = point(2, 3);
    const o = { kind: "source", point: primary, inlinedAt: [frame], contributors: [point(4, 5)] };
    expect(p.project("data-owner", o)).toEqual({ file: "other.ts", line: 1, column: 2 });
    reject(() => p.project("data-owner", { kind: "source", point: primary }));
    reject(() => p.project("other-owner", o));
    reject(() => p.project("data-owner", { ...o, contributors: [point(0, 1, "data-source", "other-owner")] }));
  });
  it("allows the same valid point in independent contributor and inline chains", () => {
    const p = factory()(multiSource()),
      frame = point(1, 2);
    expect(
      p.project("data-owner", {
        kind: "source",
        point: point(0, 1, "other-source", "other-owner"),
        inlinedAt: [frame],
        contributors: [clone(frame)],
      }),
    ).toEqual({ file: "other.ts", line: 0, column: 0 });
  });
  it("retains the narrow nonempty module-init declaration exception", () => {
    const f = data();
    Object.assign(f.inventory.allUnits[0]!, { kind: "module-init", declarationStart: 2, declarationEnd: 4 });
    const p = factory()(f);
    expect(p.project("data-owner", sourceOrigin(0, 1))).toEqual({ file: "data.ts", line: 0, column: 0 });
    reject(() => p.project("data-owner", sourceOrigin(0)));
    const ordinary = data();
    ordinary.inventory.allUnits[0]!.declarationStart = 2;
    reject(() => factory()(ordinary).project("data-owner", sourceOrigin(0, 1)));
  });
  it.each([
    ["frontend", "implicit-return"],
    ["frontend", "binding-scaffold"],
    ["frontend", "control-scaffold"],
    ["middleend", "cfg-scaffold"],
    ["middleend", "representation-scaffold"],
    ["async", "state-dispatch"],
    ["async", "frame-access"],
    ["async", "capability"],
    ["async", "continuation"],
    ["backend", "control-scaffold"],
    ["backend", "abi-scaffold"],
  ])("DATA function-owned generated %s/%s returns null after checking cause", (phase, role) => {
    const p = factory()(data()),
      o = { kind: "generated", phase, role, ownerUnitId: "data-owner", cause: point(1, 2) };
    expect(p.project("data-owner", o)).toBeNull();
    reject(() => p.project("data-owner", { ...o, cause: { ...point(), sourceId: "missing" } }));
    reject(() => p.project("data-owner", { ...o, ownerUnitId: "missing" }));
    reject(() => p.project("missing", o));
    reject(() => p.project("data-owner", { ...o, cause: undefined }));
    reject(() => p.project("data-owner", { ...o, role: "invented" }));
  });
  it("requires an original synthetic owner for frontend insertion", () => {
    const f = data(),
      owner = f.inventory.allUnits[0]!,
      d = derived(owner.id);
    f.derivedUnits.push(d);
    const o = { kind: "generated", phase: "frontend", role: "insertion", ownerUnitId: owner.id };
    reject(() => factory()(f).project(owner.id, o));
    Object.assign(owner, { syntheticRole: "compiler:insertion" });
    const p = factory()(f);
    expect(p.project(owner.id, o)).toBeNull();
    reject(() => p.project(d.id, { ...o, ownerUnitId: d.id }));
  });
  it.each([
    { kind: "generated", phase: "support", role: "runtime-body", bindingId: "binding" },
    { kind: "generated", phase: "startup", role: "adapter", sourceIds: ["data-source"] },
  ])("refuses %j without real corresponding physical issuer authority", (o) => {
    reject(() => factory()(data()).project("data-owner", o), /issuer|ownership|support|startup/);
  });
  it("measures finite requested construction and indexed point costs", () => {
    const text = "😀row\r\n".repeat(10000),
      f = data(text);
    const start = performance.now(),
      p = factory()(f),
      constructionMs = performance.now() - start;
    const begin = performance.now();
    let rows = 0;
    for (let i = 0; i < 20000; i++) {
      const offset = (i * 37) % (text.length + 1);
      const result = p.project("data-owner", sourceOrigin(offset)) as { line: number; column: number };
      // Independent arithmetic oracle for this regular seven-code-unit fixture.
      expect(result.line).toBe(Math.floor(offset / 7));
      expect(result.column).toBe(offset % 7);
      rows++;
    }
    const projectionMs = performance.now() - begin;
    expect(rows).toBe(20000);
    expect(Number.isFinite(constructionMs)).toBe(true);
    expect(Number.isFinite(projectionMs)).toBe(true);
    console.log(
      JSON.stringify({
        evidence: "DATA-requested-position-cost",
        utf16Units: text.length,
        lineCount: 10001,
        points: rows,
        constructionMs,
        projectionMs,
        microsecondsPerPoint: (projectionMs * 1000) / rows,
      }),
    );
  });
});
