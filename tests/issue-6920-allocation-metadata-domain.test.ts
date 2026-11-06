// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.

import { describe, expect, it } from "vitest";
import { AllocSiteRegistry, ALLOC_NAMESPACES } from "../src/ir/analysis/alloc-registry.js";
import type { AllocRegistrySnapshot } from "../src/ir/analysis/contracts/allocations.js";
import { AccessSet } from "../src/ir/analysis/lattice.js";
import { captureAllocationEvidenceCensus } from "../src/ir/analysis/allocation-evidence/census.js";
import {
  checkRegistryEvidenceMetadataDomain,
  compareRegistryEvidence,
  indexRegistryEvidence,
} from "../src/ir/analysis/allocation-evidence/metadata.js";
import { asAllocSiteId, asBlockId, type IrModule } from "../src/ir/core/nodes.js";
import { IrFunctionBuilder } from "../src/ir/builder.js";
import { irVal, irVec } from "../src/ir/core/types.js";
import { createTestIrFunctionIdentityFactory } from "./helpers/ir-identities.js";

const site = asAllocSiteId(0);
const namespaces = [ALLOC_NAMESPACES.ownership, ALLOC_NAMESPACES.escape, ALLOC_NAMESPACES.encoding];
function snapshot(entries: readonly (readonly [string, unknown])[]): AllocRegistrySnapshot {
  return {
    size: 1,
    entries: [{ state: "live", site: { id: site, kind: "array", type: irVec(irVal({ kind: "f64" }), false) } }],
    metadata: [{ id: site, entries }],
  };
}
function check(namespace: string, value: unknown) {
  return checkRegistryEvidenceMetadataDomain(indexRegistryEvidence(snapshot([[namespace, value]])));
}
const invalid = { kind: "invalid", code: "namespace-value", at: { kind: "site", site } };
// Defaults apply only to omitted arguments; explicit undefined is malformed DATA.
const ownership = (...args: [ops?: unknown, state?: unknown]) => ({
  state: args.length < 2 ? "owned" : args[1],
  ops: args.length < 1 ? ["read"] : args[0],
});
const escapeMetadata = (...args: [classification?: unknown, stackAllocatable?: unknown]) => ({
  classification: args.length < 1 ? "local" : args[0],
  stackAllocatable: args.length < 2 ? true : args[1],
});

describe("issue-6920 allocation metadata value domains", () => {
  it("accepts every canonical ownership state, ordered access subset and boolean marker", () => {
    const accesses = ["read", "write", "mutate", "identity", "escape"];
    expect(AccessSet.full().toArray()).toEqual(accesses);
    let cases = 0;
    for (const state of ["owned", "borrowed", "shared", "escaped"]) {
      for (let mask = 0; mask < 32; mask++) {
        const ops = accesses.filter((_, offset) => mask & (1 << offset));
        for (const marker of [undefined, false, true]) {
          const value = { ...ownership(ops, state), ...(marker === undefined ? {} : { stackCandidate: marker }) };
          expect(check(ALLOC_NAMESPACES.ownership, value)).toBeUndefined();
          cases++;
        }
      }
    }
    expect(cases).toBe(384);
  });

  it("accepts exactly the canonical escape and encoding domains", () => {
    for (const classification of ["local", "returned", "stored", "captured", "opaque"]) {
      expect(
        check(ALLOC_NAMESPACES.escape, escapeMetadata(classification, classification === "local")),
      ).toBeUndefined();
      expect(check(ALLOC_NAMESPACES.escape, escapeMetadata(classification, classification !== "local"))).toEqual(
        invalid,
      );
    }
    for (const encoding of ["ascii", "utf8-guaranteed", "wtf16"])
      expect(check(ALLOC_NAMESPACES.encoding, encoding)).toBeUndefined();
  });

  it("rejects missing, extra, symbolic and wrong-domain fields", () => {
    for (const state of [undefined, null, 0, true, "local", "toString", "__proto__", "constructor"])
      expect(check(ALLOC_NAMESPACES.ownership, ownership([], state))).toEqual(invalid);
    for (const value of [null, undefined, [], {}, { state: "owned" }, { ops: [] }, { ...ownership(), extra: 1 }])
      expect(check(ALLOC_NAMESPACES.ownership, value)).toEqual(invalid);
    expect(check(ALLOC_NAMESPACES.ownership, { ...ownership(), [Symbol("extra")]: 1 })).toEqual(invalid);
    for (const value of [undefined, null, true, 0, "owned", "utf8", "toString", "__proto__", "constructor"])
      expect(check(ALLOC_NAMESPACES.encoding, value)).toEqual(invalid);
    for (const value of [
      undefined,
      null,
      {},
      escapeMetadata(undefined),
      escapeMetadata("owned"),
      escapeMetadata("constructor"),
      { ...escapeMetadata(), extra: 1 },
    ])
      expect(check(ALLOC_NAMESPACES.escape, value)).toEqual(invalid);
    for (const value of [undefined, null, 0, 1, "true"])
      expect(check(ALLOC_NAMESPACES.escape, escapeMetadata("local", value))).toEqual(invalid);
  });

  it("rejects malformed markers while retaining optional false and true DATA markers", () => {
    for (const stackCandidate of [undefined, null, 0, 1, "true", {}])
      expect(check(ALLOC_NAMESPACES.ownership, { ...ownership(), stackCandidate })).toEqual(invalid);
  });

  it("rejects duplicate, reversed, foreign, sparse and oversized access arrays", () => {
    for (const ops of [
      ["read", "read"],
      ["write", "read"],
      ["read", "unknown"],
      [undefined],
      new Array(1),
      new Array(6),
      ["read", "write", "mutate", "identity", "escape", "escape"],
      { 0: "read", length: 1 },
      "read",
      null,
      undefined,
    ])
      expect(check(ALLOC_NAMESPACES.ownership, ownership(ops))).toEqual(invalid);
    const sparse = new Array(2);
    sparse[1] = "write";
    expect(check(ALLOC_NAMESPACES.ownership, ownership(sparse))).toEqual(invalid);
    expect(check(ALLOC_NAMESPACES.ownership, ownership(Object.assign(["read"], { extra: true })))).toEqual(invalid);
  });

  it("never invokes array includes, iterator or accessor methods supplied by metadata", () => {
    let calls = 0;
    const hostile = () => {
      calls++;
      throw new Error("metadata method invoked");
    };
    for (const key of ["includes", "filter", "values", Symbol.iterator]) {
      const data = ["read"];
      Object.defineProperty(data, key, { value: hostile });
      expect(check(ALLOC_NAMESPACES.ownership, ownership(data))).toEqual(invalid);
      const accessor = ["read"];
      Object.defineProperty(accessor, key, { get: hostile });
      expect(check(ALLOC_NAMESPACES.ownership, ownership(accessor))).toEqual(invalid);
    }
    const inherited = ["read"];
    Object.setPrototypeOf(inherited, Object.create(Array.prototype, { includes: { get: hostile } }));
    expect(check(ALLOC_NAMESPACES.ownership, ownership(inherited))).toBeUndefined();
    expect(calls).toBe(0);
  });

  it("rejects indexed and record accessors without evaluating getters", () => {
    let calls = 0;
    const getter = () => {
      calls++;
      throw new Error("metadata getter invoked");
    };
    const accessors: readonly [string, object, string][] = [
      [ALLOC_NAMESPACES.ownership, ownership(), "state"],
      [ALLOC_NAMESPACES.ownership, ownership(), "ops"],
      [ALLOC_NAMESPACES.ownership, { ...ownership(), stackCandidate: true }, "stackCandidate"],
      [ALLOC_NAMESPACES.escape, escapeMetadata(), "classification"],
      [ALLOC_NAMESPACES.escape, escapeMetadata(), "stackAllocatable"],
    ];
    for (const [namespace, value, key] of accessors) {
      Object.defineProperty(value, key, { get: getter });
      expect(check(namespace, value)).toEqual(invalid);
    }
    const indexed = ["read"];
    Object.defineProperty(indexed, "0", { get: getter });
    expect(check(ALLOC_NAMESPACES.ownership, ownership(indexed))).toEqual(invalid);
    expect(calls).toBe(0);
  });

  it("keeps absent cells distinct from present undefined and leaves extensions outside its authority", () => {
    for (const registry of [{ ...snapshot([]), metadata: [] }, snapshot([])]) {
      const before = structuredClone(registry);
      expect(checkRegistryEvidenceMetadataDomain(indexRegistryEvidence(registry))).toBeUndefined();
      expect(registry).toEqual(before);
    }
    for (const namespace of namespaces) expect(check(namespace, undefined)).toEqual(invalid);
    for (const value of [undefined, null, "unknown", { future: true }])
      expect(check("future-extension", value)).toBeUndefined();
  });

  it("preserves row order, namespace order and the exact first invalid site", () => {
    const registry: AllocRegistrySnapshot = {
      size: 3,
      entries: [0, 1, 2].map((id) => ({
        state: "live",
        site: { id: asAllocSiteId(id), kind: "array", type: irVec(irVal({ kind: "f64" }), false) },
      })),
      metadata: [
        { id: asAllocSiteId(2), entries: [[ALLOC_NAMESPACES.ownership, ownership()]] },
        {
          id: asAllocSiteId(1),
          entries: [
            ["extension", undefined],
            [ALLOC_NAMESPACES.encoding, undefined],
          ],
        },
        { id: site, entries: [[ALLOC_NAMESPACES.escape, undefined]] },
      ],
    };
    const before = structuredClone(registry);
    const index = indexRegistryEvidence(registry);
    expect(checkRegistryEvidenceMetadataDomain(index)).toEqual({
      ...invalid,
      at: { kind: "site", site: asAllocSiteId(1) },
    });
    expect([...index.rows.keys()]).toEqual([2, 1, 0]);
    expect([...index.rows.get(asAllocSiteId(1))!.keys()]).toEqual(["extension", ALLOC_NAMESPACES.encoding]);
    expect(registry).toEqual(before);
  });

  it("domain success grants neither body truth nor canonical ownership-marker acceptance", () => {
    const registry = new AllocSiteRegistry();
    const f64 = irVal({ kind: "f64" });
    const i32 = irVal({ kind: "i32" });
    const ids = createTestIrFunctionIdentityFactory("issue-6920-allocation-metadata-body-truth");
    const builder = new IrFunctionBuilder(ids.next("finite-vector"), [f64], false, registry);
    builder.openBlock();
    const value = builder.emitConst({ kind: "f64", value: 1.5 }, f64);
    const offset = builder.emitConst({ kind: "i32", value: 0 }, i32);
    const vector = builder.emitVecNewFixed([value], f64, irVec(f64, false));
    const read = builder.emitVecGet(vector, offset, f64);
    builder.terminate({ kind: "return", values: [read] });
    registry.annotate(site, ALLOC_NAMESPACES.ownership, ownership());
    const capturedSnapshot = registry.snapshot();
    const census = captureAllocationEvidenceCensus({ functions: [builder.finish()] }, capturedSnapshot);
    expect(census.kind).toBe("captured");
    if (census.kind !== "captured") throw new Error("finite vector fixture was not captured");
    expect(census.allocations.get(site)?.toArray()).toEqual(["read"]);
    const indexWithOwnership = (value: unknown) =>
      indexRegistryEvidence({
        ...capturedSnapshot,
        metadata: [{ id: site, entries: [[ALLOC_NAMESPACES.ownership, value]] }],
      });
    const matching = indexWithOwnership(ownership());
    expect(checkRegistryEvidenceMetadataDomain(matching)).toBeUndefined();
    expect(compareRegistryEvidence(matching, census)).toBeUndefined();
    for (const value of [ownership(["read"], "borrowed"), ownership(["write"])]) {
      const index = indexWithOwnership(value);
      expect(checkRegistryEvidenceMetadataDomain(index)).toBeUndefined();
      expect(compareRegistryEvidence(index, census)).toEqual(invalid);
    }
    const marked = indexWithOwnership({ ...ownership(), stackCandidate: false });
    expect(checkRegistryEvidenceMetadataDomain(marked)).toBeUndefined();
    expect(compareRegistryEvidence(marked, census)).toEqual({ ...invalid, code: "noncanonical-ownership-marker" });
  });

  it("can reject malformed metadata independently of a body outside finite coverage", () => {
    const identities = createTestIrFunctionIdentityFactory("issue-6920-allocation-metadata-domain");
    const module: IrModule = {
      functions: [
        {
          unitId: identities.unit(0),
          name: "outside-finite-profile",
          params: [],
          resultTypes: [],
          exported: false,
          blocks: [
            {
              id: asBlockId(0),
              blockArgs: [],
              blockArgTypes: [],
              instrs: [],
              terminator: { kind: "return", values: [] },
            },
            {
              id: asBlockId(1),
              blockArgs: [],
              blockArgTypes: [],
              instrs: [],
              terminator: { kind: "return", values: [] },
            },
          ],
          valueCount: 0,
        },
      ],
    };
    const registry = snapshot([[ALLOC_NAMESPACES.ownership, ownership([], "not-an-ownership")]]);
    expect(captureAllocationEvidenceCensus(module, registry)).toMatchObject({
      kind: "not-covered",
      reason: "function-shape",
    });
    expect(checkRegistryEvidenceMetadataDomain(indexRegistryEvidence(registry))).toEqual(invalid);
    const valid = snapshot([[ALLOC_NAMESPACES.ownership, ownership()]]);
    expect(checkRegistryEvidenceMetadataDomain(indexRegistryEvidence(valid))).toBeUndefined();
    expect(captureAllocationEvidenceCensus(module, valid)).toMatchObject({
      kind: "not-covered",
      reason: "function-shape",
    });
  });
});
