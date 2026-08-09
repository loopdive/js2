// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// (#743) The satellite's evaluator extensions, and the single factory that
// composes them.
//
// The `Scope.flags` probe (issue Results, 2026-08-07) measured that the slot
// needs EXACTLY three evaluator rules and that any two of them move nothing:
//
//   1. the bitwise/shift producer rule   — `fnctor-i32-producers.ts`
//   2. module-level numeric constants    — `fnctor-module-consts.ts`
//   3. condition-agnostic conditionals   — below
//
// The `Parser.pos` pin census (2026-08-08) added a fourth:
//
//   4. arithmetic `- * / % **` totality  — `fnctor-f64-producers.ts`
//
// The pin retirement program (2026-08-08, this issue's field↔param follow-up)
// added the last two the census left standing:
//
//   5. function-local bindings           — `fnctor-local-bindings.ts`
//   6. string substrate (String(x) /
//      indexOf / charCodeAt / length)    — `fnctor-string-producers.ts`
//
// They ride one `InferExtension` because `core.inferExpr` takes one. The rules
// answer on DISJOINT node kinds / operator sets (bitwise-binary/`~` ·
// arithmetic-binary · identifier · conditional · call/property-access), so
// composition order is not a semantic choice; first-non-`undefined` wins and
// nothing overlaps. The two identifier rules (module constants, locals) are
// disjoint by SYMBOL — a module-level binding is never a function-local — and
// each declines the other's symbols.
//
// All of this is SATELLITE-ONLY. The always-on `buildIrUnitTypeMap` path passes
// no extension at all, so the main `IrUnitTypeMap` — and therefore #1712
// byte-parity — is unaffected by construction, not by measurement.
import { ts } from "../ts-api.js";
import { createF64ProducerExtension } from "./fnctor-f64-producers.js";
import { createI32ProducerExtension } from "./fnctor-i32-producers.js";
import { createLocalBindingExtension } from "./fnctor-local-bindings.js";
import { createModuleConstExtension } from "./fnctor-module-consts.js";
import { createStringProducerExtension } from "./fnctor-string-producers.js";
import { _propagationCore as core, type InferExtension, type LatticeType } from "./propagate.js";

/**
 * `cond ? a : b` → `join(a, b)`, whatever `cond` is.
 *
 * **The core's `!boolCompatible(cond) → DYNAMIC` guard is over-conservative,
 * not soundness-required, and this rule deliberately diverges from it. Do not
 * "restore" the guard.**
 *
 * The argument is ToBoolean's TOTALITY. `ConditionalExpression : ShortCircuitExpression ? A : B`
 * evaluates the condition, applies `ToBoolean`, and then evaluates exactly one
 * of the two branches — so the expression's value is either A's value or B's
 * value, and `join(A, B)` covers both. `ToBoolean` is defined by a total table
 * over the language's type domain (Undefined/Null → false, Boolean → itself,
 * Number/BigInt → zero-or-NaN test, String → emptiness test, Symbol → true,
 * Object → true). It has no abrupt-completion path and it invokes NO user code
 * — in particular it does not go through `ToPrimitive`, so no `valueOf` /
 * `Symbol.toPrimitive` can run and no third value can be produced. There is
 * therefore no assignment of a type to `cond` under which the RESULT type could
 * differ from `join(A, B)`.
 *
 * (If the condition expression itself throws, no value flows anywhere and any
 * fact is vacuously sound — the same reasoning the BigInt guard in
 * `fnctor-i32-producers.ts` uses.)
 *
 * This is a strict REFINEMENT of the core: where the core's guard passes it
 * already computes exactly this join, and where the guard fails it answers
 * DYNAMIC, which is above `join(A, B)` in the lattice. So the rule can only
 * lower a fact, never raise one.
 *
 * It matters on acorn because 2 of the 8 `enterScope` call sites are
 * `cond ? A : B` over a DYNAMIC condition, and the core's guard threw away both
 * numeric branches for it.
 */
function createConditionalJoinExtension(
  evaluate: (expr: ts.Expression, scope: ReadonlyMap<string, LatticeType>) => LatticeType,
): InferExtension {
  return {
    tryInfer(expr, scope) {
      if (!ts.isConditionalExpression(expr)) return undefined;
      return core.join(evaluate(expr.whenTrue, scope), evaluate(expr.whenFalse, scope));
    },
  };
}

export interface SatelliteInferExtensionHost {
  readonly sourceFile: ts.SourceFile;
  readonly checker: ts.TypeChecker;
  /**
   * Re-entry into the shared evaluator WITH this extension installed. A caller
   * that passes a plain `core.inferExpr` (no `ext`) silently answers the
   * pre-extension type for every operand one level down — see the nesting
   * fixtures in `tests/issue-743-i32-producers.test.ts`.
   */
  readonly evaluate: (expr: ts.Expression, scope: ReadonlyMap<string, LatticeType>) => LatticeType;
}

export function createSatelliteInferExtension(host: SatelliteInferExtensionHost): InferExtension {
  const rules: readonly InferExtension[] = [
    createI32ProducerExtension(host.evaluate),
    // Arithmetic `- * / % **` — disjoint from the bitwise/shift set above, so
    // composition order between the two is not a semantic choice.
    createF64ProducerExtension(host.evaluate),
    createModuleConstExtension(host.sourceFile, host.checker),
    createLocalBindingExtension(host.sourceFile, host.checker, host.evaluate),
    createStringProducerExtension(host.sourceFile, host.checker, host.evaluate),
    createConditionalJoinExtension(host.evaluate),
  ];
  return {
    tryInfer(expr, scope) {
      for (const rule of rules) {
        const answer = rule.tryInfer(expr, scope);
        if (answer !== undefined) return answer;
      }
      return undefined;
    },
  };
}
