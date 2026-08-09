// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.

import { describe, expect, it } from "vitest";
import { AllocSiteRegistry } from "../src/ir/alloc-registry.js";
import { planLinearMemory } from "../src/ir/analysis/linear-memory-plan.js";
import {
  irArgcGlobalRef,
  irClassTypeRef,
  irGlobalBindingKey,
  irModuleGlobalRef,
  irSourceGlobalRef,
  irSourceTypeRef,
  irTypeBindingKey,
  sameIrGlobalBinding,
  sameIrTypeBinding,
} from "../src/ir/abi-bindings.js";
import { createIrBindingId, createIrSourceId, type IrBindingId } from "../src/ir/identity.js";
import { IrFunctionBuilder } from "../src/ir/builder.js";
import { PorfforModuleAssembler } from "../src/ir/backend/porffor/assembler.js";
import { asBlockId, asValueId, type IrFunction, type IrGlobalRef, type IrTypeRef } from "../src/ir/nodes.js";
import { irGlobalReferenceProblem, irTypeReferenceProblem, verifyIrFunction } from "../src/ir/verify.js";
import { createTestIrClassId, createTestIrFunctionIdentityFactory } from "./helpers/ir-identities.js";

const identities = createTestIrFunctionIdentityFactory("issue-3520-global-type-binding");
const otherSource = createIrSourceId({ kind: "source", order: 1, sourceKey: "@test/other-global-source" });
const I32 = { kind: "val", val: { kind: "i32" } } as const;

describe("#3520 structural global and type bindings", () => {
  it("keys source globals by binding identity and excludes compatibility labels", () => {
    const first = irModuleGlobalRef(identities.sourceId, 2, "__mod_same");
    const renamed = irModuleGlobalRef(identities.sourceId, 2, "__renamed_adapter");
    const other = irModuleGlobalRef(otherSource, 2, "__mod_same");

    expect(sameIrGlobalBinding(first.binding, renamed.binding)).toBe(true);
    expect(irGlobalBindingKey(first.binding)).toBe(irGlobalBindingKey(renamed.binding));
    expect(sameIrGlobalBinding(first.binding, other.binding)).toBe(false);
    expect(Object.isFrozen(first)).toBe(true);
    expect(Object.isFrozen(first.binding)).toBe(true);
  });

  it("keeps argc program-singleton identity anchored to the entry source", () => {
    const first = irArgcGlobalRef(identities.sourceId);
    const repeated = irArgcGlobalRef(identities.sourceId);
    const foreignProgram = irArgcGlobalRef(otherSource);

    expect(sameIrGlobalBinding(first.binding, repeated.binding)).toBe(true);
    expect(sameIrGlobalBinding(first.binding, foreignProgram.binding)).toBe(false);
    expect(first.binding).toMatchObject({ kind: "runtime", symbol: "__argc" });
  });

  it("separates ordinary type and class-layout domains without using labels", () => {
    const sourceType = irSourceTypeRef(identities.sourceId, "record-layout", "$Same");
    const renamed = irSourceTypeRef(identities.sourceId, "record-layout", "$Renamed");
    const classType = irClassTypeRef(createTestIrClassId("issue-3520-global-type-binding"), "$Same");

    expect(sameIrTypeBinding(sourceType.binding, renamed.binding)).toBe(true);
    expect(irTypeBindingKey(sourceType.binding)).not.toBe(irTypeBindingKey(classType.binding));
    expect(Object.isFrozen(classType.binding)).toBe(true);
  });

  it("rejects cross-domain binding IDs in factories and serialized refs", () => {
    const typeId = createIrBindingId({
      ownerId: identities.sourceId,
      domain: "type",
      role: "not-a-global",
    });
    expect(() => irSourceGlobalRef(typeId, "bad")).toThrow(/global binding domain/);

    const wrongGlobal = {
      kind: "global",
      name: "bad",
      binding: { kind: "source", bindingId: typeId },
    } as unknown as IrGlobalRef;
    expect(irGlobalReferenceProblem(wrongGlobal)).toMatch(/global-domain/);

    const globalId = createIrBindingId({
      ownerId: identities.sourceId,
      domain: "global",
      role: "not-a-type",
    });
    const wrongType = {
      kind: "type",
      name: "bad",
      binding: { kind: "source", bindingId: globalId },
    } as unknown as IrTypeRef;
    expect(irTypeReferenceProblem(wrongType)).toMatch(/type-domain/);
  });

  it("deep-verifies nested global refs and rejects legacy name-only targets", () => {
    const legacy = { kind: "global", name: "legacy" } as unknown as IrGlobalRef;
    const fixture: IrFunction = {
      ...identities.next("nested-global-verification"),
      params: [{ value: asValueId(0), type: I32, name: "condition" }],
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
                  kind: "global.get",
                  target: legacy,
                  result: asValueId(1),
                  resultType: I32,
                },
              ],
              else: [],
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

    expect(verifyIrFunction(fixture).map((error) => error.message)).toContain(
      "global.get target is missing required global binding; legacy name-only refs are not valid IR",
    );
  });

  it("keeps same-labelled globals separate in the shared linear memory plan", () => {
    const firstRef = irModuleGlobalRef(identities.sourceId, 10, "same");
    const secondRef = irModuleGlobalRef(otherSource, 10, "same");
    const buildWrite = (ref: IrGlobalRef, name: string) => {
      const builder = new IrFunctionBuilder(identities.next(name), []);
      builder.openBlock();
      const value = builder.emitConst({ kind: "i32", value: 1 }, I32);
      builder.emitGlobalSet(ref, value);
      builder.terminate({ kind: "return", values: [] });
      return builder.finish();
    };

    const plan = planLinearMemory(
      { functions: [buildWrite(firstRef, "first-global"), buildWrite(secondRef, "second-global")] },
      new AllocSiteRegistry(),
    );
    expect(plan.globals.map((global) => global.id).sort()).toEqual(
      [firstRef.binding.bindingId, secondRef.binding.bindingId].sort(),
    );
  });

  it("resolves Porffor globals by full binding payload and rejects label lookalikes", () => {
    const assembler = new PorfforModuleAssembler();
    const first = irModuleGlobalRef(identities.sourceId, 30, "same");
    const second = irModuleGlobalRef(otherSource, 30, "same");
    const firstHandle = assembler.declareIrGlobal(first, "f64");
    const secondHandle = assembler.declareIrGlobal(second, "f64");

    expect(firstHandle).not.toBe(secondHandle);
    expect(assembler.resolveGlobal(irModuleGlobalRef(identities.sourceId, 30, "renamed"))).toBe(firstHandle);
    expect(() => assembler.resolveGlobal(irModuleGlobalRef(identities.sourceId, 31, "same"))).toThrow(
      /unresolved global binding/,
    );

    const forged = {
      ...first,
      binding: { kind: "runtime", bindingId: first.binding.bindingId, symbol: "forged" },
    } as unknown as IrGlobalRef;
    expect(() => assembler.resolveGlobal(forged)).toThrow(/unresolved global binding/);
  });

  it("rejects a branded-looking but wrong-domain binding cast", () => {
    const callable = createIrBindingId({
      ownerId: identities.unit(20),
      domain: "callable",
      role: "not-global",
    }) as IrBindingId;
    expect(() => irSourceGlobalRef(callable, "bad")).toThrow(/global binding domain/);
  });
});
