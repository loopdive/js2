// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * (#2717) Element coercion for materializing a dynamic array into a typed
 * `$AnyValue`-element vec (`(string | number)[]` and other union element
 * types) on a native-first lane.
 *
 * `buildVecFromExternref` (type-coercion.ts) reads each element of the source
 * array as an externref and, for a ref element type, used to finish with a
 * bare `any.convert_extern; ref.cast_null $Elem`. That is right when the
 * element already IS the target struct, but a dynamic array (the `$ObjVec` a
 * native `flat`/`concat`/`map` produces) holds primitives in their boxed
 * carrier forms — an i31 small integer, a `$BoxedNumber`, a native string —
 * none of which is an `$AnyValue`, so the cast TRAPPED ("illegal cast"):
 *
 * ```js
 * const b = [1, [2, [3]], "x"].flat(2);   // b : (string | number)[]
 * b.length;                               // standalone: illegal cast
 * ```
 *
 * The fix keeps the cast for an element that already is an `$AnyValue`
 * (byte-for-byte the old behaviour on every value that did not trap) and
 * boxes everything else through the module's own `__any_from_extern`
 * classifier, the same helper every other externref → `$AnyValue` boundary on
 * this lane uses. JS-host lanes are untouched: `ensureAnyFromExternHelper`
 * answers `undefined` outside `native-first`, and the caller keeps its cast.
 */
import type { Instr } from "../ir/types.js";
import { ensureAnyFromExternHelper } from "./any-helpers.js";
import { allocLocal } from "./context/locals.js";
import type { CodegenContext, FunctionContext } from "./context/types.js";

/**
 * Instructions converting the externref on the stack into `(ref null $AnyValue)`
 * when `elemTypeIdx` is the `$AnyValue` struct on a native-first lane; returns
 * `undefined` otherwise so the caller emits its existing cast.
 */
export function anyValueElemFromExternInstrs(
  ctx: CodegenContext,
  fctx: FunctionContext,
  elemTypeIdx: number,
): Instr[] | undefined {
  if (ctx.anyValueTypeIdx < 0 || elemTypeIdx !== ctx.anyValueTypeIdx) return undefined;
  const fromExternIdx = ensureAnyFromExternHelper(ctx);
  if (fromExternIdx === undefined) return undefined;
  const tmp = allocLocal(fctx, `__anyv_elem_${fctx.locals.length}`, {
    kind: "externref",
  });
  return [
    { op: "local.tee", index: tmp },
    { op: "any.convert_extern" },
    { op: "ref.test", typeIdx: elemTypeIdx },
    {
      op: "if",
      blockType: {
        kind: "val",
        type: { kind: "ref_null", typeIdx: elemTypeIdx },
      },
      then: [
        { op: "local.get", index: tmp },
        { op: "any.convert_extern" },
        { op: "ref.cast_null", typeIdx: elemTypeIdx },
      ],
      else: [
        { op: "local.get", index: tmp },
        { op: "ref.is_null" },
        {
          op: "if",
          blockType: {
            kind: "val",
            type: { kind: "ref_null", typeIdx: elemTypeIdx },
          },
          // A null element keeps the old `ref.cast_null` answer (a null ref).
          then: [{ op: "ref.null", typeIdx: elemTypeIdx }],
          else: [
            { op: "local.get", index: tmp },
            { op: "call", funcIdx: fromExternIdx },
          ],
        },
      ],
    },
  ];
}
