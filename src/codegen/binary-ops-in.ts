// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * The `key in obj` relational operator — extracted verbatim from
 * compileBinaryExpression in binary-ops.ts (#3280, WAVE C decomposition).
 * Handles: private-brand runtime check (`#x in obj`, #1365), `in` on a
 * statically-primitive RHS (§13.10.1 TypeError, #2741), vec (array) index
 * bounds check, static/dynamic key resolution against struct fields + the TS
 * type system, and the `__extern_has` host MOP route for externref/anyref
 * receivers (#1444). Every path returns; byte-identical lift — no behavioural
 * change (prove-emit-identity IDENTICAL across gc/standalone/wasi).
 */
import { ts } from "../ts-api.js";
import type { FieldDef, Instr, ValType } from "../ir/types.js";
import { popBody, pushBody } from "./context/bodies.js";
import { allocLocal, allocTempLocal, releaseTempLocal } from "./context/locals.js";
import type { CodegenContext, FunctionContext } from "./context/types.js";
import {
  emitPrivateBrandPredicate,
  emitThrowTypeError,
  resolveDeclaringClassForPrivateName,
} from "./expressions/helpers.js";
import { ensureLateImport } from "./expressions/late-imports.js";
import { resolveWasmType } from "./index.js";
// (#3920) Own-presence is a per-instance bit, never a shape property — the `in`
// answer must come from the same presence machinery the value read uses.
import { emitInPresence } from "./closed-struct-presence.js";
import type { InnerResult } from "./shared.js";
import { coerceType, compileExpression, flushLateImportShifts } from "./shared.js";
import { inRhsIsExclusivelyPrimitive } from "./binary-ops.js";
import { identifierIsWrittenTo } from "./native-ordinary-instanceof.js"; // (#4484) reassigned-binding guard
import { overlayRouteActive } from "./typed-lane-overlay-route.js"; // (#4222) overlay-aware index presence
import { vecNamedKeyNeedsRuntime } from "./vec-named-key-presence.js"; // (#4062) array expando presence

/**
 * (#3714) `emitThrowTypeError` pushes directly onto `fctx.body`; to nest its
 * throw sequence inside an `if` branch's `then:` instruction array, redirect
 * `fctx.body` to a scratch array via `pushBody`/`popBody`, capture what it
 * emitted, and hand that back as a plain `Instr[]`.
 */
function buildThrowTypeErrorBranch(ctx: CodegenContext, fctx: FunctionContext, message: string): Instr[] {
  const saved = pushBody(fctx);
  emitThrowTypeError(ctx, fctx, message);
  const throwInstrs = fctx.body;
  popBody(fctx, saved);
  return throwInstrs;
}

/**
 * Keep a dynamic `key in value` comparison on the JavaScript property surface.
 * Physical structs also contain compiler-only fields such as `__tag`; unlike
 * public TypeScript properties, the import collector intentionally has no
 * string constant for those fields.
 */
function publicPhysicalFieldNames(rightType: ts.Type, fields: FieldDef[]): string[] {
  const publicPropertyNames = new Set(rightType.getProperties().map((property) => property.name));
  return fields
    .map((field) => field.name)
    .filter((name): name is string => name !== undefined && publicPropertyNames.has(name));
}

/**
 * Compile a `key in obj` binary expression (op === InKeyword). Reads only the
 * codegen context, function context, and the expression node. Always returns.
 */
export function compileInOperator(ctx: CodegenContext, fctx: FunctionContext, expr: ts.BinaryExpression): InnerResult {
  // #1365 — `#x in obj` is a RUNTIME brand check, not a compile-time
  // property-name lookup. Per ES2022 §12.10.3 (RelationalExpression :
  // PrivateIdentifier `in` ShiftExpression) step 5, the result is `true` iff
  // `obj` carries the brand of the class that lexically declared `#x`,
  // `false` when `obj` is a DIFFERENT object, and a **TypeError** when `obj`
  // is not an Object at all (verified against real V8/Node: `null`,
  // `undefined`, and every primitive throw, not just `null` — #3714).
  //
  // Today the generic `in` path returns a compile-time `i32.const` based
  // on whether the receiver type's struct happens to have `__priv_<name>`
  // as a field. That conflates two unrelated classes both declaring a
  // private named the same — `#x in instanceOfDifferentClass` returns
  // true when it should return false.
  //
  // Fix: emit a runtime `ref.test` against the declaring class's struct.
  // Falls through to the legacy path if the resolver can't find the
  // declaring class (defensive — well-formed source always finds it).
  if (ts.isPrivateIdentifier(expr.left)) {
    const declared = resolveDeclaringClassForPrivateName(ctx, expr.left);
    if (declared) {
      // Compile the receiver. Coerce externref → anyref and save it so
      // the brand predicate can combine structural ref.test with class-tag
      // ancestry.
      const objResult = compileExpression(ctx, fctx, expr.right);
      const receiverIsExternref = objResult?.kind === "externref";
      // (#3714) When the receiver's static type is externref (the common
      // case for an untyped/`any` parameter), a WasmGC `ref.test` alone
      // cannot distinguish "a real object of the wrong class" (should stay
      // `false`) from "not an object at all" (should throw). Stash a raw
      // copy of the externref BEFORE `any.convert_extern` so the JS-host
      // fast-path check below can ask the host directly — Wasm has no
      // visibility into what an opaque externref wraps. A statically-typed
      // receiver (already known to be a struct/array/etc.) skips this
      // entirely: it's always an Object, no runtime ambiguity to resolve.
      let externCopy: number | undefined;
      if (receiverIsExternref && !ctx.standalone && !ctx.wasi) {
        externCopy = allocTempLocal(fctx, { kind: "externref" });
        fctx.body.push({ op: "local.tee", index: externCopy });
      }
      if (receiverIsExternref) {
        fctx.body.push({ op: "any.convert_extern" });
      }
      const tmpAny = allocTempLocal(fctx, { kind: "anyref" });
      fctx.body.push({ op: "local.set", index: tmpAny });
      emitPrivateBrandPredicate(ctx, fctx, tmpAny, declared.className, declared.structTypeIdx);
      const isObjectIdx =
        externCopy !== undefined
          ? ensureLateImport(ctx, "__extern_is_object", [{ kind: "externref" }], [{ kind: "i32" }])
          : undefined;
      if (externCopy !== undefined && isObjectIdx !== undefined) {
        const externCopyLocal: number = externCopy;
        const brandLocal = allocTempLocal(fctx, { kind: "i32" });
        fctx.body.push({ op: "local.set", index: brandLocal });
        fctx.body.push({ op: "local.get", index: brandLocal });
        fctx.body.push({ op: "i32.eqz" }); // brand check came back false
        fctx.body.push({
          op: "if",
          blockType: { kind: "empty" },
          then: [
            { op: "local.get", index: externCopyLocal },
            { op: "call", funcIdx: isObjectIdx },
            { op: "i32.eqz" }, // and the receiver is not an Object at all
            {
              op: "if",
              blockType: { kind: "empty" },
              then: buildThrowTypeErrorBranch(
                ctx,
                fctx,
                "Cannot use 'in' operator to search for private field in a non-object",
              ),
              else: [],
            },
          ],
          else: [],
        });
        fctx.body.push({ op: "local.get", index: brandLocal });
        releaseTempLocal(fctx, brandLocal);
        releaseTempLocal(fctx, externCopyLocal);
      } else if (externCopy !== undefined) {
        // Defensive: `ensureLateImport` failed (should not happen for a
        // brand-new import name). The brand predicate's i32 is already on
        // the stack from `emitPrivateBrandPredicate` above — just release
        // the unused externref copy and fall back to the pre-existing
        // false-no-throw behavior rather than failing the compile.
        releaseTempLocal(fctx, externCopy);
      }
      releaseTempLocal(fctx, tmpAny);
      return { kind: "i32" };
    }
    // No declaring class found — fall through to the legacy compile-time
    // path. The compile-time bool will be wrong but at least won't trap.
  }

  const rightType = ctx.checker.getTypeAtLocation(expr.right);
  let rightWasm = resolveWasmType(ctx, rightType);

  // (#2741) §13.10.1 step 5 — `key in rval` throws a **TypeError** when
  // `Type(rval)` is not Object. When the RHS static type is EXCLUSIVELY a
  // non-object primitive (number / string / boolean / bigint / symbol / null /
  // undefined, or a literal/union thereof), its runtime value can never be an
  // Object, so emit a runtime throw rather than statically folding to a boolean
  // (which is what the path below would do, e.g. `"toString" in true → true`).
  // Spec evaluation order (steps 1-4): evaluate the LHS (key) then the RHS for
  // side effects, THEN throw. `any` / `unknown` / object / `never` / a union
  // containing a non-primitive constituent are NOT caught here — they defer to
  // the runtime [[HasProperty]] / `__extern_has` path, which throws for a
  // genuinely-primitive runtime value via the native `key in obj`.
  // (#4484 D) …but only when the static type is EVIDENCE about the value here.
  // `var NUMBER = 0; (NUMBER = Number, "MAX_VALUE") in NUMBER` widens `NUMBER`
  // to `number` from its initializer and TS never narrows it back (the write is
  // a diagnostic that `skipSemanticDiagnostics` suppresses), so the fold threw
  // for an RHS holding the real `Number` constructor — a WRONG throw, catchable
  // (`S11.8.7_A2.4_T1`). Identical defect and identical guard as the
  // `instanceof` §13.10.2 step-1 fold in `compileHostInstanceOf`.
  const rhsIsReassignedBinding =
    ts.isIdentifier(expr.right) && identifierIsWrittenTo(expr.right.getSourceFile(), expr.right.text);
  if (!rhsIsReassignedBinding && inRhsIsExclusivelyPrimitive(rightType)) {
    const lt = compileExpression(ctx, fctx, expr.left);
    if (lt !== null) fctx.body.push({ op: "drop" });
    const rt = compileExpression(ctx, fctx, expr.right);
    if (rt !== null) fctx.body.push({ op: "drop" });
    emitThrowTypeError(ctx, fctx, "Cannot use 'in' operator to search for property in a non-object");
    return { kind: "i32" };
  }

  // (#2617) The TS type of a `new Proxy(...)`-bound identifier is its TARGET
  // type (ProxyConstructor returns T), so `resolveWasmType` yields the target
  // struct and the static `in` fold below would constant-fold `'k' in p` to
  // the target's field membership — never calling `__extern_has`, so a `has`
  // trap (incl. one that throws, #2617) never runs. But #2615 slots that
  // variable as `externref`. Trust the ACTUAL slot type: if the receiver is an
  // identifier whose local slot is externref/anyref, treat the RHS as externref
  // so the `in` routes through `__extern_has` (the host Proxy MOP).
  if (
    (rightWasm.kind === "ref" || rightWasm.kind === "ref_null") &&
    ts.isIdentifier(expr.right) &&
    fctx.localMap.has(expr.right.text)
  ) {
    const idx = fctx.localMap.get(expr.right.text)!;
    const entry = idx < fctx.params.length ? fctx.params[idx] : fctx.locals[idx - fctx.params.length];
    const slotType =
      entry && typeof entry === "object" && "type" in entry
        ? (entry as { type: ValType }).type
        : (entry as ValType | undefined);
    if (slotType?.kind === "externref" || slotType?.kind === "anyref") {
      rightWasm = slotType;
    }
  }

  // Get struct field names if available; detect vec (array) types
  let structFieldNames: string[] | null = null;
  let isVecType = false;
  let vecTypeIdx = -1;
  let structWasm: ValType | undefined; // (#3920) receiver's closed-struct type
  if (rightWasm.kind === "ref" || rightWasm.kind === "ref_null") {
    const typeIdx = (rightWasm as { typeIdx: number }).typeIdx;
    const structDef = ctx.mod.types[typeIdx];
    if (structDef?.kind === "struct") {
      if (structDef.name?.startsWith("__vec_")) {
        isVecType = true;
        vecTypeIdx = typeIdx;
      } else {
        structFieldNames = publicPhysicalFieldNames(rightType, structDef.fields);
        structWasm = rightWasm;
      }
    }
  }

  // Resolve the key to a compile-time string if possible.
  // For comma expressions like (x = y, "key"), extract the last element.
  // For PrivateIdentifier (#field in obj), extract the field name without '#'.
  let staticKey: string | null = null;
  const leftExpr: ts.Expression = expr.left;
  if (ts.isPrivateIdentifier(leftExpr)) {
    staticKey = leftExpr.text.startsWith("#") ? "__priv_" + leftExpr.text.slice(1) : leftExpr.text;
  } else if (ts.isStringLiteral(leftExpr)) {
    staticKey = leftExpr.text;
  } else if (ts.isNumericLiteral(leftExpr)) {
    staticKey = leftExpr.text;
  } else if (ts.isBinaryExpression(leftExpr) && leftExpr.operatorToken.kind === ts.SyntaxKind.CommaToken) {
    // Comma expression: extract the last element for the static key
    let last: ts.Expression = leftExpr.right;
    while (ts.isBinaryExpression(last) && last.operatorToken.kind === ts.SyntaxKind.CommaToken) {
      last = last.right;
    }
    if (ts.isStringLiteral(last)) {
      staticKey = last.text;
    } else if (ts.isNumericLiteral(last)) {
      staticKey = last.text;
    }
  } else if (ts.isParenthesizedExpression(leftExpr)) {
    // Parenthesized expression: unwrap and check for comma or literal
    const inner = leftExpr.expression;
    if (ts.isBinaryExpression(inner) && inner.operatorToken.kind === ts.SyntaxKind.CommaToken) {
      let last: ts.Expression = inner.right;
      while (ts.isBinaryExpression(last) && last.operatorToken.kind === ts.SyntaxKind.CommaToken) {
        last = last.right;
      }
      if (ts.isStringLiteral(last)) {
        staticKey = last.text;
      } else if (ts.isNumericLiteral(last)) {
        staticKey = last.text;
      }
    } else if (ts.isStringLiteral(inner)) {
      staticKey = inner.text;
    } else if (ts.isNumericLiteral(inner)) {
      staticKey = inner.text;
    }
  }

  // Also check the TypeScript type system for property existence.
  // This handles built-in constructors (Number.MAX_VALUE), prototype methods
  // (valueOf, toString), and dynamically assigned properties.
  let tsTypeHasProperty = false;
  if (staticKey !== null) {
    // Check direct properties on the TypeScript type
    const prop = rightType.getProperty(staticKey);
    if (prop) {
      tsTypeHasProperty = true;
    }
    // Check the right side's type for comma expressions too
    if (
      !tsTypeHasProperty &&
      ts.isBinaryExpression(expr.right) &&
      expr.right.operatorToken.kind === ts.SyntaxKind.CommaToken
    ) {
      let lastRight: ts.Expression = expr.right.right;
      while (ts.isBinaryExpression(lastRight) && lastRight.operatorToken.kind === ts.SyntaxKind.CommaToken) {
        lastRight = lastRight.right;
      }
      const lastRightType = ctx.checker.getTypeAtLocation(lastRight);
      const prop2 = lastRightType.getProperty(staticKey);
      if (prop2) tsTypeHasProperty = true;
    }
    // Also check apparent type (includes prototype methods like valueOf, toString)
    if (!tsTypeHasProperty) {
      const apparentType = ctx.checker.getApparentType(rightType);
      const apparentProp = apparentType.getProperty(staticKey);
      if (apparentProp) tsTypeHasProperty = true;
    }
  }

  // Array (vec) index bounds check: `index in arr` → 0 <= index < arr.length
  if (isVecType && staticKey !== null) {
    const numIdx = Number(staticKey);
    if (Number.isFinite(numIdx) && numIdx >= 0 && Number.isInteger(numIdx)) {
      // Evaluate left for side effects, drop result
      const leftResult = compileExpression(ctx, fctx, expr.left);
      if (leftResult) {
        fctx.body.push({ op: "drop" });
      }
      // (#4222) Under the overlay route the dense `numIdx < length` compare is
      // NOT the HasProperty answer: `delete arr[numIdx]` leaves `length`
      // untouched and records the absence as a `FLAG_DELETED_INDEX` companion
      // entry, and an accessor index may sit beyond the physical backing. Defer
      // to `__extern_has_idx`, the chokepoint whose overlay presence prologue
      // knows about both — the same typed→dynamic hand-off #4159 made for
      // element reads/writes. Route-inactive modules keep the inline compare
      // byte-for-byte.
      if (overlayRouteActive(ctx)) {
        const hasIdxFn = ensureLateImport(
          ctx,
          "__extern_has_idx",
          [{ kind: "externref" }, { kind: "f64" }],
          [{ kind: "i32" }],
        );
        flushLateImportShifts(ctx, fctx);
        if (hasIdxFn !== undefined) {
          const recvResult = compileExpression(ctx, fctx, expr.right);
          if (recvResult) {
            fctx.body.push({ op: "extern.convert_any" });
            fctx.body.push({ op: "f64.const", value: numIdx });
            fctx.body.push({ op: "call", funcIdx: hasIdxFn });
          } else {
            fctx.body.push({ op: "i32.const", value: 0 });
          }
          return { kind: "i32" };
        }
      }
      // Compile the array expression to get the vec struct
      const rightResult = compileExpression(ctx, fctx, expr.right);
      if (rightResult) {
        // Read length field (field 0 of vec struct)
        fctx.body.push({ op: "struct.get", typeIdx: vecTypeIdx, fieldIdx: 0 });
        // Compare: numIdx < length
        fctx.body.push({ op: "i32.const", value: numIdx });
        fctx.body.push({ op: "i32.gt_s" }); // length > index  <==>  index < length
      } else {
        fctx.body.push({ op: "i32.const", value: 0 });
      }
      return { kind: "i32" };
    }
    // Non-numeric key like "length" on array — check TS type
    if (staticKey === "length") {
      const leftResult = compileExpression(ctx, fctx, expr.left);
      if (leftResult) {
        fctx.body.push({ op: "drop" });
      }
      const rightResult = compileExpression(ctx, fctx, expr.right);
      if (rightResult) {
        fctx.body.push({ op: "drop" });
      }
      fctx.body.push({ op: "i32.const", value: 1 });
      return { kind: "i32" };
    }
  }

  // (#3920) BEFORE the fold below: a conditionally-assigned field is a
  // per-instance bit, not a shape property — see `closed-struct-presence.ts`.
  if (staticKey !== null && emitInPresence(ctx, fctx, structWasm, staticKey, expr.left, expr.right)) {
    return { kind: "i32" };
  }

  // Static resolution: key is known at compile time
  if (staticKey !== null) {
    const hasInStruct = structFieldNames !== null && structFieldNames.includes(staticKey);
    // (#2992 S6, standalone) A growable-object-literal receiver rides the
    // dynamic `$Object` representation, where a shape key may have been
    // DELETED at runtime — the checker-type fold (`tsTypeHasProperty`) is
    // unsound for it. Force the runtime `__extern_has` arm below (which the
    // slice-1 tombstone machinery answers correctly for both present and
    // deleted keys).
    const growableReceiver =
      ctx.standalone && ts.isIdentifier(expr.right) && ctx.growableObjectLiteralVars.has(expr.right.text);
    const has = !growableReceiver && (hasInStruct || tsTypeHasProperty);
    // (#1444) When RHS is externref/anyref AND static analysis came up empty
    // (no struct field, no TS-typed prop), the answer is NOT reliably false
    // — the host object may carry dynamic keys (e.g. regex `result.groups`).
    // Route through `__extern_has` for the real `in` check instead of
    // emitting an unconditional `false`.
    //
    // (#4062) The same reasoning reaches one receiver further: a STATICALLY-TYPED
    // array carrying a named expando (`a.foo = 7`) answers `7` on the read and
    // folded `false` here, because a vec's field list is `["length","data"]` and
    // the bag is invisible to both. `__extern_has`'s vec arm consults the #3251
    // overlay and the #3537 bag, so routing makes `in` agree with the read — and
    // only a folded `false` is routed, so no affirmative answer moves.
    const vecNamedKeyRoute = !has && vecNamedKeyNeedsRuntime(ctx, rightWasm, staticKey, 0);
    if (!has && (rightWasm.kind === "externref" || rightWasm.kind === "anyref" || vecNamedKeyRoute)) {
      const hasIdx = ensureLateImport(
        ctx,
        "__extern_has",
        [{ kind: "externref" }, { kind: "externref" }],
        [{ kind: "i32" }],
      );
      if (hasIdx !== undefined) {
        flushLateImportShifts(ctx, fctx);
        // (#2741) §13.10.1 evaluates the LHS (key, steps 1-2) BEFORE the RHS
        // (object, steps 3-4). Evaluate the key first into a temp, then the
        // object, then re-push the key so the call args are `(obj, key)`.
        // Use coerceType (not a bare extern.convert_any) so a non-ref key
        // (e.g. `Infinity` → f64) is boxed to externref via __box_number.
        const leftResult = compileExpression(ctx, fctx, expr.left, { kind: "externref" });
        if (leftResult === null) {
          fctx.body.push({ op: "ref.null.extern" });
        } else if (leftResult.kind !== "externref") {
          coerceType(ctx, fctx, leftResult, { kind: "externref" });
        }
        const keyTmp = allocTempLocal(fctx, { kind: "externref" });
        fctx.body.push({ op: "local.set", index: keyTmp });
        const rightResult = compileExpression(ctx, fctx, expr.right, { kind: "externref" });
        if (rightResult === null) {
          fctx.body.push({ op: "ref.null.extern" });
        } else if (rightResult.kind !== "externref") {
          coerceType(ctx, fctx, rightResult, { kind: "externref" });
        }
        fctx.body.push({ op: "local.get", index: keyTmp });
        releaseTempLocal(fctx, keyTmp);
        fctx.body.push({ op: "call", funcIdx: hasIdx });
        return { kind: "i32" };
      }
    }
    // Evaluate both operands for side effects (needed for comma expressions like
    // (NUMBER = Number, "MAX_VALUE") in NUMBER). Drop the produced values.
    const leftResult = compileExpression(ctx, fctx, expr.left);
    if (leftResult) {
      fctx.body.push({ op: "drop" });
    }
    const rightResult = compileExpression(ctx, fctx, expr.right);
    if (rightResult) {
      fctx.body.push({ op: "drop" });
    }
    fctx.body.push({ op: "i32.const", value: has ? 1 : 0 });
    return { kind: "i32" };
  }

  // Dynamic key with known struct fields: runtime string comparison.
  // (#2741) Gate to a REFERENCE-like key (string / externref / anyref). A
  // value-typed key (`Infinity`/`true`/a number → f64/i32) cannot be fed to
  // `__str_eq` (it expects a string/externref) — doing so produced a malformed
  // module ("call expected externref, found f64"). Such keys (now reachable
  // because the §13.10.1 ToPropertyKey 2322 is downgraded) fall through to the
  // defined fallback below instead of crashing wasm validation.
  const leftKeyWasm = resolveWasmType(ctx, ctx.checker.getTypeAtLocation(expr.left));
  const keyIsRefLike =
    leftKeyWasm.kind === "externref" ||
    leftKeyWasm.kind === "anyref" ||
    leftKeyWasm.kind === "ref" ||
    leftKeyWasm.kind === "ref_null";
  if (structFieldNames !== null && structFieldNames.length > 0 && keyIsRefLike) {
    // Compile the key expression (should produce a string/externref)
    const keyType = compileExpression(ctx, fctx, expr.left);
    if (keyType) {
      // Compare key against each field name using wasm:js-string equals
      const equalsIdx = ctx.funcMap.get("__str_eq") ?? ctx.funcMap.get("string_equals");
      const jsStrEquals = ctx.mod.imports.findIndex((imp) => imp.module === "wasm:js-string" && imp.name === "equals");
      const eqFunc = jsStrEquals >= 0 ? jsStrEquals : equalsIdx;
      if (eqFunc !== undefined && eqFunc >= 0) {
        const keyLocal = allocLocal(fctx, `__in_key_${fctx.locals.length}`, keyType);
        fctx.body.push({ op: "local.set", index: keyLocal });
        // Start with false (0)
        fctx.body.push({ op: "i32.const", value: 0 });
        for (const fieldName of structFieldNames) {
          const strGlobal = ctx.stringGlobalMap.get(fieldName);
          if (strGlobal !== undefined) {
            fctx.body.push({ op: "local.get", index: keyLocal });
            fctx.body.push({ op: "global.get", index: strGlobal });
            fctx.body.push({ op: "call", funcIdx: eqFunc });
            fctx.body.push({ op: "i32.or" }); // OR with accumulated result
          }
        }
        return { kind: "i32" };
      }
    }
  }

  // Dynamic key with no struct fields — try TS type system for known properties
  // Compile both sides for side effects, then use TS type system if the key
  // can be resolved from its type (e.g., a string variable with a known literal type).
  {
    // (#1444) When RHS is externref-backed (host object — e.g. regex
    // `result.groups`, untyped JS values), route through `__extern_has` so
    // `'key' in hostObj` reflects the actual JS `in` semantics instead of
    // the unconditional `false` fallback. The static path above still
    // covers WasmGC structs / vec types / TS-typed properties where the
    // compile-time answer is reliable.
    if (rightWasm.kind === "externref" || rightWasm.kind === "anyref") {
      const hasIdx = ensureLateImport(
        ctx,
        "__extern_has",
        [{ kind: "externref" }, { kind: "externref" }],
        [{ kind: "i32" }],
      );
      if (hasIdx !== undefined) {
        flushLateImportShifts(ctx, fctx);
        // (#2741) §13.10.1 evaluates the LHS (key, steps 1-2) BEFORE the RHS
        // (object, steps 3-4) — e.g. `x() in y()` must throw from `x()` first,
        // and an unresolvable LHS reference (`undef in obj`) must throw before
        // the object is evaluated. Evaluate the key first into a temp, then the
        // object, then re-push the key so the call args stay `(obj, key)`.
        // coerceType (not a bare extern.convert_any) boxes a non-ref key.
        const leftResult = compileExpression(ctx, fctx, expr.left, { kind: "externref" });
        if (leftResult === null) {
          fctx.body.push({ op: "ref.null.extern" });
        } else if (leftResult.kind !== "externref") {
          coerceType(ctx, fctx, leftResult, { kind: "externref" });
        }
        const keyTmp = allocTempLocal(fctx, { kind: "externref" });
        fctx.body.push({ op: "local.set", index: keyTmp });
        const rightResult = compileExpression(ctx, fctx, expr.right, { kind: "externref" });
        if (rightResult === null) {
          fctx.body.push({ op: "ref.null.extern" });
        } else if (rightResult.kind !== "externref") {
          coerceType(ctx, fctx, rightResult, { kind: "externref" });
        }
        fctx.body.push({ op: "local.get", index: keyTmp });
        releaseTempLocal(fctx, keyTmp);
        fctx.body.push({ op: "call", funcIdx: hasIdx });
        return { kind: "i32" };
      }
    }

    const leftResult = compileExpression(ctx, fctx, expr.left);
    if (leftResult) {
      fctx.body.push({ op: "drop" });
    }
    const rightResult = compileExpression(ctx, fctx, expr.right);
    if (rightResult) {
      fctx.body.push({ op: "drop" });
    }

    // Try to resolve key from the TS type of the left expression
    const leftType = ctx.checker.getTypeAtLocation(expr.left);
    if (leftType.isStringLiteral()) {
      const key = leftType.value;
      const prop = rightType.getProperty(key);
      const apparentType = ctx.checker.getApparentType(rightType);
      const apparentProp = apparentType.getProperty(key);
      const has = !!(prop || apparentProp || (structFieldNames && structFieldNames.includes(key)));
      fctx.body.push({ op: "i32.const", value: has ? 1 : 0 });
      return { kind: "i32" };
    }

    // Fully dynamic — emit false as safe fallback
    fctx.body.push({ op: "i32.const", value: 0 });
    return { kind: "i32" };
  }
}
