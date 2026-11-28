// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * (#7354 F1b) A top-level function declaration read as a value on the Prepared path (`var g = f`, `f.x = 1`,
 * `typeof f`). The declaration's own unit stays what a call of the name reaches; the value is one closure per
 * declaration, made by its script's module-init before the first statement (GlobalDeclarationInstantiation,
 * §16.1.7: the function object exists before any code of the script runs) and kept in a dynamic home.
 * Every read of the name is that home's read, so two reads are the same value. The closure's function is a
 * trampoline that calls the declaration's unit with its own arguments and puts the result into the carrier.
 *
 * The script must be the program's only startup source, whose module-init runs before any code that could read the
 * home (a script that runs first would read the home before its value is stored). (#7363 A3) A called eval source
 * runs only from its site, after that prologue, declares no function and stores into no identifier: a text that does
 * is no site (`literal-dynamic-code.ts`), since the write walk below sees only the declaring file. (#7354 H2) The
 * binding is writable (§9.1.1.4.18): where an identifier writes it (`preparedBindingRewritten`, which sees every write on this
 * path), the home is mutable and untagged, and a call of the name reads it: the call planner plans no direct call of a
 * reassigned declaration (`imported-functions.ts`).
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
  type IrBindingId,
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
import { preparedBindingRewritten } from "./module-binding-script-var.js";
import { annexBDeclaringRange, annexBWritesScriptBinding } from "../shared/annexb-block-functions.js";

const DYNAMIC: IrType = Object.freeze({ kind: "dynamic" });

/**
 * The top-level function declarations of a program with one startup source that some identifier of that source reads
 * as a value, or that an Annex B block function writes, in source order. A call's callee is no value read: a call
 * stays the declaration's direct call. (#7354 C2) `new`'s constructor is one: [[Construct]] takes the function object,
 * its `prototype` included.
 */
export function functionDeclarationsReadAsValues(
  checker: ts.TypeChecker,
  startupSources: readonly ts.SourceFile[],
): readonly ts.FunctionDeclaration[] {
  const source = startupSources[0]!;
  // An ES module's declarations are no global bindings; an export names the unit (the export join's question).
  if (startupSources.length !== 1 || ts.isExternalModule(source)) return [];
  const read = new Set<ts.Declaration>();
  const visit = (node: ts.Node): void => {
    if (ts.isIdentifier(node) && readsValue(node)) {
      const declaration = checker.getSymbolAtLocation(node)?.valueDeclaration;
      if (declaration) read.add(declaration);
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  // (#7372 2a-3) An Annex B block function of its name writes the binding: calls of the name then read the home.
  return source.statements.filter(
    (statement): statement is ts.FunctionDeclaration =>
      ts.isFunctionDeclaration(statement) &&
      (read.has(statement) || (statement.name !== undefined && annexBWritesScriptBinding(source, statement.name.text))),
  );
}

function readsValue(identifier: ts.Identifier): boolean {
  const { parent } = identifier;
  return !(
    (ts.isFunctionDeclaration(parent) && parent.name === identifier) ||
    (ts.isCallExpression(parent) && parent.expression === identifier)
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

/** A declaration's unit and the unit's contract: what a function object of the declaration calls. */
export interface FunctionDeclarationUnit {
  readonly declaration: ts.FunctionDeclaration;
  readonly unitId: IrUnitId;
  readonly unitName: string;
  readonly params: readonly IrType[];
  readonly returnType: IrType | null;
}

/** One declaration's value: its unit, the unit's contract, and its home. */
export interface FunctionDeclarationValue extends FunctionDeclarationUnit {
  readonly home: ModuleBindingGlobal;
}

/** The declaration's unit; a contract the trampoline cannot carry (a typed parameter) refuses by name. */
export function functionDeclarationUnit(
  identity: Pick<IrPlanningIdentityContext, "unitIdByDeclaration" | "terminalByUnitId">,
  signatures: ReadonlyMap<IrUnitId, { readonly params: readonly IrType[]; readonly returnType: IrType | null }>,
  declaration: ts.FunctionDeclaration,
): FunctionDeclarationUnit {
  const unitId = identity.unitIdByDeclaration.get(declaration)!;
  const { params, returnType } = signatures.get(unitId)!;
  if (params.some((type) => type.kind !== "dynamic")) refuse(declaration.name!.text, "has a typed parameter");
  return { declaration, unitId, unitName: identity.terminalByUnitId.get(unitId)!.displayName, params, returnType };
}

/** A home as the source producer lists its globals. */
export interface FunctionValueGlobal {
  readonly binding: ModuleBindingGlobal;
  readonly identity: {
    readonly ownerUnitId: IrUnitId;
    readonly storageOwnerUnitId: IrUnitId;
    readonly sourceId: IrSourceId;
    readonly mutable: boolean;
  };
}

/**
 * Each declaration's value, with its home on the startup binding its script's plan holds for it. A name with a second
 * declaration (whose last-wins and Annex B semantics are not modelled), or a unit whose contract the trampoline
 * cannot carry, refuses by name, owned by the declaration's unit (`diagnostic`).
 */
export function functionDeclarationValues(
  checker: ts.TypeChecker,
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
    // A JS symbol also lists the member stores of its function (`f.x = 1`), which declare no binding.
    // (#7372 2a-3) An Annex B block function the checker binds to the file is no second declaration: it has its own
    // block binding and writes this home (`annexb-block-function-values.ts`).
    const declarations = checker.getSymbolAtLocation(declaration.name!)!.declarations!.filter(ts.isFunctionDeclaration);
    if (declarations.filter((other) => annexBDeclaringRange(other) === null).length > 1)
      refuse(name, "has a second declaration");
    const rewritten = preparedBindingRewritten(checker, declaration.name!);
    const unit = functionDeclarationUnit(identity, signatures, declaration);
    const start = declaration.getStart();
    const plan = startup.find((row) => row.bindings.some((binding) => binding.start === start))!;
    const binding = plan.bindings.find((row) => row.names[0] === name && row.start === start)!;
    // A script without top-level code has no module-init to make the value: nothing of it runs.
    const moduleInit = plan.unitId ?? refuse(name, "is in a script that runs no top-level code");
    const global = moduleInitDynamicHome(moduleInit, plan.sourceId, binding.globalBindingId!, name, {
      type: irDynamic(rewritten ? undefined : JS_TAG_IDS.Function),
      mutable: rewritten,
    });
    return { ...unit, home: global.binding, global };
  });
}

/**
 * A home in the dynamic carrier: a module-init global named `adapterName` (the key its storage is found by), owned
 * and stored by the module-init. (#7372 2a) An Annex B block function's homes are built the same way.
 */
export function moduleInitDynamicHome(
  moduleInit: IrUnitId,
  sourceId: IrSourceId,
  bindingId: IrBindingId,
  adapterName: string,
  { type, mutable }: { readonly type: IrType; readonly mutable: boolean },
): FunctionValueGlobal {
  const binding: ModuleBindingGlobal = {
    ownerUnitId: moduleInit,
    globalRef: irSourceGlobalRef(bindingId, adapterName),
    tdzGlobalRef: null,
    globalName: adapterName,
    tdzGlobalName: null,
    type,
  };
  return { binding, identity: { ownerUnitId: moduleInit, storageOwnerUnitId: moduleInit, sourceId, mutable } };
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
  /** (#7489) The program's code strictness, for a function object's own `caller` (`emitFunctionObjectInit`). */
  readonly resolver?: Parameters<typeof emitFunctionObjectInit>[3];
}

/** The module-init prologue: each declaration's closure, stored in its home. */
export function emitFunctionDeclarationValues(
  cx: FunctionValueHost,
  values: readonly FunctionDeclarationValue[],
): void {
  for (const value of values) cx.builder.emitGlobalSet(value.home.globalRef, emitFunctionDeclarationObject(cx, value));
}

/**
 * A fresh function object of the declaration, as a dynamic value: a closure of its trampoline, made a function object
 * (`emitFunctionObjectInit`, named `name` when given). (#7487) A literal `Function` site makes one per evaluation.
 */
export function emitFunctionDeclarationObject(
  cx: FunctionValueHost,
  unit: FunctionDeclarationUnit,
  name?: string,
): IrValueId {
  const signature: IrClosureSignature = { params: unit.params, returnType: DYNAMIC };
  const closure = cx.builder.emitClosureNew(liftTrampoline(cx, unit, signature), signature, [], []);
  emitFunctionObjectInit(cx.builder, closure, unit.declaration, cx.resolver, name);
  const callable = cx.builder.emitCallablePack(closure, signature);
  return cx.builder.emitCall(irRuntimeFuncRef(IR_DYN_CALL_BOX_FN), [callable], irDynamic())!;
}

/** `(__self, ...args) => carrier(unit(...args))`: a derived function of the lowering unit. */
function liftTrampoline(cx: FunctionValueHost, value: FunctionDeclarationUnit, signature: IrClosureSignature) {
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
