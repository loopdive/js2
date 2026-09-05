// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * (#4619 family D) The DEMAND that makes a primitive-wrapper receiver's
 * `.toString()` / `.valueOf()` resolvable on the DYNAMIC route.
 *
 * ## Why a demand hook is needed at all
 *
 * #4248's `__extern_get` arm already answers `<wrapper>.<member>` with the
 * identity-stable per-(brand, member) singleton — but only for members whose
 * closure the module has ALREADY minted, discovered by scanning `ctx.funcMap`
 * for `__proto_method_<brand>_<member>` (`native-proto-instance-method-read.ts`).
 * That gate is exactly right for the question #4248 answers, IDENTITY: you
 * cannot ask `x.toString === Number.prototype.toString` without also naming the
 * prototype member, so demanded and answerable coincide.
 *
 * It is NOT right for a plain CALL. `new Number(0).toString()` names only the
 * instance member, so nothing mints the closure, `__extern_get` answers null,
 * and `__extern_method_call`'s #4221 absent-callee guard reports
 * `TypeError: called value is not a function`. Measured on base `2937ca57a`:
 * that is the error for all three wrappers, while adding a bare
 * `var _f = Number.prototype.toString;` to the SAME module moved it to the
 * refusal body's own message — i.e. minting was the only missing half of the
 * routing.
 *
 * ## Why it is hooked at the #1397 branch and not lower
 *
 * The wrapper call goes dynamic because of #1397's wrapper-reassignment branch
 * (`call-receiver-method.ts`), which routes a wrapper receiver through
 * `__extern_method_call` whenever the module assigns `<anything>.toString`
 * anywhere — universal in test262, where `sta.js` carries
 * `Test262Error.prototype.toString = …`. That branch is the RIGHT behaviour
 * (`s1.toString = Number.prototype.toString; s1.toString()` must observe the
 * own slot and throw, §15.7.4.2 `_A2_*`), so this hook does not touch it: it
 * runs immediately before the hand-off and merely makes the destination exist.
 *
 * Hooking here rather than inside `emitWrapperDynamicMethodCall` keeps the
 * receiver's static brand — already computed at that site — out of this
 * module, so nothing here needs the checker.
 *
 * Minting is idempotent and append-only (`ensureStandaloneNativeMethodClosure`
 * mints DEFINED funcs), and a member whose native body still refuses reifies
 * to the identity-stable catchable-TypeError stand-in, which is what
 * `refusalBodyFallback` means everywhere else. So the worst case for a member
 * this issue did not wire is that the call throws a catchable
 * `… is not yet implemented …` instead of `called value is not a function` —
 * strictly closer to the spec, and the same value `Number.prototype.<member>`
 * already reads as.
 *
 * ## …and the mint ignores the argument count the dispatch is gated on
 *
 * #1397's branch only takes the dynamic exit for a 0-argument call, but a call
 * WITH arguments still falls through to `__extern_method_call` further down and
 * needs the same closure to be there. Measured: `Boolean.prototype.toString(true)`
 * (test262 `S15.6.4.2_A1_T2` — §20.3.3.2 takes no argument, so the extra one is
 * simply ignored) reported "called value is not a function" while the 0-arg
 * spelling in `_A1_T1` passed, purely from that gate. So the caller mints on the
 * wider condition and dispatches on the narrower one.
 */
import { ts } from "../ts-api.js";
import { ensureStandaloneNativeMethodClosure, getNativeProtoBuiltinGlue } from "./native-proto.js";
import {
  ensureBooleanNativeProtoGlue,
  ensureNumberNativeProtoGlue,
  ensureStringNativeProtoGlue,
} from "./array-object-proto.js";
import type { CodegenContext } from "./context/types.js";
import type { WrapperBrandName } from "./wrapper-proto-value-of.js";

/** Register (once) the brand glue for one of the three wrapper families. */
function ensureWrapperGlue(ctx: CodegenContext, brandName: WrapperBrandName): number | undefined {
  if (brandName === "String") return ensureStringNativeProtoGlue(ctx);
  if (brandName === "Number") return ensureNumberNativeProtoGlue(ctx);
  return ensureBooleanNativeProtoGlue(ctx);
}

/**
 * Mint `<brandName>.prototype.<member>`'s closure so the dynamic read
 * (`__extern_get`) can resolve it for a wrapper receiver.
 *
 * No-op outside standalone, for a member the brand does not advertise, and for
 * an accessor member (a plain read of one must INVOKE it — a different
 * question, and one this route cannot answer).
 */
export function ensureWrapperProtoDynamicMember(
  ctx: CodegenContext,
  brandName: WrapperBrandName,
  member: string,
): void {
  if (!ctx.standalone) return;
  const brand = ensureWrapperGlue(ctx, brandName);
  if (brand === undefined) return;
  const glue = getNativeProtoBuiltinGlue(ctx, brand);
  if (!glue || !glue.memberCsv.split(",").includes(member)) return;
  if (glue.memberKind(member) !== "method") return;
  ensureStandaloneNativeMethodClosure(ctx, brand, member, "method", { refusalBodyFallback: true });
}

/**
 * (#4619 family D) The `(member, ifaceName)` a reflective `.call` receiver
 * NAMES, when the source text is better evidence than the symbol.
 *
 * `lib.es5.d.ts` declares `interface Boolean { valueOf(): boolean }` and
 * nothing else — no `toString`. So `Boolean.prototype.toString`'s symbol is
 * `Object`'s method signature, and the reflective dispatch mis-attributes the
 * call to the Object brand: measured on base, `Boolean.prototype.toString
 * .call(false)` answered `undefined` (it fell out of the #4119 guard to the
 * legacy `.call` tail, which drops `thisArg`), while the identical NUMBER
 * spelling — whose interface does declare `toString` — worked. §20.3.3.2 is
 * unambiguous that the member is Boolean's own.
 *
 * Scope is exactly the two members with a wired wrapper body (`valueOf`
 * #4491/#4582, `toString` #4619) on the three wrapper constructors, and only
 * when the constructor identifier is the AMBIENT one. Widening it to every
 * member would re-route genuinely INHERITED spellings —
 * `Boolean.prototype.hasOwnProperty.call(o, k)` IS Object's method and resolves
 * correctly through the symbol today — into a brand whose glue refuses them.
 *
 * Returns `undefined` to leave the symbol's answer alone.
 */
export function wrapperProtoSyntacticMember(
  ctx: CodegenContext,
  receiver: ts.Expression,
  member: string,
): { member: string; ifaceName: string } | undefined {
  if (member !== "toString" && member !== "valueOf") return undefined;
  if (!ts.isPropertyAccessExpression(receiver)) return undefined;
  const proto = receiver.expression;
  if (!ts.isPropertyAccessExpression(proto) || proto.name.text !== "prototype") return undefined;
  if (!ts.isIdentifier(proto.expression)) return undefined;
  const base = proto.expression.text;
  if (base !== "Number" && base !== "String" && base !== "Boolean") return undefined;
  if (ctx.moduleGlobals.has(base) || ctx.topLevelFunctionNames.has(base) || ctx.classSet.has(base)) return undefined;
  return { member: receiver.name.text, ifaceName: base };
}
