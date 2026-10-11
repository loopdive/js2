// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import { describe, expect, it } from "vitest";
import { createEmptyModule, type ValType } from "../src/ir/types.js";
import { PhysicalModuleReservations } from "../src/wasm/physical/module-reservations.js";
import type * as canonical from "../src/runtime/wasmgc/values/closure-layouts.js";
import {
  reserveNativeClosureResources,
  requireNativeClosureReservations,
  type NativeClosureRequirements,
  type NativeClosureSignatureRequest,
  type NativeClosureMetadataRequest,
} from "../src/backend/wasmgc/resources/native-closures.js";

const signature = (
  id: string,
  params: ValType[] = [{ kind: "externref" }],
  results: ValType[] = [],
  allocationMode: canonical.ClosureAllocationMode = "ordinary",
  minimumArgumentCount?: number,
): NativeClosureSignatureRequest => ({
  kind: "signature",
  id,
  params,
  results,
  allocationMode,
  ...(minimumArgumentCount === undefined ? {} : { minimumArgumentCount }),
});
const metadata = (
  id: string,
  signatureId: string,
  key = "promise:settle",
  name = "",
  length = 1,
): NativeClosureMetadataRequest => ({ kind: "metadata", id, signatureId, key, name, length });
function requirements(
  requests: NativeClosureRequirements["requests"] = [signature("settle"), metadata("settle-meta", "settle")],
): NativeClosureRequirements {
  return { key: "module:closures", startingClosureCounter: 7, requests, referenceTypes: [] };
}
function reserve(input = requirements()) {
  const module = createEmptyModule(),
    tx = new PhysicalModuleReservations(module);
  const pack = reserveNativeClosureResources(tx, input);
  return { module, tx, pack };
}

describe("fresh closure coordinate batch authentication", () => {
  it("audits the entire deduplicated type population once after freeze", () => {
    const module = createEmptyModule(),
      tx = new PhysicalModuleReservations(module);
    const external = tx.reserveType("batch-external", { kind: "struct", name: "external", fields: [] });
    const input = {
      ...requirements([
        signature("first", [{ kind: "ref", typeIdx: external.typeIndex }]),
        signature("same", [{ kind: "ref", typeIdx: external.typeIndex }]),
        metadata("first-meta", "first", "batch:first"),
        metadata("same-meta", "same", "batch:alias"),
      ]),
      referenceTypes: [external],
    };
    const pack = reserveNativeClosureResources(tx, input);
    const expected = [
      ...new Set([
        external,
        pack.root,
        ...pack.signatures.map((row) => row.binding.type),
        ...pack.metadata.map((row) => row.binding.type),
      ]),
    ];
    expect(expected).toHaveLength(4);
    expect(pack.signatures[0]!.binding.type).toBe(pack.root);
    expect(pack.signatures[0]!.binding.type).toBe(pack.signatures[1]!.binding.type);
    tx.freezeReservations();
    const batch = tx.physicalIndices.bind(tx);
    const captured: unknown[][] = [];
    tx.physicalIndices = (tokens) => {
      captured.push([...tokens]);
      return batch(tokens);
    };
    tx.physicalIndex = () => {
      throw Error("scalar audit called");
    };
    expect(requireNativeClosureReservations(tx, pack)).toBe(pack);
    expect(captured).toEqual([expected]);
    tx.seal();
    expect(requireNativeClosureReservations(tx, pack)).toBe(pack);
    expect(captured).toEqual([expected, expected]);
  });

  it("checks the last coordinate returned by the genuine batch", () => {
    const r = reserve();
    r.tx.freezeReservations();
    const batch = r.tx.physicalIndices.bind(r.tx);
    r.tx.physicalIndices = (tokens) => {
      const indices = [...batch(tokens)];
      indices[indices.length - 1]! += 1;
      return indices;
    };
    expect(() => requireNativeClosureReservations(r.tx, r.pack)).toThrow("closure type coordinate mismatch");
  });

  it.each(["body", "locals", "type", "population"] as const)(
    "reaudits unrelated %s mutation after a successful closure batch",
    (change) => {
      const r = reserve();
      const type = r.tx.reserveType("unrelated-type", { kind: "struct", name: "unrelated", fields: [] });
      const fn = r.tx.reserveFunction("unrelated-function", "unrelated", { params: [], results: [{ kind: "i32" }] });
      r.tx.freezeReservations();
      r.tx.fillFunction(fn, { locals: [], body: [{ op: "i32.const", value: 1 }] });
      expect(requireNativeClosureReservations(r.tx, r.pack)).toBe(r.pack);
      if (change === "body") Object.assign(fn.object.body[0]!, { value: 2 });
      else if (change === "locals") fn.object.locals = [];
      else if (change === "type") Object.assign(type.object, { name: "changed" });
      else r.module.functions.push({ ...fn.object });
      expect(() => requireNativeClosureReservations(r.tx, r.pack)).toThrow(/altered|population/);
      expect(r.tx.state).toBe("failed");
    },
  );
});

describe("reentrant closure coordinate audit", () => {
  it("refuses a swallowed phase failure during a live descriptor getter", () => {
    const r = reserve();
    const fn = r.tx.reserveFunction("reentrant-function", "reentrant", { params: [], results: [{ kind: "i32" }] });
    r.tx.freezeReservations();
    r.tx.fillFunction(fn, { locals: [], body: [{ op: "i32.const", value: 1 }] });
    expect(requireNativeClosureReservations(r.tx, r.pack)).toBe(r.pack);
    let calls = 0;
    Object.defineProperty(fn.object, "name", {
      enumerable: true,
      configurable: true,
      get() {
        calls++;
        try {
          r.tx.reserveType("forbidden-phase", { kind: "struct", name: "forbidden", fields: [] });
        } catch {
          /* Keep the live snapshot equal while the private ledger becomes failed. */
        }
        return "reentrant";
      },
    });
    expect(() => requireNativeClosureReservations(r.tx, r.pack)).toThrow(/failed|phase/);
    expect(calls).toBeGreaterThan(0);
    expect(r.tx.state).toBe("failed");
  });
});
