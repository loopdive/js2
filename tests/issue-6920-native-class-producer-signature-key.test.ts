// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
// Captured snapshots and their mathematical variants are computational DATA, never a Model or admission proof.
import { afterEach, expect, it, vi } from "vitest";
import { setImmediate } from "node:timers/promises";
import { analyzeMultiSource } from "../src/checker/index.js";
import { captureTypedIrProgramInput, prepareIrProgramSources } from "../src/ir/program-source.js";
import { prepareIrProgramAbiEntries } from "../src/ir/program-abi-contracts.js";
import { normalizeNativeClassValues } from "../src/ir/program/native-js-class-values.js";
import { analyzeNativeJsClassValueDomains } from "../src/ir/analysis/allocation-evidence/js-class-value-domains/producer.js";
import { replayNativeJsClassValueDomains } from "../src/ir/analysis/allocation-evidence/js-class-value-domains/independent.js";
import * as codec from "../src/ir/analysis/allocation-evidence/js-class-value-domains/producer-private-keys.js";
import {
  nativeJsClassValueDataKey as key,
  copyNativeJsClassValueData as copy,
} from "../src/ir/analysis/allocation-evidence/js-class-value-domains/data.js";
import { preparedIrDataMismatch } from "../src/shared/contracts/prepared-ir-data.js";
type Snapshot = codec.ProducerSignatureSnapshot;
type Path = readonly (string | number)[];
type Data = Record<string | number, unknown>;
const sources = [
  "class C{static m(){return 1;}}class D{static n(){return true;}}export function mutate(){C.m=D.n;return 0;}export function run(){return C.m()===true?1:0;}",
  "class C{static m(){return 1;}}function write(){C.m=3;throw 7;}export function mutate(){write();return 0;}export function run(){C.m();return 7;}",
  "class C{m(x:number):number{return x;}}export function run():number{new C().m(4);return 7;}",
  "class C{}function f():number{const c=new C();c.missing(4);return 7;}export function run():number{f();return 7;}",
];
afterEach(async () => {
  vi.restoreAllMocks();
  await setImmediate();
});
function capture(text: string) {
  const policy = { backend: "wasmgc", target: "standalone" } as const;
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
  const typed = captureTypedIrProgramInput(prepared),
    context = { ...typed, abi: { entries: prepareIrProgramAbiEntries(typed) } };
  const normalized = normalizeNativeClassValues(context, context.ir, "original");
  if (normalized.kind !== "normalized") throw Error(JSON.stringify(normalized));
  const samples: { before: Snapshot; after: Snapshot; result: string }[] = [],
    actual = codec.signatureKey;
  const spy = vi.spyOn(codec, "signatureKey").mockImplementation(function (this: unknown, snapshot) {
    const before = copy(snapshot),
      result = Reflect.apply(actual, this, [snapshot]);
    samples.push({ before, result, after: copy(snapshot) });
    return result;
  });
  let report;
  try {
    report = analyzeNativeJsClassValueDomains(normalized.input);
  } finally {
    spy.mockRestore();
  }
  expect(samples.length).toBeGreaterThanOrEqual(4);
  expect(samples.length % 2).toBe(0);
  expect(replayNativeJsClassValueDomains(normalized.input, report)).toEqual([]);
  expect(report).toEqual(analyzeNativeJsClassValueDomains(normalized.input));
  for (const row of samples) expect(preparedIrDataMismatch(row.before, row.after)).toBeUndefined();
  return { samples, report };
}
function data(value: unknown): Data {
  if (!value || typeof value !== "object") throw Error("missing actual DATA row");
  return value as Data;
}
function at(value: unknown, path: Path): unknown {
  for (const field of path) value = data(value)[field];
  return value;
}
function put(snapshot: Snapshot, path: Path, value: unknown): Snapshot {
  const result = copy(snapshot),
    parent = data(at(result, path.slice(0, -1)));
  Object.defineProperty(parent, path.at(-1)!, { value, writable: true, enumerable: true, configurable: true });
  return result;
}
function locate(pool: readonly Snapshot[], choose: (snapshot: Snapshot) => Path | undefined) {
  for (const snapshot of pool) {
    const path = choose(snapshot);
    if (path) return { snapshot, path };
  }
  throw Error("missing genuine populated coordinate");
}
function changed(snapshot: Snapshot, path: Path, value: unknown) {
  const before = at(snapshot, path),
    mutated = put(snapshot, path, value);
  expect(at(mutated, path)).toBe(value);
  expect(key(mutated)).not.toBe(key(snapshot));
  expect(key(put(mutated, path, before))).toBe(key(snapshot));
  expect(codec.signatureKey(mutated)).toBe(key(mutated));
}
function recordChanges(row: ReturnType<typeof locate>, replacements: Record<string, unknown>) {
  for (const [field, value] of Object.entries(replacements)) changed(row.snapshot, [...row.path, field], value);
}
function differentDomain(pool: readonly Snapshot[], before: unknown) {
  const domains = pool.flatMap((s) => s.values.map((row) => row[1].domain));
  const result = domains.find((domain) => key(domain) !== key(before));
  if (!result) throw Error("missing distinct actual domain");
  return result;
}
function corpus() {
  return sources.flatMap((source) => capture(source).samples.map((row) => row.before));
}
function tupleCoordinates(pool: readonly Snapshot[]) {
  for (let position = 0; position < 9; position++) {
    const row = locate(pool, (s) => {
      const i = s.summaries.findIndex(
        (r) =>
          position === 0 ||
          position === 3 ||
          position === 4 ||
          (Array.isArray(data(r)[position]) && (data(r)[position] as unknown[]).length > 0),
      );
      return i < 0 ? undefined : ["summaries", i, position];
    });
    const old = at(row.snapshot, row.path);
    changed(
      row.snapshot,
      row.path,
      typeof old === "boolean"
        ? !old
        : typeof old === "string"
          ? old + "!"
          : [...(old as unknown[]), (old as unknown[])[0]],
    );
  }
  for (const field of ["entries", "normalWorlds", "publicTerminalWorlds"] as const)
    for (let position = 0; position < 3; position++) {
      const row = locate(pool, (s) => {
        const i = s[field].findIndex((r) => position === 0 || (data(r)[position] as unknown[]).length > 0);
        return i < 0 ? undefined : [field, i, position];
      });
      const old = at(row.snapshot, row.path);
      changed(
        row.snapshot,
        row.path,
        typeof old === "string" ? old + "!" : [...(old as unknown[]), (old as unknown[])[0]],
      );
    }
}
const topFields = [
  "calls",
  "entries",
  "normalWorlds",
  "obligations",
  "observedWorld",
  "publicReachable",
  "publicTerminalWorlds",
  "reachable",
  "summaries",
  "values",
] as const;
it("matches real producer signature calls and changed and stable iteration pairs across public histories", () => {
  const all = sources.map(capture),
    pool = all.flatMap((row) => row.samples.map((sample) => sample.before));
  for (const { samples, report } of all) {
    let changedPairs = 0,
      stablePairs = 0;
    for (const row of samples) {
      expect(Object.keys(row.before).sort()).toEqual(topFields);
      expect(row.result).toBe(key(row.before));
      expect(codec.signatureKey(row.before)).toBe(row.result);
    }
    for (let i = 0; i < samples.length; i += 2) {
      const actualSame = samples[i]!.result === samples[i + 1]!.result;
      expect(actualSame).toBe(key(samples[i]!.before) === key(samples[i + 1]!.before));
      if (actualSame) stablePairs++;
      else changedPairs++;
    }
    expect(changedPairs).toBeGreaterThan(0);
    expect(stablePairs).toBeGreaterThan(0);
    expect(report.calls.length).toBeGreaterThan(0);
    expect(report.values.length).toBeGreaterThan(0);
  }
  expect(pool.some((s) => s.publicReachable.length === 0)).toBe(true);
  expect(pool.some((s) => s.publicReachable.length > 0 && s.publicTerminalWorlds.length > 0)).toBe(true);
  expect(pool.some((s) => s.observedWorld[0].length > 0 && s.observedWorld[1].length > 0)).toBe(true);
  expect(all[0]!.report.calls.some((row) => row.kind === "invoke" && row.targets.length === 2)).toBe(true);
  expect(all[1]!.report.functions.some((row) => row.mayThrow && !row.normalCompletion)).toBe(true);
  expect(all[1]!.report.obligations.some((row) => row.reason === "unknown-callee")).toBe(true);
});
it("keeps every complete wrapper coordinate and whole generic subtree load-bearing", () => {
  const pool = corpus(),
    base = pool.find((s) => s.values.length > 1)!;
  expect(base).toBeDefined();
  const unit = base.summaries.find((row) => row[0] !== base.values[0]![1].unitId)![0];
  for (const field of topFields) {
    const s = pool.find(
      (row) => row[field].length > 0 && (field !== "observedWorld" || row.observedWorld[0].length > 0),
    );
    if (!s) throw Error("empty top field " + field);
    const value =
      field === "observedWorld"
        ? [[...s.observedWorld[0], s.observedWorld[0][0]], s.observedWorld[1]]
        : [...s[field], s[field][0]];
    changed(s, [field], value);
  }
  const valueRow = locate(pool, (s) => (s.values.length ? ["values", 0, 1] : undefined));
  const global = locate(pool, (s) => (s.observedWorld[0].length ? ["observedWorld", 0, 0, 1] : undefined));
  const cell = locate(pool, (s) => (s.observedWorld[1].length ? ["observedWorld", 1, 0, 1] : undefined));
  const obligation = locate(pool, (s) =>
    s.obligations.some((r) => r[1].location !== null)
      ? ["obligations", s.obligations.findIndex((r) => r[1].location !== null), 1]
      : undefined,
  );
  const known = locate(pool, (s) => {
    const i = s.values.findIndex((r) => r[1].domain.kind === "known" && r[1].domain.roots.length > 0);
    return i < 0 ? undefined : ["values", i, 1, "domain"];
  });
  const singleton = locate(pool, (s) => {
    const i = s.values.findIndex((r) => r[1].domain.kind !== "known");
    return i < 0 ? undefined : ["values", i, 1, "domain"];
  });
  const single = data(at(singleton.snapshot, singleton.path)),
    domain = data(at(known.snapshot, known.path));
  changed(singleton.snapshot, [...singleton.path, "kind"], single.kind === "bottom" ? "unknown" : "bottom");
  if (!Array.isArray(domain.families)) throw Error("missing actual family array");
  recordChanges(known, { families: [...domain.families, "Number"], roots: [] });
  const g = data(at(global.snapshot, global.path)),
    c = data(at(cell.snapshot, cell.path));
  recordChanges(global, {
    bindingId: String(g.bindingId) + "!",
    domain: differentDomain(pool, g.domain),
    initialization: g.initialization === "maybe" ? "initialized" : "maybe",
  });
  recordChanges(cell, {
    key: { ...data(c.key), signatureAudit: "key" },
    presence: c.presence === "maybe" ? "present" : "maybe",
    prototypeRoots: [c.root, c.root],
    root: { ...data(c.root), signatureAudit: "root" },
    valueDomain: differentDomain(pool, c.valueDomain),
  });
  recordChanges(valueRow, {
    unitId: unit,
    value: Number(data(at(valueRow.snapshot, valueRow.path)).value) + 1000,
    domain: differentDomain(pool, data(at(valueRow.snapshot, valueRow.path)).domain),
  });
  const ob = data(at(obligation.snapshot, obligation.path));
  recordChanges(obligation, {
    location: null,
    reason: ob.reason === "opaque-effect" ? "unknown-callee" : "opaque-effect",
    unitId: ob.unitId === null ? unit : null,
  });
  tupleCoordinates(pool);
  changed(global.snapshot, [...global.path.slice(0, -1), 0], "map-key!");
  for (const path of [
    ["calls", 0, 1],
    [...cell.path, "root"],
    [...cell.path, "key"],
    [...obligation.path, "location"],
  ] as Path[]) {
    const s =
      path[0] === "calls"
        ? pool.find((row) => row.calls.length)!
        : path[0] === "obligations"
          ? obligation.snapshot
          : cell.snapshot;
    const extra = put(s, [...path, "signatureAudit"], { escaped: '"\\\ud800', big: 1n });
    expect(at(extra, [...path, "signatureAudit"])).toBeDefined();
    expect(key(extra)).not.toBe(key(s));
    expect(codec.signatureKey(extra)).toBe(key(extra));
  }
});
it("preserves raw array order duplicates fixed tuple holes own undefined and scalar bytes", () => {
  const pool = capture(sources[2]!).samples.map((r) => r.before),
    s = pool.find((row) => row.values.length > 1 && row.reachable.length > 0)!;
  expect(s).toBeDefined();
  changed(s, ["values"], [...s.values].reverse());
  changed(s, ["values"], [...s.values, s.values[0]]);
  changed(s, ["values"], []);
  const tieRows = [
    ["é", s.values[0]![1]],
    ["e\u0301", s.values[1]![1]],
  ];
  expect("é".localeCompare("e\u0301")).toBe(0);
  const ties = put(s, ["values"], tieRows);
  expect(codec.signatureKey(ties)).toBe(key(ties));
  changed(ties, ["values"], [...tieRows].reverse());
  for (const path of [["reachable"], ["summaries", 0], ["values", 0]] as Path[]) {
    const hole = copy(s),
      explicit = copy(s),
      array = data(at(hole, path)),
      other = data(at(explicit, path));
    expect(Object.hasOwn(array, 0)).toBe(true);
    expect(Reflect.deleteProperty(array, 0)).toBe(true);
    Object.defineProperty(other, 0, { value: undefined, enumerable: true, writable: true, configurable: true });
    expect(Object.hasOwn(array, 0)).toBe(false);
    expect(Object.hasOwn(other, 0)).toBe(true);
    expect(array.length).toBe(other.length);
    expect(key(hole)).not.toBe(key(explicit));
    expect(codec.signatureKey(hole)).toBe(key(hole));
    expect(codec.signatureKey(explicit)).toBe(key(explicit));
  }
  for (const value of [undefined, null, 0, -0, NaN, Infinity, -Infinity, '"\\\n', "é", "e\u0301", "\ud800"]) {
    const path: Path = typeof value === "string" ? ["values", 0, 1, "unitId"] : ["values", 0, 1, "value"];
    const changed = put(s, path, value);
    expect(codec.signatureKey(changed)).toBe(key(changed));
  }
});
type Event = { method: string; value: unknown; receiver: boolean; arity: number; result?: boolean };
function observe(s: Snapshot, encode: typeof codec.signatureKey, pendingReads: boolean) {
  const clone = copy(s),
    jd = Object.getOwnPropertyDescriptor(JSON, "stringify")!,
    nd = Object.getOwnPropertyDescriptor(Number, "isFinite")!;
  const json = JSON.stringify,
    finite = Number.isFinite,
    apply = Reflect.apply,
    events: Event[] = [];
  const top = [...clone.publicReachable].reverse(),
    original = clone.publicReachable,
    oldValue = clone.values[0]![1].value;
  let topEdits = 0,
    nestedEdits = 0,
    valuesStarted = false,
    nestedNames = 0,
    output: string | undefined,
    error: unknown;
  try {
    Object.defineProperty(Number, "isFinite", {
      ...nd,
      value(this: unknown, ...args: unknown[]) {
        const result = apply(finite, this, args);
        events.push({ method: "finite", value: args[0], receiver: this === Number, arity: args.length, result });
        return result;
      },
    });
    Object.defineProperty(JSON, "stringify", {
      ...jd,
      value(this: unknown, ...args: unknown[]) {
        events.push({ method: "json", value: args[0], receiver: this === JSON, arity: args.length });
        if (pendingReads && args[0] === "publicReachable") {
          Object.defineProperty(clone, "publicReachable", { value: top });
          topEdits++;
        }
        if (pendingReads && args[0] === "values") valuesStarted = true;
        else if (pendingReads && valuesStarted && args[0] === "value") {
          nestedNames++;
          if (nestedEdits === 0) {
            Object.defineProperty(clone.values[0]![1], "value", { value: oldValue + 1000 });
            nestedEdits++;
          }
        }
        return apply(json, this, args);
      },
    });
    output = encode(clone);
  } catch (caught) {
    error = caught;
  } finally {
    try {
      Object.defineProperty(JSON, "stringify", jd);
    } finally {
      Object.defineProperty(Number, "isFinite", nd);
    }
  }
  return {
    output,
    error,
    events,
    topEdits,
    nestedEdits,
    nestedNames,
    topDifferent: key(top) !== key(original),
    replaced: clone.publicReachable === top,
    newValue: clone.values[0]![1].value,
  };
}
it("preserves complete live intrinsic traces and uniquely reached pending DATA reads", () => {
  const pool = capture(sources[0]!).samples.map((r) => r.before),
    s = pool.find((row) => row.publicReachable.length > 1 && row.values.length > 0)!;
  expect(s).toBeDefined();
  const reference = observe(s, key, true),
    actual = observe(s, codec.signatureKey, true);
  expect(reference.error).toBeUndefined();
  expect(actual.error).toBeUndefined();
  expect(actual.output).toBe(reference.output);
  expect(actual.output).not.toBe(key(s));
  expect(actual.events).toEqual(reference.events);
  expect(actual.events.length).toBeGreaterThan(100);
  expect(actual.events.every((row) => row.receiver && row.arity === 1)).toBe(true);
  expect(actual.events.some((row) => row.method === "finite")).toBe(true);
  expect(actual.topEdits).toBe(1);
  expect(actual.topDifferent && actual.replaced).toBe(true);
  expect(actual.events.filter((row) => row.method === "json" && row.value === "values").length).toBe(1);
  expect(actual.nestedEdits).toBe(1);
  expect(actual.nestedNames).toBe(s.values.length);
  expect(actual.newValue).toBe(s.values[0]![1].value + 1000);
  for (const value of [NaN, Infinity, -Infinity, undefined]) {
    const variant = put(s, ["values", 0, 1, "value"], value),
      ref = observe(variant, key, false),
      got = observe(variant, codec.signatureKey, false);
    expect(ref.error).toBeUndefined();
    expect(got.error).toBeUndefined();
    expect(got.output).toBe(ref.output);
    expect(got.events).toEqual(ref.events);
    expect(got.events.some((row) => row.method === "json" && Object.is(row.value, value))).toBe(false);
    if (value !== undefined)
      expect(
        got.events.some((row) => row.method === "finite" && Object.is(row.value, value) && row.result === false),
      ).toBe(true);
  }
  const row = locate(pool, (x) =>
    x.observedWorld[1].some((r) => r[1].prototypeRoots.length)
      ? ["observedWorld", 1, x.observedWorld[1].findIndex((r) => r[1].prototypeRoots.length), 1, "prototypeRoots"]
      : undefined,
  );
  const roots = at(row.snapshot, row.path) as unknown[],
    repeated = put(row.snapshot, row.path, [roots[0], roots[0]]);
  const ref = observe(repeated, key, false),
    got = observe(repeated, codec.signatureKey, false);
  expect(ref.error).toBeUndefined();
  expect(got.error).toBeUndefined();
  expect(got.output).toBe(ref.output);
  expect(got.events).toEqual(ref.events);
  const single = observe(put(row.snapshot, row.path, [roots[0]]), key, false);
  expect(single.error).toBeUndefined();
  expect(got.events.length).toBeGreaterThan(single.events.length);
  expect(got.output).not.toBe(single.output);
});
