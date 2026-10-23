// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import { ts } from "../../src/ts-api.js";
import { sourceInput, typedOptions, requireProgram } from "./typed-program-fixtures.js";
import { prepareIrSourceDefinitionPopulation } from "../../src/ir/program/source-class-definitions.js";
import { prepareSourceClosureEntry } from "../../src/ir/source-closure-entry.js";
import { lowerFunctionAstToIr } from "../../src/ir/from-ast.js";
import { IrFunctionBuilder } from "../../src/ir/builder.js";
import { AllocSiteRegistry } from "../../src/ir/analysis/alloc-registry.js";
import { irUnitFuncRef, irIntrinsicFuncRef } from "../../src/ir/core/callable-bindings.js";
import { irClosureMethodReference, IR_CLOSURE_UNDEFINED } from "../../src/ir/core/closure-invocation-callables.js";
import { buildIrModuleInitPlan } from "../../src/ir/module-init-plan.js";
import { buildIrProgramCallableBindingGraph } from "../../src/ir/program-callable-bindings.js";
import { prepareTypedIrProgram } from "../../src/ir/program-prepare-ir.js";

export const MEMBER_ENTRY_SOURCE = `export function make(seed:number):number {
  class C {
    read(x:number):number {return seed+x+(this===null?100:200);}
    write(x:number):number {seed=x;return seed;}
  }
  return seed;
}
export function run(seed:number):number {return 0;}`;
const number = { kind: "val", val: { kind: "f64" } } as const;
const external = { kind: "val", val: { kind: "externref" } } as const;
const cell = { kind: "boxed", inner: number } as const;
export const memberEntryPolicy = {
  ...typedOptions.policy,
  numberBoundary: { box: "native", unbox: "native" },
  stringConst: { storage: "native" },
} as const;

/** Original method ASTs/inventory; only the typed make/run harness is hand-authored. No class evaluation claim. */
export function memberEntryInput(bypass?: "direct" | "escape" | "export", nestedThrow = false) {
  const text = nestedThrow
    ? MEMBER_ENTRY_SOURCE.replace(
        "read(x:number):number {return seed+x+(this===null?100:200);}",
        "read(x:number):number {const bonus=():number=>this===null?100:200; const nested=():number=>{throw 7;}; try {nested();} catch(error) {} return seed+x+bonus();}",
      )
    : MEMBER_ENTRY_SOURCE;
  const input = sourceInput({ "./entry.ts": text });
  const { inventory, identity } = prepareIrSourceDefinitionPopulation(input);
  const originalInventory = JSON.stringify(inventory);
  const factory = input.entrySource.statements[0] as ts.FunctionDeclaration;
  const declaration = factory.body!.statements[0] as ts.ClassDeclaration;
  const allocations = new AllocSiteRegistry();
  const entries = declaration.members.map((method) => {
    const entry = prepareSourceClosureEntry({
      ...input,
      identity,
      declaration: method as ts.MethodDeclaration,
      captures: [{ declaration: factory.parameters[0]!, fieldType: cell }],
    });
    const lowered = lowerFunctionAstToIr(method as ts.MethodDeclaration, {
      ownerUnitId: entry.unitId,
      funcName: (method.name as ts.Identifier).text,
      identityContext: identity,
      checker: input.checker,
      allocRegistry: allocations,
      sourceClosureEntry: entry,
      numericThrow: "number-boundary",
      resolver: { jsHostExterns: () => false },
    });
    if (lowered.liftedUnitProvenance.some((row) => !("sourceUnit" in row)))
      throw Error("member fabricated a derived body");
    return { entry, fn: lowered.main, nested: lowered.lifted };
  });
  const makeUnit = inventory.terminalUnits.find((unit) => unit.displayName === "make")!;
  const make = new IrFunctionBuilder({ unitId: makeUnit.id, name: "make" }, [number], true, allocations);
  const seed = make.addParam("seed", number);
  make.openBlock();
  make.terminate({ kind: "return", values: [seed] });
  const runUnit = inventory.terminalUnits.find((unit) => unit.displayName === "run")!;
  const b = new IrFunctionBuilder(
    { unitId: runUnit.id, name: "run" },
    [bypass === "escape" ? external : number],
    true,
    allocations,
  );
  const initial = b.addParam("seed", number);
  b.openBlock();
  const n = (value: number) => b.emitConst({ kind: "f64", value }, number);
  const leftCell = b.emitRefCellNew(initial, number.val);
  const rightCell = b.emitRefCellNew(b.emitBinary("f64.add", initial, n(16), number), number.val);
  const closure = (index: number, captured: typeof leftCell) => {
    const { entry, fn } = entries[index]!;
    const raw = b.emitClosureNew(irUnitFuncRef(fn), entry.signature, entry.captureFieldTypes, [captured]);
    return { raw, external: b.emitCoerceToExternref(b.emitCallablePack(raw, entry.signature)) };
  };
  const left = closure(0, leftCell),
    right = closure(0, rightCell),
    writer = closure(1, leftCell);
  const nil = b.emitConst({ kind: "null", ty: external }, external);
  const undefinedValue = b.emitCall(irIntrinsicFuncRef(IR_CLOSURE_UNDEFINED), [], external)!;
  const call = (callee: typeof left, receiver: typeof nil, value: number) =>
    b.emitIntrinsic("js.number.unbox", [
      b.emitCall(
        irClosureMethodReference(1),
        [receiver, callee.external, b.emitIntrinsic("js.number.box", [n(value)])],
        external,
      )!,
    ]);
  const first = call(left, nil, 4);
  call(writer, nil, 31);
  const second = call(right, undefinedValue, 4),
    third = call(left, nil, 5);
  if (bypass === "direct") b.emitClosureCall(left.raw, [n(9)], number);

  const result = b.emitBinary(
    "f64.add",
    b.emitBinary(
      "f64.add",
      b.emitBinary("f64.mul", first, n(1000000), number),
      b.emitBinary("f64.mul", second, n(1000), number),
      number,
    ),
    third,
    number,
  );
  b.terminate({ kind: "return", values: [bypass === "escape" ? left.external : result] });
  const graph = buildIrProgramCallableBindingGraph({
    checker: input.checker,
    sourceFiles: input.sourceFiles,
    identityContext: identity,
  });
  const packet = {
    inventory,
    ir: {
      functions: [
        make.finish(),
        ...entries.flatMap(({ fn, nested }, index) => [
          bypass === "export" && index === 0 ? { ...fn, exported: true } : fn,
          ...nested,
        ]),
        b.finish(),
      ],
    },
    derivedUnits: [],
    startup: [
      buildIrModuleInitPlan({
        sourceFile: input.entrySource,
        checker: input.checker,
        identityContext: identity,
        target: "standalone",
        deferTopLevelInit: false,
      }),
    ],
    callables: graph.records,
    globals: [],
    allocations: allocations.snapshot(),
  };
  return { input, packet, inventory, originalInventory, entries, identity, declaration, factory };
}
export function prepareMemberEntryProgram(bypass?: Parameters<typeof memberEntryInput>[0], nestedThrow = false) {
  const fixture = memberEntryInput(bypass, nestedThrow);
  return {
    ...fixture,
    program: requireProgram(
      prepareTypedIrProgram(fixture.packet, {
        ...typedOptions,
        policy: memberEntryPolicy,
        runtimePolicies: [memberEntryPolicy],
      }),
    ),
  };
}
