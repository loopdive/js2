// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import ts from "typescript";
import { describe, expect, it } from "vitest";
import { irSupportRef, irTypeEquals, asVal, irVal, type IrType } from "../src/ir/core/types.js";
import { irSupportTypeRef } from "../src/ir/core/type-references.js";
import { irSupportTypeRef as compatibilityFactory } from "../src/ir/abi-bindings.js";
import { irSupportFuncRef } from "../src/ir/core/callable-bindings.js";
import {
  asBlockId,
  asValueId,
  forEachInstrDeep,
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
import { createDerivedIrUnitId } from "../src/shared/contracts/identity-values.js";
import { ProgramAbiMap } from "../src/ir/program/abi.js";
import { createEmptyModule } from "../src/ir/types.js";
import { PhysicalModuleReservations } from "../src/wasm/physical/module-reservations.js";
import { createStringDataType } from "../src/runtime/wasmgc/values/string-layouts.js";
import { AllocSiteRegistry } from "../src/ir/analysis/alloc-registry.js";
import { numToStringRadixDef } from "../src/stdlib/number-format.js";
// Mandatory joined R+F test. No fallback/skip when the source kernel is absent
// from an uncomposed R checkout; validation must use the composed production.
import { buildSelfHostedIrBody } from "../src/frontend/builtins/build-ir.js";
import type { IrDirectCallTarget } from "../src/ir/ast-lowering-plans.js";

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
const read = (path: string) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");
const hash = (text: string) => createHash("sha256").update(text).digest("hex");
function replaceOnce(source: string, before: string, after: string): string {
  const at = source.indexOf(before);
  if (at < 0 || source.indexOf(before, at + before.length) >= 0) throw new Error("missing/duplicate relocation span");
  return source.slice(0, at) + after + source.slice(at + before.length);
}
function requireFactoryRelocation(canonical: string, facade: string): void {
  const parsed = ts.createSourceFile("type-references.ts", canonical, ts.ScriptTarget.Latest, true);
  const functions = parsed.statements.filter(ts.isFunctionDeclaration);
  expect(functions.map((fn) => fn.name?.text)).toEqual(["typeRef", "irSupportTypeRef"]);
  const helper = functions[0]!.getText(parsed),
    factory = functions[1]!.getText(parsed);
  const prefix = `// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.

import { requireBindingId, requireNonEmpty } from "./binding-key-primitives.js";
import { createIrBindingId } from "../../shared/contracts/identity-values.js";
import type { IrClassId, IrSourceId, IrUnitId } from "../../shared/contracts/ir-identity.js";
import type { IrTypeBinding, IrTypeRef } from "./types.js";

type IrBindingOwnerId = IrSourceId | IrUnitId | IrClassId;

`;
  expect(canonical).toBe(
    prefix + helper + "\n\n/** Reference one compiler support type intention. */\n" + factory + "\n",
  );
  let inverse = replaceOnce(
    facade,
    'import type { IrGlobalBinding, IrGlobalRef, IrTypeBinding, IrTypeRef } from "./nodes.js";\nimport { typeRef, irSupportTypeRef } from "./core/type-references.js";\nexport { irSupportTypeRef } from "./core/type-references.js";',
    'import type { IrGlobalBinding, IrGlobalRef, IrTypeBinding, IrTypeRef } from "./nodes.js";',
  );
  inverse = replaceOnce(
    inverse,
    "/** Exact source-owned value-storage ID for one top-level declaration ordinal. */",
    replaceOnce(helper, "export function typeRef", "function typeRef") +
      "\n\n/** Exact source-owned value-storage ID for one top-level declaration ordinal. */",
  );
  inverse = replaceOnce(
    inverse,
    "/** Exact reserved layout type identity for one nominal-fnctor constructor. */",
    "/** Reference one compiler support type intention. */\n" +
      factory +
      "\n\n/** Exact reserved layout type identity for one nominal-fnctor constructor. */",
  );
  expect(hash(inverse)).toBe("9324caf316c596019beab1007c7e602263ae2955328a0f336b1ab38246bb09fc");
}

describe("nominal index-free support references", () => {
  it("retains the exact old factory identity and complete two-body relocation receipt", () => {
    expect(compatibilityFactory).toBe(irSupportTypeRef);
    requireFactoryRelocation(read("src/ir/core/type-references.ts"), read("src/ir/abi-bindings.ts"));
  });
  it.each(["body", "extra", "route", "export"] as const)(
    "rejects a %s relocation mutation after the original positive",
    (kind) => {
      const canonical = read("src/ir/core/type-references.ts"),
        facade = read("src/ir/abi-bindings.ts");
      requireFactoryRelocation(canonical, facade);
      const changed =
        kind === "body"
          ? replaceOnce(canonical, "    role: checkedRole,", "    role: role,")
          : kind === "extra"
            ? canonical + "void 0;\n"
            : kind === "route"
              ? replaceOnce(canonical, 'from "./types.js"', 'from "../nodes.js"')
              : replaceOnce(canonical, "export function typeRef", "function typeRef");
      expect(() => requireFactoryRelocation(changed, facade)).toThrow();
    },
  );
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
  it("lowers the unchanged original radix through the genuine frontend kernel (mandatory R+F join)", () => {
    const radixType = irSupportRef(irSupportTypeRef(sourceId, "number-format-radix:scratch", "__nfd_buffer"), true);
    const definition = numToStringRadixDef(radixType),
      allocRegistry = new AllocSiteRegistry();
    expect(Buffer.byteLength(definition.source, "utf8")).toBe(1618);
    expect(hash(definition.source)).toBe("7b13099fbed0a87079f92e9bddbf75959065ed28daf66d5ad344e0b240037dc6");
    const parsed = ts.createSourceFile("radix.ts", definition.source, ts.ScriptTarget.Latest, true);
    const sourceCalls: string[] = [],
      sourceLiterals: string[] = [];
    const collect = (node: ts.Node): void => {
      if (ts.isCallExpression(node)) sourceCalls.push(node.expression.getText(parsed));
      if (ts.isStringLiteral(node)) sourceLiterals.push(node.text);
      ts.forEachChild(node, collect);
    };
    collect(parsed);
    expect(sourceCalls).toHaveLength(16);
    expect(
      sourceCalls.reduce<Record<string, number>>((counts, name) => {
        counts[name] = (counts[name] ?? 0) + 1;
        return counts;
      }, {}),
    ).toEqual({ "Math.floor": 4, __num_fmt_trap: 1, __nfd_new: 1, __nfd_set: 7, __nfd_get: 2, __nfd_fin: 1 });
    expect(sourceLiterals).toEqual(["NaN", "Infinity", "-Infinity", "0"]);
    const callees = new Map<string, IrDirectCallTarget>();
    const roles = ["new", "get", "set", "fin", "trap"] as const;
    [...definition.calleeTypes].forEach(([name, signature], index) =>
      callees.set(name, {
        target: irSupportFuncRef(sourceId, "number-format-radix:" + roles[index]!, name),
        signature,
      }),
    );
    expect([...callees.keys()]).toEqual(["__nfd_new", "__nfd_get", "__nfd_set", "__nfd_fin", "__num_fmt_trap"]);
    const ownerUnitId = createDerivedIrUnitId({
      parentId: sourceId,
      role: "runtime-support:number-format-radix",
      ordinal: 0,
    });
    const body = buildSelfHostedIrBody({ definition, ownerUnitId, callees, allocRegistry });
    expect(body.unitId).toBe(ownerUnitId);
    const table: IrModuleDeclarations = {
      declaredSignatures: new Map(
        [...callees.values()].map(({ target, signature }) => [
          irBindingKey(target.binding)!,
          { params: signature.params, result: signature.returnType },
        ]),
      ),
    };
    expect(verifyIrFunction(body, undefined, table)).toEqual([]);
    const supportResults: IrType[] = [],
      calls: string[] = [];
    for (const block of body.blocks)
      for (const instr of block.instrs)
        forEachInstrDeep(instr, (nested) => {
          if (nested.resultType?.kind === "support-ref") supportResults.push(nested.resultType);
          if (nested.kind === "call") calls.push(nested.target.name);
        });
    expect(supportResults.length).toBeGreaterThan(0);
    expect(supportResults.every((type) => irTypeEquals(type, radixType))).toBe(true);
    const scratchValues = new Set<number>();
    for (const block of body.blocks)
      for (const instr of block.instrs)
        forEachInstrDeep(instr, (nested) => {
          if (nested.result !== null && nested.resultType?.kind === "support-ref") scratchValues.add(nested.result);
        });
    for (const block of body.blocks)
      for (const instr of block.instrs)
        forEachInstrDeep(instr, (nested) => {
          if (nested.kind === "slot.write") expect(scratchValues.has(nested.value)).toBe(false);
          if (nested.kind === "slot.read") expect(nested.resultType?.kind).not.toBe("support-ref");
        });
    expect(calls).toContain("__nfd_new");
    expect(calls).toContain("__nfd_fin");
    // This is source lowering and verification, not prepared-program/D2 execution.
  });
});
