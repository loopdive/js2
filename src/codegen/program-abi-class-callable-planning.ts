// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.

import { irSupportFuncRef, irUnitCallableBindingId, irUnitFuncRef } from "../ir/callable-bindings.js";
import type { IrBindingId, IrClassId, IrUnitId, IrUnitKind } from "../ir/identity.js";
import type { IrPlanningIdentityContext } from "../ir/planning-identity.js";
import { ProgramAbiInvariantError } from "../ir/program-abi.js";
import type { FuncHandle, FuncTypeDef, WasmFunction } from "../ir/types.js";
import { ts } from "../ts-api.js";
import type { CodegenContext } from "./context/types.js";
import { definedFuncAt, isImportFuncIdx, pushDefinedFunc } from "./func-space.js";
import {
  planProgramAbiSupportCallable,
  planProgramAbiUnitCallable,
  PROGRAM_ABI_CALLABLE_ROLE,
} from "./program-abi-planning.js";
import type { ProgramAbiSession } from "./program-abi-session.js";

export { mintDefinedFunc } from "./func-space.js";

const PROMISE_SUBCLASS_ONHOST_CALLABLE_ROLE = "promise-subclass-onhost-constructor";

interface ProgramAbiClassUnitCallableObservation {
  readonly unitId: IrUnitId;
  readonly displayName: string;
  readonly funcIdx: FuncHandle;
  readonly func: WasmFunction;
}

interface ProgramAbiClassSupportCallableObservation {
  readonly bindingId: IrBindingId;
  readonly classId: IrClassId;
  readonly role: string;
  readonly roleOrdinal: number;
  readonly displayName: string;
  readonly funcIdx: FuncHandle;
  readonly func: WasmFunction;
}

interface ProgramAbiInheritedClassCallableObservation {
  readonly childClassId: IrClassId;
  readonly canonicalUnitId: IrUnitId;
  readonly displayName: string;
}

/** Push and structurally observe one class-owned allocation atomically. */
export function pushProgramAbiClassCallable(
  ctx: CodegenContext,
  declaration: ts.Node,
  kind: "unit" | "constructor-new" | "promise-subclass-onhost",
  funcIdx: FuncHandle,
  func: WasmFunction,
): void {
  pushDefinedFunc(ctx, funcIdx, func);
  const registry = ctx.programAbiClassCallables;
  if (!registry) return;
  if (kind === "unit") {
    registry.observeUnit(declaration, func.name, funcIdx);
    return;
  }
  if (!ts.isClassDeclaration(declaration) && !ts.isClassExpression(declaration)) {
    throw new ProgramAbiInvariantError(
      "unknown-inventory-class",
      `class support callable ${func.name} does not have a class declaration`,
    );
  }
  if (kind === "constructor-new") {
    registry.observeConstructorNew(declaration, func.name, funcIdx);
  } else {
    registry.observePromiseSubclassOnHostConstructor(declaration, func.name, funcIdx);
  }
}

/** Register one inherited class compatibility alias against its exact source owner. */
export function setProgramAbiInheritedClassCallableAlias(
  ctx: CodegenContext,
  childDeclaration: ts.ClassDeclaration | ts.ClassExpression,
  physicalName: string,
  funcIdx: FuncHandle,
): void {
  ctx.programAbiClassCallables?.observeInheritedAlias(childDeclaration, physicalName, funcIdx);
  ctx.funcMap.set(physicalName, funcIdx);
}

function hasStaticModifier(node: ts.Node): boolean {
  return (
    ts.canHaveModifiers(node) &&
    (ts.getModifiers(node)?.some((modifier) => modifier.kind === ts.SyntaxKind.StaticKeyword) ?? false)
  );
}

function expectedClassUnitKind(declaration: ts.Node): IrUnitKind | null {
  if (ts.isClassDeclaration(declaration) || ts.isClassExpression(declaration)) {
    return "class-implicit-constructor";
  }
  if (ts.isConstructorDeclaration(declaration)) return "class-constructor";
  if (ts.isMethodDeclaration(declaration)) {
    return hasStaticModifier(declaration) ? "class-static-method" : "class-instance-method";
  }
  if (ts.isGetAccessorDeclaration(declaration)) {
    return hasStaticModifier(declaration) ? "class-static-getter" : "class-instance-getter";
  }
  if (ts.isSetAccessorDeclaration(declaration)) {
    return hasStaticModifier(declaration) ? "class-static-setter" : "class-instance-setter";
  }
  return null;
}

function enclosingClassDeclaration(declaration: ts.Node): ts.ClassDeclaration | ts.ClassExpression | null {
  if (ts.isClassDeclaration(declaration) || ts.isClassExpression(declaration)) return declaration;
  const parent = declaration.parent;
  return parent && (ts.isClassDeclaration(parent) || ts.isClassExpression(parent)) ? parent : null;
}

function functionSignature(ctx: CodegenContext, func: WasmFunction): FuncTypeDef {
  const signature = ctx.mod.types[func.typeIdx];
  if (!signature || signature.kind !== "func") {
    throw new ProgramAbiInvariantError(
      "type-remap-mismatch",
      `class callable ${func.name} references non-function or missing type ${func.typeIdx}`,
    );
  }
  return signature;
}

/**
 * Exact class-callable sidecar spanning collection and final ABI planning.
 *
 * Class collection observes allocator-owned functions before body replacement
 * and DCE. Finalization selects the structurally last live allocation for each
 * source unit/support identity. An IR replacement has already received its
 * exact owner and leaves the observed legacy object dead; a retained direct
 * body receives that same semantic owner here. Only genuinely unclassified
 * functions reach the generic retained-callable population.
 */
export class ProgramAbiClassCallableRegistry {
  private readonly units = new Map<IrUnitId, ProgramAbiClassUnitCallableObservation[]>();
  private readonly supports = new Map<IrBindingId, ProgramAbiClassSupportCallableObservation[]>();
  private readonly inheritedAliases = new Map<
    IrClassId,
    Map<IrUnitId, ProgramAbiInheritedClassCallableObservation[]>
  >();
  private planned = false;

  constructor(
    readonly session: ProgramAbiSession,
    readonly ctx: CodegenContext,
    readonly identityContext: IrPlanningIdentityContext,
  ) {
    session.assertModule(ctx.mod);
    if (identityContext.inventory !== session.inventory) {
      throw new ProgramAbiInvariantError(
        "context-session-mismatch",
        "Program ABI class-callable registry and planning context do not share one inventory",
      );
    }
  }

  /** Canonical last live allocator observation for one exact class unit. */
  functionForUnit(unitId: IrUnitId): WasmFunction | undefined {
    const observation = this.units
      .get(unitId)
      ?.filter((candidate) => definedFuncAt(this.ctx, candidate.funcIdx) !== undefined)
      .at(-1);
    return observation ? definedFuncAt(this.ctx, observation.funcIdx) : undefined;
  }

  /** Observe one allocator function belonging to an exact class source unit. */
  observeUnit(declaration: ts.Node, displayName: string, funcIdx: FuncHandle): IrUnitId {
    this.assertOpen(displayName);
    const expectedKind = expectedClassUnitKind(declaration);
    const classDeclaration = enclosingClassDeclaration(declaration);
    if (!expectedKind || !classDeclaration) {
      throw new ProgramAbiInvariantError(
        "missing-source-unit",
        `class callable ${displayName} does not have a supported exact class declaration`,
      );
    }
    const unitId = this.identityContext.unitIdByDeclaration.get(declaration);
    const classId = this.identityContext.classIdByDeclaration.get(classDeclaration);
    const unit = unitId === undefined ? undefined : this.identityContext.unitByUnitId.get(unitId);
    if (
      unitId === undefined ||
      classId === undefined ||
      !unit ||
      unit.kind !== expectedKind ||
      unit.lexicalOwnerId !== classId ||
      this.identityContext.declarationByUnitId.get(unitId) !== declaration ||
      this.identityContext.declarationByClassId.get(classId) !== classDeclaration
    ) {
      throw new ProgramAbiInvariantError(
        "missing-source-unit",
        `class callable ${displayName} has no consistent exact ${expectedKind} inventory owner`,
      );
    }

    const func = this.requireDefinedFunction(displayName, funcIdx);
    const observations = this.units.get(unitId) ?? [];
    const previous = observations.at(-1);
    if (previous?.funcIdx !== funcIdx || previous.func !== func || previous.displayName !== displayName) {
      observations.push(Object.freeze({ unitId, displayName, funcIdx, func }));
      this.units.set(unitId, observations);
    }
    return unitId;
  }

  /** Observe the AST-free WasmGC `<Class>_new` support function before DCE. */
  observeConstructorNew(
    declaration: ts.ClassDeclaration | ts.ClassExpression,
    displayName: string,
    funcIdx: FuncHandle,
  ): IrBindingId {
    return this.observeSupport(
      declaration,
      "class-constructor-new",
      PROGRAM_ABI_CALLABLE_ROLE.classConstructorNew,
      displayName,
      funcIdx,
    );
  }

  /** Observe the JS-host Promise-subclass constructor support body before DCE. */
  observePromiseSubclassOnHostConstructor(
    declaration: ts.ClassDeclaration | ts.ClassExpression,
    displayName: string,
    funcIdx: FuncHandle,
  ): IrBindingId {
    return this.observeSupport(
      declaration,
      PROMISE_SUBCLASS_ONHOST_CALLABLE_ROLE,
      PROGRAM_ABI_CALLABLE_ROLE.classHostConstructor,
      displayName,
      funcIdx,
    );
  }

  /** Observe one child-class alias of an exact inherited source callable. */
  observeInheritedAlias(
    childDeclaration: ts.ClassDeclaration | ts.ClassExpression,
    displayName: string,
    funcIdx: FuncHandle,
  ): IrUnitId | undefined {
    this.assertOpen(displayName);
    const childClassId = this.identityContext.classIdByDeclaration.get(childDeclaration);
    if (
      childClassId === undefined ||
      this.identityContext.declarationByClassId.get(childClassId) !== childDeclaration
    ) {
      throw new ProgramAbiInvariantError(
        "unknown-inventory-class",
        `inherited class callable ${displayName} has no exact child class owner`,
      );
    }
    // (#3672) An IMPORT handle here is not a corrupt locator — it is a
    // host-import entry the caller's inherited-member scan matched by textual
    // prefix coincidence. `class Registry extends Map {}` combined with a
    // SEPARATE plain `new Map()` use registers host imports under exactly the
    // `Map_set` / `Map_has` keys that `${ancestor}_` prefix-scans in
    // `collectClassInfo` (src/codegen/class-bodies.ts) treat as inherited
    // parent members. A host import can never BE a canonical class unit (units
    // only ever observe defined functions), so this is the same "nothing exact
    // to observe" outcome the zero-canonical-owner branch below already
    // tolerates — return undefined rather than aborting the whole compile.
    //
    // The `!func` throw is kept for the case it was actually written for: a
    // NON-import handle with no defined record, i.e. a genuinely stale or
    // never-pushed locator (the #2043 late-import-shift corruption class).
    // Collapsing both causes into one throw is what aborted every real-world
    // program that subclasses a builtin collection — ESLint's
    // `LazyLoadingRuleMap extends Map` among them.
    if (isImportFuncIdx(this.ctx, funcIdx)) return undefined;
    const func = definedFuncAt(this.ctx, funcIdx);
    if (!func) {
      throw new ProgramAbiInvariantError(
        "missing-required-locator",
        `inherited class callable ${displayName} has no exact defined function for handle ${funcIdx}`,
      );
    }
    const canonicalUnitIds = [...this.units.entries()]
      .filter(([, observations]) => observations.some((observation) => observation.funcIdx === funcIdx))
      .map(([unitId]) => unitId);
    if (canonicalUnitIds.length === 0) return undefined;
    if (canonicalUnitIds.length > 1) {
      throw new ProgramAbiInvariantError(
        "missing-source-unit",
        `inherited class callable ${displayName} resolves to ${canonicalUnitIds.length} exact source owners`,
      );
    }
    const canonicalUnitId = canonicalUnitIds[0]!;
    const canonical = this.identityContext.unitByUnitId.get(canonicalUnitId);
    const canonicalClass =
      canonical?.lexicalOwnerId === null || canonical?.lexicalOwnerId === undefined
        ? undefined
        : this.identityContext.declarationByClassId.get(canonical.lexicalOwnerId as IrClassId);
    if (!canonical || !canonicalClass || !canonical.kind.startsWith("class-")) {
      throw new ProgramAbiInvariantError(
        "missing-source-unit",
        `inherited class callable ${displayName} has no exact canonical class unit`,
      );
    }
    const aliasesByUnit = this.inheritedAliases.get(childClassId) ?? new Map();
    const observations = aliasesByUnit.get(canonicalUnitId) ?? [];
    const previous = observations.at(-1);
    if (
      previous?.childClassId !== childClassId ||
      previous.canonicalUnitId !== canonicalUnitId ||
      previous.displayName !== displayName
    ) {
      observations.push(Object.freeze({ childClassId, canonicalUnitId, displayName }));
      aliasesByUnit.set(canonicalUnitId, observations);
      this.inheritedAliases.set(childClassId, aliasesByUnit);
    }
    return canonicalUnitId;
  }

  private observeSupport(
    declaration: ts.ClassDeclaration | ts.ClassExpression,
    role: string,
    roleOrdinal: number,
    displayName: string,
    funcIdx: FuncHandle,
  ): IrBindingId {
    this.assertOpen(displayName);
    const classId = this.identityContext.classIdByDeclaration.get(declaration);
    if (
      classId === undefined ||
      this.identityContext.declarationByClassId.get(classId) !== declaration ||
      !this.session.inventory.classes.some((record) => record.id === classId)
    ) {
      throw new ProgramAbiInvariantError(
        "unknown-inventory-class",
        `class support callable ${displayName} has no exact inventoried class owner`,
      );
    }
    const func = this.requireDefinedFunction(displayName, funcIdx);
    const ref = irSupportFuncRef(classId, role, displayName);
    const bindingId = ref.binding.kind === "support" ? ref.binding.bindingId : undefined;
    if (!bindingId) {
      throw new ProgramAbiInvariantError(
        "invalid-binding-reference",
        `class support callable ${displayName} did not produce a support binding`,
      );
    }
    const observations = this.supports.get(bindingId) ?? [];
    const previous = observations.at(-1);
    if (previous?.funcIdx !== funcIdx || previous.func !== func || previous.displayName !== displayName) {
      observations.push(Object.freeze({ bindingId, classId, role, roleOrdinal, displayName, funcIdx, func }));
      this.supports.set(bindingId, observations);
    }
    return bindingId;
  }

  /** Assign semantic owners to every observed class function retained by DCE. */
  planRetained(): void {
    if (this.planned) return;
    this.planned = true;
    for (const [unitId, observations] of this.units) {
      const canonical = observations.filter((observation) => definedFuncAt(this.ctx, observation.funcIdx)).at(-1);
      const func = canonical ? definedFuncAt(this.ctx, canonical.funcIdx) : undefined;
      if (!canonical || !func) continue;
      const expectedBindingId = irUnitCallableBindingId(unitId);
      if (this.session.hasPlan(expectedBindingId)) {
        if (!this.session.hasLocator(expectedBindingId, func)) {
          throw new ProgramAbiInvariantError(
            "duplicate-slot-locator",
            `retained class callable ${canonical.displayName} is not the exact allocator owned by ${expectedBindingId}`,
          );
        }
        continue;
      }
      const bindingId = planProgramAbiUnitCallable(this.ctx, {
        ref: irUnitFuncRef({ unitId, name: canonical.displayName }),
        signature: functionSignature(this.ctx, func),
        func,
      });
      if (bindingId !== expectedBindingId) {
        throw new ProgramAbiInvariantError(
          "missing-source-unit",
          `retained class callable ${canonical.displayName} was not accepted for exact unit ${unitId}`,
        );
      }
    }

    for (const bindingId of this.supports.keys()) this.planSupport(bindingId, false);
  }

  /** Plan one observed support callable before dependency-complete IR sealing. */
  prepareSupport(bindingId: IrBindingId): FuncHandle {
    this.assertOpen(bindingId);
    this.planSupport(bindingId, true);
    const handle = this.handleForSupport(bindingId);
    if (handle === undefined) {
      throw new ProgramAbiInvariantError(
        "invalid-binding-reference",
        `prepared class support callable ${bindingId} lost its observed allocator`,
      );
    }
    return handle;
  }

  /** Plan one exact non-terminal implicit-constructor `_init` support unit. */
  prepareImplicitConstructorUnit(
    unitId: IrUnitId,
    contract: {
      readonly selfParamIndex: number;
      readonly parent?: { readonly unitId: IrUnitId; readonly funcIdx: FuncHandle };
      /**
       * (#3522) Exact containing terminal owner of a NESTED implicit
       * constructor, or `null`/absent when the class is top-level. The caller
       * proves the containing owner is in the same preparation transaction;
       * this guard then verifies the inventory records exactly that nesting.
       */
      readonly containingTerminalOwnerId?: IrUnitId | null;
    },
  ): FuncHandle {
    this.assertOpen(unitId);
    const unit = this.identityContext.unitByUnitId.get(unitId);
    const canonical = this.units
      .get(unitId)
      ?.filter((observation) => definedFuncAt(this.ctx, observation.funcIdx))
      .at(-1);
    const func = canonical ? definedFuncAt(this.ctx, canonical.funcIdx) : undefined;
    if (
      unit?.kind !== "class-implicit-constructor" ||
      unit.terminalOwnerId !== (contract.containingTerminalOwnerId ?? null) ||
      !canonical ||
      !func
    ) {
      throw new ProgramAbiInvariantError(
        "missing-source-unit",
        `implicit constructor support ${unitId} has no exact live non-terminal allocator`,
      );
    }
    if (contract.parent && this.handleForUnit(contract.parent.unitId) !== contract.parent.funcIdx) {
      throw new ProgramAbiInvariantError(
        "invalid-binding-reference",
        `implicit constructor support ${canonical.displayName} lost its exact parent init allocator`,
      );
    }
    this.session.recordPreparedImplicitConstructorSupport(unitId, {
      selfParamIndex: contract.selfParamIndex,
      ...(contract.parent ? { parentInitFuncIdx: contract.parent.funcIdx } : {}),
      containingTerminalOwnerId: contract.containingTerminalOwnerId ?? null,
    });
    const expectedBindingId = irUnitCallableBindingId(unitId);
    if (this.session.hasPlan(expectedBindingId)) {
      if (!this.session.hasLocator(expectedBindingId, func)) {
        throw new ProgramAbiInvariantError(
          "duplicate-slot-locator",
          `implicit constructor support ${canonical.displayName} is not the exact allocator owned by ${expectedBindingId}`,
        );
      }
    } else {
      const bindingId = planProgramAbiUnitCallable(this.ctx, {
        ref: irUnitFuncRef({ unitId, name: canonical.displayName }),
        signature: functionSignature(this.ctx, func),
        func,
      });
      if (bindingId !== expectedBindingId) {
        throw new ProgramAbiInvariantError(
          "missing-source-unit",
          `implicit constructor support ${canonical.displayName} was not accepted for ${unitId}`,
        );
      }
    }
    return canonical.funcIdx;
  }

  /** Resolve one exact class source unit to its current stable allocator handle. */
  handleForUnit(unitId: IrUnitId): FuncHandle | undefined {
    const canonical = this.units
      .get(unitId)
      ?.filter((observation) => definedFuncAt(this.ctx, observation.funcIdx))
      .at(-1);
    return canonical?.funcIdx;
  }

  /** Resolve one exact class support binding to its current stable allocator handle. */
  handleForSupport(bindingId: IrBindingId): FuncHandle | undefined {
    const canonical = this.supports
      .get(bindingId)
      ?.filter((observation) => definedFuncAt(this.ctx, observation.funcIdx))
      .at(-1);
    return canonical?.funcIdx;
  }

  private planSupport(bindingId: IrBindingId, required: boolean): void {
    const canonical = this.supports
      .get(bindingId)
      ?.filter((observation) => definedFuncAt(this.ctx, observation.funcIdx))
      .at(-1);
    const func = canonical ? definedFuncAt(this.ctx, canonical.funcIdx) : undefined;
    if (!canonical || !func) {
      if (required) {
        throw new ProgramAbiInvariantError(
          "invalid-binding-reference",
          `prepared class support callable ${bindingId} has no live observed allocator`,
        );
      }
      return;
    }
    if (this.session.hasPlan(bindingId)) {
      if (!this.session.hasLocator(bindingId, func)) {
        throw new ProgramAbiInvariantError(
          "duplicate-slot-locator",
          `retained class support callable ${canonical.displayName} is not the exact allocator owned by ${bindingId}`,
        );
      }
      return;
    }
    const ref = irSupportFuncRef(canonical.classId, canonical.role, canonical.displayName);
    const plannedBindingId = planProgramAbiSupportCallable(this.ctx, {
      ref,
      anchor: { kind: "class", classId: canonical.classId },
      role: canonical.role,
      roleOrdinal: canonical.roleOrdinal,
      signature: functionSignature(this.ctx, func),
      func,
    });
    if (plannedBindingId !== bindingId) {
      throw new ProgramAbiInvariantError(
        "invalid-binding-reference",
        `retained class support callable ${canonical.displayName} was not accepted for ${bindingId}`,
      );
    }
  }

  /** Resolve one inherited alias to its exact canonical source unit and handle. */
  inheritedAlias(
    childClassId: IrClassId,
    canonicalUnitId: IrUnitId,
  ): { readonly canonicalUnitId: IrUnitId; readonly handle: FuncHandle } | undefined {
    const canonical = this.inheritedAliases.get(childClassId)?.get(canonicalUnitId)?.at(-1);
    if (!canonical) return undefined;
    const handle = this.handleForUnit(canonical.canonicalUnitId);
    return handle === undefined ? undefined : Object.freeze({ canonicalUnitId: canonical.canonicalUnitId, handle });
  }

  private assertOpen(displayName: string): void {
    if (this.planned) {
      throw new ProgramAbiInvariantError(
        "planning-sealed",
        `cannot observe class callable ${displayName} after retained class-callable planning`,
      );
    }
  }

  private requireDefinedFunction(displayName: string, funcIdx: FuncHandle): WasmFunction {
    const func = definedFuncAt(this.ctx, funcIdx);
    if (!func || func.name !== displayName) {
      throw new ProgramAbiInvariantError(
        "missing-required-locator",
        `class callable ${displayName} has no exact defined function for handle ${funcIdx}`,
      );
    }
    return func;
  }
}
