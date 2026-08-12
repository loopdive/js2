// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * Per-function direct-eval environment reification (#2925/#2929).
 *
 * The AOT compiler already represents a mutable closure capture as a one-field
 * ref cell and routes identifier reads/writes through `boxedCaptures`. Direct
 * eval uses that same mechanism: only lexical ancestors of a real direct-eval
 * call promote their source bindings, and the interpreter receives references
 * to those cells. This keeps non-eval functions byte-neutral and avoids a
 * second environment representation or a lossy copy-in/copy-out bridge.
 */
import { ts, forEachChild } from "../ts-api.js";
import type { Instr, ValType } from "../ir/types.js";
import type { TypeOracle } from "../checker/oracle.js";
import { ensureExternStrictEqHelper } from "./any-helpers.js";
import { allocLocal, getLocalType } from "./context/locals.js";
import type { CodegenContext, FunctionContext } from "./context/types.js";
import { mintDefinedFunc, pushDefinedFunc } from "./func-space.js";
import { isStrictContext } from "./helpers/is-strict-function.js";
import { ensureObjVecBuilders } from "./object-runtime.js";
import { addFuncType, getOrRegisterRefCellType } from "./registry/types.js";
import { buildRuntimeEvalValueUnwrap } from "./runtime-eval-boundary.js";
import { coerceType } from "./shared.js";

/**
 * Frozen direct-eval state-pool layout shared with both runtime providers.
 *
 * Each source-visible binding consumes four ref-cell carriers:
 * `[name, value, deletability-marker-name, marker-value]`. The caller hands
 * the provider one flat `$ObjVec` containing 256 carriers, hence 64 visible
 * bindings. Keep these values aligned with the interpreter and QuickJS
 * membranes; changing them is an ABI change even though the helper functions
 * below are module-private.
 */
const DIRECT_EVAL_STATE_POOL_CELLS = 256;
const DIRECT_EVAL_STATE_BINDING_STRIDE = 4;
const RUNTIME_EVAL_NEW_STATE_POOL = "__runtime_eval_new_activation_state_pool";
const RUNTIME_EVAL_FIND_STATE_VALUE_CELL = "__runtime_eval_find_activation_state_value_cell";
const RUNTIME_EVAL_DELETE_STATE_BINDING = "__runtime_eval_delete_activation_state_binding";

/** Exact companion name that authenticates a configurable eval-created var.
 * Keep this aligned with `src/interp/eval-environment.ts`; it is part of the
 * existing four-cell provider/caller carrier, not a new ABI field. */
export const RUNTIME_EVAL_DELETABLE_BINDING_MARKER = "\0js2wasm:deletable-eval-binding";

/** Impossible source name used only inside a lifted closure's capture layout.
 * It threads the owning activation's state-pool pointer without changing the
 * runtime-provider ABI or making the pool observable to JavaScript. */
export const RUNTIME_EVAL_STATE_POOL_CAPTURE_NAME = "\0js2wasm:runtime-eval-state-pool";

/** (#4309) An iteration statement that installs its own declarative record —
 * a `let`/`const` head. §14.7.4.2/§14.7.5.6 wrap the WHOLE statement (head,
 * test, increment, body) in it, braced body or not. A `var` head installs
 * none, so it is excluded — see `directEvalRunsAtScriptGlobal`. */
function iterationStatementDeclaresLexicalHead(node: ts.Node): boolean {
  if (!ts.isForStatement(node) && !ts.isForInStatement(node) && !ts.isForOfStatement(node)) return false;
  const initializer: ts.ForInitializer | undefined = node.initializer;
  if (initializer === undefined || !ts.isVariableDeclarationList(initializer)) return false;
  return (initializer.flags & ts.NodeFlags.BlockScoped) !== 0;
}

/**
 * A sloppy direct eval whose call expression belongs directly to Script code
 * has the same GlobalEnvironmentRecord as indirect eval. Its call site uses the
 * global entry instead of manufacturing an empty AOT activation record; the
 * latter would hide B.3.3 global properties in a provider-private declarative
 * record (#2929).
 *
 * The stopping set is exactly "nodes that install a LexicalEnvironment between
 * the call and the script root". (#4309) `ts.isBlock` covers a braced loop body
 * but not the per-iteration record itself, so `for (let i = 0; …) eval(s)`
 * unbraced — and any call in a lexical head — walked past a real record to the
 * source file and was mis-lowered to indirect. `var` heads stay out: routing
 * them direct would move a B.3.3 global publication into the private record
 * this shim exists to avoid.
 */
export function directEvalRunsAtScriptGlobal(call: ts.CallExpression, ctx: CodegenContext): boolean {
  if (isStrictContext(call, ctx.inferModuleStrictArguments)) return false;
  let node: ts.Node | undefined = call.parent;
  while (node) {
    if (ts.isSourceFile(node)) return true;
    if (
      ts.isFunctionLike(node) ||
      ts.isClassDeclaration(node) ||
      ts.isClassExpression(node) ||
      ts.isBlock(node) ||
      ts.isCaseClause(node) ||
      ts.isDefaultClause(node) ||
      ts.isCatchClause(node) ||
      ts.isWithStatement(node) ||
      iterationStatementDeclaresLexicalHead(node)
    ) {
      return false;
    }
    node = node.parent;
  }
  return false;
}

function isGlobalEvalIdentifier(ident: ts.Identifier, oracle: TypeOracle): boolean {
  const declaration = oracle.valueDeclarationOf(ident);
  return declaration === undefined || declaration.getSourceFile().isDeclarationFile;
}

function isDirectEvalCall(node: ts.Node, oracle: TypeOracle): boolean {
  if (!ts.isCallExpression(node) || node.questionDotToken) return false;
  let callee: ts.Expression = node.expression;
  while (ts.isParenthesizedExpression(callee)) callee = callee.expression;
  return ts.isIdentifier(callee) && callee.text === "eval" && isGlobalEvalIdentifier(callee, oracle);
}

/**
 * A direct eval in a nested lexical descendant can still name an outer
 * binding, so the scan deliberately descends through nested functions. Each
 * nested function is compiled separately and receives its own binding set too.
 */
export function functionMayReachDirectEval(decl: ts.FunctionLikeDeclaration, oracle: TypeOracle): boolean {
  if (!decl.body) return false;
  let found = false;
  const visit = (node: ts.Node): void => {
    if (found) return;
    if (isDirectEvalCall(node, oracle)) {
      found = true;
      return;
    }
    forEachChild(node, visit);
  };
  visit(decl.body);
  return found;
}

/** Direct eval owned by this exact function activation, excluding every nested
 * function/class body. This differs from {@link functionMayReachDirectEval},
 * whose deliberate descendant walk is used to reify outer lexical bindings. */
export function functionOwnScopeMayReachDirectEval(decl: ts.FunctionLikeDeclaration, oracle: TypeOracle): boolean {
  if (!decl.body) return false;
  let found = false;
  const root = decl.body;
  const visit = (node: ts.Node): void => {
    if (found) return;
    if (node !== root && (ts.isFunctionLike(node) || ts.isClassDeclaration(node) || ts.isClassExpression(node))) {
      return;
    }
    if (isDirectEvalCall(node, oracle)) {
      found = true;
      return;
    }
    forEachChild(node, visit);
  };
  visit(root);
  return found;
}

/** Whether the immediately enclosing source-function activation owns direct
 * eval. Lifted closures/declarations use this source-level predicate before
 * the owner's pool local necessarily exists (notably during declaration
 * pre-registration), so their capture layout is independent of compile order. */
export function enclosingFunctionOwnScopeMayReachDirectEval(
  node: ts.FunctionLikeDeclaration,
  oracle: TypeOracle,
): boolean {
  let owner: ts.Node | undefined = node.parent;
  while (owner && !ts.isFunctionLike(owner)) owner = owner.parent;
  if (!owner || !("body" in owner) || owner.body === undefined) return false;
  return functionOwnScopeMayReachDirectEval(owner as ts.FunctionLikeDeclaration, oracle);
}

function addBindingName(name: ts.BindingName, names: Set<string>): void {
  if (ts.isIdentifier(name)) {
    if (name.text !== "this") names.add(name.text);
    return;
  }
  for (const element of name.elements) {
    if (!ts.isOmittedExpression(element)) addBindingName(element.name, names);
  }
}

/** Collect bindings owned by `decl`, without stealing declarations from a
 * nested function/class scope. `arguments` is implicit but visible to eval. */
export function collectDirectEvalBindingNames(decl: ts.FunctionLikeDeclaration): Set<string> {
  const names = new Set<string>();
  // Arrow functions inherit `arguments` from their lexical parent; ordinary
  // functions create their own binding.
  if (!ts.isArrowFunction(decl)) names.add("arguments");
  for (const param of decl.parameters) addBindingName(param.name, names);

  const root = decl.body;
  if (!root) return names;
  const visit = (node: ts.Node): void => {
    if (node !== root) {
      if (ts.isFunctionDeclaration(node)) {
        if (node.name) names.add(node.name.text);
        return;
      }
      if (
        ts.isFunctionExpression(node) ||
        ts.isArrowFunction(node) ||
        ts.isMethodDeclaration(node) ||
        ts.isGetAccessorDeclaration(node) ||
        ts.isSetAccessorDeclaration(node) ||
        ts.isConstructorDeclaration(node)
      ) {
        return;
      }
      if (ts.isClassDeclaration(node) || ts.isClassExpression(node)) {
        if (node.name) names.add(node.name.text);
        return;
      }
    }
    if (ts.isVariableDeclaration(node)) addBindingName(node.name, names);
    if (ts.isCatchClause(node) && node.variableDeclaration) addBindingName(node.variableDeclaration.name, names);
    forEachChild(node, visit);
  };
  visit(root);
  return names;
}

/** Collect bindings that belong to the current VariableEnvironment.
 *
 * This is intentionally narrower than `collectDirectEvalBindingNames`: nested
 * block/catch lexicals and the function body's top-level `let`/`const`/class
 * declarations are call-site LexicalEnvironment entries. Parameters,
 * `arguments`, function declarations, and every recursively nested `var`
 * declaration belong to the persistent VariableEnvironment. */
export function collectDirectEvalActivationBindingNames(decl: ts.FunctionLikeDeclaration): Set<string> {
  const names = new Set<string>();
  if (!ts.isArrowFunction(decl)) names.add("arguments");
  for (const param of decl.parameters) addBindingName(param.name, names);
  if (!decl.body || !ts.isBlock(decl.body)) return names;

  for (const statement of decl.body.statements) {
    if (ts.isVariableStatement(statement)) {
      if ((statement.declarationList.flags & (ts.NodeFlags.Let | ts.NodeFlags.Const)) === 0) {
        for (const declaration of statement.declarationList.declarations) addBindingName(declaration.name, names);
      }
    } else if (ts.isFunctionDeclaration(statement)) {
      if (statement.name) names.add(statement.name.text);
    }
  }

  const visitVarScoped = (node: ts.Node): void => {
    if (
      ts.isFunctionDeclaration(node) ||
      ts.isFunctionExpression(node) ||
      ts.isArrowFunction(node) ||
      ts.isMethodDeclaration(node) ||
      ts.isGetAccessorDeclaration(node) ||
      ts.isSetAccessorDeclaration(node) ||
      ts.isConstructorDeclaration(node) ||
      ts.isClassDeclaration(node) ||
      ts.isClassExpression(node)
    ) {
      return;
    }
    if (ts.isVariableDeclaration(node)) {
      const list = node.parent;
      if (ts.isVariableDeclarationList(list) && (list.flags & (ts.NodeFlags.Let | ts.NodeFlags.Const)) === 0) {
        addBindingName(node.name, names);
      }
    }
    forEachChild(node, visitVarScoped);
  };
  for (const statement of decl.body.statements) visitVarScoped(statement);
  return names;
}

function boxTopAsExternref(ctx: CodegenContext, fctx: FunctionContext, type: ValType): void {
  if (type.kind !== "externref") coerceType(ctx, fctx, type, { kind: "externref" });
}

/** Promote every currently allocated eval-visible binding to the canonical
 * `(mut externref)` cell. Calling this again is intentional: block/catch/loop
 * bindings can be allocated after the function-entry hoist pass. */
export function reifyCurrentDirectEvalBindings(ctx: CodegenContext, fctx: FunctionContext): void {
  const names = fctx.directEvalBindingNames;
  if (!names) return;
  const cellTypeIdx = fctx.directEvalRefCellTypeIdx ?? getOrRegisterRefCellType(ctx, { kind: "externref" });
  fctx.directEvalRefCellTypeIdx = cellTypeIdx;
  if (!fctx.boxedCaptures) fctx.boxedCaptures = new Map();
  if (!fctx.directEvalActivationBindings) fctx.directEvalActivationBindings = new Map();

  for (const name of names) {
    const localIdx = fctx.localMap.get(name);
    if (localIdx === undefined) continue;
    const existingMetadata = fctx.boxedCaptures.get(name);
    const currentLocalType = getLocalType(fctx, localIdx);
    // A rolled-back speculative promotion may have restored localMap while an
    // older snapshot implementation left the boxed metadata re-pointed. Never
    // trust cell metadata unless the live local actually carries that cell.
    const existing =
      existingMetadata &&
      (currentLocalType?.kind === "ref" || currentLocalType?.kind === "ref_null") &&
      currentLocalType.typeIdx === existingMetadata.refCellTypeIdx
        ? existingMetadata
        : undefined;
    if (existing?.refCellTypeIdx === cellTypeIdx && existing.valType.kind === "externref") {
      if (fctx.directEvalActivationBindingNames?.has(name)) {
        if (!fctx.directEvalActivationBindings.has(name)) {
          fctx.directEvalActivationBindings.set(name, localIdx);
        }
      }
      continue;
    }

    let valueType: ValType | undefined;
    if (existing) {
      // A default-parameter closure can box a param before the body pre-pass.
      // Promote the currently shared value into the canonical eval cell. Later
      // AOT reads/writes use this cell; ordinary body-hoisted closures see the
      // canonical cell because this pass runs before their compilation.
      fctx.body.push(
        { op: "local.get", index: localIdx },
        { op: "ref.as_non_null" },
        { op: "struct.get", typeIdx: existing.refCellTypeIdx, fieldIdx: 0 },
      );
      valueType = existing.valType;
    } else {
      valueType = getLocalType(fctx, localIdx);
      if (!valueType) continue;
      fctx.body.push({ op: "local.get", index: localIdx });
    }
    boxTopAsExternref(ctx, fctx, valueType);

    const cellLocal = allocLocal(fctx, `__direct_eval_cell_${name}_${fctx.locals.length}`, {
      kind: "ref",
      typeIdx: cellTypeIdx,
    });
    fctx.body.push({ op: "struct.new", typeIdx: cellTypeIdx }, { op: "local.set", index: cellLocal });
    fctx.localMap.set(name, cellLocal);
    fctx.boxedCaptures.set(name, { refCellTypeIdx: cellTypeIdx, valType: { kind: "externref" } });
    if (fctx.directEvalActivationBindingNames?.has(name)) {
      if (!fctx.directEvalActivationBindings.has(name)) {
        fctx.directEvalActivationBindings.set(name, cellLocal);
      }
    }
  }
}

/**
 * Register the module-level constructor for one caller-owned direct-eval state
 * pool. The runtime loop keeps the call site constant-size: the AOT activation
 * owns one nullable externref local, and its first executed direct eval fills
 * that local with the exact 256-cell flat carrier expected by the provider.
 */
export function ensureDirectEvalStatePoolNewHelper(ctx: CodegenContext, cellTypeIdx: number): number {
  const existing = ctx.funcMap.get(RUNTIME_EVAL_NEW_STATE_POOL);
  if (existing !== undefined) return existing;

  const { newIdx, pushIdx } = ensureObjVecBuilders(ctx);
  const funcIdx = mintDefinedFunc(ctx);
  const typeIdx = addFuncType(ctx, [], [{ kind: "externref" }], "$runtime_eval_new_activation_state_pool_type");
  const poolLocal = 0;
  const indexLocal = 1;
  const loopBody: Instr[] = [
    { op: "local.get", index: indexLocal },
    { op: "i32.const", value: DIRECT_EVAL_STATE_POOL_CELLS },
    { op: "i32.ge_u" },
    { op: "br_if", depth: 1 },
    { op: "local.get", index: poolLocal },
    { op: "ref.null.extern" },
    { op: "struct.new", typeIdx: cellTypeIdx },
    { op: "extern.convert_any" },
    { op: "call", funcIdx: pushIdx },
    { op: "local.get", index: indexLocal },
    { op: "i32.const", value: 1 },
    { op: "i32.add" },
    { op: "local.set", index: indexLocal },
    { op: "br", depth: 0 },
  ];
  const body: Instr[] = [
    { op: "call", funcIdx: newIdx },
    { op: "local.set", index: poolLocal },
    { op: "i32.const", value: 0 },
    { op: "local.set", index: indexLocal },
    {
      op: "block",
      blockType: { kind: "empty" },
      body: [{ op: "loop", blockType: { kind: "empty" }, body: loopBody }],
    },
    { op: "local.get", index: poolLocal },
  ];
  ctx.funcMap.set(RUNTIME_EVAL_NEW_STATE_POOL, funcIdx);
  pushDefinedFunc(ctx, funcIdx, {
    name: RUNTIME_EVAL_NEW_STATE_POOL,
    typeIdx,
    locals: [
      { name: "pool", type: { kind: "externref" } },
      { name: "i", type: { kind: "i32" } },
    ],
    body,
    exported: false,
  });
  return funcIdx;
}

/** Reserve the nullable pool pointer before source-order lowering decides
 * whether a particular read precedes the textual eval call. Wasm initializes
 * the externref local to null; the first actual eval (or an escaping closure
 * that must retain the activation) fills it through the shared constructor. */
export function ensureDirectEvalActivationStatePoolLocal(
  ctx: CodegenContext,
  fctx: FunctionContext,
): { poolLocal: number; cellTypeIdx: number } {
  const cellTypeIdx = fctx.directEvalRefCellTypeIdx ?? getOrRegisterRefCellType(ctx, { kind: "externref" });
  fctx.directEvalRefCellTypeIdx = cellTypeIdx;
  if (fctx.directEvalActivationStatePoolLocal === undefined) {
    fctx.directEvalActivationStatePoolLocal = allocLocal(
      fctx,
      `__runtime_direct_eval_activation_state_pool_${fctx.locals.length}`,
      { kind: "externref" },
    );
  }
  return { poolLocal: fctx.directEvalActivationStatePoolLocal, cellTypeIdx };
}

/** Materialize the current activation's state pool if it is still null. */
export function emitEnsureDirectEvalActivationStatePoolInitialized(
  ctx: CodegenContext,
  fctx: FunctionContext,
): { poolLocal: number; cellTypeIdx: number } {
  const state = ensureDirectEvalActivationStatePoolLocal(ctx, fctx);
  const newIdx = ensureDirectEvalStatePoolNewHelper(ctx, state.cellTypeIdx);
  fctx.body.push(
    { op: "local.get", index: state.poolLocal },
    { op: "ref.is_null" },
    {
      op: "if",
      blockType: { kind: "empty" },
      then: [
        { op: "call", funcIdx: newIdx },
        { op: "local.set", index: state.poolLocal },
      ],
    },
  );
  return state;
}

/** Whether a provider-created binding in the activation pool can win this
 * identifier lookup. Current-function var/lexical bindings remain static;
 * only an outer capture or a name with no current binding can be shadowed by a
 * later sloppy direct-eval var declaration. */
export function runtimeEvalStateMayShadowBinding(ctx: CodegenContext, fctx: FunctionContext, name: string): boolean {
  // The caller-owned activation carrier belongs to the standalone/WASI
  // provider seam. JS-host direct eval keeps its existing static-splice/host
  // behavior and must not synthesize provider-only helpers into that module.
  if (!ctx.standalone && !ctx.wasi) return false;
  if (fctx.directEvalActivationStatePoolLocal === undefined && fctx.directEvalBindingNames === undefined) {
    return false;
  }
  if (fctx.directEvalActivationBindingNames?.has(name)) return false;
  if (fctx.localMap.has(name) && !fctx.directEvalOuterBindingNames?.has(name)) return false;
  return true;
}

/**
 * Register the shared sibling-read lookup. It returns the matching VALUE-cell
 * carrier (never the value itself), using null only for a miss. That preserves
 * the old found/value distinction even when the stored JavaScript value is
 * null or undefined; the caller performs the canonical value unwrap exactly
 * where it did before this compaction.
 */
export function ensureDirectEvalStateValueCellLookup(ctx: CodegenContext, cellTypeIdx: number): number | undefined {
  const existing = ctx.funcMap.get(RUNTIME_EVAL_FIND_STATE_VALUE_CELL);
  if (existing !== undefined) return existing;

  ensureObjVecBuilders(ctx);
  const objVecTypeIdx = ctx.objectRuntimeTypes?.objVecTypeIdx;
  const objVecArrTypeIdx = ctx.objectRuntimeTypes?.objVecArrTypeIdx;
  const strictEqIdx = ensureExternStrictEqHelper(ctx);
  if (objVecTypeIdx === undefined || objVecArrTypeIdx === undefined || strictEqIdx === undefined) return undefined;

  // params 0=pool, 1=name; locals 2=poolAny, 3=vec, 4=data, 5=len,
  // 6=i, 7=cellAny.
  const poolAnyLocal = 2;
  const vecLocal = 3;
  const dataLocal = 4;
  const lengthLocal = 5;
  const indexLocal = 6;
  const cellAnyLocal = 7;
  const locals: { name: string; type: ValType }[] = [
    { name: "poolAny", type: { kind: "anyref" } },
    { name: "vec", type: { kind: "ref_null", typeIdx: objVecTypeIdx } },
    { name: "data", type: { kind: "ref_null", typeIdx: objVecArrTypeIdx } },
    { name: "len", type: { kind: "i32" } },
    { name: "i", type: { kind: "i32" } },
    { name: "cellAny", type: { kind: "anyref" } },
  ];
  const unwrapSharedValue = buildRuntimeEvalValueUnwrap(ctx, locals, 2);
  const loopBody: Instr[] = [
    // A malformed/truncated carrier is a miss, never an array OOB trap.
    { op: "local.get", index: indexLocal },
    { op: "i32.const", value: 1 },
    { op: "i32.add" },
    { op: "local.get", index: lengthLocal },
    { op: "i32.ge_u" },
    { op: "br_if", depth: 1 },
    { op: "local.get", index: dataLocal },
    { op: "ref.as_non_null" },
    { op: "local.get", index: indexLocal },
    { op: "array.get", typeIdx: objVecArrTypeIdx },
    { op: "any.convert_extern" },
    { op: "local.tee", index: cellAnyLocal },
    { op: "ref.test", typeIdx: cellTypeIdx },
    {
      op: "if",
      blockType: { kind: "empty" },
      then: [
        { op: "local.get", index: cellAnyLocal },
        { op: "ref.cast", typeIdx: cellTypeIdx },
        { op: "struct.get", typeIdx: cellTypeIdx, fieldIdx: 0 },
        ...unwrapSharedValue,
        { op: "local.get", index: 1 },
        { op: "call", funcIdx: strictEqIdx },
        {
          op: "if",
          blockType: { kind: "empty" },
          then: [
            { op: "local.get", index: dataLocal },
            { op: "ref.as_non_null" },
            { op: "local.get", index: indexLocal },
            { op: "i32.const", value: 1 },
            { op: "i32.add" },
            { op: "array.get", typeIdx: objVecArrTypeIdx },
            { op: "return" },
          ],
        },
      ],
    },
    { op: "local.get", index: indexLocal },
    { op: "i32.const", value: DIRECT_EVAL_STATE_BINDING_STRIDE },
    { op: "i32.add" },
    { op: "local.set", index: indexLocal },
    { op: "br", depth: 0 },
  ];
  const body: Instr[] = [
    { op: "local.get", index: 0 },
    { op: "any.convert_extern" },
    { op: "local.tee", index: poolAnyLocal },
    { op: "ref.test", typeIdx: objVecTypeIdx },
    { op: "i32.eqz" },
    {
      op: "if",
      blockType: { kind: "empty" },
      then: [{ op: "ref.null.extern" }, { op: "return" }],
    },
    { op: "local.get", index: poolAnyLocal },
    { op: "ref.cast", typeIdx: objVecTypeIdx },
    { op: "local.set", index: vecLocal },
    { op: "local.get", index: vecLocal },
    { op: "ref.as_non_null" },
    { op: "struct.get", typeIdx: objVecTypeIdx, fieldIdx: 1 },
    { op: "local.set", index: dataLocal },
    { op: "local.get", index: vecLocal },
    { op: "ref.as_non_null" },
    { op: "struct.get", typeIdx: objVecTypeIdx, fieldIdx: 0 },
    { op: "local.set", index: lengthLocal },
    { op: "i32.const", value: 0 },
    { op: "local.set", index: indexLocal },
    {
      op: "block",
      blockType: { kind: "empty" },
      body: [{ op: "loop", blockType: { kind: "empty" }, body: loopBody }],
    },
    { op: "ref.null.extern" },
  ];
  const funcIdx = mintDefinedFunc(ctx);
  const typeIdx = addFuncType(
    ctx,
    [{ kind: "externref" }, { kind: "externref" }],
    [{ kind: "externref" }],
    "$runtime_eval_find_activation_state_value_cell_type",
  );
  ctx.funcMap.set(RUNTIME_EVAL_FIND_STATE_VALUE_CELL, funcIdx);
  pushDefinedFunc(ctx, funcIdx, {
    name: RUNTIME_EVAL_FIND_STATE_VALUE_CELL,
    typeIdx,
    locals,
    body,
    exported: false,
  });
  return funcIdx;
}

/** Register the shared AOT delete operation for a provider-created binding.
 * The result is 1 when a matching four-cell group was tombstoned and 0 on a
 * miss. The caller retains the ordinary global/static delete as the miss arm. */
export function ensureDirectEvalStateBindingDelete(ctx: CodegenContext, cellTypeIdx: number): number | undefined {
  const existing = ctx.funcMap.get(RUNTIME_EVAL_DELETE_STATE_BINDING);
  if (existing !== undefined) return existing;

  ensureObjVecBuilders(ctx);
  const objVecTypeIdx = ctx.objectRuntimeTypes?.objVecTypeIdx;
  const objVecArrTypeIdx = ctx.objectRuntimeTypes?.objVecArrTypeIdx;
  const strictEqIdx = ensureExternStrictEqHelper(ctx);
  if (objVecTypeIdx === undefined || objVecArrTypeIdx === undefined || strictEqIdx === undefined) return undefined;

  // params 0=pool, 1=name, 2=exact deletability marker; locals 3=poolAny,
  // 4=vec, 5=data, 6=len, 7=i, 8=cellAny.
  const poolAnyLocal = 3;
  const vecLocal = 4;
  const dataLocal = 5;
  const lengthLocal = 6;
  const indexLocal = 7;
  const cellAnyLocal = 8;
  const locals: { name: string; type: ValType }[] = [
    { name: "poolAny", type: { kind: "anyref" } },
    { name: "vec", type: { kind: "ref_null", typeIdx: objVecTypeIdx } },
    { name: "data", type: { kind: "ref_null", typeIdx: objVecArrTypeIdx } },
    { name: "len", type: { kind: "i32" } },
    { name: "i", type: { kind: "i32" } },
    { name: "cellAny", type: { kind: "anyref" } },
  ];
  const unwrapSharedValue = buildRuntimeEvalValueUnwrap(ctx, locals, 3);
  const clearCell = (offset: number): Instr[] => [
    { op: "local.get", index: dataLocal },
    { op: "ref.as_non_null" },
    { op: "local.get", index: indexLocal },
    ...(offset === 0 ? [] : [{ op: "i32.const", value: offset } as Instr, { op: "i32.add" } as Instr]),
    { op: "array.get", typeIdx: objVecArrTypeIdx },
    { op: "any.convert_extern" },
    { op: "local.tee", index: cellAnyLocal },
    { op: "ref.test", typeIdx: cellTypeIdx },
    {
      op: "if",
      blockType: { kind: "empty" },
      then: [
        { op: "local.get", index: cellAnyLocal },
        { op: "ref.cast", typeIdx: cellTypeIdx },
        { op: "ref.null.extern" },
        { op: "struct.set", typeIdx: cellTypeIdx, fieldIdx: 0 },
      ],
    },
  ];
  const loopBody: Instr[] = [
    { op: "local.get", index: indexLocal },
    { op: "i32.const", value: DIRECT_EVAL_STATE_BINDING_STRIDE - 1 },
    { op: "i32.add" },
    { op: "local.get", index: lengthLocal },
    { op: "i32.ge_u" },
    { op: "br_if", depth: 1 },
    { op: "local.get", index: dataLocal },
    { op: "ref.as_non_null" },
    { op: "local.get", index: indexLocal },
    { op: "array.get", typeIdx: objVecArrTypeIdx },
    { op: "any.convert_extern" },
    { op: "local.tee", index: cellAnyLocal },
    { op: "ref.test", typeIdx: cellTypeIdx },
    {
      op: "if",
      blockType: { kind: "empty" },
      then: [
        { op: "local.get", index: cellAnyLocal },
        { op: "ref.cast", typeIdx: cellTypeIdx },
        { op: "struct.get", typeIdx: cellTypeIdx, fieldIdx: 0 },
        ...unwrapSharedValue,
        { op: "local.get", index: 1 },
        { op: "call", funcIdx: strictEqIdx },
        {
          op: "if",
          blockType: { kind: "empty" },
          then: [
            // A source-visible name is deletable only when the adjacent marker
            // cell carries the exact internal marker. A same-shaped ordinary
            // declarative group must fall through without being tombstoned.
            { op: "local.get", index: dataLocal },
            { op: "ref.as_non_null" },
            { op: "local.get", index: indexLocal },
            { op: "i32.const", value: 2 },
            { op: "i32.add" },
            { op: "array.get", typeIdx: objVecArrTypeIdx },
            { op: "any.convert_extern" },
            { op: "local.tee", index: cellAnyLocal },
            { op: "ref.test", typeIdx: cellTypeIdx },
            {
              op: "if",
              blockType: { kind: "empty" },
              then: [
                { op: "local.get", index: cellAnyLocal },
                { op: "ref.cast", typeIdx: cellTypeIdx },
                { op: "struct.get", typeIdx: cellTypeIdx, fieldIdx: 0 },
                ...unwrapSharedValue,
                { op: "local.get", index: 2 },
                { op: "call", funcIdx: strictEqIdx },
                {
                  op: "if",
                  blockType: { kind: "empty" },
                  then: [
                    ...clearCell(0),
                    ...clearCell(1),
                    ...clearCell(2),
                    ...clearCell(3),
                    { op: "i32.const", value: 1 },
                    { op: "return" },
                  ],
                },
              ],
            },
          ],
        },
      ],
    },
    { op: "local.get", index: indexLocal },
    { op: "i32.const", value: DIRECT_EVAL_STATE_BINDING_STRIDE },
    { op: "i32.add" },
    { op: "local.set", index: indexLocal },
    { op: "br", depth: 0 },
  ];
  const body: Instr[] = [
    { op: "local.get", index: 0 },
    { op: "any.convert_extern" },
    { op: "local.tee", index: poolAnyLocal },
    { op: "ref.test", typeIdx: objVecTypeIdx },
    { op: "i32.eqz" },
    {
      op: "if",
      blockType: { kind: "empty" },
      then: [{ op: "i32.const", value: 0 }, { op: "return" }],
    },
    { op: "local.get", index: poolAnyLocal },
    { op: "ref.cast", typeIdx: objVecTypeIdx },
    { op: "local.set", index: vecLocal },
    { op: "local.get", index: vecLocal },
    { op: "ref.as_non_null" },
    { op: "struct.get", typeIdx: objVecTypeIdx, fieldIdx: 1 },
    { op: "local.set", index: dataLocal },
    { op: "local.get", index: vecLocal },
    { op: "ref.as_non_null" },
    { op: "struct.get", typeIdx: objVecTypeIdx, fieldIdx: 0 },
    { op: "local.set", index: lengthLocal },
    { op: "i32.const", value: 0 },
    { op: "local.set", index: indexLocal },
    {
      op: "block",
      blockType: { kind: "empty" },
      body: [{ op: "loop", blockType: { kind: "empty" }, body: loopBody }],
    },
    { op: "i32.const", value: 0 },
  ];
  const funcIdx = mintDefinedFunc(ctx);
  const typeIdx = addFuncType(
    ctx,
    [{ kind: "externref" }, { kind: "externref" }, { kind: "externref" }],
    [{ kind: "i32" }],
    "$runtime_eval_delete_activation_state_binding_type",
  );
  ctx.funcMap.set(RUNTIME_EVAL_DELETE_STATE_BINDING, funcIdx);
  pushDefinedFunc(ctx, funcIdx, {
    name: RUNTIME_EVAL_DELETE_STATE_BINDING,
    typeIdx,
    locals,
    body,
    exported: false,
  });
  return funcIdx;
}

export interface DirectEvalBinding {
  name: string;
  cellLocal: number;
}

export interface DirectEvalBindingLayers {
  /** Persistent current-function environment, including eval-created vars. */
  activation: DirectEvalBinding[];
  /** Fresh lexical shadows visible at this particular call site. */
  lexical: DirectEvalBinding[];
  /** Canonical cells captured from outer function activations. */
  outer: DirectEvalBinding[];
}

/** Return the lexical bindings visible at the current direct-eval call site
 * without emitting reification code. A binding owned by the current function
 * is lexical when its live local differs from the persistent activation cell;
 * outer captures are a separate environment layer and do not participate in
 * EvalDeclarationInstantiation's LexicalEnvironment→VariableEnvironment walk. */
export function currentDirectEvalLexicalBindingNames(fctx: FunctionContext): ReadonlySet<string> {
  const result = new Set<string>();
  const names = fctx.directEvalBindingNames;
  if (!names) return result;
  for (const name of names) {
    if (fctx.directEvalOuterBindingNames?.has(name)) continue;
    const currentLocal = fctx.localMap.get(name);
    if (currentLocal === undefined) continue;
    if (fctx.directEvalActivationBindings?.get(name) !== currentLocal) result.add(name);
  }
  return result;
}

/** Snapshot the cells visible at one direct-eval call site, after promoting any
 * binding allocated since the entry pre-pass (e.g. a block shadow). */
export function currentDirectEvalBindings(ctx: CodegenContext, fctx: FunctionContext): DirectEvalBindingLayers {
  reifyCurrentDirectEvalBindings(ctx, fctx);
  const names = fctx.directEvalBindingNames;
  const cellTypeIdx = fctx.directEvalRefCellTypeIdx;
  const activation: DirectEvalBinding[] = [];
  const lexical: DirectEvalBinding[] = [];
  const outer: DirectEvalBinding[] = [];
  if (!names || cellTypeIdx === undefined) return { activation, lexical, outer };

  for (const [name, cellLocal] of fctx.directEvalActivationBindings ?? []) {
    activation.push({ name, cellLocal });
  }

  for (const name of names) {
    const cellLocal = fctx.localMap.get(name);
    const boxed = fctx.boxedCaptures?.get(name);
    if (cellLocal !== undefined && boxed?.refCellTypeIdx === cellTypeIdx && boxed.valType.kind === "externref") {
      if (fctx.directEvalOuterBindingNames?.has(name)) {
        outer.push({ name, cellLocal });
      } else if (fctx.directEvalActivationBindings?.get(name) !== cellLocal) {
        lexical.push({ name, cellLocal });
      }
    }
  }
  return { activation, lexical, outer };
}
