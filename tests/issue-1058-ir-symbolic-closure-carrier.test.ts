// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import { describe, expect, it } from "vitest";
import { analyzeSource } from "../src/checker/index.js";
import { createCodegenContext } from "../src/codegen/context/create-context.js";
import { getFuncRefWrapperRootTypeIdx } from "../src/codegen/closures/funcref-wrapper-types.js";
import { mintDefinedFunc, pushDefinedFunc } from "../src/codegen/func-space.js";
import { addFuncType } from "../src/codegen/registry/types.js";
import { ProgramAbiSession } from "../src/codegen/program-abi-session.js";
import { describeProgramAbiSupportType } from "../src/codegen/program-abi-support-type-description.js";
import { canonicalProgramAbiClosureLayoutKey } from "../src/codegen/program-abi-type-planning.js";
import { irSupportTypeRef, irTypeBindingKey } from "../src/ir/abi-bindings.js";
import { emitBinary } from "../src/emit/binary.js";
import { IrFunctionBuilder } from "../src/ir/builder.js";
import { irUnitFuncRef } from "../src/ir/callable-bindings.js";
import { ClosureStructRegistry } from "../src/ir/closure-struct-registry.js";
import { buildIrUnitInventory } from "../src/ir/identity.js";
import type { IrType } from "../src/ir/nodes.js";
import { lowerIrFunctionToWasm, type IrLowerResolver } from "../src/ir/lower.js";
import { lowerPreparedClosureSupportType } from "../src/ir/prepared-closure-support.js";
import { irPhysicalTypeKey, irTypeKey } from "../src/ir/type-key.js";
import { createEmptyModule, type StructTypeDef } from "../src/ir/types.js";
import { createTestIrFunctionIdentityFactory } from "./helpers/ir-identities.js";

function nodeType(index: number): StructTypeDef {
  return {
    kind: "struct",
    name: "NodeCarrier",
    fields: [
      { name: "value", type: { kind: "f64" }, mutable: true },
      { name: "parent", type: { kind: "ref_null", typeIdx: index }, mutable: true },
    ],
  };
}

function fixture() {
  const ast = analyzeSource("export function run(): number { return 42; }", "/repo/symbolic-carrier.ts");
  const inventory = buildIrUnitInventory([ast.sourceFile], { entrySource: ast.sourceFile, checker: ast.checker });
  const sourceId = inventory.sources[0]!.id;
  const module = createEmptyModule();
  module.types.push({ kind: "struct", name: "dead", fields: [] }, nodeType(1));
  const session = new ProgramAbiSession(inventory, module);
  const ctx = createCodegenContext(module, ast.checker, { fast: true, nativeStrings: true }, session);
  const ref = irSupportTypeRef(sourceId, "recursive-node", "NodeCarrier");
  const otherRef = irSupportTypeRef(sourceId, "other-node", "OtherNodeCarrier");
  const type = module.types[1]!;
  const cell = session.createTypeCell(type);
  const contribution = describeProgramAbiSupportType({
    session,
    entrySourceId: sourceId,
    ref,
    type,
    cell,
    roleOrdinal: 0,
    derivedOrdinal: 0,
  });
  session.ensurePlan(contribution.draft);
  session.registerStructuralReference(ref.binding.bindingId, contribution.structuralReferenceKey!);
  session.attachLocator(ref.binding.bindingId, contribution.locator!);
  const carrier = (index = 1, nullable = false): IrType => ({
    kind: "val",
    val: { kind: nullable ? "ref_null" : "ref", typeIdx: index },
    typeRef: ref,
  });
  return { ctx, module, session, ref, otherRef, carrier };
}

const layoutKey = (type: IrType) => canonicalProgramAbiClosureLayoutKey({ params: [type], returnType: type }, [type]);

describe("#1058 symbolic recursive closure carriers", () => {
  it("keys physical allocations by identity and nullability, not candidate index", () => {
    const f = fixture();
    const a = f.carrier(1);
    const b = f.carrier(99);
    const different: IrType = { kind: "val", val: { kind: "ref", typeIdx: 1 }, typeRef: f.otherRef };
    expect(layoutKey(a)).toBe(layoutKey(b));
    expect(layoutKey(a)).not.toBe(layoutKey(different));
    expect(layoutKey(a)).not.toBe(layoutKey(f.carrier(1, true)));
    expect(irPhysicalTypeKey(a)).toBe(irPhysicalTypeKey(b));
    expect(irPhysicalTypeKey(a)).not.toBe(irPhysicalTypeKey(different));
    expect(irPhysicalTypeKey(a)).not.toBe(irPhysicalTypeKey(f.carrier(1, true)));
    // Prepared-callable semantic fingerprints keep their existing contract.
    expect(irTypeKey(a)).not.toBe(irTypeKey(b));
    expect(irTypeKey(a)).toBe(irTypeKey(different));
  });

  it("resolves the current recursive type cell after a complete layout remap", () => {
    const f = fixture();
    expect(lowerPreparedClosureSupportType(f.ctx, f.carrier(99))).toEqual({ kind: "ref", typeIdx: 1 });
    const nextTypes = [nodeType(0), f.module.types[0]!, ...f.module.types.slice(2)];
    f.session.applyTypeLayoutRemap({
      previousTypes: f.module.types,
      nextTypes,
      targetsByOldIndex: f.module.types.map((_, index) => (index === 0 ? 1 : index === 1 ? 0 : index)),
    });
    f.module.types = nextTypes;
    expect(lowerPreparedClosureSupportType(f.ctx, f.carrier(99))).toEqual({ kind: "ref", typeIdx: 0 });
    expect(lowerPreparedClosureSupportType(f.ctx, f.carrier(99, true))).toEqual({ kind: "ref_null", typeIdx: 0 });
  });

  it("reuses closure allocations for the same symbolic carrier", () => {
    const f = fixture();
    const registry = new ClosureStructRegistry(f.ctx, (type) => lowerPreparedClosureSupportType(f.ctx, type));
    const signature = { params: [f.carrier()], returnType: f.carrier() };
    const first = registry.resolveSubtype(signature, [f.carrier()]);
    expect(first).not.toBeNull();
    const unowned: IrType = { kind: "val", val: { kind: "ref", typeIdx: 1 }, typeRef: f.otherRef };
    expect(registry.resolveSubtype({ params: [unowned], returnType: unowned }, [unowned])).toBeNull();
    expect(registry.resolveSubtype({ params: [f.carrier(99)], returnType: f.carrier(99) }, [f.carrier(99)])).toBe(
      first,
    );
    expect(f.module.types[first!.funcTypeIdx]).toMatchObject({
      params: [expect.anything(), { kind: "ref", typeIdx: 1 }],
      results: [{ kind: "ref", typeIdx: 1 }],
    });
  });

  it("refuses unowned, scalar-attached and unbound physical references", () => {
    const f = fixture();
    const unowned: IrType = { kind: "val", val: { kind: "ref", typeIdx: 1 }, typeRef: f.otherRef };
    const scalar: IrType = { kind: "val", val: { kind: "f64" }, typeRef: f.ref };
    const raw: IrType = { kind: "val", val: { kind: "ref", typeIdx: 1 } };
    expect(() => lowerPreparedClosureSupportType(f.ctx, unowned)).toThrow(/no exact Program ABI type plan/);
    expect(() => lowerPreparedClosureSupportType(f.ctx, scalar)).toThrow(/attached to a scalar/);
    expect(() => lowerPreparedClosureSupportType(f.ctx, raw)).toThrow(/complete IR resolver/);
    expect(() => layoutKey(scalar)).toThrow(/attached to a scalar/);
    expect(() => layoutKey(raw)).toThrow(/module-relative ref type indices/);
    expect(() => irPhysicalTypeKey(scalar)).toThrow(/attached to a scalar/);
  });

  it.each([false, true])("executes a zero-import recursive Node closure (captured=%s)", (captured) => {
    const f = fixture();
    const identities = createTestIrFunctionIdentityFactory("symbolic-node-closure");
    const node = f.carrier(99);
    const signature = { params: [node], returnType: node };
    const captures = captured ? [node] : [];
    const registry = new ClosureStructRegistry(f.ctx, (type) => lowerPreparedClosureSupportType(f.ctx, type));
    expect(registry.resolveSubtype(signature, captures)).not.toBeNull();
    const builder = new IrFunctionBuilder(identities.next("lifted"), [node]);
    const self = builder.addParam("self", { kind: "closure", signature });
    const arg = builder.addParam("arg", node);
    builder.openBlock();
    builder.terminate({ kind: "return", values: [captured ? builder.emitClosureCap(self, 0, node) : arg] });
    const lifted = { ...builder.finish(), closureSubtype: { signature, captureFieldTypes: captures } };
    const handle = mintDefinedFunc(f.ctx);
    f.module.declaredFuncRefs.push(handle);
    const resolver: IrLowerResolver = {
      resolveFunc: (ref) => {
        expect(ref).toEqual(irUnitFuncRef(lifted));
        return handle;
      },
      resolveGlobal: () => {
        throw new Error("unexpected global");
      },
      resolveType: (ref) => f.session.resolveCurrentIndex(ref.binding.bindingId, "type", irTypeBindingKey(ref.binding)),
      internFuncType: (type) => addFuncType(f.ctx, type.params, type.results),
      resolveClosure: (sig) => registry.resolveBase(sig),
      resolveClosureRoot: () => getFuncRefWrapperRootTypeIdx(f.ctx) ?? null,
      resolveClosureSubtype: (sig, fields) => registry.resolveSubtype(sig, fields),
    };
    pushDefinedFunc(f.ctx, handle, lowerIrFunctionToWasm(lifted, resolver).func);
    const run = new IrFunctionBuilder(identities.next("run"), [node], true);
    const initial = run.addParam("initial", node);
    const next = run.addParam("next", node);
    run.openBlock();
    const closure = run.emitClosureNew(irUnitFuncRef(lifted), signature, captures, captured ? [initial] : []);
    run.terminate({ kind: "return", values: [run.emitClosureCall(closure, [next], node)] });
    const runHandle = mintDefinedFunc(f.ctx);
    pushDefinedFunc(f.ctx, runHandle, lowerIrFunctionToWasm(run.finish(), resolver).func);
    f.module.exports.push({ name: "run", desc: { kind: "func", index: runHandle } });
    const make = mintDefinedFunc(f.ctx);
    pushDefinedFunc(f.ctx, make, {
      name: "make",
      typeIdx: addFuncType(f.ctx, [{ kind: "f64" }, { kind: "ref_null", typeIdx: 1 }], [{ kind: "ref", typeIdx: 1 }]),
      locals: [],
      exported: true,
      body: [
        { op: "local.get", index: 0 },
        { op: "local.get", index: 1 },
        { op: "struct.new", typeIdx: 1 },
      ],
    });
    f.module.exports.push({ name: "make", desc: { kind: "func", index: make } });
    const wasm = new WebAssembly.Module(emitBinary(f.module));
    expect(WebAssembly.Module.imports(wasm)).toEqual([]);
    const exports = new WebAssembly.Instance(wasm, {}).exports;
    const makeNode = exports.make as (value: number, parent: unknown) => unknown;
    const invoke = exports.run as (initial: unknown, next: unknown) => unknown;
    const parent = makeNode(17, null);
    const child = makeNode(42, parent);
    expect(invoke(parent, child)).toBe(captured ? parent : child);
    expect(invoke(child, parent)).toBe(captured ? child : parent);
  });
});
