// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * Receiver binding for a **call on an object-literal function-valued property**.
 *
 * ## The defect
 *
 * ```js
 * var obj = { x: 42, m: function () { return this.x; } };
 * obj.m();            // undefined   (want 42)
 * obj.m.call(obj);    // 42          — already correct
 * ```
 *
 * This is ordinary, everyday JavaScript, and it was wrong on **both** lanes
 * (standalone AND gc/host) for every arity, for a nested receiver
 * (`outer.inner.m()`), and — worst — for a method that WRITES through `this`
 * (`this.x = 99` landed nowhere observable). The value read is right: extracting
 * the member first (`var g = obj.m; g.call(obj)`) has always worked.
 *
 * ## Root cause (measured on the emitted WAT, not inferred)
 *
 * `compileCallablePropertyCall` (`expressions/calls-closures.ts`) lowers
 * `obj.m()` to a `call_ref` whose **first argument is the CLOSURE ref** — the
 * lifted function's `self`/environment carrier — and threads nothing else. The
 * receiver is compiled only to read the field off it and is then unreachable.
 *
 * The callee half was already correct and needed no change. For
 * `m: function () { return this.x; }`, `bodyReferencesOwnThis` is true, so
 * `compileFunctionBody` sets `readsCurrentThis` and the lifted body opens with
 *
 * ```wat
 * global.get $__current_this ; local.tee ; ref.is_null
 * (if (result externref) (then <undefined>) (else <the receiver>))
 * ```
 *
 * i.e. it reads the global and falls back to `undefined` when nothing was
 * installed. Nothing on this path ever wrote that global. So — exactly as in
 * #4192, whose machinery this module reuses rather than re-derives — **only the
 * writer was missing**; `obj.m.call(obj)` works today precisely because
 * `__apply_closure` installs it.
 *
 * ## Shape
 *
 * The receiver is captured (as externref) at the ONE point it is already
 * compiled, so it is evaluated exactly once — no re-compilation of
 * `propAccess.expression`, and therefore no risk of running a side-effecting or
 * getter-backed receiver twice. The install is emitted **after the arguments**,
 * immediately before the `call_ref`:
 *
 * ```wat
 * <receiver>  local.tee $tmp ; local.get $tmp ; extern.convert_any
 *             local.set  $__objm_recv          ;; captured once, with the field read
 * …           ;; self, arguments, funcref — unchanged
 * global.get  $__current_this ; local.set $__objm_prev
 * local.get   $__objm_recv    ; global.set $__current_this
 * call_ref                    ;; unchanged
 * [local.set  $res] ; local.get $__objm_prev ; global.set $__current_this ; [local.get $res]
 * ```
 *
 * **Argument order is load-bearing.** Installing before the arguments are
 * evaluated would corrupt an argument that reads the CALLER's `this`
 * (`obj.m(this.q)`), since that read also goes through `__current_this`. Every
 * arm therefore installs at the last possible moment.
 *
 * Save/install/restore is inline, matching `closure-receiver-install.ts`,
 * `__call_fn_method_N` (closure-exports.ts) and `fillDirectCallTrampolines`
 * (typed-this.ts) — **including their one documented limitation, that an
 * exceptional unwind skips the restore**. Being the single path that differs is
 * worth less than matching the established sequence.
 *
 * ## Admission — narrow, and each gate is a refusal rather than a guess
 *
 * `planObjectLiteralMethodReceiverBind` fires only when EVERY declaration of the
 * member symbol is an object-literal `PropertyAssignment` whose initializer is a
 * plain `FunctionExpression`, or a named native-generator declaration reference,
 * that references its own `this` (in the body or a parameter initializer):
 *
 *  - **`FunctionExpression`, never an arrow.** An arrow's `this` is lexical;
 *    installing a dynamic receiver would replace a correct answer with a wrong
 *    one. `{ m: () => … }` is deliberately untouched.
 *  - **A referenced generator declaration is admitted only for this exact
 *    property-assignment shape.** Its native frame snapshots the receiver while
 *    this call installs it; a plain declaration or any other receiver remains
 *    on its established path.
 *  - **The body or a parameter initializer must reference its own `this`** —
 *    the same function-like predicate used by the callee prologue, so the
 *    call-time writer and the deferred-body reader can never disagree. A
 *    method that ignores its receiver is byte-identical to before.
 *  - **Not a generator, not `async`, no explicit `this` parameter** — those
 *    carry their own receiver conventions.
 *  - **A shorthand `MethodDeclaration` is admitted when its own body contains
 *    `super`, or when it reads its own `this` in an object literal promoted to
 *    the standalone dynamic-prototype representation.** The latter narrow
 *    gate keeps mixed literals' ordinary methods on the same call-time
 *    receiver path as their `super` sibling; ordinary closed literals remain
 *    on the established static path.
 *  - **Every declaration must qualify.** A symbol declared by two literals, one
 *    of them arrow-valued, is refused rather than half-bound.
 *
 * An unresolvable member (an `any` receiver, a computed name with no symbol) has
 * no declarations and is refused, which keeps the whole `any` surface — where a
 * receiver could be anything — on its existing lowering.
 */
import { ts } from "../ts-api.js";
import type { Instr, ValType } from "../ir/types.js";
import type { CodegenContext, FunctionContext } from "./context/types.js";
import { allocLocal } from "./context/locals.js";
import { bodyReferencesOwnThis, functionLikeReferencesOwnThis } from "./helpers/body-references-own-this.js";
import { ensureCurrentThisGlobal } from "./statements/nested-declarations.js";
import { innerResultValType } from "./closure-receiver-install.js";

/**
 * Locals reserved for one install/restore pair.
 *
 * **The `__current_this` global index is deliberately NOT stored here.** It is
 * re-read from `ctx.currentThisGlobalIdx` at each emit point. Registering a
 * string-constant import inserts an IMPORT global, which shifts every
 * module-global index up by one; `fixupModuleGlobalIndices` repairs the cached
 * index and every already-emitted `global.get`/`global.set`, but it cannot
 * repair a plain number a caller is holding. This module plans before the
 * receiver and installs after the ARGUMENTS, so a string literal anywhere in
 * between would desync a baked index — measured: the install landed on the
 * module-object global instead, and V8 rejected the module with
 * `global.set[0] expected type (ref null 8), found local.get of type externref`.
 * (Same family as #2023 / #2001-S1 / #3032 / #3933.)
 */
export interface ObjectLiteralMethodReceiverBind {
  readonly recvLocal: number;
  readonly prevLocal: number;
}

/**
 * Is `initializer` a plain, `this`-reading function expression — the one shape
 * whose receiver the call site must install?
 */
function isThisReadingFunctionExpression(initializer: ts.Expression): boolean {
  if (!ts.isFunctionExpression(initializer) || initializer.body === undefined) return false;
  if (initializer.asteriskToken !== undefined) return false;
  if (initializer.modifiers?.some((m) => m.kind === ts.SyntaxKind.AsyncKeyword) === true) return false;
  const first = initializer.parameters[0];
  if (first && ts.isIdentifier(first.name) && first.name.text === "this") return false;
  return functionLikeReferencesOwnThis(initializer);
}

/**
 * Does a shorthand object-literal method's own body contain `super`?  Unlike
 * ordinary function-valued properties, these methods are the standalone
 * #4688 shape whose direct call must install the receiver into
 * `__current_this`; the helper intentionally stops at nested non-arrow
 * function boundaries because those have their own `super` binding rules.
 */
function methodBodyReferencesSuper(body: ts.Node): boolean {
  if (body.kind === ts.SyntaxKind.SuperKeyword) return true;
  if (ts.isFunctionExpression(body) || ts.isFunctionDeclaration(body) || ts.isMethodDeclaration(body)) return false;
  let found = false;
  body.forEachChild((child) => {
    if (!found && methodBodyReferencesSuper(child)) found = true;
  });
  return found;
}

/**
 * True when a shorthand object-literal method must receive the call-time
 * receiver. Dynamic-prototype literals use the open object representation, so
 * an own-`this` method (including one with a receiver-sensitive parameter
 * initializer) in the same literal as a `super` method must not use the static
 * `__anon_*_method` stub (it has no current-this install).
 */
function shorthandMethodNeedsReceiver(ctx: CodegenContext, declaration: ts.MethodDeclaration): boolean {
  if (!declaration.body || !ts.isObjectLiteralExpression(declaration.parent)) return false;
  return (
    methodBodyReferencesSuper(declaration.body) ||
    (ctx.dynamicProtoLiteralNodes.has(declaration.parent) && functionLikeReferencesOwnThis(declaration))
  );
}

/** True when an object-literal shorthand call needs the call-time receiver. */
export function objectLiteralMethodNeedsCallReceiver(ctx: CodegenContext, expr: ts.CallExpression): boolean {
  const callee = expr.expression;
  if (!ts.isPropertyAccessExpression(callee)) return false;
  const declarations = ctx.oracle.declarationsOf(callee.name);
  return (
    declarations.length > 0 &&
    declarations.every(
      (declaration) => ts.isMethodDeclaration(declaration) && shorthandMethodNeedsReceiver(ctx, declaration),
    )
  );
}

/**
 * Class fields can install a separately declared ordinary function as their
 * callable value (`match = match`). Such a value still receives the owning
 * instance when called as `router.match()`. Resolve that immutable declaration
 * so the same receiver install used for object-literal function properties can
 * preserve the method-call Reference semantics.
 */
function isThisReadingFunctionDeclarationReference(
  ctx: CodegenContext,
  initializer: ts.Expression,
  generator = false,
): boolean {
  if (!ts.isIdentifier(initializer)) return false;
  let declaration = ctx.oracle.valueDeclarationOf(initializer);
  if (declaration && (ts.isImportClause(declaration) || ts.isImportSpecifier(declaration))) {
    declaration = ctx.importBindingTargets?.get(declaration);
  }
  if (!declaration || !ts.isFunctionDeclaration(declaration) || declaration.body === undefined) return false;
  if ((declaration.asteriskToken !== undefined) !== generator) return false;
  if (declaration.modifiers?.some((m) => m.kind === ts.SyntaxKind.AsyncKeyword) === true) return false;
  const first = declaration.parameters[0];
  if (first && ts.isIdentifier(first.name) && first.name.text === "this") return false;
  return functionLikeReferencesOwnThis(declaration);
}

/**
 * Does the member named by `nameNode` resolve — in every one of its
 * declarations — to either an object-literal property holding a `this`-reading
 * function expression or a class field holding a reference to a `this`-reading
 * function declaration? See the module header for why each clause is a refusal.
 */
export function objectLiteralMethodNeedsReceiver(ctx: CodegenContext, nameNode: ts.Node): boolean {
  const decls = ctx.oracle.declarationsOf(nameNode);
  if (decls.length === 0) return false;
  for (const d of decls) {
    if (ts.isPropertyAssignment(d)) {
      if (
        !isThisReadingFunctionExpression(d.initializer) &&
        !isThisReadingFunctionDeclarationReference(ctx, d.initializer, /* generator */ true)
      ) {
        return false;
      }
      continue;
    }
    // A shorthand method carrying `super`, or own `this` in an open dynamic-
    // prototype literal, needs the same call-time receiver install as a
    // this-reading function expression. Ordinary closed-literal shorthand
    // methods retain their established static path and remain byte-identical.
    if (ts.isMethodDeclaration(d) && shorthandMethodNeedsReceiver(ctx, d)) continue;
    if (ts.isPropertyDeclaration(d) && d.initializer) {
      if (!isThisReadingFunctionDeclarationReference(ctx, d.initializer)) return false;
      continue;
    }
    return false;
  }
  return true;
}

/**
 * Reserve the global + locals for one install/restore pair, or `undefined` to
 * leave the existing lowering byte-identical.
 *
 * Locals are allocated ONLY on admission: an unused local still occupies a slot
 * in the function's locals vector, so allocating speculatively would break the
 * byte-identity that makes this change safe to reason about.
 */
export function planObjectLiteralMethodReceiverBind(
  ctx: CodegenContext,
  fctx: FunctionContext,
  nameNode: ts.Node,
): ObjectLiteralMethodReceiverBind | undefined {
  if (!objectLiteralMethodNeedsReceiver(ctx, nameNode)) return undefined;
  // Registers the global if some earlier phase has not; its INDEX is read again
  // at each emit point (see the interface doc).
  ensureCurrentThisGlobal(ctx);
  const seq = fctx.locals.length;
  return {
    recvLocal: allocLocal(fctx, `__objm_recv_${seq}`, { kind: "externref" }),
    prevLocal: allocLocal(fctx, `__objm_prev_${seq}`, { kind: "externref" }),
  };
}

/**
 * Element-access twin: `obj["m"]()`, where the key is a literal the checker can
 * still resolve to the same property symbol.
 *
 * This form differs from `obj.m()` in one way that matters: the element-access
 * lowering compiles receiver AND key as one unit, so the receiver cannot be
 * captured off that evaluation and has to be compiled a SECOND time. The gate is
 * therefore additionally restricted to a **plain identifier receiver**, whose
 * re-read is free of observable effects — the same admission #4096 used for the
 * same reason. `obj.f().m()`, `a[i].m()` and every other computed receiver are
 * refused rather than evaluated twice.
 *
 * A runtime (non-literal) key resolves to no symbol and is refused here; that
 * shape does not even reach this function today — it falls to the tail
 * dispatch's drop-everything arm, which is #4252's territory, not this one.
 */
export function planElementAccessMethodReceiverBind(
  ctx: CodegenContext,
  fctx: FunctionContext,
  elemAccess: ts.ElementAccessExpression,
): ObjectLiteralMethodReceiverBind | undefined {
  if (!ts.isIdentifier(elemAccess.expression)) return undefined;
  return planObjectLiteralMethodReceiverBind(ctx, fctx, elemAccess.argumentExpression);
}

/**
 * Runtime-key twin: `obj[k]()`, where `k` is a variable so no property symbol
 * exists to interrogate.
 *
 * Until #4252 landed this shape did not invoke the callee at all; now it routes
 * through `tryEmitInlineDynamicCall`, which runs the callee with no receiver —
 * the same missing writer, one layer down. The gate therefore has to be asked of
 * the RECEIVER's object literal instead of the member:
 *
 *  - the receiver is a plain identifier bound to an **object literal**, so the
 *    extra read needed to capture it is free and the literal's properties are
 *    visible;
 *  - **no property of that literal is arrow-valued.** With a runtime key any
 *    property could be the callee, so one arrow anywhere in the literal is
 *    enough to refuse the whole thing;
 *  - at least one property IS a `this`-reading function expression — otherwise
 *    there is nothing to fix and
 *    the module must stay byte-identical;
 *  - **neither the KEY nor any ARGUMENT references `this`.** This is the
 *    ordering gate, and unlike the static arms it cannot be satisfied by moving
 *    the install: the dynamic dispatch evaluates the whole callee AND its own
 *    arguments, so the install must precede both. `obj[this.k]()` /
 *    `obj[k](this.y)` would then read the receiver where the caller's `this` is
 *    meant — trading one wrong answer for another. Refuse instead.
 */
export function planDynamicElementReceiverBind(
  ctx: CodegenContext,
  fctx: FunctionContext,
  elemAccess: ts.ElementAccessExpression,
  args: readonly ts.Expression[],
): ObjectLiteralMethodReceiverBind | undefined {
  const receiver = elemAccess.expression;
  if (!ts.isIdentifier(receiver)) return undefined;
  if (bodyReferencesOwnThis(elemAccess.argumentExpression)) return undefined;
  for (const a of args) if (bodyReferencesOwnThis(a)) return undefined;
  const declaration = ctx.oracle.valueDeclarationOf(receiver);
  if (!declaration || !ts.isVariableDeclaration(declaration)) return undefined;
  const literal = declaration.initializer;
  if (!literal || !ts.isObjectLiteralExpression(literal)) return undefined;
  let demanded = false;
  for (const p of literal.properties) {
    if (!ts.isPropertyAssignment(p)) continue;
    if (ts.isArrowFunction(p.initializer)) return undefined;
    if (isThisReadingFunctionExpression(p.initializer)) {
      demanded = true;
    }
  }
  if (!demanded) return undefined;
  ensureCurrentThisGlobal(ctx);
  const seq = fctx.locals.length;
  return {
    recvLocal: allocLocal(fctx, `__objm_recv_${seq}`, { kind: "externref" }),
    prevLocal: allocLocal(fctx, `__objm_prev_${seq}`, { kind: "externref" }),
  };
}

/**
 * Compile `receiver` once purely to capture it into the reserved local, then
 * drop the value. For call shapes whose own lowering fuses receiver and key (or
 * owns the whole callee), this is the only way to get the receiver — which is
 * why those plans admit an identifier receiver only.
 *
 * Returns `false` (nothing installable) for a non-reference receiver.
 */
export function emitStandaloneReceiverCapture(
  fctx: FunctionContext,
  receiverType: ValType | null | symbol,
  bind: ObjectLiteralMethodReceiverBind,
): boolean {
  const type = innerResultValType(receiverType);
  if (type === undefined) return false;
  const ok = captureObjectLiteralMethodReceiver(fctx, type, bind);
  fctx.body.push({ op: "drop" });
  return ok;
}

/**
 * Copy the receiver — already on the stack, and left there — into the reserved
 * externref local. Called at the single site where the receiver is compiled, so
 * the receiver expression runs exactly once.
 *
 * Returns `false` for a non-reference receiver, which the admission gate makes
 * unreachable (a member symbol declared by an object literal implies an object
 * receiver). The caller must then skip the install rather than convert: boxing a
 * primitive here would need an import, and a late import shifts function indices
 * mid-body (the #2174 hazard).
 */
export function captureObjectLiteralMethodReceiver(
  fctx: FunctionContext,
  receiverType: ValType,
  bind: ObjectLiteralMethodReceiverBind,
): boolean {
  if (receiverType.kind === "externref" || receiverType.kind === "ref_extern") {
    fctx.body.push({ op: "local.tee", index: bind.recvLocal });
    return true;
  }
  if (
    receiverType.kind === "ref" ||
    receiverType.kind === "ref_null" ||
    receiverType.kind === "anyref" ||
    receiverType.kind === "eqref"
  ) {
    const tmp = allocLocal(fctx, `__objm_raw_${fctx.locals.length}`, receiverType);
    fctx.body.push(
      { op: "local.tee", index: tmp },
      { op: "local.get", index: tmp },
      { op: "extern.convert_any" },
      { op: "local.set", index: bind.recvLocal },
    );
    return true;
  }
  return false;
}

/**
 * Save the live `__current_this` and install the captured receiver. Stack-
 * neutral, so it can be emitted with the call's operands already pushed — which
 * is required: this must run AFTER the arguments (module header).
 */
export function emitObjectLiteralMethodThisInstall(
  ctx: CodegenContext,
  fctx: FunctionContext,
  bind: ObjectLiteralMethodReceiverBind,
): void {
  const globalIdx = ctx.currentThisGlobalIdx;
  fctx.body.push(
    { op: "global.get", index: globalIdx },
    { op: "local.set", index: bind.prevLocal },
    { op: "local.get", index: bind.recvLocal },
    { op: "global.set", index: globalIdx },
  );
}

/**
 * Emit ONLY the restore half, with no result on the stack. Used when a
 * downstream dispatch declined AFTER the install was emitted: leaving the
 * install standing would leak the receiver into the rest of the frame as
 * `this`, which is a worse defect than the one being fixed.
 */
export function emitObjectLiteralMethodThisRestore(
  ctx: CodegenContext,
  fctx: FunctionContext,
  bind: ObjectLiteralMethodReceiverBind,
): void {
  fctx.body.push({ op: "local.get", index: bind.prevLocal }, { op: "global.set", index: ctx.currentThisGlobalIdx });
}

/**
 * Restore the saved receiver after the call and hand `result` straight back, so
 * a call site reads `return finishObjectLiteralMethodCall(ctx, fctx, bind, …)`.
 * A `null`/`VOID_RESULT` result left nothing on the stack; anything else is
 * parked in a typed local across the restore.
 *
 * `bind === undefined` (not admitted) is a pass-through — that is what keeps
 * every unadmitted shape byte-identical.
 */
export function finishObjectLiteralMethodCall<T extends ValType | null | symbol>(
  ctx: CodegenContext,
  fctx: FunctionContext,
  bind: ObjectLiteralMethodReceiverBind | undefined,
  result: T,
): T {
  if (!bind) return result;
  const restore: Instr[] = [
    { op: "local.get", index: bind.prevLocal },
    { op: "global.set", index: ctx.currentThisGlobalIdx },
  ];
  const type = innerResultValType(result);
  if (type === undefined) {
    fctx.body.push(...restore);
    return result;
  }
  const resultLocal = allocLocal(fctx, `__objm_res_${fctx.locals.length}`, type);
  fctx.body.push({ op: "local.set", index: resultLocal }, ...restore, { op: "local.get", index: resultLocal });
  return result;
}
