// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import { ts } from "../../src/ts-api.js";
import { sourceInput, typedOptions, requireProgram } from "./typed-program-fixtures.js";
import { prepareIrSourceDefinitionPopulation } from "../../src/ir/source-class-definitions.js";
import { prepareSourceClosureEntry } from "../../src/ir/source-closure-entry.js";
import { lowerFunctionAstToIr } from "../../src/ir/from-ast.js";
import { createSourceLexicalBinding, initializeSourceLexicalBinding } from "../../src/ir/source-lexical-bindings.js";
import { IrFunctionBuilder } from "../../src/ir/builder.js";
import { AllocSiteRegistry } from "../../src/ir/analysis/alloc-registry.js";
import { irUnitFuncRef, irIntrinsicFuncRef } from "../../src/ir/core/callable-bindings.js";
import { irClosureMethodReference, IR_CLOSURE_UNDEFINED } from "../../src/ir/core/closure-invocation-callables.js";
import { buildIrModuleInitPlan } from "../../src/ir/module-init-plan.js";
import { buildIrProgramCallableBindingGraph } from "../../src/ir/program-callable-bindings.js";
import { prepareTypedIrProgram } from "../../src/ir/program-prepare-ir.js";
import { memberEntryPolicy } from "./prepared-member-entries.js";

const external = { kind: "val", val: { kind: "externref" } } as const;
const number = { kind: "val", val: { kind: "f64" } } as const;
const flag = { kind: "boxed", inner: { kind: "val", val: { kind: "i32" } } } as const;

/** Actual original accessor bodies over constructed binding storage; no ClassDefinitionEvaluation claim. */
export function prepareSourceClassBindings(immutable: boolean) {
  const members =
    "get read():number{const nested=():number=>{const retained=():number=>(C===null?100:200)+count;return retained();};return nested();}set write(value:number){function assign():number{if(value===9){C=(count++,null as any);}else if(value===10){C=(count++,3 as any);}else{C=(count++,true as any);}return 0;}assign();}get deferred():()=>number{return ():number=>{const retained=():number=>(C===null?100:200)+count;return retained();};}";
  const source = sourceInput({
    "./entry.ts": `function make():number{let count=0;${immutable ? `class C{${members}}` : `class C{}class D{${members}}`}return 0;}export function run(mode:number):number{return 0;}`,
  });
  const { inventory, identity } = prepareIrSourceDefinitionPopulation(source),
    originalInventory = JSON.stringify(inventory);
  const factory = source.entrySource.statements[0] as ts.FunctionDeclaration;
  const count = (factory.body!.statements[0] as ts.VariableStatement).declarationList.declarations[0]!;
  const classDeclaration = factory.body!.statements[1] as ts.ClassDeclaration;
  const owner = immutable ? classDeclaration : (factory.body!.statements[2] as ts.ClassDeclaration);
  const registry = new AllocSiteRegistry();
  const entries = owner.members.map((declaration) => {
    const entry = prepareSourceClosureEntry({
      identity,
      checker: source.checker,
      declaration: declaration as ts.GetAccessorDeclaration | ts.SetAccessorDeclaration,
      captures: [
        { declaration: classDeclaration, fieldType: { kind: "boxed", inner: external }, initializedFieldType: flag },
        { declaration: count, fieldType: { kind: "boxed", inner: number } },
      ],
    });
    const lowered = lowerFunctionAstToIr(entry.declaration, {
      ownerUnitId: entry.unitId,
      funcName: (declaration.name as ts.Identifier).text,
      identityContext: identity,
      checker: source.checker,
      allocRegistry: registry,
      sourceClosureEntry: entry,
      numericThrow: "number-boundary",
      resolver: { jsHostExterns: () => false },
    });
    return { entry, lowered };
  });
  const make = (name: string, exported = false) => {
    const unit = inventory.terminalUnits.find((unit) => unit.displayName === name)!;
    return new IrFunctionBuilder({ unitId: unit.id, name }, [number], exported, registry);
  };
  const originalMake = make("make");
  originalMake.openBlock();
  originalMake.terminate({ kind: "return", values: [originalMake.emitConst({ kind: "f64", value: 0 }, number)] });
  const b = make("run", true),
    mode = b.addParam("mode", number);
  b.openBlock();
  const n = (value: number) => b.emitConst({ kind: "f64", value }, number);
  const binding = createSourceLexicalBinding(b, !immutable),
    countCell = b.emitRefCellNew(n(0), number.val);
  const closures = entries.map(({ entry, lowered }) =>
    b.emitCoerceToExternref(
      b.emitCallablePack(
        b.emitClosureNew(irUnitFuncRef(lowered.main), entry.signature, entry.captureFieldTypes, [
          binding.valueCell,
          binding.initializedCell,
          countCell,
        ]),
        entry.signature,
      ),
    ),
  );
  const nil = b.emitConst({ kind: "null", ty: external }, external);
  const deferred = b.emitCall(irClosureMethodReference(0), [nil, closures[2]!], external)!;
  const read = () =>
    b.emitIntrinsic("js.number.unbox", [b.emitCall(irClosureMethodReference(0), [nil, deferred], external)!]);
  const write = (argument = n(9)) =>
    b.emitCall(
      irClosureMethodReference(1),
      [nil, closures[1]!, b.emitIntrinsic("js.number.box", [argument])],
      external,
    );
  const output = b.declareSlot("output", number.val);
  b.emitSlotWrite(output, n(0));
  const attempt = (body: () => void, caught: number) => {
    const payloadSlot = b.declareSlot("caught", external.val);
    const instructions = b.collectBodyInstrs(body),
      handler = b.collectBodyInstrs(() => b.emitSlotWrite(output, n(caught)));
    b.emitTry({ body: instructions, catchClause: { payloadSlot, body: handler } });
  };
  const uninitializedRead = b.collectBodyInstrs(() => attempt(() => b.emitSlotWrite(output, read()), 11));
  const uninitializedWrite = b.collectBodyInstrs(() => {
    attempt(() => {
      write();
    }, 13);
    b.emitSlotWrite(
      output,
      b.emitBinary(
        "f64.add",
        b.emitSlotRead(output),
        b.emitBinary("f64.mul", b.emitRefCellGet(countCell, number), n(1000), number),
        number,
      ),
    );
  });
  const initialized = b.collectBodyInstrs(() => {
    const value = b.emitCall(irIntrinsicFuncRef(IR_CLOSURE_UNDEFINED), [], external)!;
    initializeSourceLexicalBinding(b, binding, value);
    const boxedWrite = b.collectBodyInstrs(() => {
      const boolean = b.emitBinary("f64.eq", mode, n(5), { kind: "val", val: { kind: "i32" } });
      attempt(() => {
        write(b.emitSelect(boolean, n(11), n(10), number));
      }, 22);
      if (immutable) {
        b.emitSlotWrite(output, b.emitBinary("f64.add", b.emitSlotRead(output), read(), number));
      } else {
        const stored = b.emitRefCellGet(binding.valueCell, external);
        b.emitSlotWrite(output, b.emitIntrinsic("js.number.unbox", [stored]));
        b.emitSlotWrite(
          output,
          b.emitBinary(
            "f64.add",
            b.emitSlotRead(output),
            b.emitBinary("f64.mul", b.emitRefCellGet(countCell, number), n(1000), number),
            number,
          ),
        );
      }
    });
    const referenceWrite = b.collectBodyInstrs(() => {
      const mutation = b.collectBodyInstrs(() =>
        attempt(() => {
          write();
        }, 22),
      );
      b.emitIfStmt({
        cond: b.emitBinary("f64.eq", mode, n(2), { kind: "val", val: { kind: "i32" } }),
        then: mutation,
        else: [],
      });
      b.emitSlotWrite(output, b.emitBinary("f64.add", b.emitSlotRead(output), read(), number));
    });
    const ordinary = b.collectBodyInstrs(() =>
      b.emitSlotWrite(
        output,
        b.emitIntrinsic("js.number.unbox", [b.emitCall(irClosureMethodReference(0), [nil, closures[0]!], external)!]),
      ),
    );
    const retained = b.collectBodyInstrs(() => {
      b.emitIfStmt({
        cond: b.emitBinary("f64.ge", mode, n(4), { kind: "val", val: { kind: "i32" } }),
        then: boxedWrite,
        else: referenceWrite,
      });
    });
    b.emitIfStmt({
      cond: b.emitBinary("f64.eq", mode, n(6), { kind: "val", val: { kind: "i32" } }),
      then: ordinary,
      else: retained,
    });
  });
  const later = b.collectBodyInstrs(() =>
    b.emitIfStmt({
      cond: b.emitBinary("f64.eq", mode, n(3), { kind: "val", val: { kind: "i32" } }),
      then: uninitializedWrite,
      else: initialized,
    }),
  );
  b.emitIfStmt({
    cond: b.emitBinary("f64.eq", mode, n(0), { kind: "val", val: { kind: "i32" } }),
    then: uninitializedRead,
    else: later,
  });
  b.terminate({ kind: "return", values: [b.emitSlotRead(output)] });
  const callables = buildIrProgramCallableBindingGraph({
    checker: source.checker,
    sourceFiles: source.sourceFiles,
    identityContext: identity,
  });
  const input = {
    inventory,
    ir: {
      functions: [
        originalMake.finish(),
        ...entries.flatMap(({ lowered }) => [lowered.main, ...lowered.lifted]),
        b.finish(),
      ],
    },
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
    callables: callables.records,
    globals: [],
    allocations: registry.snapshot(),
  };
  const policy = { ...memberEntryPolicy, booleanBoundary: { box: "native", unbox: "native" } } as const;
  const program = requireProgram(
    prepareTypedIrProgram(input, {
      ...typedOptions,
      policy,
      runtimePolicies: [policy],
    }),
  );
  return { program, input, source, originalInventory, entries };
}
