// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// (#6867) Optional-field struct WIDENING at a typed-ref coercion.
//
// TypeScript accepts `const o = { a: "x" }; f(o)` against
// `function f(p: { a: string; b?: unknown })` — the target shape only adds
// OPTIONAL properties. The two shapes lower to distinct WasmGC structs
// (`{a}` vs `{a, b}`), and `coerceType`'s guarded downcast between unrelated
// structs fails its `ref.test`, yields `ref.null`, and the callee's parameter
// arrives null ("dereferencing a null pointer" on the first field read). That
// is the whole jest `expectationResultFactory` cluster: every test builds an
// `options` local that omits some optional `Options` fields.
//
// #4394 already builds an object LITERAL in argument position directly as the
// expected struct; this module covers every other source (a local, a field, a
// return value): when every destination field missing from the source is a
// declared-optional property, the coercion
//   1. keeps the value unchanged when it already IS the target struct at
//      runtime (`ref.test` succeeds — identity, subtype and fields preserved);
//   2. otherwise projects it into a fresh target struct, copying the shared
//      fields and completing the absent optional ones with JS `undefined`
//      (externref: the canonical undefined; f64: the #866 sentinel).
// A missing REQUIRED field still declines, so `base as Derived` keeps the
// established guarded-cast behaviour.

import type { Instr, ValType } from "../../ir/types.js";
import { ts } from "../../ts-api.js";
import type { FunctionContext } from "../context/types.js";
import { allocTempLocal, releaseTempLocal } from "../context/locals.js";
import { popBody, pushBody } from "../context/bodies.js";

/** Record a declared-optional property (`k?: T`) on its struct field. */
export function optionalFieldFlag(prop: ts.Symbol): { optional?: true } {
  return (prop.flags & ts.SymbolFlags.Optional) !== 0 ? { optional: true } : {};
}

/**
 * Emit the widening for a source ref already on the stack. `project` emits the
 * field-copy projection, consuming the NON-NULL source ref pushed before it.
 */
export function emitOptionalFieldWidening(
  fctx: FunctionContext,
  fromTypeIdx: number,
  toTypeIdx: number,
  toNullable: boolean,
  project: () => void,
): void {
  const sourceLocal = allocTempLocal(fctx, { kind: "ref_null", typeIdx: fromTypeIdx });
  fctx.body.push({ op: "local.set", index: sourceLocal });
  const resultType: ValType = { kind: "ref_null", typeIdx: toTypeIdx };
  const saved = pushBody(fctx);
  let projection: Instr[];
  try {
    fctx.body.push({ op: "local.get", index: sourceLocal }, { op: "ref.as_non_null" });
    project();
    projection = fctx.body;
  } finally {
    popBody(fctx, saved);
  }
  // A null source keeps null (`undefined`/`null` flows through like the
  // narrowing arm); the trailing assert below handles non-null targets.
  const nonNullArm: Instr[] = [
    { op: "local.get", index: sourceLocal },
    { op: "ref.test", typeIdx: toTypeIdx },
    {
      op: "if",
      blockType: { kind: "val", type: resultType },
      then: [
        { op: "local.get", index: sourceLocal },
        { op: "ref.cast_null", typeIdx: toTypeIdx },
      ],
      else: projection,
    },
  ];
  fctx.body.push(
    { op: "local.get", index: sourceLocal },
    { op: "ref.is_null" },
    {
      op: "if",
      blockType: { kind: "val", type: resultType },
      then: [{ op: "ref.null", typeIdx: toTypeIdx }],
      else: nonNullArm,
    },
  );
  if (!toNullable) fctx.body.push({ op: "ref.as_non_null" });
  releaseTempLocal(fctx, sourceLocal);
}
