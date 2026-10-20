// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
// World records below test computational algebra only: no ReplayModel, prepared authority or engine proof.
import { afterEach, expect, it } from "vitest";
import { setImmediate } from "node:timers/promises";
import { analyzeMultiSource } from "../src/checker/index.js";
import { captureTypedIrProgramInput, prepareIrProgramSources } from "../src/ir/program-source.js";
import { prepareIrProgramAbiEntries } from "../src/ir/program-abi-contracts.js";
import { normalizeNativeClassValues } from "../src/ir/program/native-js-class-values.js";
import { analyzeNativeJsClassValueDomains } from "../src/ir/analysis/allocation-evidence/js-class-value-domains/producer.js";
import { replayNativeJsClassValueDomains } from "../src/ir/analysis/allocation-evidence/js-class-value-domains/independent.js";
import {
  BOTTOM,
  UNKNOWN,
  known,
  stable,
  cellKey,
  joinWorld,
  worldData,
  canOmitNormalizedWorldJoin,
  type World,
  type GlobalState,
} from "../src/ir/analysis/allocation-evidence/js-class-value-domains/independent-kernel.js";
import type {
  NativeJsValueDomain as Domain,
  NativeJsClassValueDomainHeapCell as Cell,
} from "../src/ir/analysis/allocation-evidence/js-class-value-domains/contracts.js";
import { preparedIrDataMismatch } from "../src/shared/contracts/prepared-ir-data.js";
import { asAllocSiteId } from "../src/ir/core/nodes.js";
import type { IrBindingId } from "../src/shared/contracts/ir-identity.js";
afterEach(() => setImmediate());
function fixture() {
  const policy = { backend: "wasmgc", target: "standalone" } as const;
  const text =
    "class C{static m(){return 1;}}class D{static n(){return true;}}export function mutate(){C.m=D.n;return 0;}export function run(){return C.m()===true?1:0;}";
  const ast = analyzeMultiSource({ "./entry.ts": text }, "./entry.ts");
  const prepared = prepareIrProgramSources({
    sourceFiles: ast.sourceFiles,
    entrySource: ast.entryFile,
    checker: ast.checker,
    policy,
    runtimePolicies: [policy],
    deferTopLevelInit: false,
    linearVectorProjection: "native-f64",
  });
  if (prepared.kind !== "prepared") throw Error(JSON.stringify(prepared));
  const typed = captureTypedIrProgramInput(prepared);
  const context = { ...typed, abi: { entries: prepareIrProgramAbiEntries(typed) } };
  const normalized = normalizeNativeClassValues(context, context.ir, "original");
  if (normalized.kind !== "normalized") throw Error(JSON.stringify(normalized));
  const report = analyzeNativeJsClassValueDomains(normalized.input);
  expect(replayNativeJsClassValueDomains(normalized.input, report)).toEqual([]);
  const domain = report.calls
    .map((row) => row.calleeDomain)
    .find((value): value is Extract<Domain, { kind: "known" }> => value.kind === "known" && value.roots.length > 1);
  const cell = report.heap.find((row) => row.root.kind === "allocation" && row.prototypeRoots.length > 0);
  const global = report.globals.find((row) => row.domain.kind === "known");
  const external = report.heap.flatMap((row) => row.prototypeRoots).find((root) => root.kind === "external");
  if (!domain || !cell || !global || !external) throw Error("missing genuine callable/global/prototype populations");
  expect(report.calls.some((row) => row.kind === "invoke" && row.targets.length === 2)).toBe(true);
  const row: Cell = { ...cell, presence: "maybe", valueDomain: domain, prototypeRoots: domain.roots };
  const world: World = {
    globals: new Map([[global.bindingId, { ...global, initialization: "maybe" }]]),
    heap: new Map([[cellKey(cell.root, cell.key), row]]),
    roots: new Set([stable(cell.root), ...domain.roots.map(stable)]),
  };
  return { world, cell: row, global: world.globals.get(global.bindingId)!, domain, external, input: normalized.input };
}
function withCell(world: World, patch: Partial<Cell>): World {
  const [key, row] = [...world.heap][0]!;
  return { ...world, heap: new Map([[key, { ...row, ...patch }]]) };
}
function withGlobal(world: World, patch: Partial<GlobalState>): World {
  const [key, row] = [...world.globals][0]!;
  return { ...world, globals: new Map([[key, { ...row, ...patch }]]) };
}
function check(before: World, incoming: World, expected: boolean, oldJoinChanges = !expected) {
  const original = worldData(before),
    input = worldData(incoming);
  const joined = worldData(joinWorld(before, incoming));
  expect(preparedIrDataMismatch(original, joined) !== undefined).toBe(oldJoinChanges);
  expect(canOmitNormalizedWorldJoin(before, incoming)).toBe(expected);
  expect(preparedIrDataMismatch(original, worldData(before))).toBeUndefined();
  expect(preparedIrDataMismatch(input, worldData(incoming))).toBeUndefined();
}
it("absorbs equal canonical worlds and strictly smaller actual domain/map/root populations", () => {
  const { world, cell, global, domain } = fixture();
  check(world, world, true);
  const incoming: World = { globals: new Map(), heap: new Map(), roots: new Set() };
  expect(preparedIrDataMismatch(worldData(world), worldData(incoming))).toBeDefined();
  check(world, incoming, true);
  const subset = withCell(world, {
    presence: "present",
    valueDomain: known(["Function"], [domain.roots[0]!]),
    prototypeRoots: [domain.roots[0]!],
  });
  const smaller = withGlobal(subset, { initialization: "initialized", domain: BOTTOM });
  smaller.roots = new Set([stable(cell.root)]);
  expect(smaller.roots.size).toBeLessThan(world.roots.size);
  expect(smaller.globals.get(global.bindingId)!.domain).toBe(BOTTOM);
  check(world, smaller, true);
});
it("checks the missing-cell observed-root branch for every presence state", () => {
  const { world, cell } = fixture();
  for (const presence of ["present", "absent", "maybe"] as const) {
    const before = withCell(world, { presence });
    const observed = { ...before, heap: new Map(), roots: new Set([stable(cell.root)]) };
    expect(observed.roots.has(stable(cell.root))).toBe(true);
    expect(observed.heap.size).toBe(0);
    check(before, observed, presence !== "present");
    check(before, { ...observed, roots: new Set() }, true);
    if (presence === "present") expect([...joinWorld(before, observed).heap.values()][0]!.presence).toBe("maybe");
  }
});
it("preserves all asymmetric initialization and overlap-presence joins", () => {
  const { world } = fixture();
  for (const before of ["uninitialized", "initialized", "maybe"] as const)
    for (const incoming of ["uninitialized", "initialized", "maybe"] as const)
      check(
        withGlobal(world, { initialization: before }),
        withGlobal(world, { initialization: incoming }),
        before === incoming || before === "maybe",
      );
  for (const before of ["absent", "present", "maybe"] as const)
    for (const incoming of ["absent", "present", "maybe"] as const)
      check(
        withCell(world, { presence: before }),
        withCell(world, { presence: incoming }),
        before === incoming || before === "maybe",
      );
});
it("covers UNKNOWN BOTTOM and known family union without annotation inference", () => {
  const { world } = fixture();
  const number = known(["Number"]),
    boolean = known(["Boolean"]),
    both = known(["Number", "Boolean"]);
  for (const incoming of [UNKNOWN, BOTTOM, number, both])
    check(withGlobal(world, { domain: UNKNOWN }), withGlobal(world, { domain: incoming }), true);
  for (const before of [UNKNOWN, BOTTOM, number, both])
    check(withGlobal(world, { domain: before }), withGlobal(world, { domain: BOTTOM }), true);
  for (const incoming of [UNKNOWN, number, boolean])
    check(withGlobal(world, { domain: BOTTOM }), withGlobal(world, { domain: incoming }), false);
  check(withGlobal(world, { domain: both }), withGlobal(world, { domain: number }), true);
  check(withGlobal(world, { domain: number }), withGlobal(world, { domain: both }), false);
  check(withGlobal(world, { domain: number }), withGlobal(world, { domain: UNKNOWN }), false);
});
it("requires complete root containment for known domains and prototype unions", () => {
  const { world, domain } = fixture();
  const [left, right] = domain.roots;
  if (!left || !right) throw Error("missing distinct actual roots");
  expect(stable(left)).not.toBe(stable(right));
  const one = withCell(world, { valueDomain: known(["Function"], [left]), prototypeRoots: [left] });
  check(world, one, true);
  check(one, withCell(one, { valueDomain: known(["Function"], [right]) }), false);
  check(one, withCell(one, { prototypeRoots: [right] }), false);
});
it("rejects new Map keys and roots while keeping row identity and cardinality isolated", () => {
  const { world, cell, global, external } = fixture();
  const [heapKey] = [...world.heap.keys()],
    [globalKey] = [...world.globals.keys()];
  if (heapKey === undefined || globalKey === undefined) throw Error("missing actual keys");
  const renamedHeap = { ...world, heap: new Map([[heapKey + "!", cell]]) };
  expect(renamedHeap.heap.size).toBe(world.heap.size);
  expect([...renamedHeap.heap.values()][0]).toBe([...world.heap.values()][0]);
  check(world, renamedHeap, false);
  check(world, { ...world, globals: new Map([[globalKey + "!", global]]) }, false);
  expect(world.roots.has(stable(external))).toBe(false);
  check(world, { ...world, roots: new Set([...world.roots, stable(external)]) }, false);
  const reversed = { ...world, roots: new Set([...world.roots].reverse()) };
  check(world, reversed, true);
});
it("checks each root and binding coordinate at the same actual Map key", () => {
  const { world, cell, global, input } = fixture();
  const root = cell.root;
  if (root.kind !== "allocation") throw Error("missing actual allocation cell");
  const other = input.units.find((unit) => unit.unitId !== root.unitId);
  if (!other) throw Error("missing genuine second unit");
  const changed: readonly (readonly [keyof typeof root, typeof root])[] = [
    ["site", { ...root, site: asAllocSiteId(root.site + 1) }],
    ["definitionId", { ...root, definitionId: root.definitionId === null ? global.bindingId : null }],
    ["memberOrdinal", { ...root, memberOrdinal: root.memberOrdinal === null ? 0 : null }],
    ["view", { ...root, view: root.view === "constructor" ? "prototype" : "constructor" }],
    ["unitId", { ...root, unitId: other.unitId }],
  ];
  for (const [field, replacement] of changed) {
    expect(
      Object.keys(root).filter((key) => !Object.is(Reflect.get(root, key), Reflect.get(replacement, key))),
    ).toEqual([field]);
    check(world, withCell(world, { root: replacement }), false);
  }
  const otherGlobal = input.globals.find((row) => row.ref.binding.bindingId !== global.bindingId);
  if (!otherGlobal) throw Error("missing other genuine global binding");
  check(world, withGlobal(world, { bindingId: otherGlobal.ref.binding.bindingId }), false);
  if (cell.key.kind === "wildcard") throw Error("missing actual named property key");
  const changedKind = { kind: cell.key.kind === "internal" ? "literal" : "internal", value: cell.key.value } as const;
  expect(changedKind.value).toBe(cell.key.value);
  expect(changedKind.kind).not.toBe(cell.key.kind);
  for (const key of [changedKind, { ...cell.key, value: cell.key.value + "!" }, { kind: "wildcard" }] as const) {
    expect(preparedIrDataMismatch(cell.key, key)).toBeDefined();
    check(world, withCell(world, { key }), false);
  }
});
it("refuses canonical-key collisions with distinct signed-zero root coordinates", () => {
  const { world, cell } = fixture();
  if (cell.root.kind !== "allocation") throw Error("missing allocation");
  const plus = { ...cell.root, site: asAllocSiteId(0) },
    minus = { ...cell.root, site: asAllocSiteId(-0) };
  expect(stable(plus)).toBe(stable(minus));
  expect(Object.is(plus.site, minus.site)).toBe(false);
  check(withCell(world, { root: plus }), withCell(world, { root: minus }), false);
  check(
    withCell(world, { valueDomain: known(["Function"], [plus]) }),
    withCell(world, { valueDomain: known(["Function"], [minus]) }),
    false,
  );
  check(withCell(world, { prototypeRoots: [plus] }), withCell(world, { prototypeRoots: [minus] }), false);
});
it("retains canonical-before normalization and conservative incoming-domain refusals", () => {
  const { world, domain } = fixture();
  const base = known(["Boolean", "Number"], domain.roots);
  if (base.kind !== "known") throw Error("missing canonical domain");
  for (const malformed of [
    { ...base, families: [] },
    { ...base, families: ["Boolean", "Boolean", "Number"] },
    { ...base, families: ["Number", "Boolean"] },
    { ...base, roots: [...base.roots, base.roots[0]!] },
    { ...base, roots: [...base.roots].reverse() },
  ] satisfies Domain[]) {
    const before = withCell(world, { valueDomain: malformed });
    check(before, before, false);
    // Incoming normalization is a conservative refusal: the old union may still equal canonical before.
    const canonical = withCell(world, { valueDomain: base });
    const incoming = withCell(world, { valueDomain: malformed });
    expect(canOmitNormalizedWorldJoin(canonical, incoming)).toBe(false);
  }
  for (const prototypes of [[...domain.roots, domain.roots[0]!], [...domain.roots].reverse()]) {
    const before = withCell(world, { prototypeRoots: prototypes });
    check(before, before, false);
  }
});
it("preserves distinct locale ties and detects nonadjacent exact duplicate keys", () => {
  const { world, external } = fixture();
  if (external.kind !== "external") throw Error("missing actual external seed");
  // Derived coordinates are mathematical counterexamples only, never supplied as program input.
  const left = { ...external, bindingId: (external.bindingId + "é") as IrBindingId };
  const right = { ...external, bindingId: (external.bindingId + "e\u0301") as IrBindingId };
  expect(stable(left)).not.toBe(stable(right));
  expect(stable(left).localeCompare(stable(right))).toBe(0);
  const before = withCell(world, { valueDomain: known(["Function"], [left, right]), prototypeRoots: [left, right] });
  check(before, withCell(before, { prototypeRoots: [right] }), true);
  check(before, withCell(before, { prototypeRoots: [right, left] }), true);
  const repeated = withCell(before, { prototypeRoots: [left, right, left] });
  check(repeated, repeated, false);
  const cell = [...before.heap.values()][0]!;
  const tieWorld = {
    ...before,
    heap: new Map([
      ["é", cell],
      ["e\u0301", cell],
    ]),
  };
  expect("é".localeCompare("e\u0301")).toBe(0);
  check(tieWorld, { ...tieWorld, heap: new Map([...tieWorld.heap].reverse()) }, true);
  check({ ...before, heap: new Map([["é", cell]]) }, { ...before, heap: new Map([["e\u0301", cell]]) }, false);
  const other = withCell(before, { valueDomain: known(["Function"], [left]) });
  check(other, withCell(other, { valueDomain: known(["Function"], [right]) }), false);
});

import { privateGateRootKey } from "../src/ir/analysis/allocation-evidence/js-class-value-domains/independent-kernel.js";
type ComputationalRoot = Cell["root"];
it("matches generic stable bytes for complete actual allocation and external roots", () => {
  const { world, cell, external, domain, global, input } = fixture();
  const root = cell.root;
  if (root.kind !== "allocation" || external.kind !== "external") throw Error("missing both actual root kinds");
  const other = input.units.find((unit) => unit.unitId !== root.unitId);
  if (!other) throw Error("missing second actual unit");
  const corpus: ComputationalRoot[] = [
    root,
    external,
    ...domain.roots,
    { ...root, site: asAllocSiteId(root.site + 1) },
    { ...root, unitId: other.unitId },
    { ...root, definitionId: root.definitionId === null ? global.bindingId : null },
    { ...root, memberOrdinal: root.memberOrdinal === null ? 1 : null },
    { ...root, view: root.view === "object" ? "frame" : "object" },
    { ...external, bindingId: global.bindingId },
  ];
  expect(corpus.filter((item) => item.kind === "allocation").length).toBeGreaterThan(5);
  expect(corpus.filter((item) => item.kind === "external").length).toBeGreaterThan(1);
  for (const item of corpus) {
    expect(Object.keys(item).sort()).toEqual(
      item.kind === "allocation"
        ? ["definitionId", "kind", "memberOrdinal", "site", "unitId", "view"]
        : ["bindingId", "kind"],
    );
    expect(privateGateRootKey(item)).toBe(stable(item));
    const reversed = Object.fromEntries(Object.entries(item).reverse()) as ComputationalRoot;
    expect(privateGateRootKey(reversed)).toBe(stable(item));
  }
  const canonical = known(["Function"], corpus);
  if (canonical.kind !== "known") throw Error("missing canonical roots");
  expect(canonical.roots.length).toBeGreaterThan(6);
  const before = withCell(world, { valueDomain: canonical, prototypeRoots: canonical.roots });
  check(before, withCell(before, { valueDomain: known(["Function"], [external]), prototypeRoots: [external] }), true);
});
it("preserves escaping nullable numeric keys and full-coordinate collision guards", () => {
  const { world, cell, external } = fixture();
  const root = cell.root;
  if (root.kind !== "allocation" || external.kind !== "external") throw Error("missing both actual root kinds");
  // Derived coordinates below are mathematical values, never normalized input or source/engine evidence.
  const corpus: ComputationalRoot[] = [root, { ...root, definitionId: null, memberOrdinal: null }];
  for (const suffix of ['"\\\n', "é", "e\u0301", "\ud800"])
    corpus.push({ ...external, bindingId: (external.bindingId + suffix) as IrBindingId });
  for (const number of [0, -0, 1, NaN, Infinity, -Infinity])
    corpus.push({ ...root, site: asAllocSiteId(number), memberOrdinal: number });
  expect(corpus.length).toBe(12);
  for (const item of corpus) expect(privateGateRootKey(item)).toBe(stable(item));
  const plus = { ...root, site: asAllocSiteId(0) },
    minus = { ...root, site: asAllocSiteId(-0) };
  expect(privateGateRootKey(plus)).toBe(privateGateRootKey(minus));
  expect(Object.is(plus.site, minus.site)).toBe(false);
  check(withCell(world, { prototypeRoots: [plus] }), withCell(world, { prototypeRoots: [minus] }), false);
  const left = { ...external, bindingId: (external.bindingId + "é") as IrBindingId };
  const right = { ...external, bindingId: (external.bindingId + "e\u0301") as IrBindingId };
  expect(privateGateRootKey(left)).not.toBe(privateGateRootKey(right));
  expect(privateGateRootKey(left).localeCompare(privateGateRootKey(right))).toBe(0);
  const ties = withCell(world, { prototypeRoots: [left, right] });
  check(ties, withCell(ties, { prototypeRoots: [right, left] }), true);
});
function traceRootJson(root: ComputationalRoot, encode: (value: ComputationalRoot) => string) {
  const descriptor = Object.getOwnPropertyDescriptor(JSON, "stringify")!;
  const original = JSON.stringify,
    apply = Reflect.apply,
    clone = { ...root };
  const fields = Object.keys(clone).sort();
  const changes: Record<string, unknown> =
    root.kind === "allocation"
      ? {
          definitionId: root.definitionId === null ? root.unitId : null,
          kind: root.kind,
          memberOrdinal: root.memberOrdinal === 17 ? 19 : 17,
          site: asAllocSiteId(root.site === 29 ? 31 : 29),
          unitId: root.unitId + "!",
          view: root.view === "object" ? "frame" : "object",
        }
      : { bindingId: root.bindingId + "!", kind: root.kind };
  const calls: unknown[] = [],
    mutations: string[] = [];
  let output: string | undefined, error: unknown;
  try {
    Object.defineProperty(JSON, "stringify", {
      ...descriptor,
      value(value: unknown, ...args: unknown[]) {
        const index = calls.length;
        calls.push(value);
        if (index % 2 === 0) {
          const field = fields[index / 2]!;
          Object.defineProperty(clone, field, {
            value: changes[field],
            enumerable: true,
            writable: true,
            configurable: true,
          });
          if (field !== "kind") mutations.push(field);
        }
        return apply(original, JSON, [value, ...args]);
      },
    });
    output = encode(clone);
  } catch (caught) {
    error = caught;
  } finally {
    Object.defineProperty(JSON, "stringify", descriptor);
  }
  return { output, error, calls, mutations, expected: fields.flatMap((field) => [field, changes[field]]) };
}
it("preserves live JSON name then late DATA read then scalar value order", () => {
  const { cell, external } = fixture();
  for (const root of [cell.root, external]) {
    const reference = traceRootJson(root, stable),
      actual = traceRootJson(root, privateGateRootKey);
    expect(reference.error).toBeUndefined();
    expect(actual.error).toBeUndefined();
    expect(actual.output).toBe(reference.output);
    expect(actual.calls).toEqual(reference.calls);
    expect(actual.calls).toEqual(actual.expected);
    expect(actual.calls.length).toBe(root.kind === "allocation" ? 12 : 4);
    expect(actual.mutations.length).toBe(root.kind === "allocation" ? 5 : 1);
  }
});
