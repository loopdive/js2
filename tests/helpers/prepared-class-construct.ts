// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import { sourceInput, typedOptions, requireProgram } from "./typed-program-fixtures.js";
import { prepareIrSourceDefinitionPopulation } from "../../src/ir/program/source-class-definitions.js";
import { IrFunctionBuilder } from "../../src/ir/builder.js";
import { AllocSiteRegistry } from "../../src/ir/analysis/alloc-registry.js";
import { CLASS_CONSTRUCT_SIGNATURE } from "../../src/ir/runtime/closure-invocation-callables.js";
import { CLASS_VALUE_ALLOCATION_DECLARATION } from "../../src/ir/runtime/class-value-callable.js";
import {
  IR_CONSTRUCT,
  IR_CLOSURE_RECEIVER,
  irClosureMethodReference,
} from "../../src/ir/core/closure-invocation-callables.js";
import { irUnitFuncRef, irIntrinsicFuncRef } from "../../src/ir/core/callable-bindings.js";
import { emitNativeTypeError } from "../../src/ir/native-errors.js";
import { buildIrModuleInitPlan } from "../../src/ir/module-init-plan.js";
import { buildIrProgramCallableBindingGraph } from "../../src/ir/program-callable-bindings.js";
import { prepareTypedIrProgram } from "../../src/ir/program-prepare-ir.js";
import type { IrFunction, IrValueId } from "../../src/ir/core/nodes.js";

const external = { kind: "val", val: { kind: "externref" } } as const;
const number = { kind: "val", val: { kind: "f64" } } as const;
const integer = { kind: "val", val: { kind: "i32" } } as const;
const cell = { kind: "boxed", inner: external } as const;
const vector = CLASS_CONSTRUCT_SIGNATURE.params[1]!;
const callSignature = { params: [], returnType: external } as const;
const constructFields = [cell, cell, cell] as const;
const outerFields = [external, external, external, cell, cell, cell, cell, cell] as const;
export type ConstructProbe = "marker" | "newTarget" | "argument" | "arguments" | "throw" | "nested" | "retained";
export const constructPolicy = {
  ...typedOptions.policy,
  numberBoundary: { box: "native", unbox: "native" },
  stringConst: { storage: "native" },
} as const;

/** Constructed dispatch harness, retaining the real class inventory; not source ClassDefinitionEvaluation. */
export function classConstructInput(probe: ConstructProbe = "marker", retainedDepth = 0) {
  const factoryName = (target: string, depth: number) => `factory_${target}_${depth}`;
  const factorySource = (probe === "retained" ? ["left"] : ["left", "right"])
    .flatMap((target) =>
      Array.from({ length: retainedDepth }, (_, depth) => `function ${factoryName(target, depth)}():number{return 0;}`),
    )
    .join("\n");
  const source = sourceInput({
    "./entry.ts": `export function run():number {class C{};return 0;}
    function outer():number{return 0;} function left():number{return 0;}
    function right():number{return 0;} function callClass():number{return 0;}${factorySource}`,
  });
  const { inventory, identity } = prepareIrSourceDefinitionPopulation(source);
  const originalInventory = JSON.stringify(inventory);
  const registry = new AllocSiteRegistry();
  const make = (name: string, exported = false) => {
    const unit = inventory.terminalUnits.find((unit) => unit.displayName === name)!;
    return new IrFunctionBuilder({ unitId: unit.id, name }, [external], exported, registry);
  };
  const metadata = (
    signature: typeof CLASS_CONSTRUCT_SIGNATURE | typeof callSignature,
    fields: readonly (typeof cell)[] | readonly (typeof external)[],
  ) => ({
    signature,
    captureFieldTypes: fields,
    parameters: { kind: "fixed" as const, count: signature.params.length, publicLength: signature.params.length },
  });
  const c = make("callClass");
  c.addParam("self", { kind: "closure", signature: callSignature });
  c.openBlock();
  emitNativeTypeError(c, "Class constructor cannot be invoked without new");
  c.terminate({ kind: "unreachable" });
  const call = c.finish(metadata(callSignature, []));
  function allocate(builder: IrFunctionBuilder, target: IrFunction, captures: readonly IrValueId[]) {
    const construct = builder.emitClosureNew(
      irUnitFuncRef(target),
      CLASS_CONSTRUCT_SIGNATURE,
      constructFields,
      captures,
    );
    const nil = builder.emitConst({ kind: "null", ty: external }, external);
    return builder.emitCoerceToExternref(
      builder.emitClassValueNew({
        signature: callSignature,
        callTarget: irUnitFuncRef(call),
        allocator: CLASS_VALUE_ALLOCATION_DECLARATION.ref,
        construct,
        parent: nil,
        properties: nil,
      }),
    );
  }
  function internal(name: "left" | "right", nested?: IrFunction) {
    const b = make(name);
    const self = b.addParam("self", { kind: "closure", signature: CLASS_CONSTRUCT_SIGNATURE });
    const newTarget = b.addParam("newTarget", external),
      argv = b.addParam("argv", vector);
    b.openBlock();
    const captures = constructFields.map((type, index) => b.emitClosureCap(self, index, type));
    b.emitRefCellSet(captures[1]!, newTarget);
    b.emitRefCellSet(captures[2]!, b.emitCoerceToExternref(argv));
    const marker = b.emitRefCellGet(captures[0]!, external);
    const first = () => b.emitVecGet(argv, b.emitConst({ kind: "i32", value: 0 }, integer), external);
    let value = marker;
    if (name === "right" || probe === "argument") value = first();
    else if (probe === "newTarget") value = newTarget;
    else if (probe === "arguments") value = b.emitCoerceToExternref(argv);
    else if (probe === "nested") {
      const cls = allocate(b, nested!, captures);
      value = b.emitCall(irIntrinsicFuncRef(IR_CONSTRUCT), [cls, cls, argv], external)!;
    } else if (probe === "throw") {
      b.emitThrow(marker);
      b.terminate({ kind: "unreachable" });
      return b.finish(metadata(CLASS_CONSTRUCT_SIGNATURE, constructFields));
    }
    b.terminate({ kind: "return", values: [value] });
    return b.finish(metadata(CLASS_CONSTRUCT_SIGNATURE, constructFields));
  }
  const right = internal("right"),
    left = internal("left", right);
  const factories: IrFunction[] = [];
  const factoryByTarget = new Map<string, IrFunction>();
  function retained(builder: IrFunctionBuilder, target: IrFunction, captures: readonly IrValueId[]) {
    if (!retainedDepth) return allocate(builder, target, captures);
    const cached = factoryByTarget.get(target.unitId);
    if (cached) return builder.emitCall(irUnitFuncRef(cached), captures, external)!;
    let prior: IrFunction | undefined;
    for (let depth = 0; depth < retainedDepth; depth++) {
      const factory = make(factoryName(target.name, depth));
      const parameters = constructFields.map((type, index) => factory.addParam(`cell${index}`, type));
      factory.openBlock();
      const value = prior
        ? factory.emitCall(irUnitFuncRef(prior), parameters, external)!
        : allocate(factory, target, parameters);
      const isNull = factory.emitRefIsNull(factory.emitRefCellGet(parameters[0]!, external));
      const early = factory.collectBodyInstrs(() => factory.emitEarlyReturn(value));
      factory.emitIfStmt({ cond: isNull, then: early, else: [] });
      factory.terminate({ kind: "return", values: [value] });
      prior = factory.finish();
      factories.push(prior);
    }
    factoryByTarget.set(target.unitId, prior!);
    return builder.emitCall(irUnitFuncRef(prior!), captures, external)!;
  }
  const outer = make("outer");
  const outerSelf = outer.addParam("self", { kind: "closure", signature: callSignature });
  outer.openBlock();
  const captures = outerFields.map((type, index) => outer.emitClosureCap(outerSelf, index, type));
  const markerA = outer.emitRefCellNew(captures[0]!, external.val),
    markerB = outer.emitRefCellNew(captures[1]!, external.val);
  const leftClass = retained(outer, left, [markerA, captures[6]!, captures[7]!]);
  const rightClass = retained(outer, probe === "retained" ? left : right, [markerB, captures[6]!, captures[7]!]);
  const argv = outer.emitVecNewFixed([captures[2]!, captures[1]!], external, vector);
  const invoke = (callee: IrValueId, target: IrValueId, resultCell: IrValueId) => {
    const payloadSlot = outer.declareSlot("caught", external.val);
    const body = outer.collectBodyInstrs(() => {
      const result = outer.emitCall(irIntrinsicFuncRef(IR_CONSTRUCT), [callee, target, argv], external)!;
      outer.emitRefCellSet(resultCell, result);
    });
    const handler = outer.collectBodyInstrs(() => outer.emitRefCellSet(resultCell, outer.emitSlotRead(payloadSlot)));
    outer.emitTry({ body, catchClause: { payloadSlot, body: handler } });
  };
  invoke(leftClass, rightClass, captures[3]!);
  invoke(rightClass, leftClass, captures[4]!);
  outer.emitRefCellSet(markerA, captures[2]!);
  invoke(leftClass, leftClass, captures[5]!);
  const receiver = outer.emitCall(irIntrinsicFuncRef(IR_CLOSURE_RECEIVER), [], external)!;
  outer.terminate({ kind: "return", values: [receiver] });
  const outerFn = outer.finish({
    signature: callSignature,
    captureFieldTypes: outerFields,
    parameters: { kind: "fixed", count: 0, publicLength: 0 },
  });
  const run = make("run", true);
  const incoming = run.addParam("receiver", external),
    a = run.addParam("markerA", external),
    b = run.addParam("markerB", external),
    payload = run.addParam("payload", external),
    mode = run.addParam("mode", number);
  run.openBlock();
  const nil = run.emitConst({ kind: "null", ty: external }, external);
  const cells = Array.from({ length: 5 }, () => run.emitRefCellNew(nil, external.val));
  const closure = run.emitClosureNew(irUnitFuncRef(outerFn), callSignature, outerFields, [a, b, payload, ...cells]);
  const packed = run.emitCoerceToExternref(run.emitCallablePack(closure, callSignature));
  let result = run.emitCall(irClosureMethodReference(3), [incoming, packed, a, b, payload], external)!;
  cells.forEach((cell, index) => {
    const match = run.emitBinary("f64.eq", mode, run.emitConst({ kind: "f64", value: index + 1 }, number), integer);
    const selected = run.emitRefCellGet(cell, external);
    result = run.emitIfElse({
      cond: match,
      then: [],
      thenValue: selected,
      else: [],
      elseValue: result,
      resultType: external,
    });
  });
  run.terminate({ kind: "return", values: [result] });
  const graph = buildIrProgramCallableBindingGraph({
    checker: source.checker,
    sourceFiles: source.sourceFiles,
    identityContext: identity,
  });
  const input = {
    inventory,
    ir: { functions: [run.finish(), outerFn, left, right, call, ...factories] },
    derivedUnits: [],
    startup: [
      buildIrModuleInitPlan({
        sourceFile: source.entrySource,
        checker: source.checker,
        identityContext: identity,
        target: "standalone",
        deferTopLevelInit: false,
      }),
    ],
    callables: graph.records,
    globals: [],
    allocations: registry.snapshot(),
  };
  return { input, source, originalInventory, outer: outerFn, left, right };
}
export function prepareClassConstructProgram(probe?: ConstructProbe, retainedDepth = 0) {
  const fixture = classConstructInput(probe, retainedDepth);
  return {
    ...fixture,
    program: requireProgram(
      prepareTypedIrProgram(fixture.input, {
        ...typedOptions,
        policy: constructPolicy,
        runtimePolicies: [constructPolicy],
      }),
    ),
  };
}
