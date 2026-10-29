// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * (#4462) Backend-neutral callable intents for the two host surfaces that a
 * host-free target (standalone / WASI / native strings) can service WITHOUT a
 * JS host — plus the one shape predicate both sides of the console claim
 * boundary consult.
 *
 * Why a contract module rather than a direct import of the codegen helper: the
 * IR front-end names a *semantic* callable and the resolver picks the lane's
 * provider (`resolveAndObserveCallableProvider` in `ir/integration.ts`), exactly
 * as `IR_STRING_CHAR_CODE_AT_FN` & co. do in `ir/string-runtime.ts`. `from-ast`
 * therefore never learns whether the module has native strings, a host import,
 * or neither.
 */
import { CONSOLE_METHOD_NAMES as IR_CONSOLE_METHODS } from "../shared/contracts/console-output.js";
import { ts } from "../ts-api.js";

/**
 * Host-free `Number::toString` **in the IR string carrier**. Distinct from the
 * `env.number_toString` host import: that one returns a JS string as an
 * externref, this one returns the `(ref $AnyString)` that `resolveString()`
 * yields in every native-string lane. Provider: the `ensureIrNativeNumberToString`
 * adapter (`codegen/number-format-native.ts`).
 */
export const IR_NUMBER_TO_STRING_NATIVE_FN = "__ir_number_to_string_native";

/**
 * Native stdout append takes the logical string carrier and returns nothing.
 * Standalone uses the in-module rope and its readout exports; WASI uses the
 * existing UTF-8 fd_write provider. Neither needs an env/JavaScript import.
 */
export {
  IR_CONSOLE_SINK_APPEND_FN,
  IR_CONSOLE_STDERR_APPEND_FN,
  IR_CONSOLE_FORMAT_VALUE_FN,
} from "../shared/contracts/console-output.js";

/**
 * The console methods the IR lowers. Identical in both lanes: the host lane
 * resolves `console_<m>_<variant>` imports, the host-free lane renders the
 * argument and appends it to the sink. `console.log`-family only — anything
 * else (`table`, `group`, `time`, …) has no lowering in either lane.
 */
export { IR_CONSOLE_METHODS };

/**
 * The EXACT console call shape the host-free lowering covers, as seen from the
 * receiver identifier.
 *
 * This predicate exists because the selector's host-global arm sees only the
 * bare `console` identifier, while the builder's console arm sees the whole
 * call — the classic #2135 two-predicate drift. Accepting a host-free `console`
 * identifier on identifier-ness alone would claim shapes the builder throws on
 * (`console.log(a, b)`, `console.table(x)`, a value-position `console.log(x)`),
 * turning a clean pre-claim rejection into a post-claim demote — and, under
 * #2138's IR-first skipped-slot rule, into a hard error. So the selector asks
 * the same question the builder will: is THIS identifier the receiver of a
 * statement-position, single-argument, lowerable `console.<m>(arg)`?
 *
 * Deliberately NOT checked here: the argument's lowered type. That is a
 * representation question the selector cannot answer (it has no IR types), and
 * the builder's renderer covers every carrier the corpus produces — string,
 * f64, and i32/bool — demoting only on a genuinely unrenderable carrier.
 */
export function isHostFreeConsoleCallReceiver(expr: ts.Identifier): boolean {
  const access = expr.parent;
  if (!ts.isPropertyAccessExpression(access) || access.expression !== expr || access.questionDotToken) return false;
  if (!IR_CONSOLE_METHODS.has(access.name.text)) return false;
  const call = access.parent;
  if (!ts.isCallExpression(call) || call.expression !== access || call.questionDotToken) return false;
  if (call.arguments.length !== 1 || ts.isSpreadElement(call.arguments[0]!)) return false;
  // Statement position — console methods return `undefined`, which the IR has
  // no value representation for here (the builder's own `statementPosition`
  // guard states the same restriction).
  return ts.isExpressionStatement(call.parent);
}

/** Extract the supported single console argument only after the caller proves the receiver. */
export function hostFreeConsoleArgument(
  call: ts.CallExpression,
  provesReceiver: (id: ts.Identifier) => boolean,
): ts.Expression | null {
  const target = call.expression;
  return ts.isPropertyAccessExpression(target) &&
    ts.isIdentifier(target.expression) &&
    provesReceiver(target.expression) &&
    isHostFreeConsoleCallReceiver(target.expression)
    ? call.arguments[0]!
    : null;
}
