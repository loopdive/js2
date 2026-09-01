// (#2023) `new.target` support.
//
// `new.target` is the constructor that `new` was invoked on. Inside a derived
// chain it stays the *outermost* (derived-most) class, because `super()` does
// not start a fresh construction — it continues the same one. The compiler
// emits a class body **once** and reuses it both for `new C()` and for the
// `super()` path of a subclass, so the value genuinely varies at runtime and
// cannot be folded to a per-constructor constant (the #189 `i32.const 1` stub
// did exactly that, which is the bug this fixes).
//
// Strategy — a single mutable i32 module global holds the class-id of the class
// named at the outermost `new` site:
//   * each local class gets a stable 1-based i32 id (`classNewTargetIds`);
//   * `new C(...)` sites save the previous global, set it to C's id right
//     before the `_new` call (args already on the stack), and restore it after
//     the call returns (so nested `new` inside a ctor body nests correctly);
//   * `super(...)` calls `_init` directly and deliberately does NOT touch the
//     global, so the derived-most id is preserved through the super chain;
//   * `new.target` inside a ctor reads the global; `new.target === SomeClass`
//     lowers to an i32 compare against that class's id.
//
// All of this is gated on `ctx.usesNewTarget` (a cheap AST pre-scan), so a
// program that never mentions `new.target` emits none of the machinery and the
// class call sites are byte-for-byte unchanged.

import { ts, forEachChild } from "../ts-api.js";
import type { CodegenContext } from "./context/types.js";
import type { FunctionContext } from "./context/types.js";
import type { Instr } from "../ir/types.js";
import { allocLocal } from "./context/locals.js";
import { nextModuleGlobalIdx } from "./registry/imports.js";
import { resolvesToAmbientGlobal } from "./expressions/non-constructable.js";
import { ensureObjectRuntime } from "./object-runtime.js";
import { undefinedExternInstrs } from "./any-helpers.js";

/**
 * Pre-scan the source for any `new.target` meta-property. Sets
 * `ctx.usesNewTarget`. Cheap structural walk; runs once before body compilation.
 */
export function scanForNewTarget(ctx: CodegenContext, root: ts.Node): void {
  const visit = (node: ts.Node): void => {
    if (ctx.usesNewTarget) return;
    if (ts.isMetaProperty(node) && node.keywordToken === ts.SyntaxKind.NewKeyword && node.name.text === "target") {
      ctx.usesNewTarget = true;
      return;
    }
    forEachChild(node, visit);
  };
  visit(root);
}

/**
 * Assign (or look up) the stable 1-based class-id for a local class. Ids start
 * at 1 so the global's `0` initial value never matches a real class — which
 * keeps `new.target === SomeClass` false when read outside any construction.
 */
export function getOrAssignClassNewTargetId(ctx: CodegenContext, className: string): number {
  let id = ctx.classNewTargetIds.get(className);
  if (id === undefined) {
    id = ctx.classNewTargetIds.size + 1;
    ctx.classNewTargetIds.set(className, id);
  }
  return id;
}

/**
 * Allocate the mutable i32 `new.target` class-id global if not already present.
 * Returns its absolute Wasm global index. Only call when `ctx.usesNewTarget`.
 */
export function ensureNewTargetGlobal(ctx: CodegenContext): number {
  if (ctx.newTargetGlobalIdx !== undefined) return ctx.newTargetGlobalIdx;
  const absIdx = ctx.numImportGlobals + ctx.mod.globals.length;
  ctx.mod.globals.push({
    name: "__new_target_classid",
    type: { kind: "i32" },
    mutable: true,
    init: [{ op: "i32.const", value: 0 }],
  });
  ctx.newTargetGlobalIdx = absIdx;
  return absIdx;
}

/**
 * Emit the load of the current `new.target` class-id (an i32). Only meaningful
 * inside a constructor.
 */
export function emitNewTargetClassId(ctx: CodegenContext, body: Instr[]): void {
  const idx = ensureNewTargetGlobal(ctx);
  body.push({ op: "global.get", index: idx });
}

/**
 * Emit `i32.const <classId>; global.set __new_target_classid`. Call this right
 * before pushing the constructor `call` instruction (args already on the
 * stack). No-op when `new.target` is unused.
 */
export function emitSetNewTargetBeforeCall(ctx: CodegenContext, body: Instr[], className: string): void {
  if (!ctx.usesNewTarget) return;
  const globalIdx = ensureNewTargetGlobal(ctx);
  const classId = getOrAssignClassNewTargetId(ctx, className);
  body.push({ op: "i32.const", value: classId });
  body.push({ op: "global.set", index: globalIdx });
}

// ── #3371: standalone Reflect.construct ordinary/class admission ──────────

export interface StandaloneReflectConstructOrdinarySite {
  readonly targetKind: "function" | "class" | "object";
  /** Source name of the direct ordinary-function or class allocation target. */
  readonly targetName: string;
  /** Non-zero only for an ordinary function target whose body may read new.target. */
  readonly ownerId: number;
  readonly newTargetKind: "same" | "function" | "class" | "array";
  /** Present for a class NewTarget so codegen can use the class-prototype source of truth. */
  readonly newTargetClassName?: string;
}

interface ReflectConstructOrdinaryScanState {
  readonly sites: WeakMap<ts.CallExpression, StandaloneReflectConstructOrdinarySite>;
  readonly functionTargetIds: WeakMap<ts.Node, number>;
  readonly fnctorPassThrough: WeakSet<ts.Node>;
  readonly classTargetIds: Map<string, number>;
  nextOwnerId: number;
}

const reflectConstructOrdinaryStates = new WeakMap<CodegenContext, ReflectConstructOrdinaryScanState>();

function reflectConstructOrdinaryState(ctx: CodegenContext): ReflectConstructOrdinaryScanState {
  let state = reflectConstructOrdinaryStates.get(ctx);
  if (!state) {
    state = {
      sites: new WeakMap(),
      functionTargetIds: new WeakMap(),
      fnctorPassThrough: new WeakSet(),
      classTargetIds: new Map(),
      nextOwnerId: 1,
    };
    reflectConstructOrdinaryStates.set(ctx, state);
  }
  return state;
}

function unwrapReflectConstructOperand(expression: ts.Expression): ts.Expression {
  let current = expression;
  while (
    ts.isParenthesizedExpression(current) ||
    ts.isAsExpression(current) ||
    ts.isNonNullExpression(current) ||
    ts.isTypeAssertionExpression(current) ||
    ts.isSatisfiesExpression(current)
  ) {
    current = current.expression;
  }
  return current;
}

function isAssignmentOperator(kind: ts.SyntaxKind): boolean {
  return kind >= ts.SyntaxKind.FirstAssignment && kind <= ts.SyntaxKind.LastAssignment;
}

function eachBindingIdentifier(node: ts.Node, visit: (identifier: ts.Identifier) => void): void {
  if (ts.isIdentifier(node)) {
    visit(node);
    return;
  }
  if (ts.isParenthesizedExpression(node) || ts.isAsExpression(node) || ts.isNonNullExpression(node)) {
    eachBindingIdentifier(node.expression, visit);
    return;
  }
  if (ts.isArrayBindingPattern(node) || ts.isObjectBindingPattern(node)) {
    for (const element of node.elements) {
      if (ts.isOmittedExpression(element)) continue;
      eachBindingIdentifier(element.name, visit);
    }
    return;
  }
  if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.EqualsToken) {
    eachBindingIdentifier(node.left, visit);
  }
}

function hasNewTarget(node: ts.Node): boolean {
  let found = false;
  const visit = (child: ts.Node): void => {
    if (found) return;
    if (ts.isMetaProperty(child) && child.keywordToken === ts.SyntaxKind.NewKeyword && child.name.text === "target") {
      found = true;
      return;
    }
    forEachChild(child, visit);
  };
  visit(node);
  return found;
}

function isWithinWith(node: ts.Node): boolean {
  for (let current: ts.Node | undefined = node; current; current = current.parent) {
    if (ts.isWithStatement(current)) return true;
  }
  return false;
}

function bindingIsStableInSource(ctx: CodegenContext, identifier: ts.Identifier, declaration: ts.Declaration): boolean {
  if (identifier.getSourceFile() !== declaration.getSourceFile()) return false;
  const sourceFile = identifier.getSourceFile();
  let stable = true;
  const isBinding = (candidate: ts.Identifier): boolean => ctx.oracle.valueDeclarationOf(candidate) === declaration;
  const hasPrototypeWrite = (left: ts.Expression): boolean =>
    ts.isPropertyAccessExpression(left) &&
    left.name.text === "prototype" &&
    ts.isIdentifier(unwrapReflectConstructOperand(left.expression)) &&
    isBinding(unwrapReflectConstructOperand(left.expression) as ts.Identifier);
  const visit = (node: ts.Node): void => {
    if (!stable) return;
    if (ts.isBinaryExpression(node) && isAssignmentOperator(node.operatorToken.kind)) {
      eachBindingIdentifier(node.left, (candidate) => {
        if (isBinding(candidate)) stable = false;
      });
      if (hasPrototypeWrite(node.left)) stable = false;
    }
    if (
      (ts.isPrefixUnaryExpression(node) || ts.isPostfixUnaryExpression(node)) &&
      (node.operator === ts.SyntaxKind.PlusPlusToken || node.operator === ts.SyntaxKind.MinusMinusToken)
    ) {
      eachBindingIdentifier(node.operand, (candidate) => {
        if (isBinding(candidate)) stable = false;
      });
    }
    if (ts.isVariableDeclaration(node) && node !== declaration && node.initializer) {
      eachBindingIdentifier(node.name, (candidate) => {
        if (isBinding(candidate)) stable = false;
      });
    }
    if (
      ts.isCallExpression(node) &&
      ts.isPropertyAccessExpression(node.expression) &&
      ts.isIdentifier(node.expression.expression) &&
      node.expression.expression.text === "Object" &&
      (node.expression.name.text === "defineProperty" || node.expression.name.text === "defineProperties") &&
      node.arguments[0] &&
      ts.isIdentifier(unwrapReflectConstructOperand(node.arguments[0]!)) &&
      isBinding(unwrapReflectConstructOperand(node.arguments[0]!) as ts.Identifier)
    ) {
      stable = false;
    }
    forEachChild(node, visit);
  };
  visit(sourceFile);
  return stable;
}

interface OrdinaryCarrier {
  readonly kind: "function" | "class" | "object" | "array";
  readonly name: string;
  readonly declaration?: ts.Declaration;
  readonly classDeclaration?: ts.ClassDeclaration;
}

function ordinaryCarrier(ctx: CodegenContext, expression: ts.Expression): OrdinaryCarrier | undefined {
  const unwrapped = unwrapReflectConstructOperand(expression);
  if (!ts.isIdentifier(unwrapped)) return undefined;
  if (unwrapped.text === "Object" && resolvesToAmbientGlobal(ctx, unwrapped)) {
    return { kind: "object", name: "Object" };
  }
  if (unwrapped.text === "Array" && resolvesToAmbientGlobal(ctx, unwrapped)) {
    return { kind: "array", name: "Array" };
  }
  const declaration = ctx.oracle.valueDeclarationOf(unwrapped);
  if (!declaration || !bindingIsStableInSource(ctx, unwrapped, declaration)) return undefined;
  if (ts.isFunctionDeclaration(declaration)) return { kind: "function", name: unwrapped.text, declaration };
  if (ts.isClassDeclaration(declaration) && declaration.name) {
    return { kind: "class", name: declaration.name.text, declaration, classDeclaration: declaration };
  }
  if (ts.isVariableDeclaration(declaration)) {
    const initializer = declaration.initializer && unwrapReflectConstructOperand(declaration.initializer);
    if (initializer && ts.isFunctionExpression(initializer)) {
      return { kind: "function", name: unwrapped.text, declaration };
    }
  }
  return undefined;
}

function hasExplicitConstructor(declaration: ts.ClassDeclaration): boolean {
  return declaration.members.some((member) => ts.isConstructorDeclaration(member));
}

function isSimpleObjectSubclass(ctx: CodegenContext, carrier: OrdinaryCarrier): boolean {
  if (carrier.kind !== "class" || !carrier.classDeclaration || hasExplicitConstructor(carrier.classDeclaration))
    return false;
  const parent = carrier.classDeclaration.heritageClauses?.find(
    (clause) => clause.token === ts.SyntaxKind.ExtendsKeyword,
  )?.types[0]?.expression;
  return !!parent && ts.isIdentifier(parent) && parent.text === "Object" && resolvesToAmbientGlobal(ctx, parent);
}

/**
 * Record only source-proven ordinary/class Reflect.construct sites before
 * declaration collection. This is a carrier admission scan, not a substitute
 * for GetPrototypeFromConstructor: accepted call sites still read the selected
 * NewTarget prototype at runtime.
 */
export function scanForStandaloneReflectConstructNewTarget(ctx: CodegenContext, root: ts.Node): void {
  if (!ctx.standalone || ctx.dynamicCodeDirty) return;
  const state = reflectConstructOrdinaryState(ctx);
  const declaredClasses = new Set<string>();
  const classParents = new Map<string, string>();
  const classByName = new Map<string, ts.ClassDeclaration>();
  const collectClasses = (node: ts.Node): void => {
    if (ts.isClassDeclaration(node) && node.name) {
      declaredClasses.add(node.name.text);
      classByName.set(node.name.text, node);
      const parent = node.heritageClauses?.find((clause) => clause.token === ts.SyntaxKind.ExtendsKeyword)?.types[0]
        ?.expression;
      if (parent && ts.isIdentifier(parent)) classParents.set(node.name.text, parent.text);
    }
    forEachChild(node, collectClasses);
  };
  collectClasses(root);

  const ownerIdForFunction = (declaration: ts.Declaration): number => {
    const existing = state.functionTargetIds.get(declaration);
    if (existing !== undefined) return existing;
    const id = state.nextOwnerId++;
    state.functionTargetIds.set(declaration, id);
    return id;
  };
  const ownerIdForClass = (name: string): number => {
    const existing = state.classTargetIds.get(name);
    if (existing !== undefined) return existing;
    const id = state.nextOwnerId++;
    state.classTargetIds.set(name, id);
    return id;
  };
  const markClassAllocation = (name: string): number | undefined => {
    if (!classByName.has(name)) return undefined;
    let rootName = name;
    const seen = new Set([name]);
    for (;;) {
      const parent = classParents.get(rootName);
      if (!parent || !declaredClasses.has(parent) || seen.has(parent)) break;
      seen.add(parent);
      rootName = parent;
    }
    ctx.usesDynamicProto = true;
    ctx.dynamicProtoClasses.add(rootName);
    ensureReflectConstructNewTargetGlobals(ctx);
    return ownerIdForClass(name);
  };
  const markFunctionSuperConsumer = (classDeclaration: ts.ClassDeclaration): void => {
    const parent = classDeclaration.heritageClauses?.find((clause) => clause.token === ts.SyntaxKind.ExtendsKeyword)
      ?.types[0]?.expression;
    if (!parent) return;
    const carrier = ordinaryCarrier(ctx, parent);
    if (carrier?.kind === "function" && carrier.declaration && hasNewTarget(carrier.declaration)) {
      state.fnctorPassThrough.add(carrier.declaration);
    }
  };

  const visit = (node: ts.Node): void => {
    if (
      ts.isCallExpression(node) &&
      ts.isPropertyAccessExpression(node.expression) &&
      ts.isIdentifier(node.expression.expression) &&
      node.expression.expression.text === "Reflect" &&
      resolvesToAmbientGlobal(ctx, node.expression.expression) &&
      node.expression.name.text === "construct" &&
      node.arguments.length >= 2 &&
      node.arguments.length <= 3 &&
      !isWithinWith(node)
    ) {
      const target = ordinaryCarrier(ctx, node.arguments[0]!);
      const list = unwrapReflectConstructOperand(node.arguments[1]!);
      const explicitNewTarget = node.arguments[2];
      const newTarget = explicitNewTarget ? ordinaryCarrier(ctx, explicitNewTarget) : target;
      const validList =
        ts.isArrayLiteralExpression(list) &&
        !list.elements.some((element) => ts.isOmittedExpression(element) || ts.isSpreadElement(element));
      if (target && newTarget && validList) {
        if (target.kind === "function" && target.declaration && list.elements.length <= 8) {
          const ownerId = ownerIdForFunction(target.declaration);
          const newTargetKind =
            explicitNewTarget === undefined
              ? "same"
              : newTarget.kind === "function"
                ? "function"
                : newTarget.kind === "class"
                  ? "class"
                  : newTarget.kind === "array"
                    ? "array"
                    : undefined;
          if (newTargetKind) {
            ensureReflectConstructNewTargetGlobals(ctx);
            state.sites.set(node, {
              targetKind: "function",
              targetName: target.name,
              ownerId,
              newTargetKind,
              ...(newTarget.kind === "class" ? { newTargetClassName: newTarget.name } : {}),
            });
          }
        } else if (
          target.kind === "class" &&
          target.classDeclaration &&
          explicitNewTarget &&
          !hasNewTarget(target.classDeclaration)
        ) {
          const ownerId = markClassAllocation(target.name);
          if (ownerId !== undefined) {
            markFunctionSuperConsumer(target.classDeclaration);
            const newTargetKind =
              newTarget.kind === "function"
                ? "function"
                : newTarget.kind === "class"
                  ? "class"
                  : newTarget.kind === "array"
                    ? "array"
                    : undefined;
            if (newTargetKind) {
              state.sites.set(node, {
                targetKind: "class",
                targetName: target.name,
                ownerId,
                newTargetKind,
                ...(newTarget.kind === "class" ? { newTargetClassName: newTarget.name } : {}),
              });
            }
          }
        } else if (target.kind === "object" && explicitNewTarget && isSimpleObjectSubclass(ctx, newTarget)) {
          const ownerId = markClassAllocation(newTarget.name);
          if (ownerId !== undefined) {
            state.sites.set(node, {
              targetKind: "object",
              targetName: newTarget.name,
              ownerId,
              newTargetKind: "class",
              newTargetClassName: newTarget.name,
            });
          }
        }
      }
    }
    forEachChild(node, visit);
  };
  visit(root);
}

export function standaloneReflectConstructOrdinarySite(
  ctx: CodegenContext,
  call: ts.CallExpression,
): StandaloneReflectConstructOrdinarySite | undefined {
  return reflectConstructOrdinaryStates.get(ctx)?.sites.get(call);
}

export function reflectConstructFunctionTargetId(ctx: CodegenContext, declaration: ts.Node): number | undefined {
  return reflectConstructOrdinaryStates.get(ctx)?.functionTargetIds.get(declaration);
}

export function reflectConstructFnctorPassesNewTarget(ctx: CodegenContext, declaration: ts.Node): boolean {
  return reflectConstructOrdinaryStates.get(ctx)?.fnctorPassThrough.has(declaration) === true;
}

export function reflectConstructClassTargetId(ctx: CodegenContext, className: string): number | undefined {
  return reflectConstructOrdinaryStates.get(ctx)?.classTargetIds.get(className);
}

export interface ReflectConstructNewTargetGlobals {
  readonly owner: number;
  readonly value: number;
  readonly prototypeOwner: number;
  readonly prototypeValue: number;
}

export function ensureReflectConstructNewTargetGlobals(ctx: CodegenContext): ReflectConstructNewTargetGlobals {
  const existingOwner = ctx.reflectConstructNewTargetOwnerGlobalIdx;
  const existingValue = ctx.reflectConstructNewTargetValueGlobalIdx;
  const existingPrototypeOwner = ctx.reflectConstructNewTargetProtoOwnerGlobalIdx;
  const existingPrototypeValue = ctx.reflectConstructNewTargetProtoGlobalIdx;
  if (
    existingOwner !== undefined &&
    existingValue !== undefined &&
    existingPrototypeOwner !== undefined &&
    existingPrototypeValue !== undefined
  ) {
    return {
      owner: existingOwner,
      value: existingValue,
      prototypeOwner: existingPrototypeOwner,
      prototypeValue: existingPrototypeValue,
    };
  }
  const owner = nextModuleGlobalIdx(ctx);
  ctx.mod.globals.push({
    name: "__reflect_construct_newtarget_owner",
    type: { kind: "i32" },
    mutable: true,
    init: [{ op: "i32.const", value: 0 }],
  });
  const value = nextModuleGlobalIdx(ctx);
  ctx.mod.globals.push({
    name: "__reflect_construct_newtarget_value",
    type: { kind: "externref" },
    mutable: true,
    init: [{ op: "ref.null.extern" }],
  });
  const prototypeOwner = nextModuleGlobalIdx(ctx);
  ctx.mod.globals.push({
    name: "__reflect_construct_newtarget_proto_owner",
    type: { kind: "i32" },
    mutable: true,
    init: [{ op: "i32.const", value: 0 }],
  });
  const prototypeValue = nextModuleGlobalIdx(ctx);
  ctx.mod.globals.push({
    name: "__reflect_construct_newtarget_proto",
    type: { kind: "externref" },
    mutable: true,
    init: [{ op: "ref.null.extern" }],
  });
  ctx.reflectConstructNewTargetOwnerGlobalIdx = owner;
  ctx.reflectConstructNewTargetValueGlobalIdx = value;
  ctx.reflectConstructNewTargetProtoOwnerGlobalIdx = prototypeOwner;
  ctx.reflectConstructNewTargetProtoGlobalIdx = prototypeValue;
  return { owner, value, prototypeOwner, prototypeValue };
}

export interface SavedReflectConstructNewTargetState {
  readonly ownerLocal: number;
  readonly valueLocal: number;
  readonly prototypeOwnerLocal: number;
  readonly prototypeValueLocal: number;
}

export function saveReflectConstructNewTargetState(
  ctx: CodegenContext,
  fctx: FunctionContext,
): SavedReflectConstructNewTargetState {
  const globals = ensureReflectConstructNewTargetGlobals(ctx);
  const ownerLocal = allocLocal(fctx, `__reflect_nt_owner_${fctx.locals.length}`, { kind: "i32" });
  const valueLocal = allocLocal(fctx, `__reflect_nt_value_${fctx.locals.length}`, { kind: "externref" });
  const prototypeOwnerLocal = allocLocal(fctx, `__reflect_nt_proto_owner_${fctx.locals.length}`, { kind: "i32" });
  const prototypeValueLocal = allocLocal(fctx, `__reflect_nt_proto_${fctx.locals.length}`, { kind: "externref" });
  fctx.body.push(
    { op: "global.get", index: globals.owner },
    { op: "local.set", index: ownerLocal },
    { op: "global.get", index: globals.value },
    { op: "local.set", index: valueLocal },
    { op: "global.get", index: globals.prototypeOwner },
    { op: "local.set", index: prototypeOwnerLocal },
    { op: "global.get", index: globals.prototypeValue },
    { op: "local.set", index: prototypeValueLocal },
  );
  return { ownerLocal, valueLocal, prototypeOwnerLocal, prototypeValueLocal };
}

export function activateReflectConstructNewTarget(
  ctx: CodegenContext,
  body: Instr[],
  ownerId: number,
  valueLocal: number,
  prototypeLocal: number,
): void {
  const globals = ensureReflectConstructNewTargetGlobals(ctx);
  body.push(
    { op: "local.get", index: valueLocal },
    { op: "global.set", index: globals.value },
    { op: "local.get", index: prototypeLocal },
    { op: "global.set", index: globals.prototypeValue },
    { op: "i32.const", value: ownerId },
    { op: "global.set", index: globals.owner },
    { op: "i32.const", value: ownerId },
    { op: "global.set", index: globals.prototypeOwner },
  );
}

export function restoreReflectConstructNewTargetState(
  ctx: CodegenContext,
  body: Instr[],
  saved: SavedReflectConstructNewTargetState,
): void {
  const globals = ensureReflectConstructNewTargetGlobals(ctx);
  body.push(
    { op: "local.get", index: saved.ownerLocal },
    { op: "global.set", index: globals.owner },
    { op: "local.get", index: saved.valueLocal },
    { op: "global.set", index: globals.value },
    { op: "local.get", index: saved.prototypeOwnerLocal },
    { op: "global.set", index: globals.prototypeOwner },
    { op: "local.get", index: saved.prototypeValueLocal },
    { op: "global.set", index: globals.prototypeValue },
  );
}

/** Emit an admitted ordinary-function constructor body's runtime new.target read. */
export function emitReflectConstructNewTargetRead(ctx: CodegenContext, fctx: FunctionContext): boolean {
  const owner = ctx.reflectConstructNewTargetOwnerGlobalIdx;
  const value = ctx.reflectConstructNewTargetValueGlobalIdx;
  if (owner === undefined || value === undefined) return false;
  const targetId = fctx.reflectConstructNewTargetId;
  const passThrough = fctx.reflectConstructNewTargetPassThrough === true;
  if (targetId === undefined && !passThrough) return false;
  ensureObjectRuntime(ctx);
  const undefinedValue = undefinedExternInstrs(ctx) ?? [{ op: "ref.null.extern" }];
  const active: Instr[] =
    targetId === undefined
      ? [{ op: "global.get", index: owner }, { op: "i32.eqz" }, { op: "i32.eqz" }]
      : [{ op: "global.get", index: owner }, { op: "i32.const", value: targetId }, { op: "i32.eq" }];
  fctx.body.push(...active, {
    op: "if",
    blockType: { kind: "val", type: { kind: "externref" } },
    then: [{ op: "global.get", index: value }],
    else: undefinedValue,
  });
  return true;
}
