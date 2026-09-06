// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * #3371 r4 — runtime `GetPrototypeFromConstructor(NewTarget, …)` for
 * `Reflect.construct(target, args, NewTarget)` in `--target standalone`.
 *
 * ## What changed
 * The namespace-static `Reflect.construct` arm used to select the instance
 * prototype by SCANNING THE SOURCE for a prior `NewTarget.prototype = …`
 * assignment (`assignedNewTargetPrototype`). When that scan found nothing it
 * emitted a hard compile error — the "#3371 refusal" that made 23 ES2015 rows
 * `compile_error`. A source scan can never model the real operation, which is
 * `? Get(NewTarget, "prototype")` (ES §10.1.14 step 2): an ordinary property
 * read that can run a getter, throw, or mutate the world.
 *
 * This module supplies that real read. It is used ONLY on the branch that used
 * to `reportError`, so no program that compiled before reaches any of it — the
 * static-assignment path and the non-distinct path are untouched.
 *
 * ## Ordering
 * NewTarget is evaluated exactly once, BEFORE the argument list, into an
 * externref local; `Get(NT, "prototype")` runs AFTER the ordinary construction
 * completes. That order is what the ES2015 rows in this cluster pin:
 *
 *   - `DataView/byteOffset-validated-against-initial-buffer-length.js` — the
 *     RangeError from offset validation must win over the prototype getter, so
 *     the getter must NOT run before construction.
 *   - `TypedArrayConstructors/…/throw-type-error-before-custom-proto-access.js`
 *     — same shape: `ToIndex(Symbol())` must throw first.
 *   - the six `custom-proto-access-throws.js` rows — the getter throws, and the
 *     throw propagates out of `Reflect.construct` whichever side of the
 *     allocation it runs on.
 *
 * The rows that require the read to happen strictly BEFORE allocation
 * (`ArrayBuffer/data-allocation-after-object-creation.js`) are NOT served by
 * this shape and stay refused; see the issue file's residual list.
 *
 * ## Applying the result
 * `applyRuntimeNewTargetPrototype` writes the fetched prototype onto whichever
 * carrier the construction produced: the DataView window struct, the dynamic
 * typed-array view struct, or — for anything else — the ordinary
 * `__object_setPrototypeOf` path. Before this the "no carrier arm matched" case
 * was itself a compile error.
 *
 * ## What this path REFUSES, and why (2026-09-05 review round 1)
 * The read and the write are only sound for some target/NewTarget shapes, and
 * every shape outside that set is handed back to the pre-existing #3371
 * refusal rather than answered wrongly. `classifyRuntimeNewTargetSite` is the
 * one gate; each clause below is a MEASURED wrong answer on the r4 tree
 * (`--target standalone`, node 22 as the oracle):
 *
 *   - **NewTarget denotes a class.** A class value's prototype object is not
 *     reified in standalone at all: `C.prototype` compiles to `null` even with
 *     a literal key (measured on BASE too, so it is not this arm's doing), and
 *     `__reflect_is_constructor` has no class arm, so a class reaching the
 *     runtime classifier throws "newTarget is not a constructor". Refused.
 *   - **The target reads `new.target`.** `new.target` is an i32 class-id module
 *     global keyed by class NAME (#2023); the constructed frame cannot carry a
 *     NewTarget VALUE, so the body reads `undefined` and a standard
 *     `if (new.target === undefined) throw` guard fires where node constructs.
 *     Refused. A read inside a NESTED function counts too whenever that
 *     function can itself be constructed — `readsNewTarget` explains why.
 *   - **A dynamic (reassigned) in-file function target that can hold anything
 *     but an ordinary function.** Review round 1 found this admitted on the
 *     kind of the binding's INITIALIZER alone, so `T = A` (async),
 *     `T = () => {}`, `T = function*(){}`, `T = C`, `T = G.bind(null)`,
 *     `T = undefined` and an alias chain all compiled and answered wrongly.
 *     `dynamicTargetIsAllOrdinaryFunctions` enumerates the value set instead,
 *     and also refuses a binding carrying an explicit type annotation.
 *   - **A NewTarget expression that is not a bare identifier.** The fallback
 *     route hands target+arguments to `compileNewExpression`, which evaluates
 *     AND constructs in one step, and §26.1.2 requires the IsConstructor check
 *     on NewTarget to precede construction — so there is no seam to evaluate
 *     the NewTarget expression between the argument list and the allocation.
 *     Restricting NewTarget to an identifier makes its evaluation
 *     side-effect-free, which is what makes reading it before the arguments
 *     unobservable. Anything else is refused rather than reordered.
 *   - **A target whose instance has no settable prototype.** The nominal
 *     carriers have no `$proto` field, so `__object_setPrototypeOf` is a silent
 *     no-op on them: `Reflect.construct(Array, [3], NT)` answered
 *     `Array.prototype` where node answers `NT.prototype`. A user class, an
 *     in-file function the driver route declined, and the named builtin list
 *     below all refuse for this reason. Deliberately NOT refused are the
 *     carriers whose `Object.getPrototypeOf` is independently broken on base
 *     (Promise, class instances, typed-array views — see the list's comment):
 *     those programs read a wrong prototype with or without this arm, and
 *     refusing them would drop passing rows for no correctness gain.
 *   - **The driver route with a NewTarget whose `prototype` is not a plain
 *     `$Object`.** `__native_construct_N` stores the supplied prototype only
 *     when it passes `ref.test $Object`; a prototype that is an object-literal
 *     carrier (e.g. installed by `Object.defineProperty(NT, "prototype", …)`)
 *     is silently dropped and the instance gets `%Object.prototype%`. The
 *     route is therefore limited to a NewTarget binding whose `prototype` is
 *     provably untouched.
 */
import { ts, forEachChild } from "../../ts-api.js";
import type { Instr, ValType } from "../../ir/types.js";
import type { CodegenContext, FunctionContext } from "../context/types.js";
import { allocLocal } from "../context/locals.js";
import { stringConstantExternrefInstrs } from "../native-strings.js";
import { ensureObjectRuntime } from "../object-runtime.js";
import { MAX_NATIVE_CONSTRUCT_ARITY, reserveNativeConstructDriver } from "../native-construct.js";
import { coerceType, compileExpression } from "../shared.js";
import { ensureLateImport, flushLateImportShifts } from "./late-imports.js";

const EXTERNREF: ValType = { kind: "externref" };

/**
 * Register the helpers the runtime NewTarget path calls, before any argument
 * or constructor code is emitted. Late-import registration shifts defined
 * function indices, so it has to happen while the surrounding body is still
 * empty of baked call indices for this site.
 */
export function prepareRuntimeNewTargetProto(ctx: CodegenContext, fctx: FunctionContext): void {
  ensureObjectRuntime(ctx);
  ensureLateImport(ctx, "__extern_get", [EXTERNREF, EXTERNREF], [EXTERNREF]);
  // The generic [[SetPrototypeOf]] is built at finalize, so it is absent from
  // `funcMap` while this expression compiles unless it is registered here —
  // and a silently-missing writer is exactly how the first cut of this arm
  // left `Object.getPrototypeOf(result)` at null while every row still
  // "compiled".
  ensureLateImport(ctx, "__object_setPrototypeOf", [EXTERNREF, EXTERNREF], [EXTERNREF]);
  // §10.1.14 step 3 — "if Type(proto) is not Object, use the intrinsic
  // default" needs a runtime Type(V) probe. Same pair (and same separate null
  // test) `construct-return-value.ts` uses: `__typeof_object(null)` answers 1
  // by design, and a returned FUNCTION is an Object.
  ensureLateImport(ctx, "__typeof_object", [EXTERNREF], [{ kind: "i32" }]);
  ensureLateImport(ctx, "__typeof_function", [EXTERNREF], [{ kind: "i32" }]);
  flushLateImportShifts(ctx, fctx);
}

/**
 * Push `? Get(newTarget, "prototype")` as an externref. `ntLocal` holds the
 * once-evaluated NewTarget value.
 */
export function emitRuntimeNewTargetPrototype(ctx: CodegenContext, fctx: FunctionContext, ntLocal: number): boolean {
  const getIdx = ctx.funcMap.get("__extern_get");
  if (getIdx === undefined) return false;
  fctx.body.push({ op: "local.get", index: ntLocal });
  const key = stringConstantExternrefInstrs(ctx, "prototype");
  for (let i = 0; i < key.length; i++) fctx.body.push(key[i]!);
  fctx.body.push({ op: "call", funcIdx: getIdx });
  return true;
}

/**
 * Write `proto` onto the constructed value.
 *
 * `carrierArms` are the nominal struct writes the caller already knows how to
 * do (DataView window, dynamic typed-array view); each is paired with the
 * `ref.test` type index that selects it. Anything else — an ordinary `$Object`,
 * a class instance, a wrapper — goes through `__object_setPrototypeOf`, which
 * is the same [[SetPrototypeOf]] the object model uses everywhere else.
 *
 * §10.1.14 step 3 gates the WHOLE write on `Type(proto) is Object`: a NewTarget
 * whose `prototype` is absent (`function(){}.bind(null)` has none) reads back
 * as null/undefined, and the spec answer is then the intrinsic default — which
 * is exactly the prototype the ordinary construction already installed, so
 * skipping the write IS the fix. Without this guard the raw non-object landed
 * in the carrier field and `Object.getPrototypeOf` answered `undefined`
 * (DataView) where node answers the intrinsic prototype; on `--target wasi`
 * that case trapped.
 *
 * ## Correction (r2 step 6, measured): the guard repaired DataView only.
 * The comment used to claim the typed-array carrier as well. Measured on the
 * CURRENT tree, `--target standalone`, oracle node 22 — a bound NewTarget with
 * no own `prototype`:
 *
 *   - `.tmp/p/f1_dv_bind_noproto.js` (DataView): node 3, base 3, here 3 —
 *     repaired, and the guard is what keeps it repaired.
 *   - `.tmp/p/f2_ta_bind_noproto.js` (Uint8Array): node 3, base 1, here 1 —
 *     UNCHANGED. `Object.getPrototypeOf` on a dynamically-typed typed-array
 *     view answers null on base with no `Reflect.construct` in the program at
 *     all, so the guard cannot repair what that reader reports. It stays a
 *     residual of the typed-array carrier, not of this arm.
 */
export function applyRuntimeNewTargetPrototype(
  ctx: CodegenContext,
  fctx: FunctionContext,
  resultAny: number,
  resultExtern: number,
  protoLocal: number,
  carriers: readonly { typeIdx: number; fieldIdx: number }[],
): boolean {
  const handled = allocLocal(fctx, `__reflect_construct_nt_done_${fctx.locals.length}`, { kind: "i32" });
  const apply: Instr[] = [
    { op: "i32.const", value: 0 },
    { op: "local.set", index: handled },
  ];
  for (let i = 0; i < carriers.length; i++) {
    const carrier = carriers[i]!;
    const then: Instr[] = [
      { op: "local.get", index: resultAny },
      { op: "ref.cast", typeIdx: carrier.typeIdx },
      { op: "local.get", index: protoLocal },
      { op: "struct.set", typeIdx: carrier.typeIdx, fieldIdx: carrier.fieldIdx },
      { op: "i32.const", value: 1 },
      { op: "local.set", index: handled },
    ];
    apply.push({ op: "local.get", index: resultAny });
    apply.push({ op: "ref.test", typeIdx: carrier.typeIdx });
    apply.push({ op: "if", blockType: { kind: "empty" }, then });
  }
  const setProtoIdx = ctx.funcMap.get("__object_setPrototypeOf");
  if (setProtoIdx !== undefined) {
    const generic: Instr[] = [
      { op: "local.get", index: resultExtern },
      { op: "local.get", index: protoLocal },
      { op: "call", funcIdx: setProtoIdx },
      { op: "drop" },
    ];
    apply.push({ op: "local.get", index: handled });
    apply.push({ op: "i32.eqz" });
    apply.push({ op: "if", blockType: { kind: "empty" }, then: generic });
  }
  const guard = protoIsObjectInstrs(ctx, protoLocal);
  // No Type(V) predicates ⇒ the §10.1.14 step-3 gate cannot be emitted, and an
  // ungated write is the defect this guard exists to remove. Decline; the
  // caller restores the refusal.
  if (guard === undefined) return false;
  fctx.body.push(...guard);
  fctx.body.push({ op: "if", blockType: { kind: "empty" }, then: apply });
  return true;
}

/**
 * `Type(protoLocal) is Object` as an i32, or undefined when the module has no
 * `typeof` predicates (a caller that cannot classify must not write).
 */
function protoIsObjectInstrs(ctx: CodegenContext, protoLocal: number): Instr[] | undefined {
  const typeofObjectIdx = ctx.funcMap.get("__typeof_object");
  const typeofFunctionIdx = ctx.funcMap.get("__typeof_function");
  if (typeofObjectIdx === undefined || typeofFunctionIdx === undefined) return undefined;
  return [
    { op: "local.get", index: protoLocal },
    { op: "ref.is_null" },
    {
      op: "if",
      blockType: { kind: "val", type: { kind: "i32" } },
      // `null` is not an Object; `__typeof_object(null)` answers 1 (JS
      // `typeof null === "object"`), so the null test has to come first.
      then: [{ op: "i32.const", value: 0 }],
      else: [
        { op: "local.get", index: protoLocal },
        { op: "call", funcIdx: typeofObjectIdx },
        { op: "local.get", index: protoLocal },
        { op: "call", funcIdx: typeofFunctionIdx },
        { op: "i32.or" },
      ],
    },
  ];
}

/**
 * Is `value` an ORDINARY user function (not a class, not a native builtin, not
 * a generator/async) whose binding is never reassigned in this source file?
 *
 * The reassignment scan is the load-bearing half. Resolving the identifier to
 * its `valueDeclaration` alone answers by DECLARATION SHAPE, which a later
 * `fn = somethingElse`, a parameter shadow, or a `with`/`eval` write can
 * falsify at runtime — the exact "resolved by name, not by single-assignment
 * proof" family every review of this cluster has caught. Decline unless the
 * proof holds.
 */
export function isUnreassignedOrdinaryFunction(ctx: CodegenContext, value: ts.Expression): boolean {
  if (ts.isFunctionExpression(value)) return isPlainFunctionLike(value);
  if (!ts.isIdentifier(value)) return false;
  const declarations = ctx.oracle.declarationsOf(value);
  if (declarations.length !== 1) return false;
  const declaration = declarations[0]!;
  if (!ts.isFunctionDeclaration(declaration) || !isPlainFunctionLike(declaration)) return false;
  return !isRebound(value.getSourceFile(), value.text);
}

function isPlainFunctionLike(node: ts.FunctionDeclaration | ts.FunctionExpression): boolean {
  return (
    node.asteriskToken === undefined &&
    !(node.modifiers?.some((m: ts.ModifierLike) => m.kind === ts.SyntaxKind.AsyncKeyword) ?? false)
  );
}

/**
 * Can `target` — a REASSIGNED binding, which `isUnreassignedOrdinaryFunction`
 * by definition rejects — only ever hold an ordinary function?
 *
 * The r4 cut admitted such a binding on the KIND OF ITS INITIALIZER alone
 * (`let T = F` ⇒ "function") and never looked at the later writes, so every
 * `T = <something else>` compiled and answered WRONGLY where base refused
 * (review round 1, all measured `--target standalone` vs node 22):
 * `T = A` async and `T = A2` through a `const A2 = A` alias returned an object
 * at 5 where node throws TypeError 0 (`c2`, `o1`); likewise `T = () => {}`
 * (`c3`), `T = function*(){}` (`c4`) and `T = undefined` (`o3`). `T = C` for a
 * class read prototype+field 13 vs node 3 (`i5`), and `T = G.bind(null)`
 * answered NaN vs node 2 (`o2`).
 *
 * So the value set is enumerated instead: the declaration's initializer plus
 * the right-hand side of every plain `T = …` in the file. Every member must be
 * an unreassigned ordinary function declaration — no alias hop, no call
 * result, no class, no arrow, no async/generator — and any write whose value
 * set is not enumerable (`+=`, `++`, a destructuring target, a `for…of`
 * binding, `with`, direct `eval`) refuses outright.
 *
 * An explicit type ANNOTATION on the binding also refuses. `let T: any = F;
 * T = G` is not the same program as `let T = F; T = G` for the compiled
 * callee lowering: it read a wrong prototype (`b1` 4 vs node 2) and trapped on
 * the following field read (`i3`). Consulting the declared type is legitimate
 * here because the only thing it can do is turn an answer into a refusal.
 */
function dynamicTargetIsAllOrdinaryFunctions(ctx: CodegenContext, target: ts.Expression): boolean {
  if (!ts.isIdentifier(target)) return false;
  const name = target.text;
  const source = target.getSourceFile();
  const declarations = ctx.oracle.declarationsOf(target).filter((d) => d.getSourceFile() === source);
  if (declarations.length !== 1) return false;
  const declaration = declarations[0]!;
  const values: ts.Expression[] = [];
  if (ts.isFunctionDeclaration(declaration)) {
    if (!isPlainFunctionLike(declaration)) return false;
  } else if (ts.isVariableDeclaration(declaration)) {
    // `let T: any = F` steers a different callee lowering than `let T = F`.
    if (declaration.type !== undefined) return false;
    if (declaration.initializer === undefined) return false;
    values.push(declaration.initializer);
  } else {
    return false;
  }

  let enumerable = true;
  const visit = (node: ts.Node): void => {
    if (!enumerable) return;
    if (
      ts.isWithStatement(node) ||
      (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === "eval") ||
      ((ts.isPrefixUnaryExpression(node) || ts.isPostfixUnaryExpression(node)) &&
        ts.isIdentifier(node.operand) &&
        node.operand.text === name) ||
      ((ts.isForInStatement(node) || ts.isForOfStatement(node)) && mentions(node.initializer, name))
    ) {
      enumerable = false;
      return;
    }
    if (
      ts.isBinaryExpression(node) &&
      node.operatorToken.kind >= ts.SyntaxKind.FirstAssignment &&
      node.operatorToken.kind <= ts.SyntaxKind.LastAssignment &&
      mentions(node.left, name)
    ) {
      // Only a plain `T = <expr>` contributes a value that can be read off the
      // source; a compound assignment or a destructuring target does not.
      if (node.operatorToken.kind !== ts.SyntaxKind.EqualsToken || !isNamed(node.left, name)) {
        enumerable = false;
        return;
      }
      values.push(node.right);
    }
    forEachChild(node, visit);
  };
  visit(source);
  if (!enumerable || values.length === 0) return false;
  return values.every((value) => isUnreassignedOrdinaryFunction(ctx, value));
}

/**
 * Any construct that could make `name` denote something other than the single
 * function declaration: an assignment, a `++`/`--`, a second binding (var /
 * let / const / parameter / catch / import / class), a destructuring target, or
 * a `with`/direct-`eval` that can write an unseen binding.
 */
function mentions(node: ts.Node, name: string): boolean {
  if (ts.isIdentifier(node)) return node.text === name;
  let found = false;
  forEachChild(node, (child) => {
    if (!found && mentions(child, name)) found = true;
  });
  return found;
}

function isRebound(source: ts.SourceFile, name: string): boolean {
  let rebound = false;
  const visit = (node: ts.Node): void => {
    if (rebound) return;
    if (ts.isBinaryExpression(node)) {
      const op = node.operatorToken.kind;
      // A destructuring target (`[fn] = …`, `({ fn } = …)`) is an assignment
      // whose left is not a bare identifier, so match the whole left subtree.
      if (op >= ts.SyntaxKind.FirstAssignment && op <= ts.SyntaxKind.LastAssignment && mentions(node.left, name)) {
        rebound = true;
      }
    } else if ((ts.isForInStatement(node) || ts.isForOfStatement(node)) && mentions(node.initializer, name)) {
      rebound = true;
    } else if (
      (ts.isPrefixUnaryExpression(node) || ts.isPostfixUnaryExpression(node)) &&
      ts.isIdentifier(node.operand) &&
      node.operand.text === name &&
      (node.operator === ts.SyntaxKind.PlusPlusToken || node.operator === ts.SyntaxKind.MinusMinusToken)
    ) {
      rebound = true;
    } else if (
      (ts.isVariableDeclaration(node) ||
        ts.isParameter(node) ||
        ts.isBindingElement(node) ||
        ts.isClassDeclaration(node) ||
        ts.isImportSpecifier(node) ||
        ts.isImportClause(node)) &&
      node.name !== undefined &&
      ts.isIdentifier(node.name) &&
      node.name.text === name
    ) {
      rebound = true;
    } else if (ts.isCatchClause(node) && node.variableDeclaration !== undefined) {
      const bound = node.variableDeclaration.name;
      if (ts.isIdentifier(bound) && bound.text === name) rebound = true;
    } else if (ts.isWithStatement(node)) {
      rebound = true;
    } else if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === "eval") {
      rebound = true;
    }
    if (!rebound) forEachChild(node, visit);
  };
  visit(source);
  return rebound;
}

/**
 * `Construct(target, args, NewTarget)` for an ordinary function target, with
 * the instance prototype taken from `? Get(NewTarget, "prototype")`.
 *
 * This is the only shape that can honour an arbitrary NewTarget for a user
 * function: the ordinary `new fn()` lowering builds a CLOSED struct with no
 * `$proto` field, so no later write can give the instance a different
 * prototype — which is why `Object.getPrototypeOf(result)` read back as null
 * when the post-construction [[SetPrototypeOf]] was tried on it. The driver
 * instead does `__object_create(proto)` first and runs the body against that
 * open `$Object`, so the constructor's own `Object.getPrototypeOf(this)` sees
 * the NewTarget prototype too.
 *
 * Returns false (emitting nothing) when the site does not qualify; the caller
 * then falls back to the ordinary construct-then-patch shape.
 */
export function tryEmitOrdinaryConstructWithNewTarget(
  ctx: CodegenContext,
  fctx: FunctionContext,
  target: ts.Expression,
  args: readonly ts.Expression[],
  ntLocal: number,
): boolean {
  if (!ctx.standalone) return false;
  if (args.length > MAX_NATIVE_CONSTRUCT_ARITY) return false;
  if (args.some((a) => ts.isSpreadElement(a))) return false;
  if (!isUnreassignedOrdinaryFunction(ctx, target)) return false;
  // Decline BEFORE emitting anything: a bail-out after the callee/argument
  // evaluation is already in the body would leave the fallback path to
  // evaluate them a second time.
  if (ctx.funcMap.get("__extern_get") === undefined) return false;
  ensureObjectRuntime(ctx);
  const driverIdx = reserveNativeConstructDriver(ctx, args.length, stringConstantExternrefInstrs(ctx, "prototype"));

  // Source order: callee, then every argument, then `Get(NT, "prototype")` —
  // the prototype read is the first step of [[Construct]], so it runs after the
  // whole argument list and before the body.
  const calleeTy = compileExpression(ctx, fctx, target, EXTERNREF);
  if (calleeTy && calleeTy.kind !== "externref") coerceType(ctx, fctx, calleeTy, EXTERNREF);
  else if (calleeTy === null) fctx.body.push({ op: "ref.null.extern" });
  const calleeLocal = allocLocal(fctx, `__rc_callee_${fctx.locals.length}`, EXTERNREF);
  fctx.body.push({ op: "local.set", index: calleeLocal });

  const argLocals: number[] = [];
  for (let i = 0; i < args.length; i++) {
    const argTy = compileExpression(ctx, fctx, args[i]!, EXTERNREF);
    if (argTy && argTy.kind !== "externref") coerceType(ctx, fctx, argTy, EXTERNREF);
    else if (argTy === null) fctx.body.push({ op: "ref.null.extern" });
    const argLocal = allocLocal(fctx, `__rc_arg${i}_${fctx.locals.length}`, EXTERNREF);
    fctx.body.push({ op: "local.set", index: argLocal });
    argLocals.push(argLocal);
  }

  if (!emitRuntimeNewTargetPrototype(ctx, fctx, ntLocal)) return false;
  const protoLocal = allocLocal(fctx, `__rc_proto_${fctx.locals.length}`, EXTERNREF);
  fctx.body.push({ op: "local.set", index: protoLocal });

  fctx.body.push({ op: "local.get", index: calleeLocal });
  fctx.body.push({ op: "local.get", index: protoLocal });
  for (let i = 0; i < argLocals.length; i++) fctx.body.push({ op: "local.get", index: argLocals[i]! });
  fctx.body.push({ op: "call", funcIdx: ctx.funcMap.get(`__native_construct_${args.length}`) ?? driverIdx });
  return true;
}

/**
 * Builtin constructors whose instance carrier has NO settable prototype link,
 * while `Object.getPrototypeOf` on it answers correctly — so a prototype the
 * runtime path fetches is silently discarded and the caller reads the intrinsic
 * default instead of the NewTarget one. `Reflect.construct(Array, [3], NT)`
 * answered `Array.prototype` where node answers `NT.prototype` (measured
 * 2026-09-05, `--target standalone`); these targets keep the refusal.
 *
 * The carriers whose *reader* is independently broken are deliberately NOT
 * here: on base, `Object.getPrototypeOf` already answers `null` for a
 * dynamically-typed Promise, class instance and typed-array view, so the
 * prototype those programs observe is wrong with or without this arm — a
 * pre-existing carrier gap, not a refusal turned into a wrong answer. They are
 * listed as residuals in the issue file.
 *
 * Re-measured 2026-09-05 (r2 step 2), all nine named entries, with the set
 * emptied, `--target standalone`, oracle node 22 — `getPrototypeOf` identity
 * AND one method read through the patched chain:
 *
 *   | target  | node | admitted | verdict                                     |
 *   | ------- | ---- | -------- | ------------------------------------------- |
 *   | Array   | 1    | 0        | proto not recorded — keep                    |
 *   | Map     | 1    | 0        | proto not recorded — keep                    |
 *   | RegExp  | 1    | 0        | proto not recorded — keep                    |
 *   | Set     | 1    | 0        | proto not recorded — keep                    |
 *   | Function| 1    | LEAK     | pulls a `js2wasm:runtime-eval` import — keep |
 *   | Boolean | 5    | 7        | proto recorded, dispatch nominal — keep      |
 *   | Number  | 5    | 7        | proto recorded, dispatch nominal — keep      |
 *   | String  | 5    | 3        | proto recorded, dispatch nominal — keep      |
 *   | Symbol  | 1    | 1        | never constructs; TypeError = node — DROPPED |
 *
 * Boolean/Number/String are the correction to the r2 plan's premise: a probe
 * that only compares `Object.getPrototypeOf(o)` says they take the patch, and
 * they do — but a probe that also calls `o.valueOf()` through the patched
 * chain shows the wrapper carrier still dispatches NOMINALLY, so the program
 * answers 7/7/3 where node answers 5/5/5. That is a compile error turned into
 * a wrong answer, which this arm may not do. The nominal dispatch is itself
 * pre-existing (on BASE, with no `Reflect.construct` in the program at all,
 * `Object.setPrototypeOf(new Boolean(true), P)` reads back 2 where node reads
 * 1) — but a defect being older does not make it acceptable to newly compile a
 * program onto it.
 */
const UNSETTABLE_PROTOTYPE_CONSTRUCTORS: ReadonlySet<string> = new Set([
  "Array",
  "Boolean",
  "Function",
  "Map",
  "Number",
  "Proxy",
  "RegExp",
  "Set",
  "String",
  "WeakMap",
  "WeakRef",
  "WeakSet",
]);

/** What a value expression provably denotes, for the gate below. */
type BindingKind =
  | { kind: "class" }
  /** An ordinary function declared in THIS file. */
  | { kind: "function" }
  /** Declared entirely outside this file — a lib/global constructor. */
  | { kind: "foreign"; name: string }
  | { kind: "unknown" };

function resolveBindingKind(ctx: CodegenContext, expr: ts.Expression, depth = 4): BindingKind {
  if (ts.isClassExpression(expr)) return { kind: "class" };
  if (ts.isFunctionExpression(expr)) return { kind: "function" };
  if (!ts.isIdentifier(expr) || depth <= 0) return { kind: "unknown" };
  const declarations = ctx.oracle.declarationsOf(expr);
  if (declarations.length === 0) return { kind: "unknown" };
  if (declarations.some((d) => ts.isClassDeclaration(d) || ts.isClassExpression(d))) return { kind: "class" };
  const source = expr.getSourceFile();
  if (declarations.every((d) => d.getSourceFile() !== source)) return { kind: "foreign", name: expr.text };
  if (declarations.length !== 1) return { kind: "unknown" };
  const declaration = declarations[0]!;
  if (ts.isFunctionDeclaration(declaration)) return { kind: "function" };
  if (ts.isVariableDeclaration(declaration)) {
    const initializer = ctx.oracle.variableInitializerOf(expr);
    // A `const T = C` alias must answer for what it aliases, or the class /
    // unsupported-carrier refusals below are one indirection away from useless.
    if (initializer !== undefined) return resolveBindingKind(ctx, initializer, depth - 1);
  }
  return { kind: "unknown" };
}

/**
 * Does `node` introduce a `new.target` binding of its OWN?
 *
 * `new.target` is scoped to the nearest enclosing non-arrow function
 * environment (ES §9.1.1.3). An ordinary function, a method, an accessor and a
 * class constructor each get their own; an arrow function does NOT — it reads
 * the enclosing one.
 *
 * A class field initialiser and a class static block are NOT owners either,
 * but they do not inherit the enclosing `new.target` the way an arrow does:
 * §15.7.10 [[Call]]s them, so they see `undefined`. `a4_class_field.ts` pins
 * that (node 1). They are still descended into rather than treated as owners —
 * measured on this tree, treating them as owners admits `a4` at 2 where node
 * answers 1, because the compiled class-field lowering reports a defined
 * `new.target` there. Descending keeps the site refused, which is correct.
 */
function ownsNewTarget(node: ts.Node): boolean {
  return (
    ts.isFunctionDeclaration(node) ||
    ts.isFunctionExpression(node) ||
    ts.isMethodDeclaration(node) ||
    ts.isGetAccessorDeclaration(node) ||
    ts.isSetAccessorDeclaration(node) ||
    ts.isConstructorDeclaration(node)
  );
}

/**
 * Does `node`'s BODY read the `new.target` that `node` itself introduces?
 *
 * The scan stops at a nested scope that owns a `new.target` of its own ONLY
 * when that scope can never be constructed, so
 * `function F(){ function inner(){ return new.target; } inner(); }` does not
 * count as a read by `F` — `inner`'s `new.target` is `inner`'s, and a plain
 * call gives `undefined` on both sides.
 *
 * A nested function that IS constructed is a different case, and the r4 cut
 * got it wrong: `k1_nested_ctor_use.ts` does `new inner()` inside the target,
 * where node reads `inner`'s own `new.target` as defined (2) and the compiled
 * class-id lowering reads it as `undefined` (1). So the stop is kept only for
 * a nested function whose name never appears anywhere but a direct call —
 * anything else (a `new`, a `Reflect.construct` argument, a `.bind`, any
 * escape) counts as a read and refuses the site.
 *
 * Descent continues through arrows, class field initialisers and static blocks.
 */
function readsNewTarget(node: ts.Node): boolean {
  const source = node.getSourceFile();
  let found = false;
  const visit = (child: ts.Node): void => {
    if (found) return;
    if (ts.isMetaProperty(child) && child.keywordToken === ts.SyntaxKind.NewKeyword) {
      found = true;
      return;
    }
    if (ownsNewTarget(child) && neverConstructed(source, child)) return;
    forEachChild(child, visit);
  };
  forEachChild(node, visit);
  return found;
}

/**
 * Can this nested `new.target` owner provably never be reached by
 * [[Construct]]? Only then may the scan stop at it.
 */
function neverConstructed(source: ts.SourceFile, node: ts.Node): boolean {
  // Methods and accessors have no [[Construct]] at all.
  if (ts.isMethodDeclaration(node) || ts.isGetAccessorDeclaration(node) || ts.isSetAccessorDeclaration(node)) {
    return true;
  }
  if (ts.isConstructorDeclaration(node)) return false;
  const name = ts.isFunctionDeclaration(node) || ts.isFunctionExpression(node) ? node.name : undefined;
  // An anonymous function expression is unreachable by name; only an immediate
  // call leaves it unconstructible.
  if (name === undefined) return isImmediatelyCalled(node);
  let escapes = false;
  const visit = (child: ts.Node): void => {
    if (escapes) return;
    if (ts.isIdentifier(child) && child.text === name.text && child !== name && !isDirectCallee(child)) {
      escapes = true;
      return;
    }
    forEachChild(child, visit);
  };
  visit(source);
  return !escapes;
}

/** Is `id` the callee of a plain `id(...)` call — the one benign mention? */
function isDirectCallee(id: ts.Identifier): boolean {
  const parent = id.parent as ts.Node | undefined;
  return parent !== undefined && ts.isCallExpression(parent) && parent.expression === id;
}

/** Is this function expression the callee of its own immediate call (an IIFE)? */
function isImmediatelyCalled(node: ts.Node): boolean {
  let outer: ts.Node = node;
  while (outer.parent !== undefined && ts.isParenthesizedExpression(outer.parent)) outer = outer.parent;
  const parent = outer.parent as ts.Node | undefined;
  return parent !== undefined && ts.isCallExpression(parent) && parent.expression === outer;
}

/**
 * Does the statically-resolved target function read `new.target`?
 *
 * `new.target` is lowered as an i32 class-id module global keyed by class NAME
 * (`src/codegen/new-target.ts`, #2023) — there is no NewTarget VALUE in the
 * constructed frame — so a body that reads it sees `undefined` under
 * `Reflect.construct(F, [], NT)` and the standard
 * `if (new.target === undefined) throw` guard fires where node constructs.
 * Refuse the site instead. Answers `false` when the target resolves to nothing
 * readable; those targets are native constructors with no source body.
 */
function targetReadsNewTarget(ctx: CodegenContext, target: ts.Expression): boolean {
  if (ts.isFunctionExpression(target)) return readsNewTarget(target);
  if (!ts.isIdentifier(target)) return false;
  const source = target.getSourceFile();
  for (const declaration of ctx.oracle.declarationsOf(target)) {
    if (declaration.getSourceFile() !== source) continue;
    if (readsNewTarget(declaration)) return true;
  }
  return false;
}

/**
 * Is `name`'s `prototype` property provably the one its declaration installed?
 *
 * The ordinary-construct driver stores the supplied prototype only when it
 * passes `ref.test $Object`; an object-literal carrier installed by
 * `Object.defineProperty(NT, "prototype", …)` fails that test and is dropped
 * without a word, leaving the instance on `%Object.prototype%`. A pristine
 * binding cannot be in that state, so the driver route is limited to one.
 *
 * That rationale is MEASURED, not assumed (r2 step 4): with every clause that
 * would refuse it disabled, `.tmp/p/d1_defineprop_slot.js` — an ordinary
 * function target and `Object.defineProperty(NT, "prototype", { value: P })`
 * — compiles and answers 1 where node answers 7, i.e. the instance lands on
 * `%Object.prototype%` and neither `Object.getPrototypeOf(o) === P` nor
 * `o.tag === 9` holds. The shape is refused twice over, since TypeScript also
 * synthesises an expando declaration for that `defineProperty`, which the
 * declaration-count check below rejects on its own.
 *
 * ## Mutation is not replacement (r2 step 4, measured)
 * `NT.prototype.tag = 9`, `Object.assign(NT.prototype, …)` and
 * `Object.defineProperty(NT.prototype, …)` MUTATE the object the slot already
 * holds; the slot still holds the plain `$Object` the declaration installed,
 * so the `ref.test` above still passes and all three answer node (7, 7, 7 —
 * `.tmp/p/b2_driver_protomut.js`, `b7_object_assign_proto.js`,
 * `c3_defineprop_on_proto.js`, each a `(#3371)` compile error on base). Only a
 * write whose target is the SLOT — `NT.prototype = …`, `NT["prototype"] = …`,
 * a computed `NT[k] = …`, or an `Object.*` call whose RECEIVER is the bare
 * `NT` — replaces it.
 *
 * ## Why the WRITE clauses stay keyed on the NAME (r2 step 3, measured)
 * The plan asked for the whole predicate to resolve through `ctx.oracle`.
 * Only the BINDING-COUNT clause can: the compiler's own model of a function's
 * `prototype` slot is itself name-keyed, and a prototype write to a
 * same-spelled binding in another scope corrupts the read of THIS one. With no
 * `Reflect.construct` in the program at all, `.tmp/p/m5e_read_only_base.js`
 * — an outer `function NT(){}` plus an inner `const NT = function(){}` whose
 * prototype slot is redefined — reads the OUTER `NT.prototype` as null on
 * BASE (base 5, node 6). Resolving the write clauses by symbol therefore
 * admitted `.tmp/p/m5_nt_block_shadow_mutates.js` at 1 where node answers 3.
 * So: the binding count is gone (that was the measured over-refusal — an
 * unrelated parameter of the same name), and a prototype-slot write to ANY
 * same-spelled binding still refuses, matching what the reader can actually
 * distinguish.
 */
function prototypeIsPristine(ctx: CodegenContext, newTarget: ts.Identifier): boolean {
  // Resolve the NewTarget binding by declaration identity: zero declarations is
  // unresolvable, and more than one means the name is declared twice in this
  // scope chain, where no single declaration answers for it. Replaces the
  // file-wide count of same-spelled bindings, which refused a site over a
  // helper's unrelated parameter (`m2_shadow.js`: node 7, base refused,
  // admitted here; `m1_control_noshadow.js` differs only in that parameter's
  // name and was admitted on base).
  const name = newTarget.text;
  const source = newTarget.getSourceFile();
  // Count declarations IN THIS FILE only. A lib global is declared many times
  // across the .d.ts files (`Array` is an interface plus a var plus
  // `ArrayConstructor`), and requiring exactly one declaration outright turned
  // `built-ins/Reflect/construct/return-with-newtarget-argument.js` — a
  // function target with `Array` as the NewTarget — from pass into a compile
  // error. Two IN-FILE declarations still refuse: that is the second-binding
  // case the file-wide count used to catch, and it is also how the expando
  // declaration TypeScript synthesises for
  // `Object.defineProperty(NT, "prototype", …)` is caught.
  if (ctx.oracle.declarationsOf(newTarget).filter((d) => d.getSourceFile() === source).length > 1) return false;

  let touched = false;
  const visit = (node: ts.Node): void => {
    if (touched) return;
    if (ts.isWithStatement(node)) {
      touched = true;
    } else if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === "eval") {
      touched = true;
    } else if (
      (ts.isPrefixUnaryExpression(node) || ts.isPostfixUnaryExpression(node)) &&
      ts.isIdentifier(node.operand) &&
      node.operand.text === name
    ) {
      touched = true;
    } else if (
      ts.isBinaryExpression(node) &&
      node.operatorToken.kind >= ts.SyntaxKind.FirstAssignment &&
      node.operatorToken.kind <= ts.SyntaxKind.LastAssignment &&
      replacesSlot(node.left, name)
    ) {
      touched = true;
    } else if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)) {
      const method = node.expression.name.text;
      if (
        (method === "defineProperty" ||
          method === "defineProperties" ||
          method === "setPrototypeOf" ||
          method === "assign") &&
        node.arguments.length > 0 &&
        // The RECEIVER, not any mention. `Object.assign(NT, {prototype: P})`
        // and `Object.defineProperty(NT, "prototype", …)` write the slot;
        // `Object.assign(NT.prototype, …)` and
        // `Object.defineProperty(NT.prototype, …)` mutate the object the slot
        // already holds, which stays a plain `$Object` and still passes
        // `__native_construct_N`'s `ref.test $Object`.
        isNamed(node.arguments[0]!, name)
      ) {
        touched = true;
      }
    }
    if (!touched) forEachChild(node, visit);
  };
  visit(source);
  return !touched;
}

/** Is `node` the bare identifier `name`? */
function isNamed(node: ts.Node, name: string): boolean {
  return ts.isIdentifier(node) && node.text === name;
}

/**
 * Does assigning to `left` REPLACE the `name` binding or its `prototype` slot?
 *
 * Replacement is `NT = …`, a destructuring target that binds `NT`,
 * `NT.prototype = …`, `NT["prototype"] = …` and any computed `NT[k] = …` whose
 * key is not a literal. MUTATION of the object the slot already holds
 * (`NT.prototype.tag = 9`) is not replacement: the slot still holds the plain
 * `$Object` the declaration installed, which is what the driver route needs.
 */
function replacesSlot(left: ts.Node, name: string): boolean {
  if (ts.isParenthesizedExpression(left)) return replacesSlot(left.expression, name);
  if (ts.isPropertyAccessExpression(left)) {
    return isNamed(left.expression, name) && left.name.text === "prototype";
  }
  if (ts.isElementAccessExpression(left)) {
    if (!isNamed(left.expression, name)) return false;
    const key = left.argumentExpression;
    // A non-literal key could be "prototype" at runtime; assume it is.
    if (!ts.isStringLiteral(key) && !ts.isNoSubstitutionTemplateLiteral(key)) return true;
    return key.text === "prototype";
  }
  // A bare identifier or a destructuring pattern: rebinding `NT` itself.
  return mentions(left, name);
}

/**
 * Which runtime-NewTarget route this `Reflect.construct` site may take, or
 * `undefined` when it must keep the pre-existing #3371 refusal.
 *
 * Every `undefined` clause corresponds to a measured wrong answer on the r4
 * tree; see this module's header for the measurements. A refusal is the same
 * compile error BASE emitted for all of these shapes.
 */
export function classifyRuntimeNewTargetSite(
  ctx: CodegenContext,
  target: ts.Expression,
  args: readonly ts.Expression[],
  newTarget: ts.Expression,
): "driver" | "carrier" | undefined {
  // Only a bare identifier: its evaluation is side-effect-free, which is the
  // whole reason reading it before the argument list is unobservable.
  if (!ts.isIdentifier(newTarget)) return undefined;
  const ntKind = resolveBindingKind(ctx, newTarget);
  if (ntKind.kind === "class") return undefined;
  if (targetReadsNewTarget(ctx, target)) return undefined;

  const driverEligible =
    ctx.standalone &&
    args.length <= MAX_NATIVE_CONSTRUCT_ARITY &&
    !args.some((a) => ts.isSpreadElement(a)) &&
    isUnreassignedOrdinaryFunction(ctx, target) &&
    prototypeIsPristine(ctx, newTarget);
  if (driverEligible) return "driver";

  const targetKind = resolveBindingKind(ctx, target);
  // A class instance is a CLOSED struct: the post-construction prototype patch
  // is a silent no-op on it, so if the driver route did not take the site,
  // nothing can.
  if (targetKind.kind === "class") return undefined;
  // An in-file FUNCTION target the driver declined (r2 step 5). The same
  // instance shape reached through the `unknown` route below takes the generic
  // `__object_setPrototypeOf` patch and answers node — `k1_target_param.js`
  // (node 3) does exactly that on base — so the refusal keyed on how well the
  // target resolves, not on a property of the carrier.
  //
  // But only when the driver declined for a reason that has nothing to do with
  // the NewTarget's `prototype`. Routing every declined function target here
  // was measured to turn three refusals into WRONG answers, all of them
  // NewTarget-prototype declines whose fetched prototype the closed instance
  // struct then drops: `d1_defineprop_slot.js` 1 vs node 7,
  // `m5_nt_block_shadow_mutates.js` 1 vs node 3, `d3_setprotoof_nt.js` 1 vs
  // node 3. Keeping `prototypeIsPristine` as a precondition admits
  // `j6_reassigned_target.js` (node 3 — the target is a reassigned `let`) and
  // leaves those three refused.
  if (targetKind.kind === "function") {
    if (!ctx.standalone) return undefined;
    // A target that DOES statically resolve to one unreassigned function
    // declaration gets the closed-struct `new` lowering, on which the
    // post-construction patch is a silent no-op — so if the driver declined
    // such a target (too many arguments, a spread, a non-pristine NewTarget
    // prototype), nothing can serve it. Measured: `j7_spread_args.js` 0 vs
    // node 7 and `j8_many_args.js` 1 vs node 3 when admitted.
    if (isUnreassignedOrdinaryFunction(ctx, target)) return undefined;
    // A spread argument list on a dynamic function target TRAPS where node
    // returns a value (`j9_reassigned_target_spread.js`: node 7, exception),
    // and an over-arity list loses the prototype, so this branch keeps the
    // driver's argument-shape conditions too.
    if (args.length > MAX_NATIVE_CONSTRUCT_ARITY) return undefined;
    if (args.some((a) => ts.isSpreadElement(a))) return undefined;
    // Every value the binding can hold must be an ordinary function. Resolving
    // the binding by the KIND OF ITS INITIALIZER admitted `T = A` (async),
    // `T = () => {}`, `T = function*(){}`, `T = C`, `T = G.bind(null)` and
    // `T = undefined` and answered each of them wrongly where base refused;
    // see `dynamicTargetIsAllOrdinaryFunctions` for the measurements. That
    // predicate also refuses an annotated binding, which is the `let T: any`
    // wrong-prototype case this branch used to record as a residual.
    if (!dynamicTargetIsAllOrdinaryFunctions(ctx, target)) return undefined;
    return prototypeIsPristine(ctx, newTarget) ? "carrier" : undefined;
  }
  if (targetKind.kind === "foreign") {
    return UNSETTABLE_PROTOTYPE_CONSTRUCTORS.has(targetKind.name) ? undefined : "carrier";
  }
  // Unresolvable target (a parameter — `testWithTypedArrayConstructors(TA => …)`
  // is the shape the kept typed-array rows use). The runtime `ref.test` carrier
  // arms decide; see the issue file's residual list for what stays unbounded.
  return "carrier";
}
