import ts from "typescript";
import { describe, expect, it } from "vitest";
import { irSupportRef, irTypeEquals, asVal, irVal } from "../src/ir/core/types.js";
import { irSupportTypeRef } from "../src/ir/core/type-references.js";
import { irSupportFuncRef } from "../src/ir/core/callable-bindings.js";
import {
  asBlockId,
  asValueId,
  type IrFunction,
  type IrInstr,
  type IrModuleDeclarations,
} from "../src/ir/core/nodes.js";
import { irTypeKey } from "../src/ir/type-key.js";
import { verifyIrFunction } from "../src/ir/verify.js";
import { irBindingKey } from "../src/ir/declared-types.js";
import { lowerIrTypeToValType, type IrLowerResolver } from "../src/ir/lower.js";
import { attachIrPhysicalRefTypeRefs } from "../src/ir/physical-ref-support.js";
import { attachIrStringCarrier } from "../src/ir/string-carrier.js";
import { attachIrVecLayouts } from "../src/ir/vec-layout.js";
import { verifyIrBackendLegality } from "../src/ir/backend/legality.js";
import { buildIrUnitInventory, createIrSourceId, createIrUnitId } from "../src/ir/identity.js";
import { ProgramAbiMap } from "../src/ir/program/abi.js";
import { createEmptyModule } from "../src/ir/types.js";
import { PhysicalModuleReservations } from "../src/wasm/physical/module-reservations.js";
import { createStringDataType } from "../src/runtime/wasmgc/values/string-layouts.js";

const sourceId = createIrSourceId({ kind: "entry", order: 0, sourceKey: "symbolic-support-ref.ts" });
const unitId = createIrUnitId({ sourceId, lexicalOwnerId: null, kind: "top-level-function", ordinal: 0 });
const ref = irSupportTypeRef(sourceId, "scratch", "buffer"),
  B = irSupportRef(ref, true);
const foreign = irSupportRef(irSupportTypeRef(sourceId, "foreign", "buffer"), true);
const F64 = irVal({ kind: "f64" });
const target = irSupportFuncRef(sourceId, "identity", "identity");
const declarations: IrModuleDeclarations = {
  declaredSignatures: new Map([[irBindingKey(target.binding)!, { params: [B], result: B }]]),
};
function forward(): IrFunction {
  return {
    unitId,
    name: "forward",
    params: [{ value: asValueId(0), name: "input", type: B }],
    resultTypes: [B],
    exported: false,
    valueCount: 2,
    blocks: [
      {
        id: asBlockId(0),
        blockArgs: [],
        blockArgTypes: [],
        instrs: [{ kind: "call", target, args: [asValueId(0)], result: asValueId(1), resultType: B }],
        terminator: { kind: "return", values: [asValueId(1)] },
      },
    ],
  };
}
const verify = (fn: IrFunction, table: IrModuleDeclarations | undefined = declarations) =>
  verifyIrFunction(fn, undefined, table).map((error) => error.message);

describe("nominal index-free support references", () => {
  it("keys identity and nullability, never the compatibility name or physical fields", () => {
    const renamed = irSupportRef({ ...ref, name: "different" }, true);
    expect(irTypeEquals(B, renamed)).toBe(true);
    expect(irTypeKey(B)).toBe(irTypeKey(renamed));
    expect(irTypeKey(B)).toBe(`support-ref|${ref.binding.bindingId.length}:${ref.binding.bindingId}|nullable:1`);
    expect(irTypeEquals(B, foreign)).toBe(false);
    expect(irTypeEquals(B, irSupportRef(ref, false))).toBe(false);
    expect(asVal(B)).toBeNull();
    expect(Reflect.ownKeys(B)).toEqual(["kind", "ref", "nullable"]);
    for (const field of ["val", "typeIdx", "layout", "provider"]) expect(Object.hasOwn(B, field)).toBe(false);
    expect(irTypeKey(F64)).toBe("f64");
  });
  it.each(["kind", "binding", "domain", "empty", "nullable"] as const)("rejects invalid constructor %s", (kind) => {
    expect(irSupportRef(ref, true)).toEqual(B);
    const bad = structuredClone(ref);
    if (kind === "kind") Object.assign(bad, { kind: "global" });
    if (kind === "binding") Object.assign(bad.binding, { kind: "source" });
    if (kind === "domain") Object.assign(bad.binding, { bindingId: "ir-binding:v1:global:foreign" });
    if (kind === "empty") Object.assign(bad.binding, { bindingId: "" });
    expect(() => irSupportRef(bad, kind === "nullable" ? undefined! : true)).toThrow();
  });
  it.each(["argument", "result", "return", "nullability", "missing-declaration"] as const)(
    "checks exact %s flow",
    (kind) => {
      expect(verify(forward())).toEqual([]);
      const fn = forward();
      if (kind === "argument") Object.assign(fn.params[0]!, { type: foreign });
      if (kind === "result") Object.assign(fn.blocks[0]!.instrs[0]!, { resultType: foreign });
      if (kind === "return") Object.assign(fn, { resultTypes: [foreign] });
      if (kind === "nullability") Object.assign(fn.params[0]!, { type: irSupportRef(ref, false) });
      const errors = kind === "missing-declaration" ? verifyIrFunction(fn).map((error) => error.message) : verify(fn);
      expect(errors.some((message) => message.includes("support-ref"))).toBe(true);
    },
  );
  it("checks branch identities and rejects physical slot storage", () => {
    const fn = forward();
    Object.assign(fn.blocks[0]!, {
      terminator: { kind: "br", branch: { target: asBlockId(1), args: [asValueId(1)] } },
    });
    (fn.blocks as unknown[]).push({
      id: asBlockId(1),
      blockArgs: [asValueId(2)],
      blockArgTypes: [B],
      instrs: [],
      terminator: { kind: "return", values: [asValueId(2)] },
    });
    Object.assign(fn, { valueCount: 3 });
    expect(verify(fn)).toEqual([]);
    Object.assign(fn.blocks[1]!, { blockArgTypes: [foreign] });
    expect(verify(fn)).toContain("branch arg 0 support-ref identity/nullability mismatch");
    const slot = forward();
    expect(verify(slot)).toEqual([]);
    Object.assign(slot, { slots: [{ index: 0, name: "slot", type: { kind: "externref" } }] });
    (slot.blocks[0]!.instrs as IrInstr[]).push({
      kind: "slot.write",
      slotIndex: 0,
      value: asValueId(1),
      result: null,
      resultType: null,
    });
    expect(verify(slot)).toContain("slot.write does not support support-ref flow");
    const readSlot = forward();
    expect(verify(readSlot)).toEqual([]);
    Object.assign(readSlot, { slots: [{ index: 0, name: "slot", type: { kind: "externref" } }] });
    Object.assign(readSlot.blocks[0]!.instrs[0]!, { kind: "slot.read", slotIndex: 0 });
    expect(verify(readSlot)).toContain("slot.read does not support support-ref flow");
  });
  it("preserves the leaf without calling a physical attachment allocator", () => {
    const fn = forward();
    expect(
      attachIrPhysicalRefTypeRefs(fn, () => {
        throw new Error("must not resolve support-ref as raw physical ref");
      }),
    ).toBe(fn);
    expect(attachIrStringCarrier(fn, ref).function.params[0]!.type).toBe(B);
    expect(
      attachIrVecLayouts(fn, () => {
        throw new Error("must not allocate a vector");
      }).function.params[0]!.type,
    ).toBe(B);
    expect(verifyIrBackendLegality(fn, "wasmgc")).toEqual([]);
    for (const backend of ["linear", "bytecode", "porffor"] as const)
      expect(verifyIrBackendLegality(fn, backend).some((error) => error.message.includes("support-ref"))).toBe(true);
  });
  it("resolves through two real ABI/ledger layouts without index-bearing source types", () => {
    const source = ts.createSourceFile(
      "/r/entry.ts",
      "export function run(): number { return 42; }",
      ts.ScriptTarget.Latest,
      true,
    );
    const inventory = buildIrUnitInventory([source], { entrySource: source });
    const ownedRef = irSupportTypeRef(inventory.sources[0]!.id, "scratch", "buffer"),
      type = irSupportRef(ownedRef, true);
    const indices = [0, 3].map((padding) => {
      const abi = new ProgramAbiMap(inventory),
        module = createEmptyModule(),
        tx = new PhysicalModuleReservations(module);
      abi.plan({
        id: ownedRef.binding.bindingId,
        displayName: "buffer",
        order: { sourceOrder: 0, declarationOrder: 0 },
        slotPolicy: "required",
        slotSpace: "type",
        intent: { kind: "type", shapeKey: irTypeKey(type) },
      });
      abi.sealPlan();
      for (let i = 0; i < padding; i++)
        tx.reserveType(`preceding:${i}`, { kind: "struct", name: `preceding${i}`, fields: [] });
      const token = tx.reserveType(ownedRef.binding.bindingId, createStringDataType());
      tx.freezeReservations();
      abi.bindFinalIndex(ownedRef.binding.bindingId, { space: "type", index: tx.physicalIndex(token) });
      abi.finishBinding();
      const resolver: IrLowerResolver = {
        resolveFunc: () => {
          throw new Error("unexpected callable");
        },
        resolveGlobal: () => {
          throw new Error("unexpected global");
        },
        internFuncType: () => {
          throw new Error("unexpected signature");
        },
        resolveType: (reference) => {
          const result = abi.resolveFinalIndex(reference.binding.bindingId);
          if (result?.space !== "type") throw new Error("missing owned type");
          return result.index;
        },
      };
      expect(lowerIrTypeToValType(type, resolver, "test")).toEqual({ kind: "ref_null", typeIdx: token.typeIndex });
      expect(lowerIrTypeToValType(irSupportRef(structuredClone(ownedRef), false), resolver, "test")).toEqual({
        kind: "ref",
        typeIdx: token.typeIndex,
      });
      expect(() => lowerIrTypeToValType(foreign, resolver, "test")).toThrow();
      expect(() => lowerIrTypeToValType(type, { ...resolver, resolveType: undefined! }, "test")).toThrow();
      // A rejected token permanently fails the ledger: corrupt only after all
      // positive witnesses, never reuse that failed transaction for admission.
      expect(() => tx.physicalIndex({ ...token })).toThrow();
      return token.typeIndex;
    });
    expect(indices).toEqual([0, 3]);
    expect(Object.hasOwn(type, "typeIdx")).toBe(false);
  });
});
