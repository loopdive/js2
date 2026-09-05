// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * (#5317 r4 step 4) `Array.prototype.join` / `%TypedArray%.prototype.join`
 * SEPARATOR coercion — §23.1.3.15 step 3 / §23.2.3.29 step 3:
 *
 *   If separator is undefined, let sep be ","; else let sep be ? ToString(separator).
 *
 * Both native join lanes (`compileArrayJoinNative` for a `$__vec_*` receiver,
 * `compileArrayJoinExternNative` for an `externref` receiver) used to compile
 * the argument to `externref` and then `ref.cast $AnyString` it. That cast is
 * only correct when the argument already IS a string: every other separator —
 * a plain object with a user `toString`, `null`, a number, a Symbol — TRAPS
 * ("illegal cast"), which is unrecoverable and therefore strictly worse than a
 * wrong answer. It is the mechanism behind the six ES2015 standalone
 * `TypedArray/prototype/join` rows in #5317, all of which report
 * `illegal cast [in __closure_N ← …]`.
 *
 * This emitter replaces the cast with the spec's own three arms:
 *   - `undefined` ⇒ the literal `","` (and ONLY `undefined`: `join(null)` is
 *     `"null"`, which the `return-abrupt-from-separator` family pins).
 *   - a Symbol ⇒ TypeError, because §7.1.17 ToString rejects symbols and the
 *     general-purpose standalone ToString dispatcher is deliberately printable
 *     for `String(Symbol())` (the same reason `Error.prototype.toString` adds
 *     its own strict rejection in array-object-proto.ts).
 *   - anything else ⇒ the coercion engine's own ToString provider, the same
 *     §7.1.17 ToString the element path on these very lanes already uses, so a
 *     throwing user `toString` propagates as the spec requires.
 *
 * Byte-identity: the callers keep the old cast for a string LITERAL argument
 * (`join(",")`, the overwhelmingly common lowering), so no existing module
 * without a non-literal separator changes at all. `null` is returned when the
 * runtime pieces this needs are absent, which also restores the old lowering.
 */
import type { Instr } from "../ir/types.js";
import { allocLocal } from "./context/locals.js";
import type { CodegenContext, FunctionContext } from "./context/types.js";
import { nativeStringLiteralInstrs } from "./native-strings.js";
import { buildThrowJsErrorInstrs } from "./js-errors.js";
import { ensureSymbolCarrier, usesNativeSymbolProvider } from "./symbol-native.js";
import { ensureLateImport, flushLateImportShifts } from "./expressions/late-imports.js";
import { getExternrefToStringProvider } from "./coercion-engine.js";

/**
 * `[externref separator] → [ref $AnyString]`.
 *
 * Returns `null` (⇒ the caller keeps its existing `ref.cast` lowering) when the
 * canonical ToString provider or `__typeof_undefined` is unavailable here.
 */
export function buildJoinSeparatorToString(
  ctx: CodegenContext,
  fctx: FunctionContext,
  anyStrTypeIdx: number,
): Instr[] | null {
  if (anyStrTypeIdx < 0) return null;
  // The §7.1.17 ToString provider is resolved through the coercion engine's own
  // accessor and NOT armed here: both join lanes already arm it for their
  // element path, and where it is genuinely absent this returns `null` so the
  // caller keeps its existing lowering rather than growing a second cascade.
  if (getExternrefToStringProvider(ctx) === undefined) return null;
  // Armed before any funcIdx is read into a JS variable (the #2043 late-shift
  // class): a late import registered afterwards renumbers everything below.
  const undefinedIdx = ensureLateImport(ctx, "__typeof_undefined", [{ kind: "externref" }], [{ kind: "i32" }]);
  const symbolTypeIdx = usesNativeSymbolProvider(ctx) ? ensureSymbolCarrier(ctx) : -1;
  flushLateImportShifts(ctx, fctx);
  if (undefinedIdx === undefined) return null;

  const sepRaw = allocLocal(fctx, `__jsep_raw_${fctx.locals.length}`, { kind: "externref" });
  // Built BEFORE the two funcIdxs below are read out of `funcMap`: the throw
  // template can mint the in-module error constructor, and every index read
  // into a JS variable must come after the last registration (#2043).
  const symbolGuard: Instr[] =
    symbolTypeIdx < 0
      ? []
      : [
          { op: "local.get", index: sepRaw },
          { op: "any.convert_extern" },
          { op: "ref.test", typeIdx: symbolTypeIdx },
          {
            op: "if",
            blockType: { kind: "empty" },
            then: buildThrowJsErrorInstrs(ctx, "TypeError", "Cannot convert a Symbol value to a string", {
              forceInModuleCtor: true,
            }),
          },
        ];
  const toStringIdx = getExternrefToStringProvider(ctx);
  const isUndefined = ctx.funcMap.get("__typeof_undefined") ?? undefinedIdx;
  if (toStringIdx === undefined) return null;
  return [
    { op: "local.set", index: sepRaw },
    { op: "local.get", index: sepRaw },
    { op: "call", funcIdx: isUndefined },
    {
      op: "if",
      blockType: { kind: "val", type: { kind: "ref", typeIdx: anyStrTypeIdx } },
      then: nativeStringLiteralInstrs(ctx, ","),
      else: [
        ...symbolGuard,
        { op: "local.get", index: sepRaw },
        { op: "call", funcIdx: toStringIdx },
        { op: "any.convert_extern" },
        { op: "ref.cast", typeIdx: anyStrTypeIdx },
      ],
    },
  ];
}
