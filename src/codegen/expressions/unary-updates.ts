// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * UpdateExpression compilation: prefix/postfix `++` and `--`.
 *
 * Covers every target shape: identifiers (locals, module globals, captured
 * globals, boxed ref-cell captures), property access (`obj.x++`), and
 * element access (`arr[i]--`). The non-update prefix unary operators
 * (`+`, `-`, `!`, `~`) live in ./unary.ts.
 */
import { ts } from "../../ts-api.js";
import { tryEmitUnresolvableUpdateThrow } from "../update-unresolvable-ref.js";
import type { Instr, ValType } from "../../ir/types.js";
import { emitBoundsCheckedArrayGet } from "../array-methods.js";
import { tryEmitLinearU8ElementUpdate } from "../linear-uint8-codegen.js";
import { resolveWidenedVarKey } from "../widened-var-key.js";
import { reportError } from "../context/errors.js";
import { reportSilentFallback } from "../fallback-telemetry.js";
import { allocLocal, getLocalType } from "../context/locals.js";
import type { CodegenContext, FunctionContext } from "../context/types.js";
import { compileWithUpdateExpression } from "../with-rmw.js";
import { emitToNumber } from "../coercion-engine.js";
import {
  addStringConstantGlobal,
  addUnionImports,
  ensureStructForType,
  getArrTypeIdxFromVec,
  localGlobalIdx,
} from "../index.js";
import {
  emitAlternateStructSetDispatch,
  emitBoundsGuardedArraySet,
  emitCapturedBoxGlobalRead,
  emitCapturedBoxGlobalWrite,
  getCapturedBoxGlobal,
  resolveInheritedStaticProp,
} from "../property-access.js";
import { reserveMemberGetDispatch } from "../member-get-dispatch.js"; // (#2681/#2686) symmetric struct read for inc/dec
import { resolveReceiverStruct } from "../fnctor-escape-gate.js"; // (#2681/#2686) pinned reconstructed-fnctor receiver gate
import { tryEmitTypedThisIncDec } from "../typed-this.js"; // (#3683 S2) typed-`this` inc/dec
import { receiverIsRealmGlobalObject } from "../helpers/sloppy-this-global.js"; // (#4205) realm global object receiver
import { coerceType, compileExpression, skipTransparentExpressions, unpackedElemType } from "../shared.js";
import { compileStringLiteral } from "../string-ops.js";
import { defaultValueInstrs } from "../type-coercion.js";
import {
  emitSuperUninitializedThisGuard,
  emitThrowTypeError,
  emitWebCompatCallAssignmentTarget,
  getFuncParamTypes,
} from "./helpers.js";
import { ensureLateImport, flushLateImportShifts } from "./late-imports.js";
import { compileComputedMemberKeyAfterBaseGuard } from "./computed-member-reference.js";
import { emitMappedArgParamSync } from "./logical-ops.js";
import { resolveStructName } from "./misc.js";
import { isSloppyImplicitGlobalBinding, tryEmitImplicitGlobalIncDec } from "./implicit-global-binding.js"; // (#3966) `p++` on a realm-global property

/**
 * §13.4 UpdateExpression evaluation applies ToNumeric to the operand's current
 * value before the +1/-1 step. ToNumeric on a Symbol throws TypeError per
 * §7.1.3 step 3. Symbols are lowered to i32 ids, so without this guard `s++` /
 * `--s` would silently treat the id as a number. Returns true (and emits the
 * throw) when the operand's TS type is Symbol.
 */
function emitSymbolUpdateThrow(ctx: CodegenContext, fctx: FunctionContext, operand: ts.Expression): boolean {
  // (#1930 Slice 2) oracle fold: was a direct isSymbolType check on the
  // checker type of the paren-unwrapped operand.
  if (ctx.oracle.staticJsTypeOf(unwrapParens(operand)) !== "symbol") return false;
  emitThrowTypeError(ctx, fctx, "Cannot convert a Symbol value to a number");
  return true;
}

function unwrapParens(node: ts.Expression): ts.Expression {
  while (ts.isParenthesizedExpression(node)) {
    node = node.expression;
  }
  return node;
}

/**
 * Emit a ToNumeric coercion for an externref operand of `++`/`--` (#1379).
 *
 * UpdateExpressions (ECMA-262 §13.4) call ToNumeric on the operand before
 * the +1/-1 step. ToNumeric calls ToPrimitive(NUMBER_HINT) then ToNumber
 * (BigInt is split out — see #1349). For ++/-- the routing is:
 *   - null      → 0
 *   - undefined → NaN
 *   - true/false→ 1/0
 *   - "1"       → 1     (whitespace-trimmed numeric string parse)
 *   - ""        → 0
 *   - "abc"     → NaN
 *   - {valueOf:()=>"5"} → 5    (valueOf → ToNumber chain)
 *   - {} / fn   → NaN          ([object Object]/function source → NaN)
 *
 * The host import `__unbox_number` (registered by `addUnionImports`) maps
 * to the runtime "unbox/number" intent which performs exactly this
 * ToPrimitive→Number chain via `_toPrimitive` + `_hostToPrimitive` (#1319),
 * so a direct call is correct here. The previous implementation used
 * `emitSafeExternrefToF64` which short-circuited any non-`typeof===number`
 * value to NaN — that was a defensive path from before the WasmGC
 * struct ToPrimitive support landed.
 *
 * Expects one externref on the stack; leaves one f64.
 */
function emitToNumericForUpdate(ctx: CodegenContext, fctx: FunctionContext): void {
  // Use the same canonical coercion engine as IR `dyn.to_number`. In the JS
  // host lane this remains the existing `__unbox_number` call; standalone
  // first runs native OrdinaryToPrimitive("number") and only then unboxes.
  // Calling `__unbox_number` directly skipped user valueOf/toString and the
  // primitive slots of Boolean/Number wrappers.
  emitToNumber(ctx, fctx, { kind: "externref" });
}

/**
 * #2019: resolve the module global backing a static property `++`/`--` target.
 * Handles both receiver shapes:
 *   - `ClassName.prop` — Identifier in classSet; own field first, then walk
 *     the parent chain so inherited static fields update the ancestor's global.
 *   - `this.prop` in a static context — resolve the enclosing class from
 *     `fctx.enclosingClassName` or the function-name prefix, then look up the
 *     static global (the receiver may be wrapped: `(this as any).prop`).
 * Returns the global index, or undefined when the target is not a static field.
 */
function resolveStaticPropGlobalForUpdate(
  ctx: CodegenContext,
  fctx: FunctionContext,
  receiver: ts.Expression,
  propName: string,
): number | undefined {
  // `ClassName.prop` (own or inherited).
  if (ts.isIdentifier(receiver)) {
    const clsName = ctx.classExprNameMap.get(receiver.text) ?? receiver.text;
    if (ctx.classSet.has(clsName)) {
      return ctx.staticProps.get(`${clsName}_${propName}`) ?? resolveInheritedStaticProp(ctx, clsName, propName);
    }
    return undefined;
  }
  // `this.prop` / `(this as any).prop` in a static context.
  if (
    skipTransparentExpressions(receiver).kind === ts.SyntaxKind.ThisKeyword &&
    (fctx.localMap.get("this") === undefined || fctx.isStaticContext)
  ) {
    let enclosingClass: string | undefined = fctx.enclosingClassName;
    if (!enclosingClass) {
      const fname = fctx.name;
      let pos = -1;
      while (!enclosingClass) {
        pos = fname.indexOf("_", pos + 1);
        if (pos < 0) break;
        const candidate = fname.substring(0, pos);
        if (candidate && ctx.classSet.has(candidate)) enclosingClass = candidate;
      }
    }
    if (enclosingClass) {
      return (
        ctx.staticProps.get(`${enclosingClass}_${propName}`) ??
        resolveInheritedStaticProp(ctx, enclosingClass, propName)
      );
    }
  }
  return undefined;
}

/**
 * #2019: emit `++`/`--` against a Wasm global slot. Reads the global, applies
 * ToNumeric (so non-numeric externref backing values follow §13.4), computes
 * old±1, writes it back **coerced to the global's declared type**, and leaves
 * the spec result on the stack (old value for postfix, new value for prefix).
 * Always yields f64.
 *
 * (#4079) Originally static-property-only. The plain module-global and
 * captured-global paths below each hand-rolled the same read/compute/store
 * with their OWN type-case list, and every one of those lists handled
 * `externref` and `ref`/`ref_null` but forgot **`i32`** — so a boolean-backed
 * global fell through to the f64 arm and emitted `global.get` (i32) straight
 * into `f64.add`:
 *
 *     var x = false; x++;
 *     -> f64.add[0] expected type f64, found global.get of type i32
 *
 * which kills the module at instantiate. This function already had the i32
 * arm right, so the fix is to stop having eight copies of the decision and
 * route them all here.
 */
function compileGlobalIncDec(
  ctx: CodegenContext,
  fctx: FunctionContext,
  globalIdx: number,
  f64Op: "f64.add" | "f64.sub",
  mode: "prefix" | "postfix",
): ValType {
  const globalDef = ctx.mod.globals[localGlobalIdx(ctx, globalIdx)];
  const globalType = globalDef?.type ?? { kind: "externref" };

  // Read current value as f64 (ToNumeric for non-f64 backing globals).
  fctx.body.push({ op: "global.get", index: globalIdx });
  if (globalType.kind === "externref") {
    emitToNumericForUpdate(ctx, fctx);
  } else if (globalType.kind === "i32") {
    fctx.body.push({ op: "f64.convert_i32_s" });
  }

  const oldTmp = allocLocal(fctx, `__static_incdec_old_${fctx.locals.length}`, { kind: "f64" });
  const newTmp = allocLocal(fctx, `__static_incdec_new_${fctx.locals.length}`, { kind: "f64" });
  fctx.body.push({ op: "local.tee", index: oldTmp });
  fctx.body.push({ op: "f64.const", value: 1 });
  fctx.body.push({ op: f64Op });
  fctx.body.push({ op: "local.set", index: newTmp });

  // Store the new value back, coercing to the global's declared type.
  fctx.body.push({ op: "local.get", index: newTmp });
  if (globalType.kind === "externref") {
    addUnionImports(ctx);
    const boxIdx = ctx.funcMap.get("__box_number");
    if (boxIdx !== undefined) fctx.body.push({ op: "call", funcIdx: boxIdx });
  } else if (globalType.kind === "i32") {
    fctx.body.push({ op: "i32.trunc_f64_s" });
  }
  fctx.body.push({ op: "global.set", index: globalIdx });

  // Result: old for postfix, new for prefix.
  fctx.body.push({ op: "local.get", index: mode === "postfix" ? oldTmp : newTmp });
  return { kind: "f64" };
}

/**
 * (#2656) `++this.prop` / `this.prop--` on an `any`/`externref`-typed receiver
 * (e.g. a fnctor-instance `this` inside a prototype method — acorn's tokenizer
 * shape). The statically-resolved-struct path below only fires when the receiver
 * type resolves to a known struct; for an externref receiver it used to emit a
 * `f64.const NaN` graceful fallback and SILENTLY DROP THE WRITE — so
 * `++this.pos` was a no-op (acorn's `skipSpace`/`readWord1` loops never advanced
 * → infinite loop). `this.prop = this.prop + 1` and `this.prop += 1` already
 * worked because the compound-assignment path (assignment.ts Path B) does the
 * read-modify-write; `++`/`--` simply never got the same externref arm.
 *
 * This mirrors `compilePropertyCompoundAssignmentExternref`'s write-back exactly:
 * read current via `__extern_get`, `__unbox_number` → f64, ±1, `__box_number` →
 * externref, then write back through the SYMMETRIC `struct.set` multi-struct
 * dispatch (#2659 `emitAlternateStructSetDispatch`) so a typed WasmGC-struct
 * receiver hits the same slot the member-READ fast path reads — with the
 * `__extern_set` sidecar write as the terminal fallback for genuine host
 * externrefs / dynamic-only props. Prefix returns the NEW value, postfix the OLD
 * (§13.4). f64 numeric semantics, matching `x += 1` (no BigInt special-casing —
 * the compound path has none here either).
 */
function emitExternrefMemberIncDec(
  ctx: CodegenContext,
  fctx: FunctionContext,
  objLocal: number,
  propName: string,
  f64Op: "f64.add" | "f64.sub",
  mode: "prefix" | "postfix",
  // (#2681/#2686) True only when the receiver is a PINNED reconstructed-fnctor
  // struct (acorn's `this.pos`). Only then do read+write route through the
  // `__get_member`/`__set_member` struct dispatchers (slot), symmetric with the
  // pinned simple read/write. A general any-receiver (plain object → anonymous
  // `$__anon_N` struct) stays on the bare `__extern_get`/`__extern_set` sidecar so
  // the delete-tombstone semantics (#2179/#2731) hold.
  pinned: boolean,
): ValType {
  // Key string for __extern_get / __extern_set.
  addStringConstantGlobal(ctx, propName);
  const keyResult = compileStringLiteral(ctx, fctx, propName);
  if (keyResult && keyResult.kind !== "externref") {
    coerceType(ctx, fctx, keyResult, { kind: "externref" });
  }
  const keyLocal = allocLocal(fctx, `__incdec_ekey_${fctx.locals.length}`, { kind: "externref" });
  fctx.body.push({ op: "local.set", index: keyLocal });

  // Read current value. (#2681/#2686) MUST be symmetric with the struct.set
  // write-back below: a bare `__extern_get` reads the JS-side SIDECAR while the
  // write hits the native struct SLOT, so `this.pos++` diverges and acorn's
  // tokenizer loop never advances (hang). Route through the `__get_member_<name>`
  // dispatcher (`struct.get` arms + `__extern_get` terminal) — the same
  // finalize-filled candidate set the write dispatcher uses — so read and write
  // stay consistent.
  fctx.body.push({ op: "local.get", index: objLocal });
  const getDispIdx = pinned ? reserveMemberGetDispatch(ctx, propName, fctx) : undefined;
  if (getDispIdx !== undefined) {
    fctx.body.push({ op: "call", funcIdx: getDispIdx });
  } else {
    fctx.body.push({ op: "local.get", index: keyLocal });
    const getIdx = ensureLateImport(
      ctx,
      "__extern_get",
      [{ kind: "externref" }, { kind: "externref" }],
      [{ kind: "externref" }],
    );
    flushLateImportShifts(ctx, fctx);
    if (getIdx !== undefined) {
      fctx.body.push({ op: "call", funcIdx: getIdx });
    }
  }

  // Unbox to f64 (ToNumber on the current value, matching `x += 1`).
  addUnionImports(ctx);
  const unboxIdx = ctx.funcMap.get("__unbox_number");
  if (unboxIdx !== undefined) {
    fctx.body.push({ op: "call", funcIdx: unboxIdx });
  }

  // Save OLD value (for postfix return).
  const oldTmp = allocLocal(fctx, `__incdec_eold_${fctx.locals.length}`, { kind: "f64" });
  fctx.body.push({ op: "local.tee", index: oldTmp });

  // Compute NEW = old +/- 1.
  fctx.body.push({ op: "f64.const", value: 1 });
  fctx.body.push({ op: f64Op });
  const newTmp = allocLocal(fctx, `__incdec_enew_${fctx.locals.length}`, { kind: "f64" });
  fctx.body.push({ op: "local.set", index: newTmp });

  // Box NEW to externref for the write-back.
  fctx.body.push({ op: "local.get", index: newTmp });
  const boxIdx = ctx.funcMap.get("__box_number");
  if (boxIdx !== undefined) {
    fctx.body.push({ op: "call", funcIdx: boxIdx });
  }
  const boxedLocal = allocLocal(fctx, `__incdec_eboxed_${fctx.locals.length}`, { kind: "externref" });
  fctx.body.push({ op: "local.set", index: boxedLocal });

  // Write back. Symmetric struct.set dispatch first (so a typed-struct receiver
  // hits the slot the READ fast path uses); __extern_set sidecar as the terminal
  // fallback. (#2659 pattern, mirrored from assignment.ts Path B.)
  const setIdx = ensureLateImport(
    ctx,
    "__extern_set",
    [{ kind: "externref" }, { kind: "externref" }, { kind: "externref" }],
    [],
  );
  flushLateImportShifts(ctx, fctx);
  // (#2664) Route through the deferred-fill member-set dispatcher (NON-strict —
  // this is a read-modify-write `obj.x++`, the property was already read so the
  // sidecar update never hits a getter-only-accessor throw). The dispatcher's
  // terminal else-arm IS the `__extern_set` sidecar; its struct-candidate arms
  // are enumerated at finalize (the full type table), fixing the compile-order
  // candidate freeze (#2664).
  const dispatched =
    pinned && emitAlternateStructSetDispatch(ctx, fctx, objLocal, boxedLocal, propName, /*strict*/ false);
  if (!dispatched) {
    // Not pinned (or dispatcher not reservable) — emit the bare host write.
    fctx.body.push({ op: "local.get", index: objLocal });
    fctx.body.push({ op: "local.get", index: keyLocal });
    fctx.body.push({ op: "local.get", index: boxedLocal });
    if (setIdx !== undefined) fctx.body.push({ op: "call", funcIdx: setIdx });
  }

  // Return new (prefix) or old (postfix). §13.4 UpdateExpression semantics.
  fctx.body.push({ op: "local.get", index: mode === "postfix" ? oldTmp : newTmp });
  return { kind: "f64" };
}

/**
 * (#2675) Object element `obj[keyExpr]++` / `--obj[keyExpr]` on an externref
 * (any-typed) receiver — a real read-modify-write instead of the historical
 * NaN-drop. Mirrors the working compound path `compileElementCompoundAssignment`
 * (assignment.ts; #2666 fixed it for ToPropertyKey-once) but with ±1 and §13.4
 * UpdateExpression old/new return semantics:
 *
 *   read  __extern_get(base, key) -> __unbox_number -> f64 (= old)
 *   new = old ±1
 *   write back: a STATIC string-literal key routes through the symmetric
 *     struct.set dispatch (#2659 `emitAlternateStructSetDispatch`) so a typed
 *     WasmGC-struct receiver hits the same slot the member READ uses, with
 *     `__extern_set` as the terminal sidecar fallback; a DYNAMIC key writes via
 *     `__extern_set` (the same path `o[k] += 1` uses).
 *
 * The key's ToPropertyKey (§7.1.19) fires ONCE for a side-effecting `{toString}`
 * key. `baseLocal` already holds the receiver externref. Prefix returns the NEW
 * value, postfix the OLD. f64 numeric semantics (matching `o[k] += 1`).
 */
function emitExternrefElementIncDec(
  ctx: CodegenContext,
  fctx: FunctionContext,
  baseLocal: number,
  keyExpr: ts.Expression,
  f64Op: "f64.add" | "f64.sub",
  mode: "prefix" | "postfix",
): ValType | null {
  const keyLocal = compileComputedMemberKeyAfterBaseGuard(ctx, fctx, baseLocal, keyExpr, "__incdec_ekey");
  if (keyLocal === null) return null;

  // Read current: __extern_get(base, key) -> externref (slot-consistent via _safeGet).
  fctx.body.push({ op: "local.get", index: baseLocal });
  fctx.body.push({ op: "local.get", index: keyLocal });
  const getIdx = ensureLateImport(
    ctx,
    "__extern_get",
    [{ kind: "externref" }, { kind: "externref" }],
    [{ kind: "externref" }],
  );
  flushLateImportShifts(ctx, fctx);
  if (getIdx !== undefined) fctx.body.push({ op: "call", funcIdx: getIdx });

  // Unbox -> f64 (ToNumber on the current value).
  addUnionImports(ctx);
  const unboxIdx = ctx.funcMap.get("__unbox_number");
  if (unboxIdx !== undefined) fctx.body.push({ op: "call", funcIdx: unboxIdx });

  // Save OLD (postfix return).
  const oldTmp = allocLocal(fctx, `__incdec_eeold_${fctx.locals.length}`, { kind: "f64" });
  fctx.body.push({ op: "local.tee", index: oldTmp });

  // NEW = old ±1.
  fctx.body.push({ op: "f64.const", value: 1 });
  fctx.body.push({ op: f64Op });
  const newTmp = allocLocal(fctx, `__incdec_eenew_${fctx.locals.length}`, { kind: "f64" });
  fctx.body.push({ op: "local.set", index: newTmp });

  // Box NEW for the write-back.
  fctx.body.push({ op: "local.get", index: newTmp });
  const boxIdx = ctx.funcMap.get("__box_number");
  if (boxIdx !== undefined) fctx.body.push({ op: "call", funcIdx: boxIdx });
  const boxedLocal = allocLocal(fctx, `__incdec_eeboxed_${fctx.locals.length}`, { kind: "externref" });
  fctx.body.push({ op: "local.set", index: boxedLocal });

  // Write back. Static string-literal key → symmetric struct.set dispatch (#2659)
  // for slot-consistency (terminal __extern_set fallback inside); dynamic key →
  // __extern_set (same path as `o[k] += 1`).
  const setIdx = ensureLateImport(
    ctx,
    "__extern_set",
    [{ kind: "externref" }, { kind: "externref" }, { kind: "externref" }],
    [],
  );
  flushLateImportShifts(ctx, fctx);
  // (#2681/#2686) The element-form READ above uses the BARE tombstone-aware
  // `__extern_get` (sidecar), so the write MUST match it — a struct.set dispatcher
  // here would write the SLOT while the read saw the sidecar (asymmetric), and for
  // a plain object (anonymous `$__anon_N` struct) it would also bypass the
  // delete-tombstone/ordering semantics (#2179/#2731). `o["x"]++` on a
  // reconstructed fnctor is not an acorn pattern (acorn uses `this.x++`, handled
  // by the pinned-gated `emitExternrefMemberIncDec`). So always write via the bare
  // `__extern_set` sidecar — symmetric with the read.
  fctx.body.push({ op: "local.get", index: baseLocal });
  fctx.body.push({ op: "local.get", index: keyLocal });
  fctx.body.push({ op: "local.get", index: boxedLocal });
  if (setIdx !== undefined) fctx.body.push({ op: "call", funcIdx: setIdx });

  // Return NEW (prefix) / OLD (postfix). §13.4.
  fctx.body.push({ op: "local.get", index: mode === "postfix" ? oldTmp : newTmp });
  return { kind: "f64" };
}

/**
 * (#2656/#4491) Externref read-modify-write for `obj.p++` / `--obj.p`, shared by
 * `compileMemberIncDec`'s two "the struct cannot serve this write" arms: an
 * UNRESOLVABLE receiver type (#2656) and a resolved struct with NO SLOT for the
 * property (#4491). Both used to emit `f64.const NaN` and drop the write.
 *
 * `reason` names the caller on the silent-fallback channel, which is reached only
 * when the receiver itself will not compile — that residual NaN is the honest
 * answer there (§13.4 on an unresolvable Reference).
 */
function emitMemberIncDecExternrefFallback(
  ctx: CodegenContext,
  fctx: FunctionContext,
  operand: ts.PropertyAccessExpression,
  propName: string,
  f64Op: "f64.add" | "f64.sub",
  mode: "prefix" | "postfix",
  reason: string,
): ValType | null {
  const incDecPinned =
    (operand.expression.kind === ts.SyntaxKind.ThisKeyword && fctx.thisStructName !== undefined) ||
    resolveReceiverStruct(ctx, fctx, operand.expression) !== undefined;
  const objResult = compileExpression(ctx, fctx, operand.expression);
  if (objResult) {
    const objLocal = allocLocal(fctx, `__incdec_eobj_${fctx.locals.length}`, { kind: "externref" });
    if (objResult.kind !== "externref") {
      coerceType(ctx, fctx, objResult, { kind: "externref" });
    }
    fctx.body.push({ op: "local.set", index: objLocal });
    return emitExternrefMemberIncDec(ctx, fctx, objLocal, propName, f64Op, mode, incDecPinned);
  }
  reportSilentFallback(ctx, "const-fallback", reason, operand);
  fctx.body.push({ op: "f64.const", value: NaN });
  return { kind: "f64" };
}

/**
 * Compile prefix/postfix increment/decrement on member expressions:
 *   ++obj.x, obj.x++, --obj[i], obj[i]--, etc.
 *
 * For prefix: evaluates new value (old +/- 1), stores, returns new value.
 * For postfix: evaluates old value, stores new value (old +/- 1), returns old value.
 */
function compileMemberIncDec(
  ctx: CodegenContext,
  fctx: FunctionContext,
  operand: ts.Expression,
  arithOp: "add" | "sub",
  mode: "prefix" | "postfix",
): ValType | null {
  const f64Op = arithOp === "add" ? "f64.add" : "f64.sub";
  const i32Op = arithOp === "add" ? "i32.add" : "i32.sub";

  // Unwrap parenthesized expressions: ++(obj.x) -> ++obj.x
  operand = unwrapParens(operand);

  // (#2709) `super[super()]++` / `++super[super()]` — a SuperProperty UPDATE whose
  // computed key contains a super() call. §13.3.7.1 resolves the reference (with
  // GetThisBinding) BEFORE evaluating the key, so this always throws a
  // ReferenceError; emit it and stop, before the inner super() is evaluated. No-op
  // for every other shape (see emitSuperUninitializedThisGuard).
  if (
    ts.isElementAccessExpression(operand) &&
    operand.expression.kind === ts.SyntaxKind.SuperKeyword &&
    emitSuperUninitializedThisGuard(ctx, fctx, operand.argumentExpression)
  ) {
    return { kind: "f64" };
  }

  // Handle obj.prop
  if (ts.isPropertyAccessExpression(operand)) {
    const propName = ts.isPrivateIdentifier(operand.name) ? "__priv_" + operand.name.text.slice(1) : operand.name.text;

    // #2019: static-property `++`/`--`. The receiver is either `ClassName`
    // (Identifier in classSet, possibly inheriting the field from an ancestor)
    // or `this` inside a static context. Static fields are module globals, not
    // struct fields, so the generic struct-write path below cannot reach them —
    // it falls through to the `f64.const NaN` fallback and the write is lost.
    // Mirror the staticProps arm from assignment.ts with pre/post semantics.
    {
      const staticGlobalIdx = resolveStaticPropGlobalForUpdate(ctx, fctx, operand.expression, propName);
      if (staticGlobalIdx !== undefined) {
        return compileGlobalIncDec(ctx, fctx, staticGlobalIdx, f64Op, mode);
      }
    }

    // (#4500 Slice A, third site) `this.p++` on a `var`-declared script global:
    // read/write route it to the module global, this RMW read the OBJECT.
    const realmIdx = ctx.moduleGlobals.get(propName);
    if (realmIdx !== undefined && receiverIsRealmGlobalObject(ctx, fctx, operand.expression)) {
      return compileGlobalIncDec(ctx, fctx, realmIdx, f64Op, mode);
    }

    // (#3683 S2 branch c2) TYPED-`this` `++`/`--` inside a twin — a
    // struct.get/struct.set pair against the prologue's typed local instead of
    // `__get_member_<p>` + unbox + box + `__set_member_<p>`. Emitted before ANY
    // receiver evaluation so a decline leaves the body untouched.
    {
      const typed = tryEmitTypedThisIncDec(ctx, fctx, operand, f64Op, mode);
      if (typed !== undefined) return typed;
    }

    const objType = ctx.checker.getTypeAtLocation(operand.expression);
    // Ensure anonymous types are registered as structs before resolving
    ensureStructForType(ctx, objType);
    // (#4205) The realm global object is NOT the checker's `typeof globalThis`
    // struct — declining it here routes `this.n++` to the externref RMW below
    // instead of the struct's missing-field arm, which NaN-dropped the write.
    let typeName = receiverIsRealmGlobalObject(ctx, fctx, operand.expression)
      ? undefined
      : resolveStructName(ctx, objType);
    // Fallback: check widened variable struct map (matches compilePropertyAssignment)
    // (#3364) keyed per-declaration, not by bare name.
    if (!typeName && ts.isIdentifier(operand.expression)) {
      const key = resolveWidenedVarKey(ctx, operand.expression);
      if (key !== undefined) typeName = ctx.widenedVarStructMap.get(key);
    }
    if (!typeName) {
      // (#2656) Unresolvable static struct type — typically an `any`/`externref`
      // receiver. Do NOT NaN-drop the write: route through the externref
      // read-modify-write, which hits the same slot the READ uses. (#2681/#2686)
      return emitMemberIncDecExternrefFallback(
        ctx,
        fctx,
        operand,
        propName,
        f64Op,
        mode,
        "unary-updates:incdec-unresolvable-receiver-type",
      );
    }

    // Check for accessor properties (get/set) before looking up struct fields
    const accessorKey = `${typeName}_${propName}`;
    if (ctx.classAccessorSet.has(accessorKey)) {
      const getterName = `${typeName}_get_${propName}`;
      const setterName = `${typeName}_set_${propName}`;
      const getterIdx = ctx.funcMap.get(getterName);
      const setterIdx = ctx.funcMap.get(setterName);
      if (getterIdx !== undefined && setterIdx !== undefined) {
        // Compile the object expression and save to a temp local, coercing to getter's self type
        const incGetterPTypes = getFuncParamTypes(ctx, getterIdx);
        const objResult = compileExpression(ctx, fctx, operand.expression, incGetterPTypes?.[0]);
        if (!objResult) return null;
        const objTmp = allocLocal(fctx, `__incdec_acc_obj_${fctx.locals.length}`, objResult);
        fctx.body.push({ op: "local.set", index: objTmp });

        // Read current value via getter
        fctx.body.push({ op: "local.get", index: objTmp });
        fctx.body.push({ op: "call", funcIdx: getterIdx });

        if (mode === "postfix") {
          // Save old value, compute new, store via setter, return old
          const oldTmp = allocLocal(fctx, `__incdec_acc_old_${fctx.locals.length}`, { kind: "f64" });
          fctx.body.push({ op: "local.tee", index: oldTmp });
          fctx.body.push({ op: "f64.const", value: 1 });
          fctx.body.push({ op: f64Op });
          const newTmp = allocLocal(fctx, `__incdec_acc_new_${fctx.locals.length}`, { kind: "f64" });
          fctx.body.push({ op: "local.set", index: newTmp });
          fctx.body.push({ op: "local.get", index: objTmp });
          // Coerce f64 to setter's expected value param type (if setter has value param)
          {
            const idParamTypes = getFuncParamTypes(ctx, setterIdx);
            const idValType = idParamTypes?.[1];
            if (idValType) {
              fctx.body.push({ op: "local.get", index: newTmp });
              if (idValType.kind === "externref") {
                addUnionImports(ctx);
                const bIdx = ctx.funcMap.get("__box_number");
                if (bIdx !== undefined) fctx.body.push({ op: "call", funcIdx: bIdx });
              }
            }
          }
          {
            const fs = ctx.funcMap.get(setterName) ?? setterIdx;
            fctx.body.push({ op: "call", funcIdx: fs });
          }
          fctx.body.push({ op: "local.get", index: oldTmp });
        } else {
          // Compute new, store via setter, return new
          fctx.body.push({ op: "f64.const", value: 1 });
          fctx.body.push({ op: f64Op });
          const newTmp = allocLocal(fctx, `__incdec_acc_new_${fctx.locals.length}`, { kind: "f64" });
          fctx.body.push({ op: "local.tee", index: newTmp });
          // Store: setter expects [obj, val] (or just [obj] if setter ignores value)
          const valTmp = allocLocal(fctx, `__incdec_acc_val_${fctx.locals.length}`, { kind: "f64" });
          fctx.body.push({ op: "local.set", index: valTmp });
          fctx.body.push({ op: "local.get", index: objTmp });
          // Coerce f64 to setter's expected value param type (if setter has value param)
          {
            const idParamTypes = getFuncParamTypes(ctx, setterIdx);
            const idValType = idParamTypes?.[1];
            if (idValType) {
              fctx.body.push({ op: "local.get", index: valTmp });
              if (idValType.kind === "externref") {
                addUnionImports(ctx);
                const bIdx = ctx.funcMap.get("__box_number");
                if (bIdx !== undefined) fctx.body.push({ op: "call", funcIdx: bIdx });
              }
            }
          }
          {
            const fs = ctx.funcMap.get(setterName) ?? setterIdx;
            fctx.body.push({ op: "call", funcIdx: fs });
          }
          fctx.body.push({ op: "local.get", index: newTmp });
        }
        return { kind: "f64" };
      }
    }

    const structTypeIdx = ctx.structMap.get(typeName);
    const fields = ctx.structFields.get(typeName);
    if (structTypeIdx === undefined || !fields) {
      // Struct not found — gracefully emit NaN
      reportSilentFallback(ctx, "const-fallback", "unary-updates:incdec-struct-not-found", operand);
      fctx.body.push({ op: "f64.const", value: NaN });
      return { kind: "f64" };
    }

    const fieldIdx = fields.findIndex((f) => f.name === propName);
    if (fieldIdx === -1) {
      // (#4491) The struct resolved but carries NO slot for this property. The
      // old arm emitted `f64.const NaN` and DROPPED the write, so `var m = {};
      // m.foo++` left `"foo" in m` false — §13.4 requires the update to CREATE
      // the property holding NaN. Reuse the #2656 externref read-modify-write:
      // the read still answers undefined → NaN (unchanged result value), and the
      // write-back lands under a fresh key instead of vanishing.
      return emitMemberIncDecExternrefFallback(
        ctx,
        fctx,
        operand,
        propName,
        f64Op,
        mode,
        "unary-updates:member-incdec-unknown-field",
      );
    }

    const fieldType = fields[fieldIdx]!.type;

    // Compile the object expression and save to a temp local
    const objResult = compileExpression(ctx, fctx, operand.expression);
    if (!objResult) return null;
    const objTmp = allocLocal(fctx, `__incdec_obj_${fctx.locals.length}`, objResult);
    fctx.body.push({ op: "local.set", index: objTmp });

    // Read current value: obj.prop
    fctx.body.push({ op: "local.get", index: objTmp });
    fctx.body.push({ op: "struct.get", typeIdx: structTypeIdx, fieldIdx });

    if (ctx.fast && fieldType.kind === "i32") {
      if (mode === "postfix") {
        // Save old value, compute new, store new, return old
        const oldTmp = allocLocal(fctx, `__incdec_old_${fctx.locals.length}`, {
          kind: "i32",
        });
        fctx.body.push({ op: "local.tee", index: oldTmp });
        fctx.body.push({ op: "i32.const", value: 1 });
        fctx.body.push({ op: i32Op });
        const newTmp = allocLocal(fctx, `__incdec_new_${fctx.locals.length}`, {
          kind: "i32",
        });
        fctx.body.push({ op: "local.set", index: newTmp });
        fctx.body.push({ op: "local.get", index: objTmp });
        fctx.body.push({ op: "local.get", index: newTmp });
        fctx.body.push({ op: "struct.set", typeIdx: structTypeIdx, fieldIdx });
        fctx.body.push({ op: "local.get", index: oldTmp });
        return { kind: "i32" };
      } else {
        // Compute new, store, return new
        fctx.body.push({ op: "i32.const", value: 1 });
        fctx.body.push({ op: i32Op });
        const newTmp = allocLocal(fctx, `__incdec_new_${fctx.locals.length}`, {
          kind: "i32",
        });
        fctx.body.push({ op: "local.set", index: newTmp });
        fctx.body.push({ op: "local.get", index: objTmp });
        fctx.body.push({ op: "local.get", index: newTmp });
        fctx.body.push({ op: "struct.set", typeIdx: structTypeIdx, fieldIdx });
        fctx.body.push({ op: "local.get", index: newTmp });
        return { kind: "i32" };
      }
    }

    // Default: f64 arithmetic
    // Coerce field value to f64 if needed
    if (fieldType.kind !== "f64") {
      coerceType(ctx, fctx, fieldType, { kind: "f64" });
    }

    if (mode === "postfix") {
      // Save old value, compute new, store, return old
      const oldTmp = allocLocal(fctx, `__incdec_old_${fctx.locals.length}`, {
        kind: "f64",
      });
      fctx.body.push({ op: "local.tee", index: oldTmp });
      fctx.body.push({ op: "f64.const", value: 1 });
      fctx.body.push({ op: f64Op });
      // Coerce back to field type if needed
      if (fieldType.kind !== "f64") {
        coerceType(ctx, fctx, { kind: "f64" }, fieldType);
      }
      const newTmp = allocLocal(fctx, `__incdec_new_${fctx.locals.length}`, fieldType);
      fctx.body.push({ op: "local.set", index: newTmp });
      fctx.body.push({ op: "local.get", index: objTmp });
      fctx.body.push({ op: "local.get", index: newTmp });
      fctx.body.push({ op: "struct.set", typeIdx: structTypeIdx, fieldIdx });
      fctx.body.push({ op: "local.get", index: oldTmp });
      return { kind: "f64" };
    } else {
      // Compute new, store, return new
      fctx.body.push({ op: "f64.const", value: 1 });
      fctx.body.push({ op: f64Op });
      const newF64Tmp = allocLocal(fctx, `__incdec_new_${fctx.locals.length}`, {
        kind: "f64",
      });
      fctx.body.push({ op: "local.set", index: newF64Tmp });
      // Store: obj.prop = new (coerced back to field type)
      fctx.body.push({ op: "local.get", index: objTmp });
      fctx.body.push({ op: "local.get", index: newF64Tmp });
      if (fieldType.kind !== "f64") {
        coerceType(ctx, fctx, { kind: "f64" }, fieldType);
      }
      fctx.body.push({ op: "struct.set", typeIdx: structTypeIdx, fieldIdx });
      fctx.body.push({ op: "local.get", index: newF64Tmp });
      return { kind: "f64" };
    }
  }

  // Handle obj[idx] — element access increment/decrement on arrays
  if (ts.isElementAccessExpression(operand)) {
    // #2045 C.8: linear-backed Uint8Array element update (`b[i]++` / `--b[i]`) —
    // read-modify-write the linear memory directly. Must run BEFORE
    // `compileExpression(operand.expression)` below, which materialises the
    // buffer as a value and routes the write through a path that never touches
    // linear memory (the byte stayed unchanged / threw at runtime). Falls
    // through for any non-linear element target.
    const linU8 = tryEmitLinearU8ElementUpdate(
      ctx,
      fctx,
      operand,
      /* isIncrement */ arithOp === "add",
      mode === "prefix",
    );
    if (linU8 !== null) return linU8;

    const objTsType = ctx.checker.getTypeAtLocation(operand.expression);
    const objResult = compileExpression(ctx, fctx, operand.expression);
    if (!objResult) return null;

    // Externref element access: cannot do struct.get/struct.set on externref,
    // gracefully emit NaN (incrementing a dynamic property produces NaN).
    //
    // #1720 — reference evaluation order on `base[key]++`. Per §13.4 the LHS
    // MemberExpression is evaluated to a Reference *before* GetValue forces the
    // ToNumeric coercion, and per §13.3.3 evaluating `base[key]` evaluates both
    // the base sub-expression AND the property-key sub-expression (with their
    // side effects) before the Reference is resolved. The old code dropped the
    // base and emitted NaN without ever compiling the key expression, so a
    // side-effecting key (`base[prop()]++`) silently skipped `prop()`. We now
    // evaluate the key for its side effects, then — when the base is null at
    // runtime — throw a TypeError (RequireObjectCoercible inside GetValue),
    // which is observable *before* ToPropertyKey would call the key's
    // `toString`. A non-null externref base still falls through to NaN.
    if (objResult.kind === "externref") {
      // (#2675) Object element `obj[keyExpr]++` / `--` on an any-typed (externref)
      // receiver: a real read-modify-write instead of the historical NaN-drop.
      // The key's ToPropertyKey-once, the null-base RequireObjectCoercible
      // TypeError, and the slot-consistent write-back are handled in the shared
      // helper (mirrors the working compound path `o[key] += 1`).
      const elemBaseTmp = allocLocal(fctx, `__incdec_ebase_${fctx.locals.length}`, objResult);
      fctx.body.push({ op: "local.set", index: elemBaseTmp });
      return emitExternrefElementIncDec(ctx, fctx, elemBaseTmp, operand.argumentExpression, f64Op, mode);
    }

    if (objResult.kind !== "ref" && objResult.kind !== "ref_null") {
      // Non-ref element access (numeric/i32 base): gracefully emit NaN.
      // #1720 — still evaluate the property-key expression for its side effects
      // (a numeric base can't be null, so no TypeError path applies here).
      fctx.body.push({ op: "drop" });
      const keyResult = compileExpression(ctx, fctx, operand.argumentExpression);
      if (keyResult) fctx.body.push({ op: "drop" });
      reportSilentFallback(ctx, "const-fallback", "unary-updates:incdec-nonref-element-access", operand);
      fctx.body.push({ op: "f64.const", value: NaN });
      return { kind: "f64" };
    }

    // Save object to a temp local early so the stack is clean for fallback paths
    const elemObjTmp = allocLocal(fctx, `__incdec_eobj_${fctx.locals.length}`, objResult);
    fctx.body.push({ op: "local.set", index: elemObjTmp });

    const typeIdx = (objResult as { typeIdx: number }).typeIdx;
    const typeDef = ctx.mod.types[typeIdx];

    // String/numeric literal index on a plain struct — resolve to field
    if (typeDef?.kind === "struct") {
      const isVec =
        typeDef.fields.length === 2 && typeDef.fields[0]?.name === "length" && typeDef.fields[1]?.name === "data";

      if (!isVec) {
        // Plain struct: resolve field by name
        let fieldName: string | undefined;
        if (ts.isStringLiteral(operand.argumentExpression)) {
          fieldName = operand.argumentExpression.text;
        } else if (ts.isNumericLiteral(operand.argumentExpression)) {
          fieldName = operand.argumentExpression.text;
        }

        if (fieldName) {
          const fieldIdx = typeDef.fields.findIndex((f: { name: string }) => f.name === fieldName);
          if (fieldIdx !== -1) {
            const fieldType = typeDef.fields[fieldIdx]!.type;

            // Read current value
            fctx.body.push({ op: "local.get", index: elemObjTmp });
            fctx.body.push({ op: "struct.get", typeIdx, fieldIdx });

            if (fieldType.kind !== "f64") {
              coerceType(ctx, fctx, fieldType, { kind: "f64" });
            }

            if (mode === "postfix") {
              const oldTmp = allocLocal(fctx, `__incdec_old_${fctx.locals.length}`, { kind: "f64" });
              fctx.body.push({ op: "local.tee", index: oldTmp });
              fctx.body.push({ op: "f64.const", value: 1 });
              fctx.body.push({ op: f64Op });
              if (fieldType.kind !== "f64") coerceType(ctx, fctx, { kind: "f64" }, fieldType);
              const newTmp = allocLocal(fctx, `__incdec_new_${fctx.locals.length}`, fieldType);
              fctx.body.push({ op: "local.set", index: newTmp });
              fctx.body.push({ op: "local.get", index: elemObjTmp });
              fctx.body.push({ op: "local.get", index: newTmp });
              fctx.body.push({ op: "struct.set", typeIdx, fieldIdx });
              fctx.body.push({ op: "local.get", index: oldTmp });
              return { kind: "f64" };
            } else {
              fctx.body.push({ op: "f64.const", value: 1 });
              fctx.body.push({ op: f64Op });
              const newTmp = allocLocal(fctx, `__incdec_new_${fctx.locals.length}`, { kind: "f64" });
              fctx.body.push({ op: "local.set", index: newTmp });
              fctx.body.push({ op: "local.get", index: elemObjTmp });
              fctx.body.push({ op: "local.get", index: newTmp });
              if (fieldType.kind !== "f64") coerceType(ctx, fctx, { kind: "f64" }, fieldType);
              fctx.body.push({ op: "struct.set", typeIdx, fieldIdx });
              fctx.body.push({ op: "local.get", index: newTmp });
              return { kind: "f64" };
            }
          }
        }
      }

      // Vec struct: arr[i]++ — array element increment/decrement
      if (isVec) {
        const objTmp = elemObjTmp;

        // Compile index
        const idxResult = compileExpression(ctx, fctx, operand.argumentExpression);
        if (!idxResult) return null;
        // Convert index to i32
        if (idxResult.kind === "f64") {
          fctx.body.push({ op: "i32.trunc_sat_f64_s" });
        }
        const idxTmp = allocLocal(fctx, `__incdec_idx_${fctx.locals.length}`, {
          kind: "i32",
        });
        fctx.body.push({ op: "local.set", index: idxTmp });

        // Get the data array
        const dataFieldType = typeDef.fields[1]!.type;
        const arrayTypeIdx = (dataFieldType as { typeIdx: number }).typeIdx;
        const arrayDef = ctx.mod.types[arrayTypeIdx];
        const elemType = arrayDef && arrayDef.kind === "array" ? arrayDef.element : { kind: "f64" as const };

        // Read current value: arr.data[idx] (bounds-checked)
        fctx.body.push({ op: "local.get", index: objTmp });
        fctx.body.push({ op: "struct.get", typeIdx, fieldIdx: 1 });
        fctx.body.push({ op: "local.get", index: idxTmp });
        emitBoundsCheckedArrayGet(fctx, arrayTypeIdx, elemType);

        // Coerce to f64 for arithmetic if needed
        if (elemType.kind !== "f64" && elemType.kind !== "i32") {
          coerceType(ctx, fctx, elemType, { kind: "f64" });
        }

        const numType = ctx.fast && elemType.kind === "i32" ? ("i32" as const) : ("f64" as const);
        const op = numType === "i32" ? i32Op : f64Op;

        // (#3024) A non-fast i32 element is read raw (the coerce above skips
        // i32) but the arithmetic below runs in f64 — widen the read so the
        // local.tee/f64.add sequence sees an f64, not an i32 (invalid Wasm).
        if (elemType.kind === "i32" && numType === "f64") {
          fctx.body.push({ op: "f64.convert_i32_s" });
        }

        // (#3024) The write-back below stores `newTmp` (an f64/i32 NUMERIC
        // local) straight into the element array. When the element rep is not
        // that numeric kind (externref elements — `arguments[i]++`, `any[]`
        // increments — or i64/packed reps), the raw store is INVALID Wasm
        // (`array.set expected externref, found local.get of type f64`).
        // Route the new value through coerceType into a properly-typed local
        // and store THAT. Byte-inert when elemType already matches numType.
        const makeStoreLocal = (newTmp: number): number => {
          if (elemType.kind === numType) return newTmp;
          // (#4216) Packed i8/i16 elements: coerceType leaves an i32 on the
          // stack (array.set takes i32 for packed storage), and a LOCAL may
          // never be declared with a packed kind — widen the declared type.
          const storeTmp = allocLocal(fctx, `__incdec_store_${fctx.locals.length}`, unpackedElemType(elemType));
          fctx.body.push({ op: "local.get", index: newTmp });
          coerceType(ctx, fctx, { kind: numType }, elemType);
          fctx.body.push({ op: "local.set", index: storeTmp });
          return storeTmp;
        };

        if (mode === "postfix") {
          const oldTmp = allocLocal(fctx, `__incdec_old_${fctx.locals.length}`, { kind: numType });
          fctx.body.push({ op: "local.tee", index: oldTmp });
          if (numType === "i32") {
            fctx.body.push({ op: "i32.const", value: 1 });
          } else {
            fctx.body.push({ op: "f64.const", value: 1 });
          }
          fctx.body.push({ op });
          const newTmp = allocLocal(fctx, `__incdec_new_${fctx.locals.length}`, { kind: numType });
          fctx.body.push({ op: "local.set", index: newTmp });
          // Store: arr.data[idx] = new (bounds-guarded)
          emitBoundsGuardedArraySet(fctx, objTmp, typeIdx, idxTmp, makeStoreLocal(newTmp), arrayTypeIdx);
          fctx.body.push({ op: "local.get", index: oldTmp });
          return { kind: numType };
        } else {
          if (numType === "i32") {
            fctx.body.push({ op: "i32.const", value: 1 });
          } else {
            fctx.body.push({ op: "f64.const", value: 1 });
          }
          fctx.body.push({ op });
          const newTmp = allocLocal(fctx, `__incdec_new_${fctx.locals.length}`, { kind: numType });
          fctx.body.push({ op: "local.set", index: newTmp });
          // Store: arr.data[idx] = new (bounds-guarded)
          emitBoundsGuardedArraySet(fctx, objTmp, typeIdx, idxTmp, makeStoreLocal(newTmp), arrayTypeIdx);
          fctx.body.push({ op: "local.get", index: newTmp });
          return { kind: numType };
        }
      }
    }
  }

  // Unsupported operand kind — gracefully emit NaN instead of hard error
  // (#2666 NOTE: computed-key `obj[keyExpr]++`/`--` on an object is NOT handled
  // here — it routes to NaN or the externref arm above. Wiring ToPropertyKey-once
  // through the host get/set for inc/dec is entangled with the #2659-family
  // struct-slot-vs-sidecar asymmetry (an `__extern_set` to a typed-struct object
  // updates the sidecar but `o.x` reads the slot), and most `obj[strKey]++` cases
  // are ALREADY broken on main independent of ToPropertyKey — so inc/dec is a
  // scoped FOLLOW-UP. The compound-assignment path `obj[keyExpr] op= rhs` IS
  // fixed for ToPropertyKey-once in this change.)
  reportSilentFallback(ctx, "const-fallback", "unary-updates:incdec-unsupported-operand", operand);
  fctx.body.push({ op: "f64.const", value: NaN });
  return { kind: "f64" };
}

/**
 * Compile a prefix UpdateExpression: `++x` or `--x` on any target shape
 * (identifier, property access, element access, boxed capture, global).
 *
 * Caller must have already established that `expr.operator` is either
 * `PlusPlusToken` or `MinusMinusToken`.
 */
/**
 * (#3039) `++x` / `--x` / `x++` / `x--` on a BOXED captured global — a
 * transitively-captured mutable var an accessor/method body updates. Reads and
 * writes THROUGH the ref cell (never the raw box global). Numeric-only: the
 * cell value is promoted to f64, incremented, coerced back to the cell type.
 * Returns f64 (prefix → new value, postfix → old value), matching the module /
 * captured-global inc/dec sites.
 */
function emitCapturedBoxGlobalIncDec(
  ctx: CodegenContext,
  fctx: FunctionContext,
  entry: { globalIdx: number; refCellTypeIdx: number; valType: ValType },
  arithOp: "f64.add" | "f64.sub",
  isPrefix: boolean,
): ValType {
  // Read the current cell value and promote to f64.
  emitCapturedBoxGlobalRead(ctx, fctx, entry);
  if (entry.valType.kind !== "f64") coerceType(ctx, fctx, entry.valType, { kind: "f64" });
  const oldF64 = allocLocal(fctx, `__box_ginc_old_${fctx.locals.length}`, { kind: "f64" });
  fctx.body.push({ op: "local.tee", index: oldF64 });
  fctx.body.push({ op: "f64.const", value: 1 });
  fctx.body.push({ op: arithOp });
  const newF64 = allocLocal(fctx, `__box_ginc_new_${fctx.locals.length}`, { kind: "f64" });
  fctx.body.push({ op: "local.tee", index: newF64 });
  // Coerce the new f64 back to the cell type and write it through the box.
  if (entry.valType.kind !== "f64") coerceType(ctx, fctx, { kind: "f64" }, entry.valType);
  const newVal = allocLocal(fctx, `__box_ginc_val_${fctx.locals.length}`, entry.valType);
  fctx.body.push({ op: "local.set", index: newVal });
  emitCapturedBoxGlobalWrite(fctx, entry, newVal);
  fctx.body.push({ op: "local.get", index: isPrefix ? newF64 : oldF64 });
  return { kind: "f64" };
}

function compilePrefixUpdate(
  ctx: CodegenContext,
  fctx: FunctionContext,
  expr: ts.PrefixUnaryExpression,
): ValType | null {
  // §13.4 + Annex B.3.9: evaluate a sloppy-mode call target, then throw.
  if (emitWebCompatCallAssignmentTarget(ctx, fctx, expr.operand)) return { kind: "f64" };
  // §13.4 / §7.1.3 — ++/-- on a Symbol throws TypeError before the update step.
  if (emitSymbolUpdateThrow(ctx, fctx, expr.operand)) {
    return { kind: "f64" };
  }
  // §13.4.4 GetValue on an unresolvable Reference (update-unresolvable-ref.ts).
  const unresolvablePre = tryEmitUnresolvableUpdateThrow(ctx, fctx, unwrapParens(expr.operand));
  if (unresolvablePre !== undefined) return unresolvablePre;
  switch (expr.operator) {
    case ts.SyntaxKind.PlusPlusToken: {
      const ppOperand = unwrapParens(expr.operand);
      if (ts.isIdentifier(ppOperand)) {
        const w = compileWithUpdateExpression(ctx, fctx, ppOperand, /*increment*/ true, /*prefix*/ true);
        if (w !== undefined) return w;
      }
      if (ts.isIdentifier(ppOperand) && fctx.constBindings?.has(ppOperand.text)) {
        emitThrowTypeError(ctx, fctx, "Assignment to constant variable.");
        fctx.body.push({ op: "unreachable" });
        return { kind: "f64" };
      }
      if (ts.isIdentifier(ppOperand)) {
        if (fctx.localMap.get(ppOperand.text) === undefined) {
          // (#3039) ++x on a boxed captured global — update through the cell.
          const ppBox = getCapturedBoxGlobal(ctx, ppOperand.text);
          if (ppBox !== undefined) return emitCapturedBoxGlobalIncDec(ctx, fctx, ppBox, "f64.add", true);
        }
        const idx = fctx.localMap.get(ppOperand.text);
        if (idx !== undefined) {
          const boxedPP = fctx.boxedCaptures?.get(ppOperand.text);
          if (boxedPP) {
            // ++x through ref cell (null-guarded #702)
            // For non-numeric boxed types (externref, ref_null, i64), coerce to f64
            // before arithmetic to avoid f64.add on non-f64 operand (#816)
            const needsCoerce = boxedPP.valType.kind !== "f64" && boxedPP.valType.kind !== "i32";
            if (needsCoerce) {
              const ppF64Tmp = allocLocal(fctx, `__pp_f64_${fctx.locals.length}`, { kind: "f64" });
              const ppNewTmp = allocLocal(fctx, `__pp_new_${fctx.locals.length}`, boxedPP.valType);
              // Build else-branch using savedBody pattern so coerceType can push freely
              const savedBody = fctx.body;
              const elseBranch: Instr[] = [];
              fctx.body = elseBranch;
              fctx.body.push({ op: "local.get", index: idx });
              fctx.body.push({
                op: "struct.get",
                typeIdx: boxedPP.refCellTypeIdx,
                fieldIdx: 0,
              });
              coerceType(ctx, fctx, boxedPP.valType, { kind: "f64" });
              fctx.body.push({ op: "f64.const", value: 1 });
              fctx.body.push({ op: "f64.add" });
              fctx.body.push({ op: "local.tee", index: ppF64Tmp });
              coerceType(ctx, fctx, { kind: "f64" }, boxedPP.valType);
              fctx.body.push({ op: "local.set", index: ppNewTmp });
              fctx.body.push({ op: "local.get", index: idx });
              fctx.body.push({ op: "local.get", index: ppNewTmp });
              fctx.body.push({
                op: "struct.set",
                typeIdx: boxedPP.refCellTypeIdx,
                fieldIdx: 0,
              });
              fctx.body.push({ op: "local.get", index: ppF64Tmp });
              fctx.body = savedBody;
              fctx.body.push({ op: "local.get", index: idx });
              fctx.body.push({ op: "ref.is_null" });
              fctx.body.push({
                op: "if",
                blockType: { kind: "val" as const, type: { kind: "f64" } },
                then: [{ op: "f64.const", value: NaN }],
                else: elseBranch,
              });
              return { kind: "f64" };
            }
            const ppTmp = allocLocal(fctx, `__pp_${fctx.locals.length}`, boxedPP.valType);
            fctx.body.push({ op: "local.get", index: idx });
            fctx.body.push({ op: "ref.is_null" });
            fctx.body.push({
              op: "if",
              blockType: { kind: "val" as const, type: boxedPP.valType },
              then: defaultValueInstrs(boxedPP.valType),
              else: [
                { op: "local.get", index: idx },
                { op: "local.get", index: idx },
                {
                  op: "struct.get",
                  typeIdx: boxedPP.refCellTypeIdx,
                  fieldIdx: 0,
                },
                ...((boxedPP.valType.kind === "i32"
                  ? [{ op: "i32.const", value: 1 }, { op: "i32.add" }]
                  : [{ op: "f64.const", value: 1 }, { op: "f64.add" }]) satisfies Instr[]),
                { op: "local.tee", index: ppTmp },
                {
                  op: "struct.set",
                  typeIdx: boxedPP.refCellTypeIdx,
                  fieldIdx: 0,
                },
                { op: "local.get", index: ppTmp },
              ],
            });
            return boxedPP.valType;
          }
          const localType = getLocalType(fctx, idx);
          if (localType?.kind === "i32") {
            fctx.body.push({ op: "local.get", index: idx });
            fctx.body.push({ op: "i32.const", value: 1 });
            fctx.body.push({ op: "i32.add" });
            fctx.body.push({ op: "local.tee", index: idx });
            emitMappedArgParamSync(ctx, fctx, idx, { kind: "i32" });
            return { kind: "i32" };
          }
          if (localType?.kind === "externref") {
            fctx.body.push({ op: "local.get", index: idx });
            emitToNumericForUpdate(ctx, fctx);
            fctx.body.push({ op: "f64.const", value: 1 });
            fctx.body.push({ op: "f64.add" });
            addUnionImports(ctx);
            fctx.body.push({
              op: "call",
              funcIdx: ctx.funcMap.get("__box_number")!,
            });
            fctx.body.push({ op: "local.tee", index: idx });
            emitMappedArgParamSync(ctx, fctx, idx, { kind: "externref" });
            return { kind: "externref" };
          }
          if (localType?.kind === "ref" || localType?.kind === "ref_null") {
            fctx.body.push({ op: "local.get", index: idx });
            coerceType(ctx, fctx, localType!, { kind: "f64" });
            fctx.body.push({ op: "f64.const", value: 1 });
            fctx.body.push({ op: "f64.add" });
            return { kind: "f64" };
          }
          if (localType?.kind === "i64") {
            fctx.body.push({ op: "local.get", index: idx });
            fctx.body.push({ op: "i64.const", value: 1n });
            fctx.body.push({ op: "i64.add" });
            fctx.body.push({ op: "local.tee", index: idx });
            emitMappedArgParamSync(ctx, fctx, idx, { kind: "i64" });
            return { kind: "i64" };
          }
          fctx.body.push({ op: "local.get", index: idx });
          fctx.body.push({ op: "f64.const", value: 1 });
          fctx.body.push({ op: "f64.add" });
          fctx.body.push({ op: "local.tee", index: idx });
          emitMappedArgParamSync(ctx, fctx, idx, { kind: "f64" });
          return { kind: "f64" };
        }
        // Check module globals for prefix ++
        const ppModIdx = ctx.moduleGlobals.get(ppOperand.text);
        if (ppModIdx !== undefined) {
          return compileGlobalIncDec(ctx, fctx, ppModIdx, "f64.add", "prefix");
        }
        // Check captured globals for prefix ++
        const ppCapIdx = ctx.capturedGlobals.get(ppOperand.text);
        if (ppCapIdx !== undefined) {
          const ppCapGlobalDef = ctx.mod.globals[localGlobalIdx(ctx, ppCapIdx)];
          if (ppCapGlobalDef?.type.kind === "externref") {
            fctx.body.push({ op: "global.get", index: ppCapIdx });
            emitToNumericForUpdate(ctx, fctx);
            fctx.body.push({ op: "f64.const", value: 1 });
            fctx.body.push({ op: "f64.add" });
            addUnionImports(ctx);
            fctx.body.push({
              op: "call",
              funcIdx: ctx.funcMap.get("__box_number")!,
            });
            fctx.body.push({ op: "global.set", index: ppCapIdx });
            fctx.body.push({ op: "global.get", index: ppCapIdx });
            return { kind: "externref" };
          }
          if (ppCapGlobalDef && (ppCapGlobalDef.type.kind === "ref" || ppCapGlobalDef.type.kind === "ref_null")) {
            fctx.body.push({ op: "global.get", index: ppCapIdx });
            coerceType(ctx, fctx, ppCapGlobalDef.type, { kind: "f64" });
            fctx.body.push({ op: "f64.const", value: 1 });
            fctx.body.push({ op: "f64.add" });
            return { kind: "f64" };
          }
          // (#4079) f64 OR i32 backing slot — see compileGlobalIncDec.
          return compileGlobalIncDec(ctx, fctx, ppCapIdx, "f64.add", "prefix");
        }
        // (#3966) sloppy implicit global — see the postfix arm below.
        if (isSloppyImplicitGlobalBinding(ctx, fctx, ppOperand.text)) {
          const implicit = tryEmitImplicitGlobalIncDec(ctx, fctx, ppOperand.text, "f64.add", "prefix");
          if (implicit !== undefined) return implicit;
        }
      }
      // ++obj.prop or ++obj[idx] — delegate to member increment helper
      return compileMemberIncDec(ctx, fctx, expr.operand, "add", "prefix");
    }
    case ts.SyntaxKind.MinusMinusToken: {
      const isIncrement = false;
      const arithOp = isIncrement ? "f64.add" : "f64.sub";
      const arithOpI32 = isIncrement ? "i32.add" : "i32.sub";

      const mmOperand = unwrapParens(expr.operand);
      if (ts.isIdentifier(mmOperand)) {
        const w = compileWithUpdateExpression(ctx, fctx, mmOperand, /*increment*/ false, /*prefix*/ true);
        if (w !== undefined) return w;
      }
      if (ts.isIdentifier(mmOperand) && fctx.constBindings?.has(mmOperand.text)) {
        emitThrowTypeError(ctx, fctx, "Assignment to constant variable.");
        fctx.body.push({ op: "unreachable" });
        return { kind: "f64" };
      }
      if (ts.isIdentifier(mmOperand)) {
        if (fctx.localMap.get(mmOperand.text) === undefined) {
          // (#3039) --x on a boxed captured global — update through the cell.
          const mmBox = getCapturedBoxGlobal(ctx, mmOperand.text);
          if (mmBox !== undefined) return emitCapturedBoxGlobalIncDec(ctx, fctx, mmBox, "f64.sub", true);
        }
        const idx = fctx.localMap.get(mmOperand.text);
        if (idx !== undefined) {
          const boxed = fctx.boxedCaptures?.get(mmOperand.text);
          if (boxed) {
            // ++x / --x through ref cell (null-guarded #702)
            // For non-numeric boxed types (externref, ref_null, i64), coerce to f64
            // before arithmetic to avoid f64.sub on non-f64 operand (#816)
            const needsCoerce = boxed.valType.kind !== "f64" && boxed.valType.kind !== "i32";
            if (needsCoerce) {
              const mmF64Tmp = allocLocal(fctx, `__mm_f64_${fctx.locals.length}`, { kind: "f64" });
              const mmNewTmp = allocLocal(fctx, `__mm_new_${fctx.locals.length}`, boxed.valType);
              // Build else-branch using savedBody pattern so coerceType can push freely
              const savedBody = fctx.body;
              const elseBranch: Instr[] = [];
              fctx.body = elseBranch;
              fctx.body.push({ op: "local.get", index: idx });
              fctx.body.push({
                op: "struct.get",
                typeIdx: boxed.refCellTypeIdx,
                fieldIdx: 0,
              });
              coerceType(ctx, fctx, boxed.valType, { kind: "f64" });
              fctx.body.push({ op: "f64.const", value: 1 });
              fctx.body.push({ op: arithOp });
              fctx.body.push({ op: "local.tee", index: mmF64Tmp });
              coerceType(ctx, fctx, { kind: "f64" }, boxed.valType);
              fctx.body.push({ op: "local.set", index: mmNewTmp });
              fctx.body.push({ op: "local.get", index: idx });
              fctx.body.push({ op: "local.get", index: mmNewTmp });
              fctx.body.push({
                op: "struct.set",
                typeIdx: boxed.refCellTypeIdx,
                fieldIdx: 0,
              });
              fctx.body.push({ op: "local.get", index: mmF64Tmp });
              fctx.body = savedBody;
              fctx.body.push({ op: "local.get", index: idx });
              fctx.body.push({ op: "ref.is_null" });
              fctx.body.push({
                op: "if",
                blockType: { kind: "val" as const, type: { kind: "f64" } },
                then: [{ op: "f64.const", value: NaN }],
                else: elseBranch,
              });
              return { kind: "f64" };
            }
            const tmp = allocLocal(fctx, `__pp_${fctx.locals.length}`, boxed.valType);
            fctx.body.push({ op: "local.get", index: idx });
            fctx.body.push({ op: "ref.is_null" });
            fctx.body.push({
              op: "if",
              blockType: { kind: "val" as const, type: boxed.valType },
              then: defaultValueInstrs(boxed.valType),
              else: [
                { op: "local.get", index: idx },
                { op: "local.get", index: idx },
                {
                  op: "struct.get",
                  typeIdx: boxed.refCellTypeIdx,
                  fieldIdx: 0,
                },
                ...((boxed.valType.kind === "i32"
                  ? [{ op: "i32.const", value: 1 }, { op: arithOpI32 }]
                  : [{ op: "f64.const", value: 1 }, { op: arithOp }]) satisfies Instr[]),
                { op: "local.tee", index: tmp },
                {
                  op: "struct.set",
                  typeIdx: boxed.refCellTypeIdx,
                  fieldIdx: 0,
                },
                { op: "local.get", index: tmp },
              ],
            });
            return boxed.valType;
          }
          const localType = getLocalType(fctx, idx);
          if (localType?.kind === "i32") {
            fctx.body.push({ op: "local.get", index: idx });
            fctx.body.push({ op: "i32.const", value: 1 });
            fctx.body.push({ op: arithOpI32 });
            fctx.body.push({ op: "local.tee", index: idx });
            emitMappedArgParamSync(ctx, fctx, idx, { kind: "i32" });
            return { kind: "i32" };
          }
          if (localType?.kind === "externref") {
            fctx.body.push({ op: "local.get", index: idx });
            emitToNumericForUpdate(ctx, fctx);
            fctx.body.push({ op: "f64.const", value: 1 });
            fctx.body.push({ op: arithOp });
            addUnionImports(ctx);
            fctx.body.push({
              op: "call",
              funcIdx: ctx.funcMap.get("__box_number")!,
            });
            fctx.body.push({ op: "local.tee", index: idx });
            emitMappedArgParamSync(ctx, fctx, idx, { kind: "externref" });
            return { kind: "externref" };
          }
          if (localType?.kind === "ref" || localType?.kind === "ref_null") {
            fctx.body.push({ op: "local.get", index: idx });
            coerceType(ctx, fctx, localType!, { kind: "f64" });
            fctx.body.push({ op: "f64.const", value: 1 });
            fctx.body.push({ op: arithOp });
            return { kind: "f64" };
          }
          if (localType?.kind === "i64") {
            fctx.body.push({ op: "local.get", index: idx });
            fctx.body.push({ op: "i64.const", value: 1n });
            fctx.body.push({ op: isIncrement ? "i64.add" : "i64.sub" });
            fctx.body.push({ op: "local.tee", index: idx });
            emitMappedArgParamSync(ctx, fctx, idx, { kind: "i64" });
            return { kind: "i64" };
          }
          fctx.body.push({ op: "local.get", index: idx });
          fctx.body.push({ op: "f64.const", value: 1 });
          fctx.body.push({ op: arithOp });
          fctx.body.push({ op: "local.tee", index: idx });
          emitMappedArgParamSync(ctx, fctx, idx, { kind: "f64" });
          return { kind: "f64" };
        }
        // Check module globals for prefix --
        const mmModIdx = ctx.moduleGlobals.get(mmOperand.text);
        if (mmModIdx !== undefined) {
          return compileGlobalIncDec(ctx, fctx, mmModIdx, arithOp, "prefix");
        }
        // Check captured globals for prefix --
        const mmCapIdx = ctx.capturedGlobals.get(mmOperand.text);
        if (mmCapIdx !== undefined) {
          const mmCapGlobalDef = ctx.mod.globals[localGlobalIdx(ctx, mmCapIdx)];
          if (mmCapGlobalDef?.type.kind === "externref") {
            fctx.body.push({ op: "global.get", index: mmCapIdx });
            emitToNumericForUpdate(ctx, fctx);
            fctx.body.push({ op: "f64.const", value: 1 });
            fctx.body.push({ op: arithOp });
            addUnionImports(ctx);
            fctx.body.push({
              op: "call",
              funcIdx: ctx.funcMap.get("__box_number")!,
            });
            fctx.body.push({ op: "global.set", index: mmCapIdx });
            fctx.body.push({ op: "global.get", index: mmCapIdx });
            return { kind: "externref" };
          }
          if (mmCapGlobalDef && (mmCapGlobalDef.type.kind === "ref" || mmCapGlobalDef.type.kind === "ref_null")) {
            fctx.body.push({ op: "global.get", index: mmCapIdx });
            coerceType(ctx, fctx, mmCapGlobalDef.type, { kind: "f64" });
            fctx.body.push({ op: "f64.const", value: 1 });
            fctx.body.push({ op: arithOp });
            return { kind: "f64" };
          }
          // (#4079) f64 OR i32 backing slot — see compileGlobalIncDec.
          return compileGlobalIncDec(ctx, fctx, mmCapIdx, arithOp, "prefix");
        }
        // (#3966) sloppy implicit global — see the postfix arm below.
        if (isSloppyImplicitGlobalBinding(ctx, fctx, mmOperand.text)) {
          const implicit = tryEmitImplicitGlobalIncDec(ctx, fctx, mmOperand.text, arithOp, "prefix");
          if (implicit !== undefined) return implicit;
        }
      }
      // --obj.prop or --obj[idx] — delegate to member decrement helper
      return compileMemberIncDec(ctx, fctx, expr.operand, "sub", "prefix");
    }
  }

  reportError(ctx, expr, `Unsupported prefix update operator: ${ts.SyntaxKind[expr.operator]}`);
  return null;
}

function compilePostfixUnary(
  ctx: CodegenContext,
  fctx: FunctionContext,
  expr: ts.PostfixUnaryExpression,
): ValType | null {
  if (emitWebCompatCallAssignmentTarget(ctx, fctx, expr.operand)) {
    return { kind: "f64" };
  }
  // §13.4 / §7.1.3 — x++/x-- on a Symbol throws TypeError before the update step.
  if (emitSymbolUpdateThrow(ctx, fctx, expr.operand)) {
    return { kind: "f64" };
  }
  const isIncrement = expr.operator === ts.SyntaxKind.PlusPlusToken;
  const arithOp = isIncrement ? "f64.add" : "f64.sub";
  const arithOpI32 = isIncrement ? "i32.add" : "i32.sub";

  // Unwrap parenthesized expressions: (x)++ -> x++
  const postOperand = unwrapParens(expr.operand);

  // (#2663 Slice 3) `with` Object Environment Record precedence — see with-rmw.ts.
  if (ts.isIdentifier(postOperand)) {
    const w = compileWithUpdateExpression(ctx, fctx, postOperand, isIncrement, /*prefix*/ false);
    if (w !== undefined) return w;
  }
  // §13.4.5 GetValue on an unresolvable Reference (update-unresolvable-ref.ts).
  const unresolvablePost = tryEmitUnresolvableUpdateThrow(ctx, fctx, postOperand);
  if (unresolvablePost !== undefined) return unresolvablePost;

  if (!ts.isIdentifier(postOperand)) {
    // obj.prop++ or obj[idx]++ — delegate to member increment helper
    const memberOp = isIncrement ? "add" : "sub";
    return compileMemberIncDec(ctx, fctx, expr.operand, memberOp, "postfix");
  }

  if (ts.isIdentifier(postOperand)) {
    // const bindings — increment/decrement throws TypeError at runtime
    if (fctx.constBindings?.has(postOperand.text)) {
      emitThrowTypeError(ctx, fctx, "Assignment to constant variable.");
      fctx.body.push({ op: "unreachable" });
      return { kind: "f64" };
    }
    const idx = fctx.localMap.get(postOperand.text);
    if (idx === undefined) {
      // (#3039) x++/x-- on a boxed captured global — update through the cell,
      // returning the OLD numeric value (postfix semantics).
      const postBox = getCapturedBoxGlobal(ctx, postOperand.text);
      if (postBox !== undefined) return emitCapturedBoxGlobalIncDec(ctx, fctx, postBox, arithOp, false);
      // Check module globals for postfix ++/--
      const postModIdx = ctx.moduleGlobals.get(postOperand.text);
      if (postModIdx !== undefined) {
        return compileGlobalIncDec(ctx, fctx, postModIdx, arithOp, "postfix");
      }
      // Check captured globals for postfix ++/--
      const postCapIdx = ctx.capturedGlobals.get(postOperand.text);
      if (postCapIdx !== undefined) {
        const postCapGlobalDef = ctx.mod.globals[localGlobalIdx(ctx, postCapIdx)];
        if (postCapGlobalDef?.type.kind === "externref") {
          fctx.body.push({ op: "global.get", index: postCapIdx });
          emitToNumericForUpdate(ctx, fctx);
          const postCapOldTmp = allocLocal(fctx, `__post_cap_old_${fctx.locals.length}`, { kind: "f64" });
          fctx.body.push({ op: "local.tee", index: postCapOldTmp });
          fctx.body.push({ op: "f64.const", value: 1 });
          fctx.body.push({ op: arithOp });
          addUnionImports(ctx);
          fctx.body.push({
            op: "call",
            funcIdx: ctx.funcMap.get("__box_number")!,
          });
          fctx.body.push({ op: "global.set", index: postCapIdx });
          fctx.body.push({ op: "local.get", index: postCapOldTmp });
          return { kind: "f64" };
        }
        if (postCapGlobalDef && (postCapGlobalDef.type.kind === "ref" || postCapGlobalDef.type.kind === "ref_null")) {
          fctx.body.push({ op: "global.get", index: postCapIdx });
          coerceType(ctx, fctx, postCapGlobalDef.type, { kind: "f64" });
          return { kind: "f64" };
        }
        // (#4079) f64 OR i32 backing slot — see compileGlobalIncDec.
        return compileGlobalIncDec(ctx, fctx, postCapIdx, arithOp, "postfix");
      }
      // (#3966) A sloppy implicit global has real storage on the realm global
      // object; the `f64.const 0` fallback below dropped the store entirely.
      if (isSloppyImplicitGlobalBinding(ctx, fctx, postOperand.text)) {
        const implicit = tryEmitImplicitGlobalIncDec(ctx, fctx, postOperand.text, arithOp, "postfix");
        if (implicit !== undefined) return implicit;
      }
      // Graceful fallback: emit 0 for unknown postfix increment/decrement
      fctx.body.push({ op: "f64.const", value: 0 });
      return { kind: "f64" };
    }

    // Handle boxed (ref cell) mutable captures for postfix (null-guarded #702)
    const boxedPost = fctx.boxedCaptures?.get(postOperand.text);
    if (boxedPost) {
      // For non-numeric boxed types (externref, ref_null, i64), coerce to f64
      // before arithmetic to avoid f64.add/sub on non-f64 operand (#816)
      const needsCoerce = boxedPost.valType.kind !== "f64" && boxedPost.valType.kind !== "i32";
      if (needsCoerce) {
        const postOldF64 = allocLocal(fctx, `__postbox_f64_${fctx.locals.length}`, { kind: "f64" });
        const postNewTmp = allocLocal(fctx, `__postnew_${fctx.locals.length}`, boxedPost.valType);
        // Build else-branch using savedBody pattern so coerceType can push freely
        const savedBody = fctx.body;
        const elseBranch: Instr[] = [];
        fctx.body = elseBranch;
        fctx.body.push({ op: "local.get", index: idx });
        fctx.body.push({
          op: "struct.get",
          typeIdx: boxedPost.refCellTypeIdx,
          fieldIdx: 0,
        });
        coerceType(ctx, fctx, boxedPost.valType, { kind: "f64" });
        fctx.body.push({ op: "local.tee", index: postOldF64 });
        fctx.body.push({ op: "f64.const", value: 1 });
        fctx.body.push({ op: arithOp });
        coerceType(ctx, fctx, { kind: "f64" }, boxedPost.valType);
        fctx.body.push({ op: "local.set", index: postNewTmp });
        fctx.body.push({ op: "local.get", index: idx });
        fctx.body.push({ op: "local.get", index: postNewTmp });
        fctx.body.push({
          op: "struct.set",
          typeIdx: boxedPost.refCellTypeIdx,
          fieldIdx: 0,
        });
        fctx.body.push({ op: "local.get", index: postOldF64 });
        fctx.body = savedBody;
        fctx.body.push({ op: "local.get", index: idx });
        fctx.body.push({ op: "ref.is_null" });
        fctx.body.push({
          op: "if",
          blockType: { kind: "val" as const, type: { kind: "f64" } },
          then: [{ op: "f64.const", value: NaN }],
          else: elseBranch,
        });
        return { kind: "f64" };
      }
      const oldTmp = allocLocal(fctx, `__postbox_${fctx.locals.length}`, boxedPost.valType);
      fctx.body.push({ op: "local.get", index: idx });
      fctx.body.push({ op: "ref.is_null" });
      fctx.body.push({
        op: "if",
        blockType: { kind: "val" as const, type: boxedPost.valType },
        then: defaultValueInstrs(boxedPost.valType),
        else: [
          { op: "local.get", index: idx },
          {
            op: "struct.get",
            typeIdx: boxedPost.refCellTypeIdx,
            fieldIdx: 0,
          },
          { op: "local.tee", index: oldTmp },
          ...((boxedPost.valType.kind === "i32"
            ? [{ op: "i32.const", value: 1 }, { op: arithOpI32 }]
            : [{ op: "f64.const", value: 1 }, { op: arithOp }]) satisfies Instr[]),
          ...((): Instr[] => {
            const newTmp = allocLocal(fctx, `__postnew_${fctx.locals.length}`, boxedPost.valType);
            return [
              { op: "local.set", index: newTmp },
              { op: "local.get", index: idx },
              { op: "local.get", index: newTmp },
              {
                op: "struct.set",
                typeIdx: boxedPost.refCellTypeIdx,
                fieldIdx: 0,
              },
              { op: "local.get", index: oldTmp },
            ];
          })(),
        ],
      });
      return boxedPost.valType;
    }

    const localType = getLocalType(fctx, idx);
    if (localType?.kind === "i32") {
      fctx.body.push({ op: "local.get", index: idx });
      fctx.body.push({ op: "local.get", index: idx });
      fctx.body.push({ op: "i32.const", value: 1 });
      fctx.body.push({ op: arithOpI32 });
      fctx.body.push({ op: "local.set", index: idx });
      emitMappedArgParamSync(ctx, fctx, idx, { kind: "i32" });
      return { kind: "i32" };
    }

    if (localType?.kind === "externref") {
      fctx.body.push({ op: "local.get", index: idx });
      emitToNumericForUpdate(ctx, fctx);
      const tmpOld = allocLocal(fctx, `__postfix_old_${fctx.locals.length}`, {
        kind: "f64",
      });
      fctx.body.push({ op: "local.tee", index: tmpOld });
      fctx.body.push({ op: "f64.const", value: 1 });
      fctx.body.push({ op: arithOp });
      addUnionImports(ctx);
      fctx.body.push({ op: "call", funcIdx: ctx.funcMap.get("__box_number")! });
      fctx.body.push({ op: "local.set", index: idx });
      fctx.body.push({ op: "local.get", index: tmpOld });
      emitMappedArgParamSync(ctx, fctx, idx, { kind: "f64" });
      return { kind: "f64" };
    }

    if (localType?.kind === "ref" || localType?.kind === "ref_null") {
      fctx.body.push({ op: "local.get", index: idx });
      coerceType(ctx, fctx, localType!, { kind: "f64" });
      return { kind: "f64" };
    }

    if (localType?.kind === "i64") {
      fctx.body.push({ op: "local.get", index: idx });
      fctx.body.push({ op: "local.get", index: idx });
      fctx.body.push({ op: "i64.const", value: 1n });
      fctx.body.push({ op: isIncrement ? "i64.add" : "i64.sub" });
      fctx.body.push({ op: "local.set", index: idx });
      emitMappedArgParamSync(ctx, fctx, idx, { kind: "i64" });
      return { kind: "i64" };
    }

    fctx.body.push({ op: "local.get", index: idx });
    fctx.body.push({ op: "local.get", index: idx });
    fctx.body.push({ op: "f64.const", value: 1 });
    fctx.body.push({ op: arithOp });
    fctx.body.push({ op: "local.set", index: idx });
    emitMappedArgParamSync(ctx, fctx, idx, { kind: "f64" });
    return { kind: "f64" };
  }

  // obj.prop++ / obj.prop-- (property access target)
  if (ts.isPropertyAccessExpression(expr.operand)) {
    return compilePostfixIncrementProperty(ctx, fctx, expr.operand, isIncrement);
  }

  // arr[i]++ / arr[i]-- (element access target)
  if (ts.isElementAccessExpression(expr.operand)) {
    return compilePostfixIncrementElement(ctx, fctx, expr.operand, isIncrement);
  }

  reportError(ctx, expr, "Unsupported postfix unary target");
  return null;
}

/**
 * obj.prop++ / obj.prop--: get field, save OLD, increment, set field, return OLD value
 */
function compilePostfixIncrementProperty(
  ctx: CodegenContext,
  fctx: FunctionContext,
  target: ts.PropertyAccessExpression,
  isIncrement: boolean,
): ValType | null {
  const objType = ctx.checker.getTypeAtLocation(target.expression);
  const propName = ts.isPrivateIdentifier(target.name) ? "__priv_" + target.name.text.slice(1) : target.name.text;
  const typeName = resolveStructName(ctx, objType);
  if (!typeName) {
    reportError(ctx, target, `Cannot resolve struct for postfix increment on property: ${propName}`);
    return null;
  }
  const structTypeIdx = ctx.structMap.get(typeName);
  const fields = ctx.structFields.get(typeName);
  if (structTypeIdx === undefined || !fields) {
    reportError(ctx, target, `Unknown struct type for postfix increment: ${typeName}`);
    return null;
  }
  const fieldIdx = fields.findIndex((f) => f.name === propName);
  if (fieldIdx === -1) {
    // Unknown field — gracefully emit NaN (reading undefined property in numeric context)
    reportSilentFallback(ctx, "const-fallback", "unary-updates:postfix-incr-property-unknown-field", target);
    fctx.body.push({ op: "f64.const", value: NaN });
    return { kind: "f64" };
  }

  // Compile object ref and save
  const objResult = compileExpression(ctx, fctx, target.expression);
  if (!objResult) return null;
  const objLocal = allocLocal(fctx, `__postinc_obj_${fctx.locals.length}`, objResult);
  fctx.body.push({ op: "local.set", index: objLocal });

  // Get current field value
  fctx.body.push({ op: "local.get", index: objLocal });
  fctx.body.push({ op: "struct.get", typeIdx: structTypeIdx, fieldIdx });

  // Coerce to f64 if needed
  const fieldType = fields[fieldIdx]!.type;
  if (fieldType.kind !== "f64") {
    coerceType(ctx, fctx, fieldType, { kind: "f64" });
  }

  // Save OLD value
  const oldVal = allocLocal(fctx, `__postinc_old_${fctx.locals.length}`, {
    kind: "f64",
  });
  fctx.body.push({ op: "local.set", index: oldVal });

  // Compute new value
  fctx.body.push({ op: "local.get", index: oldVal });
  fctx.body.push({ op: "f64.const", value: 1 });
  fctx.body.push({ op: isIncrement ? "f64.add" : "f64.sub" });

  // Save new value for struct.set
  const newVal = allocLocal(fctx, `__postinc_new_${fctx.locals.length}`, {
    kind: "f64",
  });
  fctx.body.push({ op: "local.set", index: newVal });

  // Set field: obj, newValue -> struct.set
  fctx.body.push({ op: "local.get", index: objLocal });
  fctx.body.push({ op: "local.get", index: newVal });
  if (fieldType.kind !== "f64") {
    coerceType(ctx, fctx, { kind: "f64" }, fieldType);
  }
  fctx.body.push({ op: "struct.set", typeIdx: structTypeIdx, fieldIdx });

  // Return OLD value (postfix returns old value)
  fctx.body.push({ op: "local.get", index: oldVal });
  return { kind: "f64" };
}

/**
 * arr[i]++ / arr[i]--: get element, save OLD, increment, set element, return OLD value
 */
function compilePostfixIncrementElement(
  ctx: CodegenContext,
  fctx: FunctionContext,
  target: ts.ElementAccessExpression,
  isIncrement: boolean,
): ValType | null {
  // (#2709) `super[super()]++` is a SuperProperty UPDATE; reference resolution
  // runs GetThisBinding() FIRST (§13.3.7.1 step 2), throwing ReferenceError before
  // the inner super() (in the key) is evaluated. Emit that throw and stop so the
  // inner super() never runs. No-op for every other shape.
  if (
    target.expression.kind === ts.SyntaxKind.SuperKeyword &&
    emitSuperUninitializedThisGuard(ctx, fctx, target.argumentExpression)
  ) {
    return { kind: "f64" };
  }

  // #2045 C.8: linear-backed Uint8Array element update — read-modify-write the
  // linear memory directly. Postfix → old value. Falls through for any other.
  const linU8 = tryEmitLinearU8ElementUpdate(ctx, fctx, target, isIncrement, /* isPrefix */ false);
  if (linU8 !== null) return linU8;

  const arrType = compileExpression(ctx, fctx, target.expression);
  if (!arrType || (arrType.kind !== "ref" && arrType.kind !== "ref_null")) {
    reportError(ctx, target, "Postfix increment on non-array element access");
    return null;
  }
  const typeIdx = (arrType as { typeIdx: number }).typeIdx;
  const typeDef = ctx.mod.types[typeIdx];

  // String-literal bracket access on struct: obj["prop"]++
  if (typeDef?.kind === "struct" && ts.isStringLiteral(target.argumentExpression)) {
    const propName = target.argumentExpression.text;
    const fieldIdx = typeDef.fields.findIndex((f: { name: string }) => f.name === propName);
    if (fieldIdx !== -1) {
      const objLocal = allocLocal(fctx, `__postinc_obj_${fctx.locals.length}`, arrType);
      fctx.body.push({ op: "local.set", index: objLocal });

      fctx.body.push({ op: "local.get", index: objLocal });
      fctx.body.push({ op: "struct.get", typeIdx, fieldIdx });
      const fieldType = typeDef.fields[fieldIdx]!.type;
      if (fieldType.kind !== "f64") coerceType(ctx, fctx, fieldType, { kind: "f64" });
      const oldVal = allocLocal(fctx, `__postinc_old_${fctx.locals.length}`, {
        kind: "f64",
      });
      fctx.body.push({ op: "local.set", index: oldVal });
      fctx.body.push({ op: "local.get", index: oldVal });
      fctx.body.push({ op: "f64.const", value: 1 });
      fctx.body.push({ op: isIncrement ? "f64.add" : "f64.sub" });
      const newVal = allocLocal(fctx, `__postinc_new_${fctx.locals.length}`, {
        kind: "f64",
      });
      fctx.body.push({ op: "local.set", index: newVal });
      fctx.body.push({ op: "local.get", index: objLocal });
      fctx.body.push({ op: "local.get", index: newVal });
      if (fieldType.kind !== "f64") coerceType(ctx, fctx, { kind: "f64" }, fieldType);
      fctx.body.push({ op: "struct.set", typeIdx, fieldIdx });
      fctx.body.push({ op: "local.get", index: oldVal });
      return { kind: "f64" };
    }
  }

  // Vec struct (array wrapped in {length, data})
  const isVecStruct =
    typeDef?.kind === "struct" &&
    typeDef.fields.length === 2 &&
    typeDef.fields[0]?.name === "length" &&
    typeDef.fields[1]?.name === "data";
  if (isVecStruct) {
    const arrTypeIdx = getArrTypeIdxFromVec(ctx, typeIdx);
    const arrDef = ctx.mod.types[arrTypeIdx];
    if (!arrDef || arrDef.kind !== "array") {
      reportError(ctx, target, "Postfix increment: vec data is not array");
      return null;
    }
    const vecLocal = allocLocal(fctx, `__postinc_vec_${fctx.locals.length}`, arrType);
    fctx.body.push({ op: "local.set", index: vecLocal });
    const idxResult = compileExpression(ctx, fctx, target.argumentExpression, {
      kind: "f64",
    });
    if (!idxResult) return null;
    fctx.body.push({ op: "i32.trunc_sat_f64_s" });
    const idxLocal = allocLocal(fctx, `__postinc_idx_${fctx.locals.length}`, {
      kind: "i32",
    });
    fctx.body.push({ op: "local.set", index: idxLocal });

    const elemType = arrDef.element;

    // Bounds check: if idx < array.len, do read-modify-write; else produce NaN
    fctx.body.push({ op: "local.get", index: idxLocal });
    fctx.body.push({ op: "local.get", index: vecLocal });
    fctx.body.push({ op: "struct.get", typeIdx, fieldIdx: 1 });
    fctx.body.push({ op: "array.len" });
    fctx.body.push({ op: "i32.lt_u" });

    // Build the in-bounds branch: read old, compute new, write, return old
    const thenInstrs: Instr[] = [];
    thenInstrs.push({ op: "local.get", index: vecLocal });
    thenInstrs.push({ op: "struct.get", typeIdx, fieldIdx: 1 });
    thenInstrs.push({ op: "local.get", index: idxLocal });
    thenInstrs.push({ op: "array.get", typeIdx: arrTypeIdx });
    if (elemType.kind !== "f64") {
      const savedBody = fctx.body;
      fctx.body = thenInstrs as any;
      coerceType(ctx, fctx, elemType, { kind: "f64" });
      fctx.body = savedBody;
    }
    const oldVal = allocLocal(fctx, `__postinc_old_${fctx.locals.length}`, {
      kind: "f64",
    });
    thenInstrs.push({ op: "local.set", index: oldVal });
    // Compute new value
    thenInstrs.push({ op: "local.get", index: oldVal });
    thenInstrs.push({ op: "f64.const", value: 1 });
    thenInstrs.push({ op: isIncrement ? "f64.add" : "f64.sub" });
    // Coerce and write back
    const newVal = allocLocal(fctx, `__postinc_new_${fctx.locals.length}`, {
      kind: "f64",
    });
    thenInstrs.push({ op: "local.set", index: newVal });
    thenInstrs.push({ op: "local.get", index: vecLocal });
    thenInstrs.push({ op: "struct.get", typeIdx, fieldIdx: 1 });
    thenInstrs.push({ op: "local.get", index: idxLocal });
    thenInstrs.push({ op: "local.get", index: newVal });
    if (elemType.kind !== "f64") {
      const savedBody = fctx.body;
      fctx.body = thenInstrs as any;
      coerceType(ctx, fctx, { kind: "f64" }, elemType);
      fctx.body = savedBody;
    }
    thenInstrs.push({ op: "array.set", typeIdx: arrTypeIdx });
    // Return old value
    thenInstrs.push({ op: "local.get", index: oldVal });

    fctx.body.push({
      op: "if",
      blockType: { kind: "val" as const, type: { kind: "f64" as const } },
      then: thenInstrs,
      else: [{ op: "f64.const", value: NaN }],
    });

    return { kind: "f64" };
  }

  reportError(ctx, target, "Unsupported postfix increment element access target");
  return null;
}

export { compileMemberIncDec, compilePostfixUnary, compilePrefixUpdate };
