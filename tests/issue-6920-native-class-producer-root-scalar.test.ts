// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
// Root variants below test computational bytes and effects, never prepared or physical authority.
import { afterEach, expect, it } from "vitest";
import { setImmediate } from "node:timers/promises";
import { analyzeMultiSource } from "../src/checker/index.js";
import { captureTypedIrProgramInput, prepareIrProgramSources } from "../src/ir/program-source.js";
import { prepareIrProgramAbiEntries } from "../src/ir/program-abi-contracts.js";
import { normalizeNativeClassValues } from "../src/ir/program/native-js-class-values.js";
import {
  analyzeNativeJsClassValueDomains,
  privateProducerRootKey,
} from "../src/ir/analysis/allocation-evidence/js-class-value-domains/producer.js";
import { replayNativeJsClassValueDomains } from "../src/ir/analysis/allocation-evidence/js-class-value-domains/independent.js";
import { nativeJsClassValueDataKey } from "../src/ir/analysis/allocation-evidence/js-class-value-domains/data.js";
import type { NativeJsValueRoot as Root } from "../src/ir/analysis/allocation-evidence/js-class-value-domains/contracts.js";
import { asAllocSiteId } from "../src/ir/core/nodes.js";
import type { IrBindingId } from "../src/shared/contracts/ir-identity.js";
afterEach(() => setImmediate());
function rootFixture() {
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
  expect(report.calls.some((row) => row.kind === "invoke" && row.targets.length === 2)).toBe(true);
  const roots = report.heap.flatMap((row) => [row.root, ...row.prototypeRoots]);
  const allocation = roots.find((root) => root.kind === "allocation"),
    external = roots.find((root) => root.kind === "external");
  if (!allocation || allocation.kind !== "allocation" || !external || external.kind !== "external")
    throw Error("missing actual root populations");
  const unit = normalized.input.units.find((row) => row.unitId !== allocation.unitId);
  const binding = normalized.input.globals.find((row) => row.ref.binding.bindingId !== allocation.definitionId);
  if (!unit || !binding) throw Error("missing distinct actual identities");
  return { roots, allocation, external, unitId: unit.unitId, bindingId: binding.ref.binding.bindingId };
}
type Event = { kind: "json" | "finite"; value: unknown; receiver: boolean; arity: number; result?: boolean };
function observeRoot(root: Root, encode: (value: Root) => string, lateReads: boolean) {
  const jsonDescriptor = Object.getOwnPropertyDescriptor(JSON, "stringify")!;
  const finiteDescriptor = Object.getOwnPropertyDescriptor(Number, "isFinite")!;
  const stringify = JSON.stringify,
    finite = Number.isFinite,
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
  const events: Event[] = [],
    reads: unknown[][] = [],
    changed: string[] = [];
  let output: string | undefined,
    error: unknown,
    jsonIndex = 0;
  try {
    Object.defineProperty(Number, "isFinite", {
      ...finiteDescriptor,
      value(this: unknown, ...args: unknown[]) {
        const result = apply(finite, this, args);
        events.push({ kind: "finite", value: args[0], receiver: this === Number, arity: args.length, result });
        return result;
      },
    });
    Object.defineProperty(JSON, "stringify", {
      ...jsonDescriptor,
      value(this: unknown, ...args: unknown[]) {
        events.push({ kind: "json", value: args[0], receiver: this === JSON, arity: args.length });
        if (lateReads) {
          const field = fields[Math.floor(jsonIndex / 2)]!;
          if (jsonIndex % 2 === 0) {
            Object.defineProperty(clone, field, {
              value: changes[field],
              enumerable: true,
              writable: true,
              configurable: true,
            });
            if (field !== "kind") changed.push(field);
          } else reads.push([field, args[0]]);
          jsonIndex++;
        }
        return apply(stringify, this, args);
      },
    });
    output = encode(clone);
  } catch (caught) {
    error = caught;
  } finally {
    Object.defineProperty(JSON, "stringify", jsonDescriptor);
    Object.defineProperty(Number, "isFinite", finiteDescriptor);
  }
  return { output, error, events, reads, changed, expectedReads: fields.map((field) => [field, changes[field]]) };
}
it("preserves actual producer root-key bytes for closed coordinates and scalar boundaries", () => {
  const { roots, allocation, external, unitId, bindingId } = rootFixture();
  const corpus: Root[] = [
    ...roots,
    { ...allocation, unitId },
    { ...allocation, definitionId: null },
    { ...allocation, definitionId: bindingId },
    { ...allocation, memberOrdinal: null },
    { ...allocation, memberOrdinal: 1 },
    { ...allocation, view: allocation.view === "object" ? "frame" : "object" },
    { ...external, bindingId },
  ];
  // These additional coordinates are mathematical values only, never supplied as normalized input.
  for (const value of [0, -0, 1, NaN, Infinity, -Infinity])
    corpus.push({ ...allocation, site: asAllocSiteId(value), memberOrdinal: value });
  for (const suffix of ['"\\\n', "é", "e\u0301", "\ud800"])
    corpus.push({ ...external, bindingId: (external.bindingId + suffix) as IrBindingId });
  expect(corpus.length).toBeGreaterThan(17);
  expect(corpus.some((root) => root.kind === "external")).toBe(true);
  expect(corpus.some((root) => root.kind === "allocation" && root.definitionId === null)).toBe(true);
  for (const root of corpus) {
    expect(Object.keys(root).sort()).toEqual(
      root.kind === "allocation"
        ? ["definitionId", "kind", "memberOrdinal", "site", "unitId", "view"]
        : ["bindingId", "kind"],
    );
    expect(privateProducerRootKey(root)).toBe(nativeJsClassValueDataKey(root));
    const reversed = Object.fromEntries(Object.entries(root).reverse()) as Root;
    expect(privateProducerRootKey(reversed)).toBe(nativeJsClassValueDataKey(root));
  }
  for (const value of [NaN, Infinity, -Infinity]) {
    const root = { ...allocation, site: asAllocSiteId(value) };
    expect(privateProducerRootKey(root)).toContain("number:" + value);
    expect(privateProducerRootKey(root)).not.toBe(nativeJsClassValueDataKey({ ...root, site: null }));
  }
  expect(privateProducerRootKey({ ...allocation, site: asAllocSiteId(0) })).toBe(
    privateProducerRootKey({ ...allocation, site: asAllocSiteId(-0) }),
  );
});
it("preserves live Number and JSON method custody and late root-field reads", () => {
  const { allocation, external } = rootFixture();
  for (const root of [allocation, external]) {
    const reference = observeRoot(root, nativeJsClassValueDataKey, true),
      actual = observeRoot(root, privateProducerRootKey, true);
    expect(reference.error).toBeUndefined();
    expect(actual.error).toBeUndefined();
    expect(actual.output).toBe(reference.output);
    expect(actual.events).toEqual(reference.events);
    expect(actual.reads).toEqual(actual.expectedReads);
    expect(actual.changed.length).toBe(root.kind === "allocation" ? 5 : 1);
    expect(actual.events.length).toBe(root.kind === "allocation" ? 14 : 4);
    expect(actual.events.every((event) => event.receiver && event.arity === 1)).toBe(true);
    const numbers = actual.events.filter((event) => event.kind === "finite");
    expect(numbers.length).toBe(root.kind === "allocation" ? 2 : 0);
    expect(numbers.every((event) => event.result === true)).toBe(true);
    expect(actual.events.filter((event) => event.kind === "json").map((event) => event.value)).toEqual(
      actual.expectedReads.flat(),
    );
  }
  for (const value of [NaN, Infinity, -Infinity]) {
    const root = { ...allocation, site: asAllocSiteId(value), memberOrdinal: value };
    const reference = observeRoot(root, nativeJsClassValueDataKey, false),
      actual = observeRoot(root, privateProducerRootKey, false);
    expect(reference.error).toBeUndefined();
    expect(actual.error).toBeUndefined();
    expect(actual.output).toBe(reference.output);
    expect(actual.output).toContain("number:" + value);
    expect(actual.events).toEqual(reference.events);
    expect(actual.events.every((event) => event.receiver && event.arity === 1)).toBe(true);
    const finiteEvents = actual.events.filter((event) => event.kind === "finite");
    expect(finiteEvents.length).toBe(2);
    expect(finiteEvents.every((event) => event.result === false && Object.is(event.value, value))).toBe(true);
    expect(actual.events.some((event) => event.kind === "json" && Object.is(event.value, value))).toBe(false);
  }
});
