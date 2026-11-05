// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import type { Instr, ValType } from "../../ir/types.js";
import type { CodegenContext } from "../context/types.js";
import { i32NumberWidening } from "../../wasm/physical/numeric-carriers.js";

/**
 * Box one loaded vector element using its actual physical element type, never
 * the vecTypeMap key: the externref family also contains typed GC-reference
 * elements. Numbers use canonical boxing and the source integer domain;
 * externrefs pass through, AnyValue boxes peel by tag, and concrete struct/array
 * refs convert through the GC boundary. Boolean and unsupported referents return
 * null so their caller retains its existing fallback (#2190/#2162b/#6651).
 */
export function boxVecElementToExternref(ctx: CodegenContext, elemType: ValType): Instr[] | null {
  if (elemType.kind === "f64") {
    const boxIdx = ctx.funcMap.get("__box_number");
    if (boxIdx === undefined) return null;
    return [{ op: "call", funcIdx: boxIdx }];
  }
  if (elemType.kind === "i32") {
    // The `boolean`-tagged i32 variant must NOT box through `__box_number`
    // (number box ≠ boolean box) — skip it (falls back to prior null behaviour).
    if ((elemType as { boolean?: boolean }).boolean) return null;
    const boxIdx = ctx.funcMap.get("__box_number");
    if (boxIdx === undefined) return null;
    return [i32NumberWidening(elemType), { op: "call", funcIdx: boxIdx }];
  }
  // (#2162b) A carrier whose `data` array element is EXACTLY `externref` (read
  // from `arrDef.element`, never the `"externref"` map key — see the scope note
  // above and [[reference_vec_externref_key_not_uniform]]) needs only an
  // identity pass-through: the loaded element is already an `externref`, so it
  // satisfies the helper's `externref` return with no boxing. This is the
  // canonical externref `$Vec` that `arr.entries()`/`.keys()`/`.values()` and
  // the spread/`Array.from` materialization hand back. The dangerous variants
  // the scope note warns about are the `ref`/`ref_null`-element carriers (the
  // `arguments`/closure-arg vecs), which would leave a `(ref null N)` on the
  // `externref` return — those stay skipped below.
  if (elemType.kind === "externref") {
    return [];
  }
  // (#2190 read-back, homogeneous string sub-array) A carrier whose `data`
  // element is a GC *string* ref — `$AnyString` / `$NativeString`
  // (`ctx.anyStrTypeIdx` / `ctx.nativeStrTypeIdx`) — is the inner vec of an
  // `any[]` of homogeneous-string arrays (`[["a","b"]]`). Without an arm here,
  // `__extern_get_idx(inner, i)` falls through to null, the caller's
  // `ref.test $AnyString` then fails, and `struct.get` null-derefs on the
  // `.length`/element read (the `e[0][0]` trap). `extern.convert_any` is the
  // universal GC-ref → externref boxing; the consuming site re-tests/casts the
  // returned externref back to `$AnyString`, so the round-trip is identity for a
  // string element and null for an array hole. Scoped to the string GC types
  // only — the `arguments`/closure-arg `(ref null N)` carriers the scope note
  // warns about stay skipped (they are not string carriers) so this adds no
  // behaviour to those paths.
  if (elemType.kind === "ref" || elemType.kind === "ref_null") {
    const ti = (elemType as { typeIdx: number }).typeIdx;
    // (#6651 G3) A tagged `$AnyValue` element is a BOX, not the JS value: project
    // it by tag (`__any_to_extern`) so a vec reader hands on the value the
    // element read (`any-value-element-read.ts`) does. `extern.convert_any` of
    // the box leaked it — `ToNumber` and the `===` identity arm do not know it.
    const anyToExtern = ti >= 0 && ti === ctx.anyValueTypeIdx ? ctx.funcMap.get("__any_to_extern") : undefined;
    if (anyToExtern !== undefined) return [{ op: "call", funcIdx: anyToExtern }];
    // (#3244) GENERALISED from the string-only arm this replaces. A homogeneous
    // reference-element array — `[{ x: 777 }]` (element = object STRUCT ref) or a
    // nested `[[10, 20, 30]]` (element = inner `__vec_<k>` STRUCT ref) — compiles
    // to a typed `__vec_<structKind>` carrier, NOT `__vec_externref`. Boxing it
    // to `any`/externref and reading an element back (`(a as any)[0].x`,
    // `(a as any)[0][1]`, and the destructure-param inner object/array pattern)
    // routes through `__extern_get_idx`; without an arm here the carrier was
    // skipped → the element read fell to the null fallback → read back
    // undefined/NaN (and the nested-pattern destructure then saw null → the
    // "Cannot destructure null" trap). `extern.convert_any` is the universal
    // GC-ref → externref boxing (identity round-trip: the consuming site
    // re-tests/casts the returned externref back to the object/vec type, exactly
    // as for a heterogeneous `__vec_externref` element or the string sub-array
    // that the prior narrow arm handled — `$AnyString`/`$NativeString` are
    // struct types, so they still match here).
    //
    // GUARD — only GC STRUCT/ARRAY referents are subtypes of `anyref`, the input
    // `extern.convert_any` requires. A FUNC-typed ref (`funcref` hierarchy) is
    // NOT an `anyref` subtype, so converting it is invalid Wasm; those carriers
    // stay on the null fallback (the rare closure/funcref-element vec — never
    // read positionally through the boundary in practice). An unknown/negative
    // typeIdx also skips, conservatively.
    if (ti >= 0) {
      const referent = ctx.mod.types[ti];
      if (referent && (referent.kind === "struct" || referent.kind === "array")) {
        return [{ op: "extern.convert_any" }];
      }
    }
  }
  // other ref / ref_null / f32 / i64 / v128 → no arm (see scope note).
  return null;
}
