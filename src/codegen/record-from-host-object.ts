// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * (#5243 / #5346) Rebuild a compiler-minted `__anon_*` record struct from a
 * HOST object, property by property.
 *
 * Split out of `type-coercion.ts` (#5346) — it is one self-contained recovery
 * terminal, not part of the coercion matrix, and the god-file it lived in is
 * over its LOC budget. The coercion the reference-field arm needs is injected
 * as `recoverRefField` rather than imported, so this module does not depend on
 * `type-coercion.ts` and the two do not form an import cycle.
 */

import type { Instr, StructTypeDef, ValType } from "../ir/types.js";
import type { CodegenContext, FunctionContext } from "./context/types.js";
import { ensureLateImport, flushLateImportShifts } from "./expressions/late-imports.js";
import { stringConstantExternrefInstrs } from "./native-strings.js";
import { addStringConstantGlobal } from "./registry/imports.js";

/** The `__unbox_number` boundary helper, named once (#2108 vocabulary gate). */
const UNBOX_NUMBER = "__unbox_number";

/**
 * (#5243) Named-property fields of a compiler-synthesized ANONYMOUS record
 * shape (`__anon_*`) — the struct type an object literal's inferred type
 * lowers to. Returns `null` for anything that is not such a shape, so the
 * record materializer below stays off every class instance, vec, tuple and
 * branded shape.
 *
 * The gate is deliberately narrow. A `__anon_*` type is a bag of data
 * properties the compiler minted from a literal's own keys, so reading those
 * keys back off a host object by NAME reconstructs the same value. A class
 * instance type, a subtype (whose `struct.new` would also need the
 * supertype's fields), or a shape carrying an erased type BRAND all carry
 * meaning that a property-by-property copy would fabricate rather than
 * recover — those keep the historical null.
 */
export function getAnonRecordFields(ctx: CodegenContext, typeIdx: number): { name: string; type: ValType }[] | null {
  const typeDef = ctx.mod.types[typeIdx];
  if (!typeDef || typeDef.kind !== "struct") return null;
  const sd = typeDef as StructTypeDef;
  if (!sd.name?.startsWith("__anon_")) return null;
  if (sd.superTypeIdx !== undefined) return null;
  if (sd.fields.length === 0 || sd.fields.length > 32) return null;
  for (const field of sd.fields) {
    // Ordinary source property names only: no internal slots, no erased brands.
    if (!/^[A-Za-z_$][A-Za-z0-9_$]*$/.test(field.name)) return null;
    if (field.name.startsWith("__")) return null;
    if (/^_{1,2}[A-Za-z0-9_$]+Brand$/.test(field.name)) return null;
    switch (field.type.kind) {
      case "f64":
      case "i32":
      case "externref":
      case "anyref":
      // A NON-nullable `ref` field is deliberately absent: the recovery below
      // can only offer a nullable value for a reference slot, and `struct.new`
      // would reject it. Such a shape keeps the historical null.
      case "ref_null":
        break;
      default:
        return null;
    }
  }
  return sd.fields.map((f) => ({ name: f.name, type: f.type }));
}

/**
 * (#5346) Record types whose materializer is currently on the stack. Compile
 * time only, single-threaded, and always balanced by the `finally` in
 * {@link buildRecordFromExternref} — it exists solely to stop a cyclic record
 * shape from recursing forever while building its own field recovery.
 */
const materializingRecordTypes = new Set<number>();

/**
 * (#5243) Build a `__anon_*` record struct from a HOST object by reading each
 * of its declared properties by name.
 *
 * WHY this exists. `coerceType`'s `externref → ref/ref_null` arm tests the
 * incoming value against the target struct and, when the test fails, used to
 * push `ref.null` — a silently wrong value that only surfaces much later, and
 * usually as somebody else's error. The path that reaches it in practice is an
 * object literal with a SPREAD (`{ ...date, days: n }`): a spread's shape is
 * not statically closed, so `objectLiteralSpreadTakesHostPath` builds it on the
 * host and hands back an `externref`, while the enclosing function's INFERRED
 * return/param type is the concrete `__anon_*` record. The two meet here, the
 * `ref.test` fails because a host object is not a WasmGC struct, and the
 * function returns null. In `@js-temporal/polyfill` that is exactly
 * `Wr(e) → { ...t.date, days: n }`, whose null then travels as the second
 * argument of `calendar.dateAdd(date, duration, options)` and detonates inside
 * the ISO calendar's destructuring parameter as
 * `Cannot destructure 'null' or 'undefined'` — every Temporal `add`/`subtract`.
 *
 * This is the SINGLE terminal of that `else` chain: when the shape or the host
 * imports do not qualify it returns the historical `ref.null` itself, rather
 * than making its one call site branch (which would grow `coerceType`).
 *
 * Semantics, stated because they are not free:
 *   * null / undefined / a non-object stay `ref.null` — `RequireObjectCoercible`
 *     must still throw in the callee's destructure guard, and fabricating a
 *     zero-filled record out of `undefined` would hide a real spec error.
 *   * the result is a COPY. Writes through the materialized struct do not
 *     reach the host object. That is a real difference from a same-rep value,
 *     and it is the same trade the vec (#2831) and tuple (#1161)
 *     materializers next door already make — against a null, which supports no
 *     read at all.
 */
export function buildRecordFromExternref(
  ctx: CodegenContext,
  fctx: FunctionContext,
  externLocal: number,
  recordTypeIdx: number,
  recoverRefField: (fieldType: ValType) => Instr[],
): Instr[] {
  const nullFallback: Instr[] = [{ op: "ref.null", typeIdx: recordTypeIdx }];
  const fields = getAnonRecordFields(ctx, recordTypeIdx);
  if (!fields) return nullFallback;
  // A host-free target has no `__extern_get` to read the properties with.
  if (ctx.standalone || ctx.wasi) return nullFallback;
  // (#5346) A record whose own field type reaches back to it (`A.b: B`,
  // `B.a: A`) would recurse forever through the field recovery below. The set
  // is COMPILE-time only and always balanced by the `finally` at the end of
  // this function, so a refused nested level costs that one field its recovery
  // (it stays null) and nothing else.
  if (materializingRecordTypes.has(recordTypeIdx)) return nullFallback;

  const externref: ValType = { kind: "externref" };
  ensureLateImport(ctx, "__extern_get", [externref, externref], [externref]);
  ensureLateImport(ctx, "__extern_is_object", [externref], [{ kind: "i32" }]);
  ensureLateImport(ctx, UNBOX_NUMBER, [externref], [{ kind: "f64" }]);
  for (const field of fields) addStringConstantGlobal(ctx, field.name);
  flushLateImportShifts(ctx, fctx);

  const getIdx = ctx.funcMap.get("__extern_get");
  const isObjectIdx = ctx.funcMap.get("__extern_is_object");
  const unboxIdx = ctx.funcMap.get(UNBOX_NUMBER);
  if (getIdx === undefined || isObjectIdx === undefined || unboxIdx === undefined) return nullFallback;

  const build: Instr[] = [];
  // (#5346 / #2182) `build` is a DETACHED instruction array: the late-import
  // shifter walks `fctx.body`, `savedBodies`, `funcStack` and `liveBodies`, and
  // a raw local like this one is in none of them. The reference-field recovery
  // below can mint a late import (the vec materializer's `__extern_length` /
  // `__array_from_iter`), which shifts every DEFINED function index — including
  // the `__extern_get` / `__unbox_number` calls already pushed here when the
  // module lowers those natively. Registering `build` for the duration makes
  // those pushed `call`s move with the shift.
  ctx.liveBodies.add(build);
  materializingRecordTypes.add(recordTypeIdx);
  // Re-read on every use rather than trusting the indices frozen above: the
  // recovery can mint a late import mid-loop. `liveBodies` repairs the calls
  // already pushed; the ones pushed AFTER that shift need the NEW index.
  const helperIdx = (name: string, frozen: number): number => ctx.funcMap.get(name) ?? frozen;
  try {
    for (const field of fields) {
      build.push({ op: "local.get", index: externLocal }, ...stringConstantExternrefInstrs(ctx, field.name), {
        op: "call",
        funcIdx: helperIdx("__extern_get", getIdx),
      });
      switch (field.type.kind) {
        case "f64":
          build.push({ op: "call", funcIdx: helperIdx(UNBOX_NUMBER, unboxIdx) });
          break;
        case "i32":
          build.push({ op: "call", funcIdx: helperIdx(UNBOX_NUMBER, unboxIdx) }, { op: "i32.trunc_sat_f64_s" });
          break;
        case "externref":
          break;
        case "anyref":
          build.push({ op: "any.convert_extern" });
          break;
        default: {
          // `ref_null` (a non-nullable `ref` never reaches here — see
          // `getAnonRecordFields`). This used to be a BARE
          // `any.convert_extern; ref.cast_null`, described in the comment above
          // as "anything else lands as null on that ONE field". It does not:
          // `ref.cast null $T` traps unless the operand is null or already a
          // `$T`, and a property read off a HOST object never is — so the very
          // situation this materializer exists to recover from ended in
          // `RuntimeError: illegal cast` (prettier's `printDocToString`, whose
          // `Indent.queue` is an ordinary host array).
          //
          // `recoverRefField` routes the field through the SAME
          // `externref → ref_null` dispatch its enclosing value took to get
          // here: `ref.test` first, then a vec element-copy / tuple /
          // nested-record materialization, and only a genuine null when none of
          // those apply. Reusing that arm (rather than a local guarded cast) is
          // what makes `queue: []` arrive as an empty vec instead of a null
          // that detonates one frame later — the printer spins forever on the
          // null, so "no longer traps" would not have been enough.
          build.push(...recoverRefField(field.type));
          break;
        }
      }
    }
  } finally {
    materializingRecordTypes.delete(recordTypeIdx);
    ctx.liveBodies.delete(build);
  }
  build.push({ op: "struct.new", typeIdx: recordTypeIdx });

  const resultType: ValType = { kind: "ref_null", typeIdx: recordTypeIdx };
  return [
    { op: "local.get", index: externLocal },
    { op: "call", funcIdx: isObjectIdx },
    {
      op: "if",
      blockType: { kind: "val", type: resultType },
      then: build,
      else: nullFallback,
    },
  ];
}
