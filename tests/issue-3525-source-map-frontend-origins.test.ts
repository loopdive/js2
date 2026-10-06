// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import ts from "typescript";
import { describe, expect, it } from "vitest";
import { analyzeMultiSource } from "../src/checker/index.js";
import {
  captureTypedIrProgramInput,
  prepareIrProgramSources,
  type IrProgramSourceInput,
  type IrProgramSourcePreparation,
  type IrSourceMapCaptureRequest,
} from "../src/ir/program-source.js";
import { forEachInstrDeep, type IrSiteId } from "../src/ir/nodes.js";
import type { IrPreparedSourceMap, IrSourceMapPoint } from "../src/shared/contracts/ir-unit-inventory.js";

// These are genuine text programs. The expected coordinates are retained from
// their original compiler-owned ASTs BEFORE invoking the producer under test.
const fixtures = [
  {
    name: "numeric multi-source and exact diagnostic operations",
    files: {
      "./base.ts": "export function twice(x: number): number { return x * 2; }",
      "./entry.ts":
        'import { twice } from "./base"; export function run(x: number): number { return Math.abs(twice(x)) + x ** 2; }',
    },
    causes: ["x * 2", "Math.abs(twice(x))", "x ** 2"],
  },
  {
    name: "control, discarded expressions and body buffers",
    files: {
      "./entry.ts":
        "export function run(x: number): number { let n: number = 0; x + 9; while (n < x) { n = n + 1; } if (n > 2) { return n; } return x; }",
    },
    causes: ["n < x", "n + 1", "n > 2"],
  },
  {
    name: "mutable captured parameter and nested arrows",
    files: {
      "./entry.ts":
        "export function run(x: number): number { x = x + 1; const next = (y: number): number => x + y; return next(2); }",
    },
    causes: ["x + 1", "x + y", "next(2)"],
  },
  {
    name: "default and destructured closure parameters",
    files: {
      "./entry.ts":
        "export function run(x: number): number { const next = (y: number = 3): number => x + y; return next(2); }",
    },
    causes: ["3", "x + y", "next(2)"],
  },
  {
    name: "computed object method key and its independent body donor",
    files: {
      "./entry.ts":
        'export function run(x: number): number { const obj = { ["read"](y: number): number { return x + y; } }; return obj.read(2); }',
    },
    causes: ['"read"', "x + y", "obj.read(2)"],
  },
  {
    name: "separate startup occurrences across an intervening function",
    files: {
      "./entry.ts": "let value: number = 1; export function read(): number { return value; } value = value * 10 + 3;",
    },
    causes: ["1", "value * 10", "value * 10 + 3"],
  },
] satisfies { name: string; files: Record<string, string>; causes: string[] }[];

type Mapped = IrProgramSourcePreparation & { readonly sourceMap?: IrPreparedSourceMap };
function original(files: Record<string, string>) {
  const ast = analyzeMultiSource(files, "./entry.ts");
  const spans = new Map<ts.SourceFile, Map<string, ts.Node[]>>();
  for (const file of ast.sourceFiles) {
    const points = new Map<string, ts.Node[]>();
    const visit = (node: ts.Node): void => {
      const key = `${node.getStart(file)}:${node.end}`;
      points.set(key, [...(points.get(key) ?? []), node]);
      ts.forEachChild(node, visit);
    };
    visit(file);
    spans.set(file, points);
  }
  const request: IrSourceMapCaptureRequest = {
    kind: "capture-source-map",
    sources: ast.sourceFiles.map((sourceFile) => ({
      sourceFile,
      projection: { originalText: sourceFile.text, analyzedText: sourceFile.text, stages: [] },
    })),
  };
  const input: IrProgramSourceInput & { sourceMap?: IrSourceMapCaptureRequest } = {
    sourceFiles: ast.sourceFiles,
    entrySource: ast.entryFile,
    checker: ast.checker,
    policy: { target: "host", backend: "wasmgc" },
    deferTopLevelInit: false,
  };
  return { ast, spans, request, input };
}
function success(result: ReturnType<typeof prepareIrProgramSources>): Mapped {
  expect(result.kind, result.kind === "prepared" ? undefined : result.detail).toBe("prepared");
  if (result.kind !== "prepared") throw new Error(result.detail);
  return result;
}
function withoutSites(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(withoutSites);
  if (value !== null && typeof value === "object")
    return Object.fromEntries(
      Object.entries(value)
        .filter(([key]) => key !== "site" && key !== "sourceMap" && key !== "sourceMapDerivedSources")
        .map(([key, item]) => [key, withoutSites(item)]),
    );
  return value;
}
function assertOwnedDataGraph(value: unknown, visited = new Set<object>()): void {
  expect(typeof value).not.toBe("function");
  expect(typeof value).not.toBe("symbol");
  if (value === null || typeof value !== "object" || visited.has(value)) return;
  visited.add(value);
  const prototype = Object.getPrototypeOf(value);
  expect([Object.prototype, null, Array.prototype, Map.prototype, Set.prototype]).toContain(prototype);
  if (prototype === Map.prototype) {
    for (const [key, item] of Map.prototype.entries.call(value)) {
      assertOwnedDataGraph(key, visited);
      assertOwnedDataGraph(item, visited);
    }
  } else if (prototype === Set.prototype) {
    for (const item of Set.prototype.values.call(value)) assertOwnedDataGraph(item, visited);
  }
  for (const key of Reflect.ownKeys(value)) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key)!;
    expect(Object.hasOwn(descriptor, "value")).toBe(true);
    assertOwnedDataGraph(descriptor.value, visited);
  }
}

function verify(fixture: (typeof fixtures)[number]) {
  const retained = original(fixture.files);
  const plain = success(prepareIrProgramSources(retained.input));
  expect(Object.hasOwn(plain, "sourceMap")).toBe(false);
  const mapped = success(
    prepareIrProgramSources({ ...retained.input, sourceMap: retained.request } as IrProgramSourceInput),
  );
  // A positive source preparation must carry the actual catalog: mere acceptance
  // of an ignored option cannot satisfy this test.
  expect(mapped.sourceMap).toBeDefined();
  const catalog = mapped.sourceMap!;
  expect(catalog.sources).toHaveLength(retained.ast.sourceFiles.length);
  expect(withoutSites(mapped.ir)).toEqual(withoutSites(plain.ir));
  expect(mapped.inventory).toEqual(plain.inventory);
  expect(mapped.startup).toEqual(plain.startup);
  expect(mapped.derivedUnits).toEqual(plain.derivedUnits);
  const semanticAllocations = (snapshot: ReturnType<typeof mapped.allocations.snapshot>) => ({
    ...snapshot,
    entries: snapshot.entries.map((row) =>
      row.state === "live"
        ? { ...row, site: Object.fromEntries(Object.entries(row.site).filter(([key]) => key !== "origin")) }
        : row,
    ),
  });
  expect(semanticAllocations(mapped.allocations.snapshot())).toEqual(semanticAllocations(plain.allocations.snapshot()));
  const sourceRows = new Map(catalog.sources.map((row) => [row.sourceId, row]));
  const sourceFiles = new Map(
    mapped.inventory.sources.map((row) => [
      row.id,
      retained.ast.sourceFiles.find((file) => file.fileName === row.originalFileName)!,
    ]),
  );
  const counts = {
    sources: catalog.sources.length,
    terminals: mapped.inventory.terminalUnits.length,
    derived: mapped.derivedUnits.length,
    functions: mapped.ir.functions.length,
    blocks: 0,
    instructions: 0,
    nested: 0,
    terminators: 0,
    registry: mapped.allocations.snapshot().size,
    source: 0,
    generated: 0,
    unmapped: 0,
  };
  const observed = new Set<string>();
  const point = (value: IrSourceMapPoint): void => {
    const file = sourceFiles.get(value.sourceId)!;
    expect(file).toBeDefined();
    const nodes = retained.spans.get(file)!.get(`${value.analyzed.start}:${value.analyzed.end}`);
    expect(nodes, JSON.stringify(value)).toBeDefined();
    expect(value.original).toEqual(value.analyzed);
    expect(value.mapping).toBe("exact");
    expect(sourceRows.get(value.sourceId)!.projection.originalText).toBe(file.text);
    const donor = mapped.inventory.allUnits.find((unit) => unit.id === value.donorUnitId);
    expect(donor).toBeDefined();
    expect(donor!.sourceId).toBe(value.sourceId);
    const owners = nodes!.map((node) => {
      for (let current: ts.Node | undefined = node; current; current = current.parent) {
        if (ts.isFunctionLike(current))
          return mapped.inventory.allUnits.find(
            (unit) =>
              unit.sourceId === value.sourceId &&
              unit.declarationStart === current!.getStart(file) &&
              unit.declarationEnd === current!.end,
          )?.id;
      }
      return mapped.inventory.allUnits.find((unit) => unit.sourceId === value.sourceId && unit.kind === "module-init")
        ?.id;
    });
    expect(
      owners,
      `independent lexical donors for ${file.text.slice(value.analyzed.start, value.analyzed.end)}`,
    ).toContain(value.donorUnitId);
    observed.add(file.text.slice(value.analyzed.start, value.analyzed.end));
  };
  const site = (value: IrSiteId | undefined, owner: string): void => {
    if (!value?.origin) {
      counts.unmapped++;
      throw new Error(`missing actual origin in ${owner}`);
    }
    if (value.origin.kind === "source") {
      counts.source++;
      point(value.origin.point);
      const file = sourceFiles.get(value.origin.point.sourceId)!;
      const position = file.getLineAndCharacterOfPosition(value.origin.point.analyzed.start);
      expect([value.line, value.column]).toEqual([position.line + 1, position.character]);
    } else {
      counts.generated++;
      expect(value.origin.phase).toBe("frontend");
      if ("ownerUnitId" in value.origin) expect(value.origin.ownerUnitId).toBe(owner);
      if ("cause" in value.origin && value.origin.cause) point(value.origin.cause);
      expect(Object.hasOwn(value, "line")).toBe(false);
      expect(Object.hasOwn(value, "column")).toBe(false);
    }
  };
  const allocations = mapped.allocations.snapshot();
  for (const fn of mapped.ir.functions)
    for (const block of fn.blocks) {
      counts.blocks++;
      counts.terminators++;
      site(block.terminator.site, fn.unitId);
      for (const instr of block.instrs) {
        counts.instructions++;
        forEachInstrDeep(instr, (item) => {
          if (item !== instr) counts.nested++;
          site(item.site, fn.unitId);
          if (item.alloc !== undefined) {
            const row = allocations.entries[item.alloc];
            expect(row.state).toBe("live");
            if (row.state === "live") expect(row.site.origin).toEqual(item.site);
          }
        });
      }
    }
  expect(counts.instructions).toBeGreaterThan(0);
  expect(counts.source).toBeGreaterThan(0);
  expect(counts.unmapped).toBe(0);
  for (const cause of fixture.causes) expect(observed, `missing exact causal syntax ${cause}`).toContain(cause);
  const typed = captureTypedIrProgramInput(mapped);
  expect(typed.sourceMap).toEqual(catalog);
  expect(Object.hasOwn(captureTypedIrProgramInput(plain), "sourceMap")).toBe(false);
  // IR includes BigInt and collection data; plain JSON is only its catalog format.
  assertOwnedDataGraph(typed);
  const serialized = JSON.stringify(typed.sourceMap);
  expect(JSON.parse(serialized)).toEqual(catalog);
  expect(serialized).not.toContain('"sourceFile"');
  console.info("B3 genuine frontend population", fixture.name, JSON.stringify(counts), JSON.stringify(fixture.causes));
  return retained;
}

describe("B3 genuine source-produced frontend origins", () => {
  for (const fixture of fixtures)
    it(fixture.name, () => {
      if (fixture === fixtures[2] || fixture === fixtures[4]) {
        const retained = original(fixture.files);
        const plain = prepareIrProgramSources(retained.input);
        expect(plain.kind).toBe("unsupported");
        if (plain.kind === "prepared") throw new Error("original refusal disappeared");
        expect(plain.detail).toContain(
          fixture === fixtures[2] ? 'captures non-local binding "x"' : "object method name not in prepared scope",
        );
        expect(
          prepareIrProgramSources({ ...retained.input, sourceMap: retained.request } as IrProgramSourceInput),
        ).toEqual(plain);
        console.info("B3 retained semantic refusal", fixture.name, JSON.stringify(plain));
      } else verify(fixture);
    });
  it("immutable capture allocation retains exact source registry origins", () =>
    verify({
      name: "immutable capture allocation",
      files: {
        "./entry.ts":
          "export function run(x: number): number { const n: number = x + 1; const next = (y: number): number => n + y; return next(2); }",
      },
      causes: ["x + 1", "n + y", "next(2)"],
    }));
  it("rejects mismatched actual source text between healthy genuine captures", () => {
    const fixture = fixtures[0];
    const retained = verify(fixture);
    const bad = {
      ...retained.request,
      sources: retained.request.sources.map((row, index) =>
        index === 0
          ? { ...row, projection: { ...row.projection, analyzedText: row.projection.analyzedText + " " } }
          : row,
      ),
    };
    expect(() => prepareIrProgramSources({ ...retained.input, sourceMap: bad } as IrProgramSourceInput)).toThrow();
    verify(fixture);
  });
  it("preserves genuine unsupported object global storage with and without mapping", () => {
    const retained = original({ "./entry.ts": "export let object: object = {};" });
    const plain = prepareIrProgramSources(retained.input);
    const mapped = prepareIrProgramSources({ ...retained.input, sourceMap: retained.request } as IrProgramSourceInput);
    expect(plain.kind).toBe("unsupported");
    expect(mapped).toEqual(plain);
    console.info("B3 retained semantic refusal", JSON.stringify(plain));
  });
});
