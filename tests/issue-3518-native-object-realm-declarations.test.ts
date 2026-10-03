// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import { afterEach, describe, expect, it } from "vitest";
import { setImmediate } from "node:timers/promises";
import {
  publicRealmFoundation,
  publicRealmClosures,
  publicRealmDeclarations,
  publicRealmSourceSlots,
  publicRealmSourceRuntime,
} from "./helpers/native-object-realm.js";
import { fillRealmLayoutFixture, ext } from "./helpers/native-realm-object-layouts.js";
import { NATIVE_REALM_CATALOG } from "../src/runtime/contracts/native-realm-catalog.js";
import { deriveNativeRealmRequirements } from "../src/ir/program/native-realm-requirements.js";
import { planNativeInvocationRequirements } from "../src/ir/program/native-invocation-requirements.js";
import {
  declareNativePublicBuiltinFunctionRequests,
  declareNativeBuiltinFunctionRequests,
  requireNativeBuiltinFunctionRequestIssuer,
  requireNativeBuiltinFunctionRequests,
  requireNativePublicBuiltinFunctionRequests,
} from "../src/backend/wasmgc/resources/native-builtin-function-requests.js";
import {
  reserveNativeObjectRealmException,
  requireNativeObjectRealmException,
  reserveNativeObjectRealmDeclarations,
  requireNativeObjectRealmDeclarations,
  fillNativeObjectRealmDeclarations,
  requireCompletedNativeObjectRealmDeclarations,
  requireCompletedNativeObjectRealm,
  nativeObjectRealmDeclarationInventory,
} from "../src/backend/wasmgc/resources/native-object-realm.js";
import {
  requireNativeSourceClosureTypes,
  nativeSourceClosureRealmState,
} from "../src/backend/wasmgc/resources/native-source-closures.js";
import {
  bindNativeRealmSourceClosureCallables,
  requireNativeRealmSourceClosureCallables,
} from "../src/backend/wasmgc/resources/native-source-closure-callables.js";
import {
  bindNativeSourceClosureUnits,
  nativeRealmSourceClosureCallableBindings,
  requireCompletedNativeSourceClosures,
} from "../src/ir/program-native-invocation.js";
import { createEmptyModule } from "../src/ir/types.js";
import { PhysicalModuleReservations } from "../src/wasm/physical/module-reservations.js";
import { indexPhysicalTypes } from "../src/wasm/physical/type-layout.js";
import { forEachInstrDeep, type IrInstrCall } from "../src/ir/core/nodes.js";
import { reserveNativeVectorTypes } from "../src/backend/wasmgc/resources/native-vectors.js";

afterEach(async () => {
  await setImmediate();
});
const population = (f: ReturnType<typeof publicRealmFoundation>) => [
  f.module.types.length,
  f.module.functions.length,
  f.module.globals.length,
  f.module.tags.length,
  f.module.imports.length,
];
const asAny = (value: unknown): any => value;

describe("authentic full-catalog request issuer", () => {
  it("retains every catalog entry and all unavailable roles without casting them to bootstrap behaviors", () => {
    const f = publicRealmFoundation();
    expect(f.realm.description.catalog).toEqual(NATIVE_REALM_CATALOG);
    expect(f.realm.description.catalog.intrinsics).toHaveLength(45);
    expect(f.requests.intrinsics).toHaveLength(44);
    expect(f.requests.requests).toHaveLength(88);
    expect(f.requests.intrinsics.filter((row) => row.intrinsic.callable.implementation === "unavailable")).toHaveLength(
      42,
    );
    expect(requireNativeBuiltinFunctionRequestIssuer(f.tx, f.requests)).toBe(f.requests);
    expect(() => requireNativeBuiltinFunctionRequests(f.tx, asAny(f.requests))).toThrow(
      "foreign or copied request issuer",
    );
    expect(f.requests.referenceTypes).toEqual([f.substrate.arguments.carrier]);
    for (const row of f.requests.intrinsics) {
      expect(row.intrinsic).toBe(f.realm.description.catalog.intrinsics.find((entry) => entry.id === row.intrinsic.id));
      const metadata = f.requests.requests.find((request) => request.id === row.metadataId)!;
      expect(metadata).toMatchObject({
        name: row.intrinsic.callable.initialName,
        length: row.intrinsic.callable.length,
      });
    }
  });
  it("keeps the existing bootstrap issuer separately authenticated by both guards", () => {
    const f = publicRealmFoundation();
    const requirements = {
      key: "bootstrap-control",
      intrinsics: [
        {
          id: "fp",
          behavior: "function-prototype" as const,
          signatureId: "fp:signature",
          metadataId: "fp:metadata",
          initialName: "",
          initialLength: 0,
          userFormalCount: 0,
          prototype: "object-prototype" as const,
          constructible: false as const,
          aliases: ["Function.prototype"],
        },
      ],
    };
    const bootstrap = declareNativeBuiltinFunctionRequests(f.tx, requirements, f.requestDependencies);
    expect(requireNativeBuiltinFunctionRequests(f.tx, bootstrap)).toBe(bootstrap);
    expect(requireNativeBuiltinFunctionRequestIssuer(f.tx, bootstrap)).toBe(bootstrap);
    expect(() => requireNativePublicBuiltinFunctionRequests(f.tx, asAny(bootstrap))).toThrow(
      "foreign or copied public request issuer",
    );
  });
  it("rejects cloned, foreign, and different genuine requirement identities before closure allocation", () => {
    const f = publicRealmFoundation(),
      other = publicRealmFoundation();
    const before = population(f);
    expect(() => requireNativeBuiltinFunctionRequestIssuer(f.tx, { ...f.requests })).toThrow(
      "foreign or copied request issuer family",
    );
    expect(() => requireNativeBuiltinFunctionRequestIssuer(other.tx, f.requests)).toThrow(
      "foreign or copied public request issuer",
    );
    const equal = deriveNativeRealmRequirements(f.program, f.projection, f.realm.source)!;
    expect(() => requireNativePublicBuiltinFunctionRequests(f.tx, f.requests, equal)).toThrow(
      "foreign or copied public request issuer",
    );
    expect(() => declareNativePublicBuiltinFunctionRequests(f.tx, { ...f.realm }, f.requestDependencies)).toThrow(
      "unissued, copied or detached realm requirements",
    );
    expect(population(f)).toEqual(before);
  });
  it("rejects hidden/accessor roles without running callbacks and retains the original dependency identities", () => {
    const f = publicRealmFoundation();
    let calls = 0;
    const before = population(f);
    for (const accessor of [false, true]) {
      const bad = { ...f.requestDependencies };
      Object.defineProperty(
        bad,
        "arguments",
        accessor
          ? {
              enumerable: true,
              get() {
                calls++;
                return f.substrate.arguments;
              },
            }
          : { enumerable: false, value: f.substrate.arguments },
      );
      expect(() => declareNativePublicBuiltinFunctionRequests(f.tx, f.realm, bad)).toThrow("non-data input record");
    }
    expect(calls).toBe(0);
    expect(population(f)).toEqual(before);
    asAny(f.requestDependencies).argumentPlan = { ...f.substrate.argumentPlan };
    expect(() => requireNativePublicBuiltinFunctionRequests(f.tx, f.requests)).toThrow(
      /changed public dependency identities|declaration plan/,
    );
  });
  it("rechecks the original mutable projection before reusing public request or tag packets", () => {
    const f = publicRealmFoundation(false, true, true);
    const projection = {
      ...f.projection,
      prepared: { ...f.projection.prepared, functions: structuredClone(f.projection.prepared.functions) },
    };
    const program = {
      ...f.program,
      ir: { ...f.program.ir, functions: structuredClone(f.program.ir.functions) },
      runtime: [projection],
    };
    const realm = deriveNativeRealmRequirements(program, projection)!;
    const requests = declareNativePublicBuiltinFunctionRequests(f.tx, realm, f.requestDependencies);
    const tagModule = createEmptyModule(),
      tagTx = new PhysicalModuleReservations(tagModule);
    const tag = reserveNativeObjectRealmException(tagTx, realm, { required: true, shared: false });
    let call: IrInstrCall | undefined;
    for (const fn of projection.prepared.functions)
      for (const block of fn.blocks)
        for (const root of block.instrs)
          forEachInstrDeep(root, (node) => {
            if (node.kind === "call") call ??= node;
          });
    if (!call) throw Error("genuine Object.create call demand disappeared");
    (call.target as { name: string }).name += "-stale";
    const before = population(f);
    expect(() => requireNativePublicBuiltinFunctionRequests(f.tx, requests)).toThrow();
    expect(() => requireNativeObjectRealmException(tagTx, tag, realm)).toThrow();
    expect(population(f)).toEqual(before);
  });
});

for (const displaced of [false, true])
  for (const decoded of [false, true])
    it(`executes actual source slots with the full catalog type suffix, displaced=${displaced}, decoded=${decoded}`, () => {
      const r = publicRealmSourceRuntime(displaced, decoded);
      expect(WebAssembly.Module.imports(r.wasm)).toEqual([]);
      expect(r.callables.entries).toHaveLength(2);
      expect(r.callables.completionScope).toBe("source-call-association");
      expect(r.c.closures.metadata).toHaveLength(44);
      expect(
        r.c.closurePlan.requirements.requests.slice(0, r.c.source!.requirements.signatures.length).map((row) => row.id),
      ).toEqual(r.c.source!.requirements.signatures.map((row) => row.id));
      expect(r.c.closurePlan.requirements.requests.slice(-88)).toEqual(r.f.requests.requests);
      expect(
        planNativeInvocationRequirements(r.c.source!.requirements, {
          utf8Storage: displaced,
          objectAccess: r.f.realm.access,
        }),
      ).toBeUndefined();
      expect(nativeSourceClosureRealmState(r.f.tx, r.c.source!.types)).toBe(r.f.pack);
      const a = r.instance(),
        b = r.instance();
      expect(() => a.makeEmpty!()).toThrow(WebAssembly.RuntimeError);
      a.initialize!({ control: "actual source prototype operand" });
      b.initialize!({ control: "another source prototype operand" });
      const captured = a.makeCaptured!(13),
        second = a.makeCaptured!(100),
        empty = a.makeEmpty!();
      expect(a.call!(captured, 7)).toBe(20);
      expect(a.call!(second, 7)).toBe(107);
      expect(a.call!(empty, 3)).toBe(10);
      expect(b.call!(b.makeCaptured!(21), 2)).toBe(23);
      expect(Object.is(captured, second)).toBe(false);
      expect(r.callables.entries.map((entry) => entry.shape.type.object)).toEqual(
        r.c.source!.types.shapes.map((row) => row.type.object),
      );
    });

describe("all-source Call association without selected invocation demands", () => {
  it("requires the real original unit binding and refuses raw filled-slot completion", () => {
    const f = publicRealmFoundation(),
      c = publicRealmClosures(f),
      s = publicRealmSourceSlots(f, c);
    expect(() => nativeRealmSourceClosureCallableBindings(f.tx, c.source!, f.realm)).toThrow("have not been bound");
    f.tx.freezeReservations();
    bindNativeSourceClosureUnits(f.tx, c.source!, s.slots);
    const bound = nativeRealmSourceClosureCallableBindings(f.tx, c.source!, f.realm);
    expect(requireNativeRealmSourceClosureCallables(f.tx, bound, c.source!.types, f.realm)).toBe(bound);
    expect(nativeRealmSourceClosureCallableBindings(f.tx, c.source!, f.realm)).toBe(bound);
    for (const row of bound.entries) f.tx.fillFunction(row.slot, { locals: [], body: [{ op: "f64.const", value: 9 }] });
    expect(() => requireCompletedNativeSourceClosures(f.tx, c.source!)).toThrow("canonical lowering is incomplete");
    expect(() => requireNativeRealmSourceClosureCallables(f.tx, { ...bound }, c.source!.types, f.realm)).toThrow(
      "foreign, copied or substituted realm callable association",
    );
    expect(() => bindNativeRealmSourceClosureCallables(f.tx, c.source!.types, s.slots, f.realm)).toThrow(
      "one frozen binding",
    );
  });
  it("refuses a missing original source slot and a different genuine realm association", () => {
    const f = publicRealmFoundation(),
      c = publicRealmClosures(f),
      s = publicRealmSourceSlots(f, c);
    f.tx.freezeReservations();
    bindNativeSourceClosureUnits(f.tx, c.source!, s.slots);
    const bad = new Map(s.slots);
    bad.delete(c.source!.requirements.units[0]!.unitId);
    expect(() => bindNativeRealmSourceClosureCallables(f.tx, c.source!.types, bad, f.realm)).toThrow(
      "no exact prepared source and original function slot",
    );
    const real = nativeRealmSourceClosureCallableBindings(f.tx, c.source!, f.realm);
    const other = deriveNativeRealmRequirements(f.program, f.projection, f.realm.source)!;
    expect(() => requireNativeRealmSourceClosureCallables(f.tx, real, c.source!.types, other)).toThrow(
      "foreign, copied or substituted realm callable association",
    );
  });
});

describe("private canonical exception role", () => {
  for (const shared of [false, true])
    it(`borrows the only canonical ${shared ? "imported" : "defined"} tag`, () => {
      const f = publicRealmFoundation(false, false, false, shared),
        c = publicRealmDeclarations(f);
      expect(c.declarations.exception).toBe(f.exception);
      expect(f.exception.tag.key).toBe("physical:exception-tag");
      expect(f.module.tags).toHaveLength(shared ? 0 : 1);
      expect(f.module.imports).toEqual(
        shared
          ? [
              {
                module: "env",
                name: "__exn",
                desc: {
                  kind: "tag",
                  typeIdx:
                    f.exception.tag.kind === "tag-import" && f.exception.tag.object.desc.kind === "tag"
                      ? f.exception.tag.object.desc.typeIdx
                      : -1,
                },
              },
            ]
          : [],
      );
      const before = population(f);
      expect(() => reserveNativeObjectRealmException(f.tx, f.realm, f.exceptionSelection)).toThrow(
        "already has an owner",
      );
      expect(population(f)).toEqual(before);
      f.tx.freezeReservations();
      expect(requireNativeObjectRealmException(f.tx, f.exception, f.realm)).toBe(f.exception);
      expect(f.tx.physicalIndex(f.exception.tag)).toBe(0);
    });
  it("rejects a preexisting canonical key without allocating a second tag", () => {
    const f = publicRealmFoundation();
    const module = createEmptyModule(),
      tx = new PhysicalModuleReservations(module);
    tx.reserveTag("physical:exception-tag", { params: [ext], results: [] }, { kind: "defined", name: "__exn" });
    const before = [module.tags.length, module.imports.length, module.types.length];
    expect(() => reserveNativeObjectRealmException(tx, f.realm, { required: true, shared: false })).toThrow(
      "duplicate planned resource key",
    );
    expect([module.tags.length, module.imports.length, module.types.length]).toEqual(before);
  });
  it("rejects copied/foreign/raw tags, stale policy and policy accessors without executing them", () => {
    const f = publicRealmFoundation(),
      other = publicRealmFoundation();
    expect(() => requireNativeObjectRealmException(f.tx, { ...f.exception }, f.realm)).toThrow(
      "foreign, copied or substituted",
    );
    expect(() => requireNativeObjectRealmException(other.tx, f.exception, f.realm)).toThrow(
      "foreign, copied or substituted",
    );
    expect(() => requireNativeObjectRealmException(f.tx, asAny(f.exception.tag), f.realm)).toThrow(
      "foreign, copied or substituted",
    );
    f.exceptionSelection.shared = true;
    expect(() => requireNativeObjectRealmException(f.tx, f.exception, f.realm)).toThrow(
      "changed checked exception linkage selection",
    );
    const module = createEmptyModule(),
      tx = new PhysicalModuleReservations(module);
    let calls = 0;
    const bad = {
      required: true,
      get shared() {
        calls++;
        return false;
      },
    };
    expect(() => reserveNativeObjectRealmException(tx, other.realm, asAny(bad))).toThrow(
      "own enumerable dependency value required",
    );
    expect(calls).toBe(0);
    expect(module.tags).toHaveLength(0);
    expect(module.types).toHaveLength(0);
  });
});

describe("pending full catalog population", () => {
  for (const displaced of [false, true])
    it(`retains actual roots, aliases, metadata and separate Call/Construct slots, displaced=${displaced}`, () => {
      const f = publicRealmFoundation(displaced),
        c = publicRealmDeclarations(f),
        p = c.declarations;
      expect(p.entries).toHaveLength(44);
      expect(p.entries.map((row) => row.request.intrinsic.id)).toEqual(
        f.requests.intrinsics.map((row) => row.intrinsic.id),
      );
      expect(p.objectPrototype.type).toBe(f.pack.types.objectPrototype);
      expect(p.globals.realm).toBe(f.pack.anchors.realm);
      expect(p.entries.find((row) => row.request.intrinsic.id === "%Function.prototype%")!.singleton).toBe(
        f.pack.anchors.functionPrototype,
      );
      expect(new Set(p.entries.map((row) => row.metadata.metadata.id)).size).toBe(44);
      expect(new Set(p.entries.map((row) => row.singleton)).size).toBe(44);
      expect(p.entries.filter((row) => row.construct).map((row) => row.request.intrinsic.id)).toEqual([
        "%Object%",
        "%Function%",
      ]);
      const table = indexPhysicalTypes(f.module.types);
      for (const row of p.entries) {
        expect(row.type.object).toMatchObject({
          kind: "struct",
          superTypeIdx: row.metadata.type.typeIndex,
          final: true,
        });
        expect(asAny(row.type.object).fields).toHaveLength(8);
        expect(asAny(row.type.object).fields.slice(5)).toEqual([
          { name: "[[Prototype]]", type: ext, mutable: true },
          { name: "[[Realm]]", type: { kind: "ref", typeIdx: f.pack.types.identity.typeIndex }, mutable: false },
          { name: "[[InitialName]]", type: { kind: "ref", typeIdx: f.strings.layout.anyStrTypeIdx }, mutable: false },
        ]);
        expect(row.lifted.object.typeIdx).toBe(row.metadata.signature.liftedFuncTypeIndex);
        expect(table.entries[row.algorithm.object.typeIdx]!.definition).toMatchObject({
          params: [ext, { kind: "ref", typeIdx: f.substrate.arguments.carrier.typeIndex }],
          results: [ext],
        });
        if (row.construct)
          expect(table.entries[row.construct.object.typeIdx]!.definition).toMatchObject({
            params: [
              { kind: "ref", typeIdx: c.closures.root.typeIndex },
              { kind: "ref", typeIdx: f.substrate.arguments.carrier.typeIndex },
              ext,
            ],
            results: [ext],
          });
      }
      const inventory = nativeObjectRealmDeclarationInventory(f.tx, p);
      expect(inventory.types).toHaveLength(44);
      expect(inventory.functions).toHaveLength(91);
      expect(inventory.globals).toHaveLength(46);
      expect(inventory.globals).not.toContain(f.pack.anchors.realm);
      expect(inventory.globals).not.toContain(f.pack.anchors.functionPrototype);
      expect(requireNativeObjectRealmDeclarations(f.tx, p, c.dependencies)).toBe(p);
    });
  for (const decoded of [false, true])
    it(`uses genuine source-produced no-source Object.create(null) demands, decoded=${decoded}`, () => {
      const f = publicRealmFoundation(false, decoded, true),
        c = publicRealmDeclarations(f);
      expect(f.realm.source).toBeUndefined();
      expect(f.realm.access.uses.length).toBeGreaterThan(0);
      expect(c.source).toBeUndefined();
      expect(c.closures.metadata).toHaveLength(44);
      expect(c.closurePlan.requirements.requests).toEqual(f.requests.requests);
      expect(c.declarations.completionScope).toBe("public-realm-declarations-only");
    });
  it("fills only module null/zero initializers and never certifies public readiness", () => {
    const f = publicRealmFoundation(),
      c = publicRealmDeclarations(f),
      p = c.declarations;
    f.tx.freezeReservations();
    fillRealmLayoutFixture(f);
    fillNativeObjectRealmDeclarations(f.tx, p);
    expect(requireCompletedNativeObjectRealmDeclarations(f.tx, p)).toBe(p);
    expect(p.globals.wholeRealmReady.object.init).toEqual([{ op: "i32.const", value: 0 }]);
    expect(p.globals.realm.object.init).toEqual([{ op: "ref.null", typeIdx: f.pack.types.identity.typeIndex }]);
    expect(p.globals.functionPrototype.object.init).toEqual([{ op: "ref.null.extern" }]);
    expect(p.objectPrototype.singleton.object.init).toEqual([
      { op: "ref.null", typeIdx: f.pack.types.objectPrototype.typeIndex },
    ]);
    expect(() => requireCompletedNativeObjectRealm(f.tx, p)).toThrow(
      "full Object/Function algorithms and runtime population remain incomplete",
    );
    expect(() => fillNativeObjectRealmDeclarations(f.tx, p)).toThrow("duplicate declaration fill");
  });
  it("claims one population before allocation and preflights its last key before any owned write", () => {
    const control = publicRealmFoundation(),
      original = publicRealmDeclarations(control);
    const inventory = nativeObjectRealmDeclarationInventory(control.tx, original.declarations),
      before = population(control);
    expect(() => reserveNativeObjectRealmDeclarations(control.tx, control.realm, original.dependencies)).toThrow(
      "already have a public population owner",
    );
    expect(population(control)).toEqual(before);
    const f = publicRealmFoundation(),
      c = publicRealmClosures(f);
    f.tx.reserveFunction(inventory.keys.at(-1)!, "collision", { params: [], results: [] });
    const collision = population(f);
    expect(() => publicRealmDeclarations(f, c)).toThrow("duplicate planned resource key");
    expect(population(f)).toEqual(collision);
  });
  it("rejects absent source state and a different authentic public request issuer before allocation", () => {
    const f = publicRealmFoundation(),
      c = publicRealmClosures(f, false),
      before = population(f);
    expect(() => publicRealmDeclarations(f, c)).toThrow("missing or substituted source realm state");
    expect(population(f)).toEqual(before);
    const g = publicRealmFoundation(),
      d = publicRealmDeclarations(g);
    const other = declareNativePublicBuiltinFunctionRequests(g.tx, g.realm, g.requestDependencies);
    expect(() => requireNativeSourceClosureTypes(g.tx, d.source!.types, g.realm.source!, other)).toThrow(
      "foreign builtin request issuer",
    );
    expect(() =>
      requireNativeObjectRealmDeclarations(g.tx, d.declarations, { ...d.dependencies, requests: other }),
    ).toThrow("foreign expected public dependencies");
  });
  it("rejects copied/foreign owners and changed retained dependencies", () => {
    const f = publicRealmFoundation(),
      c = publicRealmDeclarations(f),
      other = publicRealmFoundation();
    expect(() => requireNativeObjectRealmDeclarations(f.tx, { ...c.declarations })).toThrow(
      "foreign or copied public declarations",
    );
    expect(() => requireNativeObjectRealmDeclarations(other.tx, c.declarations)).toThrow(
      "foreign or copied public declarations",
    );
    asAny(c.dependencies).exception = other.exception;
    expect(() => requireNativeObjectRealmDeclarations(f.tx, c.declarations)).toThrow(
      "foreign, copied or substituted public exception owner",
    );
  });
  it("rejects a same-ledger alternate genuine vector carrier owner before pending allocation", () => {
    const f = publicRealmFoundation(),
      c = publicRealmClosures(f);
    expect(f.vectorPlan.layouts).toHaveLength(0);
    const alternate = reserveNativeVectorTypes(f.tx, f.vectorPlan);
    expect(alternate).not.toBe(f.vectors);
    const dependencies = {
      requests: f.requests,
      closures: c.closures,
      closurePlan: c.closurePlan,
      layouts: f.pack,
      substrate: f.substrate,
      vectors: alternate,
      vectorPlan: f.vectorPlan,
      exception: f.exception,
      source: c.source!.types,
    };
    const before = population(f);
    expect(() => reserveNativeObjectRealmDeclarations(f.tx, f.realm, dependencies)).toThrow(
      "foreign expected dependencies",
    );
    expect(population(f)).toEqual(before);
    expect(publicRealmDeclarations(f, c).declarations.entries).toHaveLength(44);
  });
  it("does not promote caller-filled algorithm slots to a completed public realm", () => {
    const f = publicRealmFoundation(),
      c = publicRealmDeclarations(f);
    const inventory = nativeObjectRealmDeclarationInventory(f.tx, c.declarations);
    f.tx.freezeReservations();
    fillRealmLayoutFixture(f);
    fillNativeObjectRealmDeclarations(f.tx, c.declarations);
    // Fault injection only: these bodies are never emitted, executed or installed as standard methods.
    for (const slot of inventory.functions) f.tx.fillFunction(slot, { locals: [], body: [{ op: "unreachable" }] });
    expect(inventory.functions).toHaveLength(91);
    expect(() => requireCompletedNativeObjectRealm(f.tx, c.declarations)).toThrow(
      "full Object/Function algorithms and runtime population remain incomplete",
    );
  });
  it("rejects hidden/accessor dependency roles and canonical-global external fill/mutation", () => {
    const f = publicRealmFoundation(),
      c = publicRealmDeclarations(f);
    let calls = 0;
    const expected = { ...c.dependencies };
    Object.defineProperty(expected, "source", {
      enumerable: true,
      get() {
        calls++;
        return c.source!.types;
      },
    });
    expect(() => requireNativeObjectRealmDeclarations(f.tx, c.declarations, expected)).toThrow(
      "own enumerable dependency value required",
    );
    expect(calls).toBe(0);
    f.tx.freezeReservations();
    fillRealmLayoutFixture(f);
    f.tx.fillGlobal(c.declarations.objectPrototype.singleton, [
      { op: "ref.null", typeIdx: f.pack.types.objectPrototype.typeIndex },
    ]);
    expect(() => fillNativeObjectRealmDeclarations(f.tx, c.declarations)).toThrow("duplicate global fill");
    const g = publicRealmFoundation(),
      d = publicRealmDeclarations(g);
    g.tx.freezeReservations();
    fillRealmLayoutFixture(g);
    fillNativeObjectRealmDeclarations(g.tx, d.declarations);
    d.declarations.globals.state.object.init[0] = { op: "i32.const", value: 2 };
    expect(() => requireCompletedNativeObjectRealmDeclarations(g.tx, d.declarations)).toThrow(
      "altered completed global",
    );
  });
});
