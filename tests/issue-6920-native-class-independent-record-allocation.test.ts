// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import type { IrBindingId } from "../src/shared/contracts/ir-identity.js";
import { expect, it } from "vitest";
import { setImmediate as yieldTurn } from "node:timers/promises";
import {
  known,
  mergeCell,
  storeCell,
  mergeGlobal,
  joinWorld,
  worldData,
  flowData,
  equationSame,
  BOTTOM,
  stable,
  type Flow,
} from "../src/ir/analysis/allocation-evidence/js-class-value-domains/independent-kernel.js";
import type { NativeJsClassValueDomainHeapCell as Cell } from "../src/ir/analysis/allocation-evidence/js-class-value-domains/contracts.js";
import { analyzeMultiSource } from "../src/checker/index.js";
import { prepareWholeIrProgram } from "../src/ir/program-preparation.js";
import { normalizeNativeClassValues } from "../src/ir/program/native-js-class-values.js";
import { analyzeNativeJsClassValueDomains } from "../src/ir/analysis/allocation-evidence/js-class-value-domains/producer.js";
import { replayNativeJsClassValueDomains } from "../src/ir/analysis/allocation-evidence/js-class-value-domains/independent.js";
import { assertPreparedIrData, preparedIrDataMismatch } from "../src/shared/contracts/prepared-ir-data.js";
it("preserves kernel domain/cell/global/world/flow ordinary records and exact DATA descriptors", () => {
  const domain = known(["Number"]),
    root = { kind: "external" as const, bindingId: "test" as IrBindingId };
  const flow: Flow = {
    alive: true,
    values: new Map([[0, domain]]),
    slots: new Map(),
    globals: new Map(),
    heap: new Map(),
    roots: new Set([stable(root)]),
  };
  const cell: Cell = {
    root,
    key: { kind: "literal", value: "x" },
    presence: "present",
    valueDomain: domain,
    prototypeRoots: [],
  };
  storeCell(flow, cell.root, cell.key, domain);
  const merged = mergeCell(cell, cell),
    global = mergeGlobal(
      { bindingId: root.bindingId, initialization: "initialized", domain },
      { bindingId: root.bindingId, initialization: "initialized", domain },
    );
  const records = [domain, merged, global, worldData(flow), flowData(flow)];
  for (const record of records) {
    expect(Object.getPrototypeOf(record)).toBe(Object.prototype);
    for (const d of Object.values(Object.getOwnPropertyDescriptors(record)))
      expect([d.writable, d.enumerable, d.configurable]).toEqual([true, true, true]);
    assertPreparedIrData(record);
  }
  const absent = joinWorld({ ...flow, heap: new Map() }, flow);
  expect([...absent.heap.values()][0]!.presence).toBe("maybe");
  expect(
    equationSame(
      { kind: "known", families: ["Number", "Undefined"], roots: [] },
      { kind: "known", families: ["Undefined", "Number"], roots: [] },
    ),
  ).toBe(true);
  expect(preparedIrDataMismatch(domain, { kind: "known", families: ["Number"], roots: [] })).toBeUndefined();
  expect(BOTTOM.kind).toBe("bottom");
});
it("does not turn fresh kernel records into cached semantic validation", () => {
  const result = known(["Number"]);
  assertPreparedIrData(result);
  let reads = 0;
  Object.defineProperty(result, "bad", {
    get() {
      reads++;
      return 1;
    },
  });
  expect(() => assertPreparedIrData(result)).toThrow();
  expect(reads).toBe(0);
});
it("replays actual original-source constructor equations with nonempty independent populations", async () => {
  await yieldTurn();
  const policy = { backend: "wasmgc" as const, target: "standalone" as const },
    ast = analyzeMultiSource(
      { "./entry.ts": "class A{constructor(){}}export function run():number{new A();return 1;}" },
      "./entry.ts",
    );
  const prepared = prepareWholeIrProgram({
    sourceFiles: ast.sourceFiles,
    entrySource: ast.entryFile,
    checker: ast.checker,
    policy,
    runtimePolicies: [policy],
    deferTopLevelInit: false,
    linearVectorProjection: "native-f64",
  });
  if (prepared.kind !== "prepared") throw Error(JSON.stringify(prepared));
  const normalized = normalizeNativeClassValues(prepared.program, prepared.program.ir, "original");
  if (normalized.kind !== "normalized") throw Error(JSON.stringify(normalized));
  const result = analyzeNativeJsClassValueDomains(normalized.input);
  expect(result).toBeDefined();
  expect(normalized.input.module.functions.length).toBeGreaterThan(2);
  expect(replayNativeJsClassValueDomains(normalized.input, result)).toEqual([]);
  expect(equationSame(result, result)).toBe(true);
  await yieldTurn();
}, 35000);
it("retains spread enumeration/getter-once and override own-definition semantics", () => {
  const root = { kind: "external" as const, bindingId: "spread" as IrBindingId },
    domain = known(["Number"]);
  const before: Cell = {
    root,
    key: { kind: "literal", value: "x" },
    presence: "present",
    valueDomain: domain,
    prototypeRoots: [],
  };
  const after = { ...before },
    symbol = Symbol("extension");
  let reads = 0,
    setters = 0;
  Object.defineProperty(after, "extension", {
    enumerable: true,
    get() {
      reads++;
      return 7;
    },
  });
  Object.defineProperty(after, symbol, { enumerable: true, value: domain });
  const old = Object.getOwnPropertyDescriptor(Object.prototype, "presence");
  let result: Cell | undefined;
  try {
    Object.defineProperty(Object.prototype, "presence", {
      set() {
        setters++;
      },
      configurable: true,
    });
    result = mergeCell(before, after);
  } finally {
    if (old) Object.defineProperty(Object.prototype, "presence", old);
    else Reflect.deleteProperty(Object.prototype, "presence");
  }
  expect(reads).toBe(1);
  expect(setters).toBe(0);
  expect(Object.getOwnPropertyDescriptor(result!, "extension")).toEqual({
    value: 7,
    writable: true,
    enumerable: true,
    configurable: true,
  });
  expect(Reflect.get(result!, symbol)).toBe(domain);
  expect(result!.presence).toBe("present");
});

// These controls exercise computational World algebra, never a fabricated ReplayModel or physical proof.
import {
  canOmitNormalizedWorldJoin,
  cellKey,
  type World,
} from "../src/ir/analysis/allocation-evidence/js-class-value-domains/independent-kernel.js";
import { prepareIrProgramSources, captureTypedIrProgramInput } from "../src/ir/program-source.js";
import { prepareIrProgramAbiEntries } from "../src/ir/program-abi-contracts.js";
import { irBindingKey } from "../src/ir/core/declared-types.js";
import { asAllocSiteId } from "../src/ir/core/nodes.js";
import type {
  NativeJsValueDomain as Domain,
  NativeJsValueRoot as Root,
} from "../src/ir/analysis/allocation-evidence/js-class-value-domains/contracts.js";
const observationPolicies = [
  { backend: "wasmgc", target: "standalone" },
  { backend: "wasmgc", target: "wasi" },
  { backend: "linear", target: "standalone" },
  { backend: "linear", target: "wasi" },
] as const;
const observationSources = [
  ["healthy", "class C{static m(){return 1;}}export function run(){C.m();return 7;}"],
  [
    "replacement",
    "class C{static m(){return 1;}}class D{static n(){return true;}}export function mutate(){C.m=D.n;return 0;}export function run(){return C.m()===true?1:0;}",
  ],
  [
    "abrupt",
    "class C{static m(){return 1;}}function write(){C.m=3;throw 7;}export function mutate(){write();return 0;}export function run(){C.m();return 7;}",
  ],
] as const;
function observationInput(text: string, policy: (typeof observationPolicies)[number]) {
  const ast = analyzeMultiSource({ "./entry.ts": text }, "./entry.ts");
  const result = prepareIrProgramSources({
    sourceFiles: ast.sourceFiles,
    entrySource: ast.entryFile,
    checker: ast.checker,
    policy,
    runtimePolicies: [policy],
    deferTopLevelInit: false,
    linearVectorProjection: "native-f64",
  });
  if (result.kind !== "prepared") throw Error(JSON.stringify(result));
  const typed = captureTypedIrProgramInput(result);
  const context = { ...typed, abi: { entries: prepareIrProgramAbiEntries(typed) } };
  const normalized = normalizeNativeClassValues(context, context.ir, "original");
  if (normalized.kind !== "normalized") throw Error(JSON.stringify(normalized));
  return normalized.input;
}
function observationWorld() {
  const input = observationInput(observationSources[1][1], observationPolicies[0]);
  const report = analyzeNativeJsClassValueDomains(input);
  expect(replayNativeJsClassValueDomains(input, report)).toEqual([]);
  const domain = report.calls
    .map((call) => call.calleeDomain)
    .find((value): value is Extract<Domain, { kind: "known" }> => value.kind === "known" && value.roots.length > 1);
  if (!domain) throw Error("missing actual replacement callable roots");
  const cell = report.heap.find((value) => value.prototypeRoots.length > 0);
  const global = report.globals.find((value) => value.domain.kind === "known");
  if (!cell || !global) throw Error("missing actual heap/global populations");
  expect(new Set(domain.roots.map(stable)).size).toBe(domain.roots.length);
  const canonicalCell: Cell = { ...cell, valueDomain: domain, prototypeRoots: domain.roots };
  const world: World = {
    globals: new Map(report.globals.map((value) => [value.bindingId, value])),
    heap: new Map(report.heap.map((value) => [cellKey(value.root, value.key), value])),
    roots: new Set(report.heap.map((value) => stable(value.root))),
  };
  world.heap.set(cellKey(cell.root, cell.key), canonicalCell);
  domain.roots.forEach((value) => world.roots.add(stable(value)));
  expect(world.globals.size).toBeGreaterThan(1);
  expect(world.heap.size).toBeGreaterThan(1);
  return { world, cell: canonicalCell, global, domain, input };
}
function replaceObservationCell(world: World, cell: Cell): World {
  const heap = new Map(world.heap);
  const key = [...heap].find(([, value]) => value.prototypeRoots.length > 1)?.[0];
  if (!key) throw Error("missing computational prototype pair");
  heap.set(key, cell);
  return { ...world, heap };
}
it("omits only normalized equal computational worlds without changing the old self-join", () => {
  const { world } = observationWorld();
  const incoming: World = {
    globals: new Map([...world.globals].reverse()),
    heap: new Map([...world.heap].reverse()),
    roots: new Set([...world.roots].reverse()),
  };
  expect(incoming).not.toBe(world);
  expect(incoming.roots.size).toBeGreaterThan(1);
  expect(canOmitNormalizedWorldJoin(world, incoming)).toBe(true);
  expect(preparedIrDataMismatch(worldData(world), worldData(joinWorld(world, incoming)))).toBeUndefined();
  expect(canOmitNormalizedWorldJoin(world, world)).toBe(true);
});
it("retains self-join normalization for noncanonical families, roots and prototype links", () => {
  const { world, cell, domain } = observationWorld();
  const pair = known(["Number", "Undefined"], domain.roots);
  if (pair.kind !== "known") throw Error("missing known computational pair");
  const domains: Domain[] = [
    { ...pair, families: [] },
    { ...pair, families: ["Number", "Number", "Undefined"] },
    { ...pair, families: ["Undefined", "Number"] },
    { ...pair, roots: [...pair.roots, pair.roots[0]!] },
    { ...pair, roots: [...pair.roots].reverse() },
  ];
  for (const malformed of domains) {
    const candidate = replaceObservationCell(world, { ...cell, valueDomain: malformed });
    expect(preparedIrDataMismatch(candidate, candidate)).toBeUndefined();
    expect(canOmitNormalizedWorldJoin(candidate, candidate)).toBe(false);
    expect(preparedIrDataMismatch(worldData(candidate), worldData(joinWorld(candidate, candidate)))).toBeDefined();
  }
  for (const prototypes of [[...domain.roots, domain.roots[0]!], [...domain.roots].reverse()]) {
    const candidate = replaceObservationCell(world, { ...cell, prototypeRoots: prototypes });
    expect(prototypes).not.toEqual(cell.prototypeRoots);
    expect(canOmitNormalizedWorldJoin(candidate, candidate)).toBe(false);
    expect(preparedIrDataMismatch(worldData(candidate), worldData(joinWorld(candidate, candidate)))).toBeDefined();
  }
});
it("keeps missing cells, populations, initialization and every actual root coordinate load-bearing", () => {
  const { world, cell, global, input } = observationWorld();
  const root = cell.root;
  if (!root || root.kind !== "allocation") throw Error("missing genuine allocation root");
  const otherUnit = input.units.find((value) => value.unitId !== root.unitId);
  if (!otherUnit) throw Error("missing genuine other unit coordinate");
  const changedRoots: readonly (readonly [keyof typeof root, typeof root])[] = [
    ["site", { ...root, site: asAllocSiteId(root.site + 1) }],
    ["definitionId", { ...root, definitionId: root.definitionId === null ? global.bindingId : null }],
    ["memberOrdinal", { ...root, memberOrdinal: root.memberOrdinal === null ? 0 : null }],
    ["view", { ...root, view: root.view === "constructor" ? "prototype" : "constructor" }],
    ["unitId", { ...root, unitId: otherUnit.unitId }],
  ];
  for (const [field, changed] of changedRoots)
    expect(Object.keys(root).filter((key) => !Object.is(Reflect.get(root, key), Reflect.get(changed, key)))).toEqual([
      field,
    ]);
  const changedCells: readonly (readonly [Cell, boolean])[] = [
    [{ ...cell, presence: cell.presence === "present" ? "absent" : "present" }, cell.presence === "maybe"],
    [{ ...cell, key: { kind: "wildcard" } }, false],
    [{ ...cell, valueDomain: BOTTOM }, true],
    [{ ...cell, prototypeRoots: [] }, true],
    ...changedRoots.map(([, value]) => [{ ...cell, root: value }, false] as const),
  ];
  for (const [changed, expected] of changedCells) {
    expect(preparedIrDataMismatch(cell, changed)).toBeDefined();
    const incoming = replaceObservationCell(world, changed);
    expect(preparedIrDataMismatch(worldData(world), worldData(joinWorld(world, incoming))) === undefined).toBe(
      expected,
    );
    expect(canOmitNormalizedWorldJoin(world, incoming)).toBe(expected);
  }
  const globalChange: World = { ...world, globals: new Map(world.globals) };
  globalChange.globals.set(global.bindingId, {
    ...global,
    initialization: global.initialization === "uninitialized" ? "initialized" : "uninitialized",
  });
  const domainChange: World = { ...world, globals: new Map(world.globals) };
  domainChange.globals.set(global.bindingId, { ...global, domain: BOTTOM });
  expect(globalChange.globals.size).toBe(world.globals.size);
  expect(domainChange.globals.size).toBe(world.globals.size);
  const renamedHeap = new Map(world.heap);
  const actualKey = [...renamedHeap].find(([, value]) => value === cell)![0];
  expect(renamedHeap.has(actualKey + "-changed")).toBe(false);
  expect(renamedHeap.delete(actualKey)).toBe(true);
  renamedHeap.set(actualKey + "-changed", cell);
  expect(renamedHeap.size).toBe(world.heap.size);
  const orderedCells = (heap: World["heap"]) =>
    [...heap].sort(([a], [b]) => a.localeCompare(b)).map(([, value]) => value);
  const oldOrder = orderedCells(world.heap),
    newOrder = orderedCells(renamedHeap);
  expect(newOrder.length).toBe(oldOrder.length);
  newOrder.forEach((value, index) => expect(value).toBe(oldOrder[index]));
  for (const [key, value] of world.heap)
    expect(renamedHeap.get(key === actualKey ? actualKey + "-changed" : key)).toBe(value);
  const changedWorlds: readonly (readonly [World, boolean])[] = [
    [globalChange, global.initialization === "maybe"],
    [domainChange, true],
    [{ ...world, heap: new Map() }, [...world.heap.values()].every((value) => value.presence !== "present")],
    [{ ...world, globals: new Map() }, true],
    [{ ...world, roots: new Set<string>() }, true],
    [{ ...world, heap: renamedHeap }, false],
  ];
  for (const [changed, expected] of changedWorlds) {
    expect(preparedIrDataMismatch(worldData(world), worldData(changed))).toBeDefined();
    expect(preparedIrDataMismatch(worldData(world), worldData(joinWorld(world, changed))) === undefined).toBe(expected);
    expect(canOmitNormalizedWorldJoin(world, changed)).toBe(expected);
  }
  const positiveZero = replaceObservationCell(world, { ...cell, root: { ...root, site: asAllocSiteId(0) } });
  const negativeZero = replaceObservationCell(world, { ...cell, root: { ...root, site: asAllocSiteId(-0) } });
  const actualCellKey = [...world.heap].find(([, value]) => value === cell)![0];
  const zeroRoot = positiveZero.heap.get(actualCellKey)!.root;
  expect(zeroRoot.kind === "allocation" && Object.is(zeroRoot.site, 0)).toBe(true);
  expect(
    preparedIrDataMismatch(worldData(positiveZero), worldData(joinWorld(positiveZero, negativeZero))),
  ).toBeDefined();
  expect(canOmitNormalizedWorldJoin(positiveZero, negativeZero)).toBe(false);
});
for (const policy of observationPolicies)
  for (const [name, text] of observationSources)
    it(`${policy.backend}:${policy.target} observation gate preserves genuine ${name} public histories`, async () => {
      await yieldTurn();
      const input = observationInput(text, policy),
        report = analyzeNativeJsClassValueDomains(input);
      expect(input.definitions.length).toBeGreaterThan(0);
      expect(report.calls.length).toBeGreaterThan(0);
      expect(report.heap.length).toBeGreaterThan(0);
      expect(report.globals.length).toBeGreaterThan(0);
      expect(replayNativeJsClassValueDomains(input, report)).toEqual([]);
      const exported = input.exports.find((value) => value.externalName === "run");
      if (!exported) throw Error("missing genuine public run");
      const unit = input.units.find(
        (value) => irBindingKey(value.target.binding) === irBindingKey(exported.target.binding),
      );
      if (!unit) throw Error("missing genuine run unit");
      const call = report.calls.find((value) => value.location.unitId === unit.unitId && value.kind === "invoke");
      if (!call) throw Error("missing genuine run invoke");
      if (name === "healthy") {
        expect(call.targets).toHaveLength(1);
        expect(call.calleeDomain).toMatchObject({ kind: "known", families: ["Function"] });
        expect(call.normalDomain).toMatchObject({ kind: "known", families: ["Number"] });
      } else if (name === "replacement") {
        expect(call.targets).toHaveLength(2);
        expect(call.normalDomain).toMatchObject({ kind: "known", families: ["Number", "Boolean"] });
      } else {
        expect(call.calleeDomain).toEqual({ kind: "unknown" });
        expect(call.mayThrow).toBe(true);
        expect(report.projections.find((value) => value.externalName === "run")?.decision).toBe("unknown");
        expect(report.functions.some((value) => value.mayThrow && !value.normalCompletion)).toBe(true);
      }
      const forged = structuredClone(report);
      const index = forged.calls.findIndex((value) => value.location === call.location);
      const actualIndex = report.calls.indexOf(call);
      expect(index).toBe(-1); // A clone must not accidentally rely on caller object identity.
      const original = forged.calls[actualIndex]!;
      (forged.calls as (typeof original)[])[actualIndex] = { ...original, mayThrow: !original.mayThrow };
      expect(forged.calls[actualIndex]!.mayThrow).not.toBe(call.mayThrow);
      expect(replayNativeJsClassValueDomains(input, forged).some((value) => value.reason === "equation")).toBe(true);
      await yieldTurn();
    }, 35000);

it("retains exact duplicate detection across distinct locale-collating root keys", () => {
  const { world, cell, input } = observationWorld();
  const report = analyzeNativeJsClassValueDomains(input);
  const external = report.heap.flatMap((value) => value.prototypeRoots).find((root) => root.kind === "external");
  if (!external || external.kind !== "external") throw Error("missing genuine external root seed");
  // Derived coordinates test helper math only; neither root is supplied to a solver or physical validator.
  const left = { ...external, bindingId: (external.bindingId + "é") as IrBindingId };
  const right = { ...external, bindingId: (external.bindingId + "e\u0301") as IrBindingId };
  expect(stable(left)).not.toBe(stable(right));
  expect(stable(left).localeCompare(stable(right))).toBe(0);
  const distinct = replaceObservationCell(world, {
    ...cell,
    valueDomain: { kind: "known", families: ["Function"], roots: [left, right] },
    prototypeRoots: [left, right],
  });
  expect(canOmitNormalizedWorldJoin(distinct, distinct)).toBe(true);
  const duplicate = replaceObservationCell(world, {
    ...cell,
    valueDomain: { kind: "known", families: ["Function"], roots: [left, right, left] },
    prototypeRoots: [left, right, left],
  });
  expect(canOmitNormalizedWorldJoin(duplicate, duplicate)).toBe(false);
  expect(preparedIrDataMismatch(worldData(duplicate), worldData(joinWorld(duplicate, duplicate)))).toBeDefined();
});
