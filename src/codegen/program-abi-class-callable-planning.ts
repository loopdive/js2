// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.

import {
  irCallableBindingKey,
  irSupportFuncRef,
  irUnitCallableBindingId,
  irUnitFuncRef,
} from "../ir/callable-bindings.js";
import type { IrBindingId, IrClassId, IrUnitId, IrUnitKind } from "../ir/identity.js";
import type { IrPlanningIdentityContext } from "../ir/planning-identity.js";
import { ProgramAbiInvariantError, type ProgramAbiCallableSignature } from "../ir/program-abi.js";
import type { FuncHandle, FuncTypeDef, WasmFunction } from "../ir/types.js";
import { ts } from "../ts-api.js";
import { classMemberFuncKey } from "./class-member-keys.js";
import type { CodegenContext } from "./context/types.js";
import { definedFuncAt, isImportFuncIdx, pushDefinedFunc } from "./func-space.js";
import {
  planProgramAbiSupportCallableAlias,
  planProgramAbiSupportCallable,
  planProgramAbiUnitCallable,
  PROGRAM_ABI_CALLABLE_ROLE,
} from "./program-abi-planning.js";
import {
  canonicalProgramAbiCallableTypeContract,
  programAbiCallableSignaturesEqual,
} from "./program-abi-signatures.js";
import { resolveComputedKeyExpression } from "./shared.js";
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
  readonly memberKind: "method" | "getter" | "setter" | "static";
  readonly memberName: string;
  readonly role: string;
  readonly derivedOrdinal: number;
  readonly displayName: string;
  readonly funcIdx: FuncHandle;
  readonly signature: ProgramAbiCallableSignature;
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
  if (ts.isConstructorDeclaration(declaration)) {
    // (#5195 r3-4, r3 review F2) `static constructor(){}` parses as a
    // ConstructorDeclaration but is an ordinary static METHOD named
    // "constructor" (§15.7); the IR inventory classifies it that way, so the
    // ABI planner has to agree or every such class fails to plan.
    return hasStaticModifier(declaration) ? "class-static-method" : "class-constructor";
  }
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

type InheritedClassMemberKind = ProgramAbiInheritedClassCallableObservation["memberKind"];

function inheritedMemberKind(declaration: ts.Node, unitKind: IrUnitKind): InheritedClassMemberKind | null {
  const isStatic = hasStaticModifier(declaration);
  if (unitKind === "class-instance-method" && ts.isMethodDeclaration(declaration) && !isStatic) return "method";
  if (
    (unitKind === "class-instance-getter" || unitKind === "class-static-getter") &&
    ts.isGetAccessorDeclaration(declaration) &&
    isStatic === unitKind.startsWith("class-static-")
  ) {
    return "getter";
  }
  if (
    (unitKind === "class-instance-setter" || unitKind === "class-static-setter") &&
    ts.isSetAccessorDeclaration(declaration) &&
    isStatic === unitKind.startsWith("class-static-")
  ) {
    return "setter";
  }
  if (unitKind === "class-static-method" && ts.isMethodDeclaration(declaration) && isStatic) return "static";
  return null;
}

function inheritedMemberRole(kind: InheritedClassMemberKind, memberName: string): string {
  return kind === "method"
    ? `class-method-adapter:instance:${memberName}`
    : `class-member-adapter:${kind}:${memberName}`;
}

function structuralClassMemberName(ctx: CodegenContext, name: ts.PropertyName): string | undefined {
  if (ts.isIdentifier(name)) return name.text;
  if (ts.isPrivateIdentifier(name)) return `__priv_${name.text.slice(1)}`;
  if (ts.isStringLiteral(name)) return name.text;
  if (ts.isNumericLiteral(name)) return String(Number(name.text));
  return ts.isComputedPropertyName(name) ? resolveComputedKeyExpression(ctx, name.expression) : undefined;
}

function inheritedParentClassId(
  ctx: CodegenContext,
  declaration: ts.ClassDeclaration | ts.ClassExpression,
  identityContext: IrPlanningIdentityContext,
): IrClassId | null | undefined {
  const heritage = declaration.heritageClauses?.find((clause) => clause.token === ts.SyntaxKind.ExtendsKeyword);
  const expression = heritage?.types[0]?.expression;
  if (!expression) return null;
  const declarations = ctx.oracle
    .declarationsOf(expression)
    .filter(
      (candidate): candidate is ts.ClassDeclaration | ts.ClassExpression =>
        ts.isClassDeclaration(candidate) || ts.isClassExpression(candidate),
    );
  if (declarations.length !== 1) return undefined;
  const parent = declarations[0]!;
  const classId = identityContext.classIdByDeclaration.get(parent);
  return classId !== undefined && identityContext.declarationByClassId.get(classId) === parent ? classId : undefined;
}

function inheritedMemberSuffix(kind: InheritedClassMemberKind, memberName: string): string {
  return kind === "getter" ? `get_${memberName}` : kind === "setter" ? `set_${memberName}` : memberName;
}

function inheritedObservationsEqual(
  left: ProgramAbiInheritedClassCallableObservation,
  right: ProgramAbiInheritedClassCallableObservation,
): boolean {
  return (
    left.childClassId === right.childClassId &&
    left.canonicalUnitId === right.canonicalUnitId &&
    left.memberKind === right.memberKind &&
    left.memberName === right.memberName &&
    left.role === right.role &&
    left.derivedOrdinal === right.derivedOrdinal &&
    left.displayName === right.displayName &&
    left.funcIdx === right.funcIdx &&
    programAbiCallableSignaturesEqual(left.signature, right.signature)
  );
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
  private readonly inheritedAliases = new Map<IrClassId, Map<string, ProgramAbiInheritedClassCallableObservation>>();
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
    const contract = this.inheritedContract(childDeclaration, childClassId, canonicalUnitId, displayName);
    if (!contract) return undefined;
    const currentSignature = functionSignature(this.ctx, func);
    const signature = canonicalProgramAbiCallableTypeContract(currentSignature);
    const observation: ProgramAbiInheritedClassCallableObservation = Object.freeze({
      ...contract,
      childClassId,
      canonicalUnitId,
      displayName,
      funcIdx,
      signature,
    });
    const aliasesByRole = this.inheritedAliases.get(childClassId) ?? new Map();
    const existing = aliasesByRole.get(observation.role);
    if (existing && !inheritedObservationsEqual(existing, observation)) {
      throw new ProgramAbiInvariantError(
        "session-draft-mismatch",
        `inherited class callable ${childClassId} / ${observation.role} was observed with conflicting structural authority`,
      );
    }
    for (const other of aliasesByRole.values()) {
      if (other.role === observation.role) continue;
      if (other.displayName === displayName || other.canonicalUnitId === canonicalUnitId) {
        throw new ProgramAbiInvariantError(
          "session-draft-mismatch",
          `inherited class callable ${childClassId} / ${displayName} conflicts with structural role ${other.role}`,
        );
      }
    }
    if (!existing) {
      this.planInheritedAliasDraft(observation, currentSignature);
      aliasesByRole.set(observation.role, observation);
      this.inheritedAliases.set(childClassId, aliasesByRole);
    }
    return canonicalUnitId;
  }

  /**
   * Plan one slotless inherited alias while its prepared scope is still open.
   *
   * This has to happen at OBSERVATION time: class-body compilation is the only
   * point at which the alias's prepared component scope is still unsealed, and
   * a new draft raised later is rejected outright ("would mutate sealed prepared
   * scope"). The consequence is that the alias's stored `intent.signature` is a
   * pre-dead-type-elimination snapshot, while its canonical is planned in
   * `planRetained` after the remap — see the exact-signature check there, which
   * must therefore compare rebased contracts and not these snapshots.
   */
  private planInheritedAliasDraft(
    observation: ProgramAbiInheritedClassCallableObservation,
    signature: FuncTypeDef,
  ): IrBindingId {
    const ref = irSupportFuncRef(
      observation.childClassId,
      observation.role,
      observation.displayName,
      observation.derivedOrdinal,
    );
    const bindingId = planProgramAbiSupportCallableAlias(this.ctx, {
      ref,
      anchor: { kind: "class", classId: observation.childClassId },
      role: observation.role,
      roleOrdinal: PROGRAM_ABI_CALLABLE_ROLE.classMethodAdapter,
      derivedOrdinal: observation.derivedOrdinal,
      aliasOf: irUnitCallableBindingId(observation.canonicalUnitId),
      signature,
    });
    if (
      ref.binding.kind !== "support" ||
      bindingId !== ref.binding.bindingId ||
      this.session.hasLocator(ref.binding.bindingId)
    ) {
      throw new ProgramAbiInvariantError(
        "invalid-binding-reference",
        `inherited class callable ${observation.childClassId} / ${observation.canonicalUnitId} was not accepted as a slotless exact alias`,
      );
    }
    return bindingId;
  }

  private inheritedContract(
    childDeclaration: ts.ClassDeclaration | ts.ClassExpression,
    childClassId: IrClassId,
    canonicalUnitId: IrUnitId,
    displayName: string,
  ):
    | Pick<ProgramAbiInheritedClassCallableObservation, "memberKind" | "memberName" | "role" | "derivedOrdinal">
    | undefined {
    const canonical = this.identityContext.unitByUnitId.get(canonicalUnitId);
    const canonicalDeclaration = this.identityContext.declarationByUnitId.get(canonicalUnitId);
    const canonicalClassId = canonical?.lexicalOwnerId as IrClassId | null | undefined;
    const canonicalClassDeclaration =
      canonicalClassId === null || canonicalClassId === undefined
        ? undefined
        : this.identityContext.declarationByClassId.get(canonicalClassId);
    const canonicalClassRecords = this.session.inventory.classes.filter((record) => record.id === canonicalClassId);
    const childClassRecords = this.session.inventory.classes.filter((record) => record.id === childClassId);
    const memberKind =
      canonicalDeclaration && canonical ? inheritedMemberKind(canonicalDeclaration, canonical.kind) : null;
    const memberName =
      canonicalDeclaration &&
      (ts.isMethodDeclaration(canonicalDeclaration) ||
        ts.isGetAccessorDeclaration(canonicalDeclaration) ||
        ts.isSetAccessorDeclaration(canonicalDeclaration))
        ? structuralClassMemberName(this.ctx, canonicalDeclaration.name)
        : undefined;
    const childName = childDeclaration.name?.text;
    if (
      !canonical ||
      !canonicalDeclaration ||
      !canonicalClassDeclaration ||
      canonicalClassRecords.length !== 1 ||
      childClassRecords.length !== 1 ||
      !memberKind ||
      memberName === undefined ||
      this.identityContext.declarationByUnitId.get(canonical.id) !== canonicalDeclaration ||
      this.identityContext.unitIdByDeclaration.get(canonicalDeclaration) !== canonical.id ||
      this.identityContext.declarationByClassId.get(canonicalClassId!) !== canonicalClassDeclaration ||
      this.identityContext.classIdByDeclaration.get(canonicalClassDeclaration) !== canonicalClassId ||
      canonicalDeclaration.parent !== canonicalClassDeclaration ||
      this.identityContext.declarationByClassId.get(childClassId) !== childDeclaration ||
      this.identityContext.classIdByDeclaration.get(childDeclaration) !== childClassId
    ) {
      throw new ProgramAbiInvariantError(
        "missing-source-unit",
        `inherited class callable ${displayName} has no complete exact canonical class-member authority`,
      );
    }
    if (childName === undefined) return undefined;
    const expectedStatic = canonical.kind.startsWith("class-static-");
    const suffix = inheritedMemberSuffix(memberKind, memberName);
    if (
      canonical.terminal &&
      (canonical.observedKind !== "class-member" || canonical.staticClassMember !== expectedStatic)
    ) {
      throw new ProgramAbiInvariantError(
        "missing-source-unit",
        `inherited class callable ${displayName} disagrees with exact ${memberKind} source unit ${canonicalUnitId}`,
      );
    }
    const parentClassId = inheritedParentClassId(this.ctx, childDeclaration, this.identityContext);
    if (parentClassId === undefined) return undefined;
    if (parentClassId === null) {
      throw new ProgramAbiInvariantError(
        "unknown-inventory-class",
        `inherited class callable ${displayName} has no exact parent class`,
      );
    }
    if (this.memberUnitIds(childDeclaration, canonical.kind, memberName).length !== 0) {
      throw new ProgramAbiInvariantError(
        "missing-source-unit",
        `inherited class callable ${displayName} aliases a member owned directly by child ${childClassId}`,
      );
    }
    const nearestUnitId = this.nearestInheritedMemberUnitId(childDeclaration, canonical.kind, memberKind, memberName);
    if (nearestUnitId !== canonicalUnitId) {
      throw new ProgramAbiInvariantError(
        "missing-source-unit",
        `inherited class callable ${displayName} targets ${canonicalUnitId}, not nearest exact override ${nearestUnitId ?? "<none>"}`,
      );
    }
    const inventoryMatches = this.session.inventory.allUnits
      .map((unit, index) => ({ unit, index }))
      .filter(({ unit }) => unit.id === canonicalUnitId);
    if (inventoryMatches.length !== 1) {
      throw new ProgramAbiInvariantError(
        "unknown-order-anchor",
        `inherited class callable ${displayName} canonical unit ${canonicalUnitId} occurs ${inventoryMatches.length} times`,
      );
    }
    const expectedDisplayName = classMemberFuncKey(this.ctx, `${childName}_${suffix}`);
    if (displayName !== expectedDisplayName) {
      throw new ProgramAbiInvariantError(
        "binding-reference-mismatch",
        `inherited class callable ${displayName} is not exact child physical key ${expectedDisplayName}`,
      );
    }
    return Object.freeze({
      memberKind,
      memberName,
      role: inheritedMemberRole(memberKind, memberName),
      derivedOrdinal: inventoryMatches[0]!.index,
    });
  }

  private nearestInheritedMemberUnitId(
    childDeclaration: ts.ClassDeclaration | ts.ClassExpression,
    unitKind: IrUnitKind,
    memberKind: InheritedClassMemberKind,
    memberName: string,
  ): IrUnitId | undefined {
    const seen = new Set<IrClassId>();
    let ancestor = this.directParentClassDeclaration(childDeclaration);
    while (ancestor) {
      const classId = this.identityContext.classIdByDeclaration.get(ancestor);
      if (
        classId === undefined ||
        this.identityContext.declarationByClassId.get(classId) !== ancestor ||
        seen.has(classId)
      ) {
        throw new ProgramAbiInvariantError(
          "unknown-inventory-class",
          `inherited ${memberKind} ${memberName} has an invalid or cyclic exact ancestor`,
        );
      }
      seen.add(classId);
      const candidates = this.memberUnitIds(ancestor, unitKind, memberName);
      if (candidates.length > 1) {
        throw new ProgramAbiInvariantError(
          "missing-source-unit",
          `ancestor ${classId} owns ${candidates.length} exact ${memberKind} units named ${memberName}`,
        );
      }
      if (candidates.length === 1) return candidates[0];
      ancestor = this.directParentClassDeclaration(ancestor);
    }
    return undefined;
  }

  private memberUnitIds(
    declaration: ts.ClassDeclaration | ts.ClassExpression,
    expectedKind: IrUnitKind,
    memberName: string,
  ): IrUnitId[] {
    return declaration.members.flatMap((member) => {
      if (!member.name || structuralClassMemberName(this.ctx, member.name) !== memberName) return [];
      if (inheritedMemberKind(member, expectedKind) === null) return [];
      const unitId = this.identityContext.unitIdByDeclaration.get(member);
      const unit = unitId === undefined ? undefined : this.identityContext.unitByUnitId.get(unitId);
      const classId = this.identityContext.classIdByDeclaration.get(declaration);
      return unitId !== undefined && unit?.kind === expectedKind && unit.lexicalOwnerId === classId ? [unitId] : [];
    });
  }

  private directParentClassDeclaration(
    declaration: ts.ClassDeclaration | ts.ClassExpression,
  ): ts.ClassDeclaration | ts.ClassExpression | undefined {
    const classId = inheritedParentClassId(this.ctx, declaration, this.identityContext);
    if (classId === null || classId === undefined) return undefined;
    const parent = this.identityContext.declarationByClassId.get(classId);
    if (
      !parent ||
      (!ts.isClassDeclaration(parent) && !ts.isClassExpression(parent)) ||
      this.identityContext.classIdByDeclaration.get(parent) !== classId
    ) {
      throw new ProgramAbiInvariantError(
        "unknown-inventory-class",
        `inherited class callable parent ${classId} has no exact declaration`,
      );
    }
    return parent;
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

    for (const [childClassId, aliasesByRole] of this.inheritedAliases) {
      const childDeclaration = this.identityContext.declarationByClassId.get(childClassId);
      if (
        !childDeclaration ||
        (!ts.isClassDeclaration(childDeclaration) && !ts.isClassExpression(childDeclaration)) ||
        this.identityContext.classIdByDeclaration.get(childDeclaration) !== childClassId
      ) {
        throw new ProgramAbiInvariantError(
          "unknown-inventory-class",
          `inherited callable observations have no exact child class ${childClassId}`,
        );
      }
      const canonicalUnitIds = new Set<IrUnitId>();
      const physicalNames = new Set<string>();
      for (const [role, observation] of aliasesByRole) {
        if (
          observation.childClassId !== childClassId ||
          observation.role !== role ||
          physicalNames.has(observation.displayName) ||
          canonicalUnitIds.has(observation.canonicalUnitId)
        ) {
          throw new ProgramAbiInvariantError(
            "session-draft-mismatch",
            `inherited class callable ${childClassId} / ${role} has conflicting map authority`,
          );
        }
        physicalNames.add(observation.displayName);
        canonicalUnitIds.add(observation.canonicalUnitId);
        const liveFunc = definedFuncAt(this.ctx, observation.funcIdx);
        if (!liveFunc) {
          throw new ProgramAbiInvariantError(
            "missing-required-locator",
            `inherited class callable ${childClassId} / ${observation.canonicalUnitId} lost its exact allocator`,
          );
        }
        const contract = this.inheritedContract(
          childDeclaration,
          childClassId,
          observation.canonicalUnitId,
          observation.displayName,
        );
        if (
          !contract ||
          contract.memberKind !== observation.memberKind ||
          contract.memberName !== observation.memberName ||
          contract.role !== observation.role ||
          contract.derivedOrdinal !== observation.derivedOrdinal
        ) {
          throw new ProgramAbiInvariantError(
            "session-draft-mismatch",
            `inherited class callable ${childClassId} / ${role} drifted after observation`,
          );
        }
        const aliasOf = irUnitCallableBindingId(observation.canonicalUnitId);
        const canonicalDraft = this.session.getDraft(aliasOf);
        const canonicalRef = irUnitFuncRef({ unitId: observation.canonicalUnitId, name: liveFunc.name });
        if (
          !canonicalDraft ||
          canonicalDraft.slotPolicy !== "required" ||
          canonicalDraft.slotSpace !== "function" ||
          canonicalDraft.intent.kind !== "callable" ||
          canonicalDraft.intent.origin !== "source" ||
          canonicalDraft.intent.unitId !== observation.canonicalUnitId ||
          canonicalDraft.structuralReferenceKey !== irCallableBindingKey(canonicalRef.binding) ||
          this.session.locatorObjectForBinding(aliasOf) !== liveFunc
        ) {
          throw new ProgramAbiInvariantError(
            "missing-required-locator",
            `inherited class callable ${childClassId} / ${observation.canonicalUnitId} has no exact canonical Program ABI locator`,
          );
        }
        const aliasRef = irSupportFuncRef(
          observation.childClassId,
          observation.role,
          observation.displayName,
          observation.derivedOrdinal,
        );
        const aliasBindingId =
          aliasRef.binding.kind === "support" ? aliasRef.binding.bindingId : (undefined as IrBindingId | undefined);
        const aliasDraft = aliasBindingId === undefined ? undefined : this.session.getDraft(aliasBindingId);
        if (
          !aliasDraft ||
          aliasDraft.slotPolicy !== "alias" ||
          aliasDraft.aliasOf !== aliasOf ||
          aliasDraft.structuralReferenceKey !== irCallableBindingKey(aliasRef.binding) ||
          aliasDraft.intent.kind !== "callable" ||
          aliasDraft.intent.origin !== "support" ||
          aliasDraft.intent.classId !== observation.childClassId ||
          this.session.hasLocator(aliasDraft.id)
        ) {
          throw new ProgramAbiInvariantError(
            "invalid-binding-reference",
            `inherited class callable ${childClassId} / ${observation.canonicalUnitId} lost its exact slotless alias plan`,
          );
        }
        // Compare CURRENT contracts, not the drafts' frozen `intent.signature`.
        // The alias is raised during class-body compilation (the only point its
        // prepared scope is still open) and the canonical is raised in this pass,
        // after `eliminateDeadImports` has applied the type layout remap. The
        // session rebases `callableTypeContracts` across that remap but never
        // rewrites a draft's stored signature, so the two snapshots describe one
        // function with two type-index numberings (`ref 14` vs `ref 1` for a
        // `super.value` getter receiver) and comparing them rejects a correct
        // module. Both contracts must exist: a missing one is an unrebased or
        // unregistered alias, which this invariant must not silently accept.
        const canonicalSignature = this.session.currentCallableSignature(aliasOf);
        const aliasSignature = this.session.currentCallableSignature(aliasDraft.id);
        const liveSignature = canonicalProgramAbiCallableTypeContract(functionSignature(this.ctx, liveFunc));
        if (
          !canonicalSignature ||
          !aliasSignature ||
          !programAbiCallableSignaturesEqual(canonicalSignature, aliasSignature) ||
          !programAbiCallableSignaturesEqual(canonicalSignature, liveSignature)
        ) {
          throw new ProgramAbiInvariantError(
            "alias-signature-mismatch",
            `inherited class callable ${childClassId} / ${observation.canonicalUnitId} disagrees with its exact canonical signature`,
          );
        }
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
    const aliasesByRole = this.inheritedAliases.get(childClassId);
    if (!aliasesByRole) return undefined;
    const matches = [...aliasesByRole.entries()].filter(
      ([, observation]) => observation.canonicalUnitId === canonicalUnitId,
    );
    if (matches.length === 0) return undefined;
    if (matches.length !== 1) {
      throw new ProgramAbiInvariantError(
        "session-draft-mismatch",
        `inherited class callable ${childClassId} / ${canonicalUnitId} has ${matches.length} structural roles`,
      );
    }
    const [role, observation] = matches[0]!;
    if (
      observation.childClassId !== childClassId ||
      observation.canonicalUnitId !== canonicalUnitId ||
      observation.role !== role ||
      definedFuncAt(this.ctx, observation.funcIdx) === undefined
    ) {
      throw new ProgramAbiInvariantError(
        "missing-required-locator",
        `inherited class callable ${childClassId} / ${canonicalUnitId} lost its exact allocator`,
      );
    }
    return Object.freeze({ canonicalUnitId, handle: observation.funcIdx });
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
