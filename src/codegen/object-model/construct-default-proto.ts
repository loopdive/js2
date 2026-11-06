// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * #6651 W2b — §10.1.14 GetPrototypeFromConstructor step 4 for the standalone
 * ordinary [[Construct]] paths.
 *
 *   3. Let proto be ? Get(constructor, "prototype").
 *   4. If proto is not an Object, then … set proto to realm's intrinsic
 *      object named intrinsicDefaultProto.
 *
 * Every native construct route ends in `__object_create(proto)`
 * (`object-runtime-prototype.ts`), and that helper already encodes step 4 for
 * every non-Object EXCEPT one: a non-null value that is not an `$Object`
 * (undefined, a number, a string, a symbol) leaves `$proto` null with no
 * `OBJ_FLAG_NULL_PROTO` — the runtime's encoding of an ordinary object whose
 * [[Prototype]] is the implicit `%Object.prototype%` terminal, the same shape a
 * `{}` literal has. A raw JS `null`, by contrast, is `Object.create(null)`'s
 * argument and sets the explicit-null flag. So `F.prototype = null; new F()`
 * built a null-prototype instance where the spec answers `%Object.prototype%`.
 *
 * The fix is therefore not a new prototype source but a rewrite of that one
 * value: a constructor-derived `null` becomes `undefined` before it reaches
 * `__object_create`. `undefined` is not an Object either, so the step-4 verdict
 * is unchanged; only the encoding moves to the implicit terminal. The
 * intrinsicDefaultProto of every route that reaches the shared driver is
 * `%Object.prototype%` (ordinary functions, bound/proxy forwards to them, and
 * the `Array.from`/`Array.of` constructor lane, whose `C` is user code).
 *
 * Standalone only: in the JS-host lane `__object_create` is the host's
 * `Object.create`, which throws on `undefined`.
 */
import type { Instr } from "../../ir/types.js";
import type { CodegenContext } from "../context/types.js";
import { definedFuncAt } from "../func-space.js";

/**
 * Instructions that rewrite a null `protoLocal` (externref) to the canonical
 * `undefined`, so `__object_create` builds an ordinary object on the implicit
 * `%Object.prototype%` terminal. `[]` — identical bytes — when the module's
 * `__object_create` is not the native one or no `undefined` singleton exists;
 * never mints anything, so it is safe at finalize/fill time.
 */
export function constructorProtoNullToDefaultInstrs(ctx: CodegenContext, protoLocal: number): Instr[] {
  const createIdx = ctx.funcMap.get("__object_create");
  if (createIdx === undefined || definedFuncAt(ctx, createIdx) === undefined) return [];
  const undefIdx = ctx.undefinedGlobalIdx;
  if (undefIdx === undefined) return [];
  return [
    { op: "local.get", index: protoLocal },
    { op: "ref.is_null" },
    {
      op: "if",
      blockType: { kind: "empty" },
      then: [
        { op: "global.get", index: undefIdx },
        { op: "extern.convert_any" },
        { op: "local.set", index: protoLocal },
      ],
    },
  ];
}
