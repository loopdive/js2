// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.

import { describe, expect, it } from "vitest";
import { createEmptyModule } from "../src/ir/types.js";
import { PhysicalModuleReservations } from "../src/wasm/physical/module-reservations.js";
import { createVectorBaseType } from "../src/runtime/wasmgc/values/vector-grow-store.js";
import { createArgumentVectorArrayType } from "../src/runtime/wasmgc/values/argument-vector-bodies.js";
import {
  declareNativeClosureResources,
  instantiateNativeClosureRequirements,
  reserveNativeClosureResources,
  nativeClosureReservationInventory,
  type NativeClosureDeclarationRequirements,
} from "../src/backend/wasmgc/resources/native-closures.js";
import {
  declareNativeArgumentVectorResources,
  reserveNativeArgumentVectorResources,
  nativeArgumentVectorReservationInventory,
} from "../src/backend/wasmgc/resources/native-argument-vectors.js";
import { preflightNativeResourceRecipe } from "../src/backend/wasmgc/resources/native-resource-declarations.js";

const requirements = (): NativeClosureDeclarationRequirements => ({
  key: "async:closures",
  startingClosureCounter: 3,
  referenceTypeKeys: ["external:object"],
  requests: [
    {
      kind: "signature",
      id: "ref",
      params: [{ kind: "ref_null", typeKey: "external:object" }],
      results: [],
      allocationMode: "ordinary",
      minimumArgumentCount: 1,
    },
    { kind: "metadata", id: "meta", signatureId: "ref", key: "reference", name: "reference", length: 1 },
    {
      kind: "signature",
      id: "ref-alias",
      params: [{ typeKey: "external:object", kind: "ref_null" }],
      results: [],
      allocationMode: "support",
      minimumArgumentCount: 0,
    },
    { kind: "metadata", id: "meta-alias", signatureId: "ref-alias", key: "reference", name: "reference", length: 1 },
    { kind: "signature", id: "settle", params: [{ kind: "externref" }], results: [], allocationMode: "ordinary" },
    { kind: "metadata", id: "settle-meta", signatureId: "settle", key: "promise:settle", name: "", length: 1 },
  ],
});
function fixture() {
  const module = createEmptyModule(),
    tx = new PhysicalModuleReservations(module);
  const external = tx.reserveType("external:object", { kind: "struct", name: "external", fields: [] });
  return { module, tx, external, types: new Map([[external.key, external]]) };
}
function closure() {
  const plan = declareNativeClosureResources(requirements()),
    input = fixture();
  const physical = instantiateNativeClosureRequirements(input.tx, plan, input.types);
  const pack = reserveNativeClosureResources(input.tx, physical, plan);
  return { ...input, physical, plan, pack };
}

describe("shared async declarations on existing reservation producers", () => {
  it("rejects late malformed physical requests before consuming reservation ordinals", () => {
    const positive = closure();
    expect(nativeClosureReservationInventory(positive.tx, positive.pack, positive.plan)).toHaveLength(4);
    const a = fixture(),
      plan = declareNativeClosureResources(requirements());
    const physical = instantiateNativeClosureRequirements(a.tx, plan, a.types);
    const requests = structuredClone(physical.requests);
    Object.assign(requests[5]!, { signatureId: "unknown" });
    const before = structuredClone(a.module);
    expect(() => reserveNativeClosureResources(a.tx, { ...physical, requests }, plan)).toThrow(
      "metadata must refer to an earlier genuine signature request",
    );
    expect(a.module).toStrictEqual(before);
    const twin = fixture();
    const probe = (tx: PhysicalModuleReservations) =>
      tx.reserveType("probe", { kind: "struct", name: "probe", fields: [] }).typeIndex;
    expect(probe(a.tx)).toBe(probe(twin.tx));
  });
  it("rejects changed actual lifted signatures, not only recorded intentions", () => {
    const a = closure();
    expect(nativeClosureReservationInventory(a.tx, a.pack, a.plan)).toHaveLength(4);
    const signature = a.module.types[a.pack.signatures[0]!.binding.liftedFuncTypeIndex];
    if (signature?.kind !== "func") throw new Error("fixture actual lifted signature");
    signature.params.push({ kind: "i32" });
    expect(() => nativeClosureReservationInventory(a.tx, a.pack, a.plan)).toThrow();
  });
  it("derives symbolic identities, aliases, indexed metadata names and all interning operations without a ledger", () => {
    const plan = declareNativeClosureResources(requirements());
    expect(plan.declarations.map((row) => row.key)).toEqual([
      "async:closures:wrapper:ref",
      "async:closures:metadata:meta",
      "async:closures:wrapper:settle",
      "async:closures:metadata:settle-meta",
    ]);
    expect(plan.reservationSteps.map((step) => step.kind)).toEqual([
      "reserve",
      "intern-signature",
      "reserve",
      "reserve",
      "intern-signature",
      "reserve",
    ]);
    expect(plan.signatures).toHaveLength(3);
    expect(plan.metadata).toHaveLength(3);
    expect(plan.signatures[0]!.wrapperKey).toBe(plan.signatures[1]!.wrapperKey);
    expect(plan.metadata[0]!.typeKey).toBe(plan.metadata[1]!.typeKey);
    expect(plan.resultingClosureCounter).toBe(5);
    expect(Object.isFrozen(plan)).toBe(true);
    expect(() => preflightNativeResourceRecipe(plan, ["external:object"])).not.toThrow();
  });

  it("preserves the concrete prerequisite and exact alias bindings through reserve/freeze", () => {
    const a = closure();
    expect(a.physical.referenceTypes[0]).toBe(a.external);
    expect(a.pack.signatures[0]!.binding).toBe(a.pack.signatures[1]!.binding);
    expect(a.pack.metadata[0]!.binding).toBe(a.pack.metadata[1]!.binding);
    const rows = nativeClosureReservationInventory(a.tx, a.pack, a.plan);
    expect(rows).toHaveLength(4);
    expect(rows).not.toContain(a.external);
    a.pack.metadata.forEach(({ binding }) =>
      expect(binding.type.object.name).toBe(`__builtinfn_meta_${binding.type.typeIndex}_struct`),
    );
    a.tx.freezeReservations();
    expect(nativeClosureReservationInventory(a.tx, a.pack, a.plan)).toEqual(rows);
    expect(a.pack.signatures[0]!.binding.info.minimumArgumentCount).toBe(0);
    expect(a.pack.metadata[0]!.binding.metadata.length).toBe(1);
  });

  it.each(["numeric", "missing", "extra", "late", "metadata-signature", "metadata-length"] as const)(
    "rejects %s symbolic input before module construction",
    (mutation) => {
      expect(declareNativeClosureResources(requirements()).declarations).toHaveLength(4);
      const bad = structuredClone(requirements());
      const first = bad.requests[0]!;
      if (first.kind !== "signature") throw new Error("fixture signature");
      if (mutation === "numeric") Object.assign(first.params[0]!, { typeIdx: 0 });
      if (mutation === "missing") Object.assign(bad, { referenceTypeKeys: [] });
      if (mutation === "extra") Object.assign(bad, { referenceTypeKeys: ["external:object", "unused"] });
      if (mutation === "late") Object.assign(bad.requests[5]!, { signatureId: "missing" });
      if (mutation === "metadata-signature") Object.assign(bad.requests[5]!, { signatureId: "ref" });
      if (mutation === "metadata-length") Object.assign(bad.requests[5]!, { length: 0 });
      expect(() => declareNativeClosureResources(bad)).toThrow();
    },
  );

  it.each(["copy", "foreign", "missing", "extra"] as const)(
    "rejects %s prerequisite tokens before any dependent population changes",
    (mutation) => {
      const plan = declareNativeClosureResources(requirements()),
        good = fixture();
      expect(instantiateNativeClosureRequirements(good.tx, plan, good.types).referenceTypes).toEqual([good.external]);
      const a = fixture(),
        types = new Map(a.types),
        before = structuredClone(a.module);
      if (mutation === "copy") types.set(a.external.key, { ...a.external });
      if (mutation === "foreign") types.set(a.external.key, fixture().external);
      if (mutation === "missing") types.clear();
      if (mutation === "extra") types.set("extra", a.external);
      expect(() => instantiateNativeClosureRequirements(a.tx, plan, types)).toThrow();
      expect(a.module).toStrictEqual(before);
    },
  );

  it.each(["declarations", "steps", "requests", "indexed-name", "signature-name", "delete"] as const)(
    "rejects substituted %s before the closure cursor allocates",
    (mutation) => {
      const positive = closure();
      expect(nativeClosureReservationInventory(positive.tx, positive.pack, positive.plan)).toHaveLength(4);
      const a = fixture(),
        plan = declareNativeClosureResources(requirements());
      const physical = instantiateNativeClosureRequirements(a.tx, plan, a.types),
        bad = structuredClone(plan);
      if (mutation === "declarations") (bad.declarations as unknown[]).reverse();
      if (mutation === "steps") (bad.reservationSteps as unknown[]).reverse();
      if (mutation === "requests") (bad.requirements.requests as unknown[]).reverse();
      if (mutation === "delete") (bad.declarations as unknown[]).pop();
      if (mutation === "signature-name") Object.assign(bad.reservationSteps[1]!, { name: "changed" });
      if (mutation === "indexed-name") {
        const row = bad.declarations[1]!;
        if (row.space !== "type") throw new Error("fixture type");
        Object.assign(row.shape, { name: { kind: "array-ref-index", typeKey: bad.rootKey } });
      }
      const before = structuredClone(a.module);
      expect(() => reserveNativeClosureResources(a.tx, physical, bad)).toThrow("substituted closure declaration plan");
      expect(a.module).toStrictEqual(before);
    },
  );

  it.each([false, true])("requires the exact declaration association and adopted array identity, early=%s", (early) => {
    const module = createEmptyModule(),
      tx = new PhysicalModuleReservations(module);
    const vectorBase = tx.reserveType("base", createVectorBaseType());
    const earlyArgumentArray = early ? tx.reserveType("early", createArgumentVectorArrayType()) : undefined;
    const plan = declareNativeArgumentVectorResources(
      { key: "argv" },
      {
        vectorBaseKey: vectorBase.key,
        ...(earlyArgumentArray ? { earlyArgumentArrayKey: earlyArgumentArray.key } : {}),
      },
    );
    const deps = { vectorBase, earlyArgumentArray },
      pack = reserveNativeArgumentVectorResources(tx, { key: "argv" }, deps, plan);
    const inventory = nativeArgumentVectorReservationInventory(tx, pack, plan);
    expect(inventory.map((row) => row.key)).toEqual(
      early ? ["argv:carrier", "argv:new", "argv:push"] : ["argv:array", "argv:carrier", "argv:new", "argv:push"],
    );
    if (early) expect(pack.array).toBe(earlyArgumentArray);
    expect(() => nativeArgumentVectorReservationInventory(tx, pack, structuredClone(plan))).toThrow();
    expect(() => nativeArgumentVectorReservationInventory(tx, { ...pack }, plan)).toThrow();
    Object.assign(deps, { vectorBase: { ...vectorBase } });
    expect(() => nativeArgumentVectorReservationInventory(tx, pack, plan)).toThrow();
  });
});
