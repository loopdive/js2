// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import { afterEach, describe, expect, it, vi } from "vitest";
// Initialize the compiler graph before constructing its context adapters.
import "../src/index.js";
import { analyzeSource } from "../src/checker/index.js";
import { createEmptyModule } from "../src/ir/types.js";
import { createCodegenContext } from "../src/codegen/context/create-context.js";
import type { CodegenContext, CodegenOptions, FunctionContext } from "../src/codegen/context/types.js";
import * as combinators from "../src/codegen/promise-combinators.js";
import * as scheduler from "../src/codegen/async-scheduler.js";
import * as objectRuntime from "../src/codegen/object-runtime.js";
import * as builtinMetadata from "../src/codegen/builtin-fn-meta.js";
import * as builtinGlobals from "../src/codegen/builtin-static-globals.js";
import * as builtinValues from "../src/codegen/builtin-value-read.js";
import * as carrierVisibility from "../src/codegen/carrier-bag-visibility.js";
import * as wrapperTypes from "../src/codegen/closures/funcref-wrapper-types.js";
import * as nativeStrings from "../src/codegen/native-strings.js";
import * as dynamicPromise from "../src/codegen/promise-dynamic-member-read.js";
import * as promiseSpecies from "../src/codegen/promise-species-then.js";
import * as errorTypes from "../src/codegen/registry/error-types.js";
import * as imports from "../src/codegen/registry/imports.js";
import * as registryTypes from "../src/codegen/registry/types.js";
import * as protocol from "../src/codegen/promises/promise-combinator-observable-protocol.js";
import * as separate from "../src/codegen/promises/promise-observable-combinators.js";

function context(): CodegenContext {
  const source = analyzeSource("export function test(): number { return 1; }", "service-context.ts");
  return createCodegenContext(createEmptyModule(), source.checker, { standalone: true, nativeStrings: true });
}

afterEach(() => vi.restoreAllMocks());

describe("linked-package context initialization preservation", () => {
  const bindings = new Map([
    ["first", { module: "binding-first", field: "a" }],
    ["second", { module: "shared", field: "b" }],
    ["third", { module: "binding-first", field: "c" }],
    ["fourth", { module: "binding-last", field: "d" }],
  ]);
  const cases: { name: string; options?: CodegenOptions; namespaces: string[] }[] = [
    { name: "absent options", namespaces: [] },
    { name: "empty options", options: {}, namespaces: [] },
    {
      name: "binding map identity and binding-derived namespace order",
      options: { linkedPackageBindings: bindings },
      namespaces: ["binding-first", "shared", "binding-last"],
    },
    {
      name: "explicit link order and deduplication",
      options: { link: ["link-first", "shared", "link-first"] },
      namespaces: ["link-first", "shared"],
    },
    {
      name: "explicit links before bindings with cross-source deduplication",
      options: { link: ["link-first", "shared", "link-first"], linkedPackageBindings: bindings },
      namespaces: ["link-first", "shared", "binding-first", "binding-last"],
    },
  ];
  for (const { name, options, namespaces } of cases) {
    it(name, () => {
      const source = analyzeSource("export function test(): number { return 1; }", "linked-context.ts");
      const mod = createEmptyModule();
      const beforeBindings = options?.linkedPackageBindings ? [...options.linkedPackageBindings.entries()] : undefined;
      const beforeLinks = options?.link ? [...options.link] : undefined;
      // Independent expectation: the exact expressions before extraction.
      const linkedPackageBindings = options?.linkedPackageBindings ?? new Map();
      const linkedNamespaces: ReadonlySet<string> = new Set([
        ...(options?.link ?? []),
        ...Array.from(linkedPackageBindings.values(), (binding) => binding.module),
      ]);
      const ctx = createCodegenContext(mod, source.checker, options);
      expect(ctx.linkedPackageBindings).toEqual(linkedPackageBindings);
      expect([...ctx.linkedNamespaces]).toEqual([...linkedNamespaces]);
      expect([...ctx.linkedNamespaces]).toEqual(namespaces);
      if (options?.linkedPackageBindings) {
        expect(ctx.linkedPackageBindings).toBe(options.linkedPackageBindings);
        expect([...options.linkedPackageBindings.entries()]).toEqual(beforeBindings);
      } else {
        const other = createCodegenContext(createEmptyModule(), source.checker, options);
        expect(ctx.linkedPackageBindings.size).toBe(0);
        expect(ctx.linkedPackageBindings).not.toBe(other.linkedPackageBindings);
        expect(ctx.linkedNamespaces).not.toBe(other.linkedNamespaces);
      }
      if (options?.link) expect(options.link).toEqual(beforeLinks);
    });
  }
});

describe("observable Promise context service boundary", () => {
  it("installs independent records and callbacks for each context and owner", () => {
    const first = context();
    const second = context();
    expect(first.promiseCombinatorProtocolServices).not.toBe(second.promiseCombinatorProtocolServices);
    expect(first.promiseObservableCombinatorServices).not.toBe(second.promiseObservableCombinatorServices);
    expect(first.promiseCombinatorProtocolServices).not.toBe(first.promiseObservableCombinatorServices);
    expect(first.promiseCombinatorProtocolServices.ensureCombinatorFunctions).not.toBe(
      second.promiseCombinatorProtocolServices.ensureCombinatorFunctions,
    );
    expect(first.promiseObservableCombinatorServices.ensureCombinatorFunctions).not.toBe(
      second.promiseObservableCombinatorServices.ensureCombinatorFunctions,
    );
  });

  it("adds no runtime ensures or allocations beyond ordinary context construction", () => {
    // Guard every newly forwarded callable provider independently of the
    // repaired constructor. Ordinary native-string/vector type registration
    // remains allowed; numeric allocation claims await the parent's cda run.
    const guards = [
      vi.spyOn(combinators, "ensureCombinatorFunctions"),
      vi.spyOn(scheduler, "ensureAsyncDriveRuntime"),
      vi.spyOn(scheduler, "ensurePromiseExecutorClosures"),
      vi.spyOn(objectRuntime, "ensureObjectRuntime"),
      vi.spyOn(objectRuntime, "ensureObjVecBuilders"),
      vi.spyOn(objectRuntime, "reserveApplyClosure"),
      vi.spyOn(builtinMetadata, "ensureBuiltinFnMetaType"),
      vi.spyOn(wrapperTypes, "getOrCreateFuncRefWrapperTypes"),
      vi.spyOn(builtinValues, "ensureStandaloneBuiltinStaticMethodClosure"),
      vi.spyOn(builtinGlobals, "emitBuiltinConstructorIdentity"),
      vi.spyOn(carrierVisibility, "reserveCarrierBagVisibility"),
      vi.spyOn(dynamicPromise, "promiseProtoThenMayBeReplaced"),
      vi.spyOn(promiseSpecies, "aggregateSettleFuncIdx"),
      vi.spyOn(scheduler, "buildPromiseSettleClosureInstrs"),
      vi.spyOn(errorTypes, "emitWasiErrorConstructor"),
      vi.spyOn(nativeStrings, "stringConstantExternrefInstrs"),
      vi.spyOn(imports, "addStringConstantGlobal"),
      vi.spyOn(imports, "ensureExnTag"),
      vi.spyOn(registryTypes, "getArrTypeIdxFromVec"),
      vi.spyOn(combinators, "emitStandalonePromiseCombinator"),
      vi.spyOn(combinators, "emitStandalonePromiseCombinatorRuntime"),
    ];
    for (const guard of guards) {
      guard.mockImplementation(() => {
        throw new Error("forbidden observable service during context construction");
      });
      // Positive control for each fail-on-call spy, before real construction.
      expect(() => Reflect.apply(guard, undefined, [])).toThrow(
        "forbidden observable service during context construction",
      );
      expect(guard).toHaveBeenCalledTimes(1);
      guard.mockClear();
    }
    const installed = context();
    for (const guard of guards) expect(guard).not.toHaveBeenCalled();
    expect(installed.promiseCombinatorProtocolServices).toBeDefined();
    expect(installed.promiseObservableCombinatorServices).toBeDefined();
  });

  for (const field of ["promiseCombinatorProtocolServices", "promiseObservableCombinatorServices"] as const) {
    it(`loads late replaced exports and forwards the actual caller context: ${field}`, () => {
      const installed = context();
      const actual = context();
      const sentinel = {} as ReturnType<typeof combinators.ensureCombinatorFunctions>;
      const combinatorSpy = vi.spyOn(combinators, "ensureCombinatorFunctions").mockReturnValue(sentinel);
      const runtime = {} as ReturnType<typeof scheduler.ensureAsyncDriveRuntime>;
      const schedulerSpy = vi.spyOn(scheduler, "ensureAsyncDriveRuntime").mockReturnValue(runtime);
      expect(installed[field].ensureCombinatorFunctions(actual)).toBe(sentinel);
      expect(installed[field].ensureAsyncDriveRuntime(actual)).toBe(runtime);
      expect(combinatorSpy).toHaveBeenCalledExactlyOnceWith(actual);
      expect(schedulerSpy).toHaveBeenCalledExactlyOnceWith(actual);
    });
  }

  it("keeps pending state lazy and does not register resources when records are read", () => {
    const ctx = context();
    const before = structuredClone(ctx.mod);
    for (const services of [ctx.promiseCombinatorProtocolServices, ctx.promiseObservableCombinatorServices]) {
      const descriptor = Object.getOwnPropertyDescriptor(services, "pendingState");
      expect(descriptor?.get).toBeTypeOf("function");
      expect(descriptor).not.toHaveProperty("value");
      expect(services.pendingState).toBe(scheduler.PROMISE_STATE_PENDING);
    }
    expect(ctx.mod).toEqual(before);
  });

  it("refuses a missing protocol record rather than selecting legacy behavior", () => {
    const ctx = { ...context(), promiseCombinatorProtocolServices: undefined } as unknown as CodegenContext;
    const legacy = vi.spyOn(combinators, "emitStandalonePromiseCombinator");
    expect(() => protocol.emitStandalonePromiseCombinator(ctx, {} as FunctionContext, "all", [])).toThrow(
      "Missing observable Promise combinator protocol services",
    );
    expect(legacy).not.toHaveBeenCalled();
  });

  it("refuses a missing pipeline record rather than selecting legacy behavior", () => {
    const ctx = { ...context(), promiseObservableCombinatorServices: undefined } as unknown as CodegenContext;
    const legacy = vi.spyOn(combinators, "emitStandalonePromiseCombinator");
    expect(() =>
      separate.emitObservableStandalonePromiseCombinatorLiteral(ctx, {} as FunctionContext, "all", []),
    ).toThrow("Missing observable Promise combinator pipeline services");
    expect(legacy).not.toHaveBeenCalled();
  });
});
