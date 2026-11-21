// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * (#7354 F1b) A top-level function declaration read as a value on the Prepared path (`var g = f`, `f.x = 1`,
 * `typeof f`). The declaration's own unit stays what a call of the name reaches; the value is one closure per
 * declaration, made by its script's module-init before the first statement (GlobalDeclarationInstantiation,
 * §16.1.7: the function object exists before any code of the script runs) and kept in an immutable dynamic home.
 * Every read of the name is that home's read, so two reads are the same value. The closure's function is a
 * trampoline that calls the declaration's unit with its own arguments and puts the result into the carrier.
 *
 * The home is sound only while the binding holds its declaration: nothing writes the name, by any route
 * (`bindingHoldsItsDeclaration`), and the script is the program's only source, whose module-init runs before any
 * code that could read the home (a script that runs first would read the home before its value is stored).
 */
import { ts } from "../ts-api.js";
import { IR_DYN_CALL_BOX_FN } from "../shared/contracts/dynamic-call-helpers.js";
import { irSourceGlobalRef } from "./abi-bindings.js";
import type { AllocSiteRegistry } from "./alloc-registry.js";
import type { ModuleBindingGlobal } from "./ast-lowering-plans.js";
import { IrFunctionBuilder } from "./builder.js";
import { irRuntimeFuncRef, irUnitFuncRef } from "./callable-bindings.js";
import {
  allocateLiftedFunctionArtifact,
  recordLiftedUnitProvenance,
  type IrDerivedUnitProvenance,
  type IrSourceId,
  type IrUnitId,
} from "./identity.js";
import { irDynamic, type IrClosureSignature, type IrFunction, type IrType, type IrValueId } from "./nodes.js";
import { IrUnsupportedError } from "./outcomes.js";
import { emitFunctionObjectInit } from "./function-object-lowering.js";
import type { IrModuleInitBindingIntent, IrModuleInitPlan } from "./program/startup.js";
import type { IrPlanningIdentityContext } from "./planning-identity.js";
import { JS_TAG_IDS } from "./runtime/js-tag-domain.js";
import { irTypeIsBoolean } from "./boolean-brand.js";
import { bindingHoldsItsDeclaration } from "../shared/intrinsic-prototype-writes.js";

const DYNAMIC: IrType = Object.freeze({ kind: "dynamic" });

/**
 * The top-level function declarations of a single-source program that some identifier reads as a value, in source
 * order. A call's callee and `new`'s constructor are no value reads: a call stays the declaration's direct call.
 */
export function functionDeclarationsReadAsValues(
  checker: ts.TypeChecker,
  sourceFiles: readonly ts.SourceFile[],
): readonly ts.FunctionDeclaration[] {
  const source = sourceFiles[0]!;
  // An ES module's declarations are no global bindings; an export names the unit (the export join's question).
  if (sourceFiles.length !== 1 || ts.isExternalModule(source)) return [];
  const read = new Set<ts.Declaration>();
  const visit = (node: ts.Node): void => {
    if (ts.isIdentifier(node) && readsValue(node)) {
      const declaration = checker.getSymbolAtLocation(node)?.valueDeclaration;
      if (declaration) read.add(declaration);
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return source.statements.filter(
    (statement): statement is ts.FunctionDeclaration => ts.isFunctionDeclaration(statement) && read.has(statement),
  );
}

function readsValue(identifier: ts.Identifier): boolean {
  const { parent } = identifier;
  return !(
    (ts.isFunctionDeclaration(parent) && parent.name === identifier) ||
    ((ts.isCallExpression(parent) || ts.isNewExpression(parent)) && parent.expression === identifier)
  );
}

/**
 * The startup bindings of the homes: each a `var`-like binding (a function declaration's binding is mutable and is
 * set at instantiation; the module-init stores the value before any other code), numbered after the script's
 * declarations (`firstOrdinal`).
 */
export function functionValueBindings(
  sourceFile: ts.SourceFile,
  declarations: readonly ts.FunctionDeclaration[],
  firstOrdinal: number,
  globalBindingId: (ordinal: number) => IrModuleInitBindingIntent["globalBindingId"],
): IrModuleInitBindingIntent[] {
  return declarations.map((declaration, index) =>
    Object.freeze({
      declarationOrdinal: firstOrdinal + index,
      names: Object.freeze([declaration.name!.text]),
      declarationKind: "var" as const,
      mutable: true,
      initialization: "undefined-at-instantiation" as const,
      globalBindingId: globalBindingId(firstOrdinal + index),
      tdzBindingId: null,
      start: declaration.getStart(sourceFile),
      end: declaration.end,
    }),
  );
}

/** One declaration's value: its unit, the unit's contract, and its home. */
export interface FunctionDeclarationValue {
  readonly declaration: ts.FunctionDeclaration;
  readonly unitId: IrUnitId;
  readonly unitName: string;
  readonly params: readonly IrType[];
  readonly returnType: IrType | null;
  readonly home: ModuleBindingGlobal;
}

/** A home as the source producer lists its globals. */
export interface FunctionValueGlobal {
  readonly binding: ModuleBindingGlobal;
  readonly identity: {
    readonly ownerUnitId: IrUnitId;
    readonly storageOwnerUnitId: IrUnitId;
    readonly sourceId: IrSourceId;
    readonly mutable: false;
  };
}

/**
 * Each declaration's value, with its home on the startup binding its script's plan holds for it. A declaration whose
 * binding may hold another value, or whose unit's contract the trampoline cannot carry, refuses by name, owned by the
 * declaration's unit (`diagnostic`).
 */
export function functionDeclarationValues(
  declarations: readonly ts.FunctionDeclaration[],
  startup: readonly IrModuleInitPlan[],
  identity: Pick<IrPlanningIdentityContext, "unitIdByDeclaration" | "terminalByUnitId">,
  signatures: ReadonlyMap<IrUnitId, { readonly params: readonly IrType[]; readonly returnType: IrType | null }>,
  diagnostic: { active: IrUnitId | undefined },
): readonly (FunctionDeclarationValue & { readonly global: FunctionValueGlobal })[] {
  return declarations.map((declaration) => {
    const name = declaration.name!.text;
    const unitId = identity.unitIdByDeclaration.get(declaration)!;
    diagnostic.active = unitId;
    if (!bindingHoldsItsDeclaration(declaration.name!, declaration)) refuse(name, "is written");
    const { params, returnType } = signatures.get(unitId)!;
    if (params.some((type) => type.kind !== "dynamic")) refuse(name, "has a typed parameter");
    const start = declaration.getStart();
    const plan = startup.find((row) => row.bindings.some((binding) => binding.start === start))!;
    const binding = plan.bindings.find((row) => row.names[0] === name && row.start === start)!;
    // A script without top-level code has no module-init to make the value: nothing of it runs.
    const moduleInit = plan.unitId ?? refuse(name, "is in a script that runs no top-level code");
    const home: ModuleBindingGlobal = {
      ownerUnitId: moduleInit,
      globalRef: irSourceGlobalRef(binding.globalBindingId!, name),
      tdzGlobalRef: null,
      globalName: name,
      tdzGlobalName: null,
      type: irDynamic(JS_TAG_IDS.Function),
    };
    return {
      declaration,
      unitId,
      unitName: identity.terminalByUnitId.get(unitId)!.displayName,
      params,
      returnType,
      home,
      global: {
        binding: home,
        identity: { ownerUnitId: moduleInit, storageOwnerUnitId: moduleInit, sourceId: plan.sourceId, mutable: false },
      },
    };
  });
}

function refuse(name: string, why: string): never {
  throw new IrUnsupportedError(
    "type-resolution-unsupported",
    "build",
    `function declaration '${name}' read as a value ${why}`,
  );
}

/** The slice of the module-init lowering context the values are made in. */
export interface FunctionValueHost {
  readonly builder: IrFunctionBuilder;
  readonly ownerUnitId: IrUnitId;
  readonly liftedCounter: { value: number };
  readonly lifted: IrFunction[];
  readonly liftedUnitProvenance: IrDerivedUnitProvenance[];
  readonly allocRegistry?: AllocSiteRegistry;
}

/** The module-init prologue: each declaration's closure, stored in its home. */
export function emitFunctionDeclarationValues(
  cx: FunctionValueHost,
  values: readonly FunctionDeclarationValue[],
): void {
  for (const value of values) {
    const signature: IrClosureSignature = { params: value.params, returnType: DYNAMIC };
    const closure = cx.builder.emitClosureNew(liftTrampoline(cx, value, signature), signature, [], []);
    emitFunctionObjectInit(cx.builder, closure, value.declaration);
    const callable = cx.builder.emitCallablePack(closure, signature);
    const dynamic = cx.builder.emitCall(irRuntimeFuncRef(IR_DYN_CALL_BOX_FN), [callable], irDynamic());
    cx.builder.emitGlobalSet(value.home.globalRef, dynamic!);
  }
}

/** `(__self, ...args) => carrier(unit(...args))`: a derived function of the module-init. */
function liftTrampoline(cx: FunctionValueHost, value: FunctionDeclarationValue, signature: IrClosureSignature) {
  const identity = allocateLiftedFunctionArtifact(cx, () => `${value.declaration.name!.text}__value`);
  recordLiftedUnitProvenance(identity, cx);
  const builder = new IrFunctionBuilder(identity, [DYNAMIC], false, cx.allocRegistry);
  builder.addParam("__self", { kind: "closure", signature });
  const args = value.params.map((type, index) => builder.addParam(`a${index}`, type));
  builder.openBlock();
  const target = irUnitFuncRef({ unitId: value.unitId, name: value.unitName });
  const result = builder.emitCall(target, args, value.returnType);
  builder.terminate({ kind: "return", values: [intoCarrier(builder, result, value.returnType)] });
  const count = value.params.length;
  cx.lifted.push(
    builder.finish({ signature, captureFieldTypes: [], parameters: { kind: "fixed", count, publicLength: count } }),
  );
  return irUnitFuncRef(identity);
}

/**
 * The result into the carrier: a void result is `undefined`; any other is boxed, a Boolean under its tag, and the
 * box arm admits it as the kind `carrierKindOf` gives its type, or refuses it by name.
 */
function intoCarrier(builder: IrFunctionBuilder, result: IrValueId | null, type: IrType | null): IrValueId {
  if (result === null || type === null) return builder.emitDynUndefined();
  if (type.kind === "dynamic") return result;
  return builder.emitBox(result, irDynamic(irTypeIsBoolean(type) ? JS_TAG_IDS.Boolean : undefined));
}
