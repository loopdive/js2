// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * (#4491 T4) §13.15.3 ApplyStringOrNumericBinaryOperator for `+` when an
 * operand is statically an OBJECT — the additive twin of
 * `relational-to-primitive.ts`'s `admitsObjectRelational`.
 *
 * ## The defect
 *
 * `binary-ops.ts` already owns a fully spec-shaped `+`: `emitAnyAdd` reduces
 * BOTH operands with `__to_primitive` (default hint) and only then decides
 * concat-vs-numeric. But its gate admits an operand only when the static type
 * is `any`/`unknown`. An operand whose type is a real object type — a `Date`, a
 * function, an object literal — misses that gate and falls through to the
 * numeric lowering below it, which compiles both sides with an f64 hint. An
 * object unboxes to NaN there, so:
 *
 * ```js
 * var d = new Date(0);
 * d + d;                        // NaN — must be d.toString() + d.toString()
 * function f1() { return 0; }
 * f1 + 1;                       // NaN — must be f1.toString() + "1"
 * ({} + function () { return 1; });  // NaN — must be two toString()s
 * ```
 *
 * This is exactly half (b) of the relational defect written down in
 * `relational-to-primitive.ts`: the operator chose its arm before reducing to
 * primitives. `f + ""` looked fine all along because a statically-STRING
 * operand is caught by an earlier `isStringType` gate and never reaches here —
 * which is why spot-checking string-concat spellings finds nothing.
 *
 * ## Why widening the gate is safe here
 *
 * The same reasoning as `admitsObjectRelational`, and for the same reason:
 * #1374's 14 runtime_error regressions came from routing object operands to a
 * HOST operator, where `+` on an opaque WasmGC struct throws. This predicate
 * widens ONLY when there is no JS host (`semanticProviders === "native-first"`),
 * where the whole dispatch is in-module (`__to_primitive`, `__typeof_string`,
 * `__str_concat`, and the numeric unboxer) and no host operator ever sees a struct.
 * The js-host/gc lane keeps its bytes and stays the regression guard.
 *
 * Native strings are required, not optional: without them `emitAnyAddFromExternTemps`
 * degrades to the legacy `f64.add`, i.e. exactly the wrong answer we are
 * routing away from. Gating on them here means a module that cannot concat
 * keeps its current lowering instead of paying for a detour to the same NaN.
 *
 * ## Hint
 *
 * DEFAULT, not number — §13.15.3 step 1 says so, and `emitAnyAdd` already
 * passes a null (= default) hint. That is what makes `d + d` two date STRINGS
 * rather than two time values, and it is the one place `+` and the relational
 * cascade (which must use NUMBER, §7.2.12) genuinely differ.
 */
import { ts } from "../ts-api.js";
import type { Instr } from "../ir/types.js";
import type { CodegenContext, FunctionContext } from "./context/types.js";
import { TO_PRIMITIVE_EXCLUDED_FLAGS, isObjectOperandType } from "./relational-to-primitive.js";
import { identifierIsWrittenTo } from "./native-ordinary-instanceof.js";
import { reserveAccessorGetDriver } from "./accessor-driver.js";
import { allocTempLocal, releaseTempLocal } from "./context/locals.js";
import { addStringConstantGlobal } from "./registry/imports.js";
import { stringConstantExternrefInstrs } from "./native-strings.js";

/**
 * Should a `+` with these operand types take the §13.15.3 ToPrimitive dispatch
 * (`emitAnyAdd`) instead of the numeric f64 lowering?
 *
 * Returns false for every operand shape the existing gates already handle
 * correctly: `any`/`unknown` (the #2058 arm above this one), bigint (no i64 arm
 * in the dispatch), and anything statically numeric or string.
 */
export function admitsObjectAdd(ctx: CodegenContext, left: ts.Type, right: ts.Type): boolean {
  if (ctx.targetProfile.semanticProviders !== "native-first") return false;
  if (!ctx.nativeStrings || ctx.anyStrTypeIdx < 0) return false;
  if ((left.flags & TO_PRIMITIVE_EXCLUDED_FLAGS) !== 0 || (right.flags & TO_PRIMITIVE_EXCLUDED_FLAGS) !== 0) {
    return false;
  }
  return isObjectOperandType(left) || isObjectOperandType(right);
}

/**
 * (#4491 T4) §20.2.3.5 step 1 for a `+` operand — the `[[SourceText]]` arm.
 *
 * `f1 + 1` reduces `f1` with OrdinaryToPrimitive(default): `valueOf` hands the
 * function back unreduced, so the answer is `Function.prototype.toString(f1)` —
 * the function's SOURCE TEXT. `emitAddOrdinaryToPrimitiveResidue` below can only
 * reach the runtime `__extern_toString`, whose callable terminal is
 * §20.2.3.5 step 3's `"function () { [native code] }"` placeholder. Both are
 * conforming answers to different questions, and the test that catches the
 * difference is the one that asks them side by side:
 *
 * ```js
 * function f1() { return 0; }
 * f1 + 1 === f1.toString() + 1;   // must hold (S11.6.1_A2.2_T3)
 * ```
 *
 * `f1.toString()` is already served from `ctx.funcSourceText` (#1463,
 * `call-receiver-method.ts`). This asks the SAME map by the SAME key so the two
 * spellings cannot disagree — parity is the point, and it inherits #1463's
 * bare-name keying rather than inventing a second, differently-wrong lookup.
 *
 * Four guards keep it honest:
 *  - the identifier must not be a LOCAL (`fctx.localMap`), which is #3364's
 *    shadowing hazard: a local named after a top-level function is a different
 *    value entirely;
 *  - the identifier must never be ASSIGNED anywhere in the file — a rebindable
 *    name's source text is not its runtime value (`identifierIsWrittenTo`, the
 *    same reassigned-binding guard `in`/`instanceof` use);
 *  - the function must carry no `f.valueOf = …` / `f.toString = …` OVERRIDE. A
 *    function object is still an ordinary object: `f2.valueOf = function(){
 *    return 1 }` makes `1 + f2` equal `2`, and the source text is then simply
 *    not the ToPrimitive answer. This one is not hypothetical — checks 2-4 of
 *    `S11.6.1_A2.2_T3` are exactly those three spellings, and the fold silently
 *    won all three before the guard existed;
 *  - the operand must have a CALL SIGNATURE (`ctx.oracle.signatureOf`, the
 *    oracle boundary for that question — #1930), so a same-named non-function
 *    binding is untouched.
 *
 * A refused operand falls to {@link emitAddOrdinaryToPrimitiveResidue}, which
 * runs the real §7.1.1.1 probe against the closure's own-property bag.
 */
export function addOperandCallableSourceText(
  ctx: CodegenContext,
  fctx: FunctionContext,
  expr: ts.Expression,
): string | undefined {
  if (ctx.targetProfile.semanticProviders !== "native-first") return undefined;
  if (!ts.isIdentifier(expr)) return undefined;
  if (fctx.localMap.has(expr.text)) return undefined;
  const captured = ctx.funcSourceText.get(expr.text);
  if (!captured) return undefined;
  const file = expr.getSourceFile();
  if (identifierIsWrittenTo(file, expr.text)) return undefined;
  if (hasToPrimitiveOverrideAssignment(file, expr.text)) return undefined;
  return ctx.oracle.signatureOf(expr) !== undefined ? captured : undefined;
}

/**
 * True when the file assigns `<name>.valueOf`, `<name>.toString`, or a computed
 * member of `<name>` — the three spellings that can move a function's
 * ToPrimitive answer off its source text. The computed form is included
 * unresolved (`f[k] = …`) because the key is not knowable here and a wrong
 * fold is worse than a runtime probe.
 */
function hasToPrimitiveOverrideAssignment(file: ts.SourceFile, name: string): boolean {
  let found = false;
  const visit = (node: ts.Node): void => {
    if (found) return;
    if (
      ts.isBinaryExpression(node) &&
      node.operatorToken.kind >= ts.SyntaxKind.FirstAssignment &&
      node.operatorToken.kind <= ts.SyntaxKind.LastAssignment
    ) {
      const lhs = node.left;
      if (ts.isPropertyAccessExpression(lhs) && ts.isIdentifier(lhs.expression) && lhs.expression.text === name) {
        if (lhs.name.text === "valueOf" || lhs.name.text === "toString") {
          found = true;
          return;
        }
      }
      if (ts.isElementAccessExpression(lhs) && ts.isIdentifier(lhs.expression) && lhs.expression.text === name) {
        found = true;
        return;
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(file);
  return found;
}

/**
 * (#4491 T4) §7.1.1.1 OrdinaryToPrimitive step 6 — "throw a TypeError" is the
 * ONLY way ToPrimitive may end without a primitive. The standalone
 * `__to_primitive` does not honour that: its non-`$Object` tail (object-runtime.ts,
 * "Any other non-$Object value … returns unchanged") hands a **function closure**
 * or a **`Date` struct** straight back, because neither is a `$Object`, a
 * `$__vec_base`, nor a nominal class with `__call_valueOf`/`__call_toString`
 * dispatchers. §13.15.3's string-vs-numeric test then sees a non-string, takes
 * the numeric arm, and unboxing a closure as a number is NaN:
 *
 * ```js
 * function f1() { return 0; }
 * f1 + 1;                 // NaN   — must be f1.toString() + "1"
 * new Date(0) + new Date(0);  // NaN — must be two date strings
 * ```
 *
 * Measured on the T4 row set: this residue, not the operand gate, is what kept
 * `S11.6.1_A2.2_T2/T3` failing after `admitsObjectAdd` correctly routed them —
 * `{} + f` passed at the same time because a `$Object` DOES reach the ordinary
 * valueOf/toString probe.
 *
 * The repair is deliberately scoped to the `+` dispatch rather than to
 * `__to_primitive` itself. Widening that tail would change ToNumber, the
 * relational cascade, `String()`, and every other ToPrimitive consumer at once,
 * and its "returns unchanged" answer is load-bearing for several shapes that
 * early-out ABOVE it (the boxed-boolean and native-error arms document two
 * action-at-a-distance regressions caused by exactly that kind of widening).
 * Here the fallback runs on a value we have already established is an OBJECT at
 * runtime, in the one operator whose spec text says the result must be a
 * primitive.
 *
 * `ref.is_null` guards JS `null` (whose `typeof` is `"object"` but which is
 * already a primitive); `undefined` reports `"undefined"` from
 * `__typeof_object`/`__typeof_function` and is therefore untouched, so
 * `undefined + 1` stays NaN instead of becoming `"undefined1"`.
 *
 * No-op (emits nothing) when either typeof probe is unavailable, so a minimal
 * standalone build keeps its current lowering byte-for-byte.
 */
export function emitAddOrdinaryToPrimitiveResidue(
  ctx: CodegenContext,
  fctx: FunctionContext,
  tmp: number,
  toStringIdx: number,
): void {
  const typeofObject = ctx.funcMap.get("__typeof_object");
  const typeofFunction = ctx.funcMap.get("__typeof_function");
  const externGet = ctx.funcMap.get("__extern_get");
  if (typeofObject === undefined || typeofFunction === undefined || externGet === undefined) return;
  const callMethod0 = reserveAccessorGetDriver(ctx);
  const nullishToNull = ctx.funcMap.get("__nullish_to_null");

  const method = allocTempLocal(fctx, { kind: "externref" });
  const result = allocTempLocal(fctx, { kind: "externref" });

  /** `local` holds a primitive: JS `null`, or neither "object" nor "function". */
  const isPrimitive = (local: number): Instr[] => [
    { op: "local.get", index: local },
    { op: "ref.is_null" },
    {
      op: "if",
      blockType: { kind: "val", type: { kind: "i32" } },
      then: [{ op: "i32.const", value: 1 }],
      else: [
        { op: "local.get", index: local },
        { op: "call", funcIdx: typeofObject },
        { op: "local.get", index: local },
        { op: "call", funcIdx: typeofFunction },
        { op: "i32.or" },
        { op: "i32.eqz" },
      ],
    },
  ];

  /**
   * §7.1.1.1 steps 2-5 for ONE method name. On a primitive result the `br`
   * leaves the whole residue region: it sits three `if`s deep inside the
   * enclosing `block`, so depth 3 targets that block.
   */
  const probe = (name: "valueOf" | "toString"): Instr[] => {
    addStringConstantGlobal(ctx, name);
    return [
      { op: "local.get", index: tmp },
      ...stringConstantExternrefInstrs(ctx, name),
      { op: "call", funcIdx: externGet },
      // (#2106 S1) An ABSENT member comes back as the non-null `$undefined`
      // singleton under the singleton regime; normalize so `ref.is_null` means
      // "absent" here exactly as it does inside `__to_primitive`.
      ...(nullishToNull === undefined ? [] : ([{ op: "call", funcIdx: nullishToNull }] satisfies Instr[])),
      { op: "local.tee", index: method },
      { op: "ref.is_null" },
      { op: "i32.eqz" },
      {
        op: "if",
        blockType: { kind: "empty" },
        then: [
          { op: "local.get", index: method },
          { op: "call", funcIdx: typeofFunction },
          {
            op: "if",
            blockType: { kind: "empty" },
            then: [
              { op: "local.get", index: tmp },
              { op: "local.get", index: method },
              { op: "call", funcIdx: callMethod0 },
              { op: "local.set", index: result },
              ...isPrimitive(result),
              {
                op: "if",
                blockType: { kind: "empty" },
                then: [
                  { op: "local.get", index: result },
                  { op: "local.set", index: tmp },
                  { op: "br", depth: 3 },
                ],
              },
            ],
          },
        ],
      },
    ];
  };

  const stillObject: Instr[] = [
    {
      op: "block",
      blockType: { kind: "empty" },
      body: [
        ...probe("valueOf"),
        ...probe("toString"),
        // Neither reduced: fall back to the runtime ToString, whose callable
        // terminal is §20.2.3.5 step 3's NativeFunction form and whose ordinary
        // terminal is `"[object Object]"`. Still a primitive — which is all
        // §13.15.3 needs — and never the object itself.
        { op: "local.get", index: tmp },
        { op: "call", funcIdx: toStringIdx },
        { op: "local.set", index: tmp },
      ],
    },
  ];

  fctx.body.push(
    { op: "local.get", index: tmp },
    { op: "ref.is_null" },
    { op: "i32.eqz" },
    {
      op: "if",
      blockType: { kind: "empty" },
      then: [
        { op: "local.get", index: tmp },
        { op: "call", funcIdx: typeofObject },
        { op: "local.get", index: tmp },
        { op: "call", funcIdx: typeofFunction },
        { op: "i32.or" },
        { op: "if", blockType: { kind: "empty" }, then: stillObject },
      ],
    },
  );

  releaseTempLocal(fctx, result);
  releaseTempLocal(fctx, method);
}
