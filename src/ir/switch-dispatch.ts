// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * (#2952 slice 6b, #7354 L0b) The discriminant a lowered `switch` dispatches on. The clause ladder (`emitSwitch`)
 * selects by an i32/f64 compared against compile-time tests; a switch it cannot compare directly first computes the
 * matching clause's INDEX (or -1), and the ladder's tests become the clause indexes. The -1 sentinel is out of the
 * `[0, n)` range, so it falls to the ladder's no-match target: the `default` clause when present, past the ladder
 * otherwise. Deliberately no new IR node: the ladder, its `br_table` fast path, fallthrough and `break` stay as slice 4
 * shipped them.
 */
import { ts } from "../ts-api.js";
import type { IrFunctionBuilder } from "./builder.js";
import { asVal, irDynamic, irVal, type IrType, type IrValueId } from "./nodes.js";
import { demoteToLegacy, IrUnsupportedError } from "./outcomes.js";
import { carrierOperand } from "./dynamic-comparison-lowering.js";
import type { FunctionObjectLoweringHost } from "./function-object-lowering.js";
import { stringCaseTestValue, switchCaseTests } from "./switch-case-tests.js";

const I32 = irVal({ kind: "i32" });

/** The value the ladder dispatches on, and whether its tests are clause indexes rather than the literals. */
export interface SwitchDiscriminant {
  readonly disc: IrValueId;
  readonly byIndex: boolean;
}

/**
 * Lower the discriminant once (§14.12.9 step 1), with the hint the tests imply. Numeric literal tests compare an i32/f64
 * discriminant directly; string literal tests compare a string one by `string.eq`. (#7354 L0b) On the Prepared lane
 * any other discriminant, and mixed or non-literal tests, take the carrier dispatch. So does an `i32` discriminant
 * there: it may be a Boolean, which strict equality never equates with a number (`switch (true) { case 1: }`).
 */
export function switchDiscriminant(
  stmt: ts.SwitchStatement,
  host: FunctionObjectLoweringHost,
  lowerDisc: (hint: IrType) => IrValueId,
): SwitchDiscriminant {
  // The selector's own predicate: the Prepared path has no selector, and the string dispatch skips non-literals.
  const caseTests = switchCaseTests(stmt);
  const lane = host.onPreparedDynamicLane();
  if (caseTests.kind === "rejected" && (!lane || caseTests.reason === "switch-multiple-defaults"))
    throw new IrUnsupportedError(
      "body-shape-rejected",
      "build",
      `ir/from-ast: ${caseTests.reason} in ${host.funcName}`,
    );
  const hint =
    caseTests.kind === "string"
      ? { kind: "string" as const }
      : caseTests.kind === "numeric"
        ? irVal({ kind: "f64" })
        : irDynamic();
  const disc = lowerDisc(hint);
  const discType = host.builder.typeOf(disc);
  const discKind = asVal(discType)?.kind ?? discType.kind;
  if (caseTests.kind === "string" && discKind === "string")
    return { disc: stringDispatch(disc, stmt, host.builder), byIndex: true };
  if (caseTests.kind === "numeric" && (discKind === "f64" || (discKind === "i32" && !lane)))
    return { disc, byIndex: false };
  const carrier = lane ? carrierOperand(disc, stmt.expression, host) : null;
  if (carrier !== null) return { disc: carrierDispatch(carrier, stmt, host), byIndex: true };
  if (caseTests.kind === "string")
    // Selector mirror (`switch-disc-not-string`): a named Unsupported reason demotes cleanly under IR-first (#2138).
    throw new IrUnsupportedError(
      "operand-coercion-unsupported",
      "build",
      `ir/from-ast: string-tested switch disc lowered to ${discType.kind}, not string, in ${host.funcName}`,
    );
  return demoteToLegacy("body-shape-rejected", `ir/from-ast: switch disc must lower to i32/f64 in ${host.funcName}`);
}

/**
 * #2952 slice 6b — the clause index of a string-tested switch, emitted into the CURRENT buffer (nested buffers cannot
 * reference its SSA values):
 *
 * ```
 *   match := -1
 *   if (string.eq(disc, lit[n-1])) match := n-1     ;; REVERSE source order
 *   …
 *   if (string.eq(disc, lit[0]))   match := 0
 * ```
 *
 * Flat comparisons with the first clause in source order writing LAST are observationally identical to a short
 * circuit: both operands are strings, so `string.eq` is total, pure and cannot throw, and the first clause still wins
 * on duplicate literals. A short circuit would need a string-typed slot, whose ValType depends on the mode.
 */
function stringDispatch(disc: IrValueId, stmt: ts.SwitchStatement, builder: IrFunctionBuilder): IrValueId {
  const matchSlot = builder.declareSlot("__switch_str_match", { kind: "i32" });
  builder.emitSlotWrite(matchSlot, builder.emitConst({ kind: "i32", value: -1 }, I32));
  const clauses = stmt.caseBlock.clauses;
  for (let k = clauses.length - 1; k >= 0; k--) {
    const clause = clauses[k]!;
    if (!ts.isCaseClause(clause)) continue;
    const matched = builder.emitStringEq(disc, builder.emitStringConst(stringCaseTestValue(clause.expression)!), false);
    const then = builder.collectBodyInstrs(() => {
      builder.emitSlotWrite(matchSlot, builder.emitConst({ kind: "i32", value: k }, I32));
    });
    builder.emitIfStmt({ cond: matched, then, else: [] });
  }
  return builder.emitSlotRead(matchSlot);
}

/**
 * (#7354 L0b) The clause index of a switch over the carrier (§14.12.9): the tests are evaluated lazily in source order
 * and compared by strict equality, the first match ends the search, and `default` is not a test. The discriminant is
 * kept in a carrier slot, because each later test is lowered inside the previous test's `else` buffer.
 */
function carrierDispatch(disc: IrValueId, stmt: ts.SwitchStatement, host: FunctionObjectLoweringHost): IrValueId {
  const { builder } = host;
  const discSlot = builder.declareSlot("__switch_carrier", { kind: "externref" });
  const matchSlot = builder.declareSlot("__switch_match", { kind: "i32" });
  builder.emitSlotWrite(discSlot, disc);
  builder.emitSlotWrite(matchSlot, builder.emitConst({ kind: "i32", value: -1 }, I32));
  const clauses = stmt.caseBlock.clauses;
  const test = (from: number): void => {
    const k = clauses.findIndex((clause, index) => index >= from && ts.isCaseClause(clause));
    if (k < 0) return;
    const clause = clauses[k] as ts.CaseClause;
    const value = carrierOperand(host.lowerExpression(clause.expression), clause.expression, host);
    if (value === null)
      throw new IrUnsupportedError(
        "operand-coercion-unsupported",
        "build",
        `ir/from-ast: switch case test has no carrier value in ${host.funcName}`,
      );
    const matched = builder.emitDynEq(builder.emitSlotReadAs(discSlot, irDynamic()), value, {
      loose: false,
      negate: false,
    });
    const then = builder.collectBodyInstrs(() => {
      builder.emitSlotWrite(matchSlot, builder.emitConst({ kind: "i32", value: k }, I32));
    });
    builder.emitIfStmt({ cond: matched, then, else: builder.collectBodyInstrs(() => test(k + 1)) });
  };
  test(0);
  return builder.emitSlotRead(matchSlot);
}
