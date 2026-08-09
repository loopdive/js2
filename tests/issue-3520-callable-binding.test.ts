// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.

import { describe, expect, it } from "vitest";

import {
  asBlockId,
  asValueId,
  createIrBindingId,
  irCallableBindingKey,
  irImportFuncRef,
  irIntrinsicFuncRef,
  irRuntimeFuncRef,
  irSupportFuncRef,
  irUnitCallableBindingId,
  irUnitFuncRef,
  sameIrCallableBinding,
  verifyIrFunction,
  type IrClosureSignature,
  type IrFuncRef,
  type IrFunction,
  type IrUnitId,
} from "../src/ir/index.js";
import { IR_FORMAT_VERSION } from "../src/ir/contract.js";
import { createTestIrFunctionIdentityFactory } from "./helpers/ir-identities.js";

const identities = createTestIrFunctionIdentityFactory("issue-3520-callable-binding");

describe("#3520 structural callable bindings", () => {
  it("keeps same-labelled unit references distinct and excludes the label from equality", () => {
    const first = identities.next("same");
    const second = identities.next("same");
    const firstRef = irUnitFuncRef(first);
    const secondRef = irUnitFuncRef(second);

    expect(firstRef.name).toBe(secondRef.name);
    expect(irUnitCallableBindingId(first.unitId)).toBe(
      createIrBindingId({ ownerId: first.unitId, domain: "callable", role: "body" }),
    );
    expect(irUnitCallableBindingId(first.unitId)).not.toBe(irUnitCallableBindingId(second.unitId));
    expect(irCallableBindingKey(firstRef.binding)).not.toBe(irCallableBindingKey(secondRef.binding));
    expect(sameIrCallableBinding(firstRef.binding, secondRef.binding)).toBe(false);

    const renamedFirst = irUnitFuncRef({ ...first, name: "different-debug-label" });
    expect(sameIrCallableBinding(firstRef.binding, renamedFirst.binding)).toBe(true);
  });

  it("separates provider and unit domains even when their text is identical", () => {
    const unit = identities.next("provider-like");
    const unitRef = irUnitFuncRef(unit);
    const providerRef = irImportFuncRef("env", unit.unitId, unit.name);
    const runtimeRef = irRuntimeFuncRef(unit.unitId, unit.name);

    expect(irCallableBindingKey(providerRef.binding)).not.toBe(irCallableBindingKey(unitRef.binding));
    expect(irCallableBindingKey(runtimeRef.binding)).not.toBe(irCallableBindingKey(unitRef.binding));
    expect(irCallableBindingKey(providerRef.binding)).not.toBe(irCallableBindingKey(runtimeRef.binding));
  });

  it("derives support bindings from their structural owner, role, and ordinal", () => {
    const owner = identities.next("owner");
    const support = irSupportFuncRef(owner.unitId, "closure-adapter", "adapter-a", 3);
    const relabelled = irSupportFuncRef(owner.unitId, "closure-adapter", "adapter-b", 3);

    expect(support.binding).toEqual({
      kind: "support",
      bindingId: createIrBindingId({
        ownerId: owner.unitId,
        domain: "support",
        role: "closure-adapter",
        ordinal: 3,
      }),
    });
    expect(sameIrCallableBinding(support.binding, relabelled.binding)).toBe(true);
    expect(support.name).not.toBe(relabelled.name);
  });

  it("rejects empty factory inputs instead of manufacturing name fallbacks", () => {
    const owner = identities.next("owner-for-invalid-inputs");
    expect(() => irUnitFuncRef({ unitId: "" as IrUnitId, name: "unit" })).toThrow(/unitId.*non-empty/);
    expect(() => irUnitFuncRef({ unitId: owner.unitId, name: "" })).toThrow(/compatibility name.*non-empty/);
    expect(() => irImportFuncRef("", "field")).toThrow(/import module.*non-empty/);
    expect(() => irImportFuncRef("env", "")).toThrow(/import field.*non-empty/);
    expect(() => irRuntimeFuncRef("")).toThrow(/runtime symbol.*non-empty/);
    expect(() => irIntrinsicFuncRef("")).toThrow(/intrinsic symbol.*non-empty/);
    expect(() => irSupportFuncRef(owner.unitId, "", "adapter")).toThrow(/support role.*non-empty/);
    expect(() => irSupportFuncRef(owner.unitId, "role", "")).toThrow(/support compatibility name.*non-empty/);
  });

  it("rejects legacy name-only call and closure refs inside nested buffers", () => {
    const legacyCall = { kind: "func", name: "legacy_call" } as unknown as IrFuncRef;
    const legacyLifted = { kind: "func", name: "legacy_lifted" } as unknown as IrFuncRef;
    const signature: IrClosureSignature = { params: [], returnType: null };
    const fixture: IrFunction = {
      ...identities.next("malformed-nested-refs"),
      params: [{ value: asValueId(0), type: { kind: "val", val: { kind: "i32" } }, name: "condition" }],
      resultTypes: [],
      blocks: [
        {
          id: asBlockId(0),
          blockArgs: [],
          blockArgTypes: [],
          instrs: [
            {
              kind: "if.stmt",
              cond: asValueId(0),
              then: [
                {
                  kind: "call",
                  target: legacyCall,
                  args: [],
                  result: null,
                  resultType: null,
                },
              ],
              else: [
                {
                  kind: "closure.new",
                  liftedFunc: legacyLifted,
                  signature,
                  captureFieldTypes: [],
                  captures: [],
                  result: asValueId(1),
                  resultType: { kind: "closure", signature },
                },
              ],
              result: null,
              resultType: null,
            },
          ],
          terminator: { kind: "return", values: [] },
        },
      ],
      exported: false,
      valueCount: 2,
    };

    expect(verifyIrFunction(fixture).map((error) => error.message)).toEqual(
      expect.arrayContaining([
        "call target is missing required callable binding; legacy name-only refs are not valid IR",
        "closure.new liftedFunc is missing required callable binding; legacy name-only refs are not valid IR",
      ]),
    );
  });

  it("retains callable bindings in the class-identity interchange revision", () => {
    expect(IR_FORMAT_VERSION).toBe("5.1");
  });
});
