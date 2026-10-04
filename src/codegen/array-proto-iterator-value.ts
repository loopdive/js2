// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/** First-class Array.prototype iterator factories for standalone/WASI.
 * Keep the actual receiver, not a snapshot: LengthOfArrayLike and indexed Get
 * occur in next(), including for ordinary array-like objects. The family stamp
 * selects the shared %ArrayIteratorPrototype%; kind selects values/keys/entries.
 */
import type { Instr, ValType } from "../ir/types.js";
import type { CodegenContext, FunctionContext } from "./context/types.js";
import {
  ensureNativeIteratorRuntime,
  getOrRegisterIterRecType,
  ITER_FAMILY_ARRAY,
  ITER_KIND_VEC,
  ITER_KIND_ARRAY_KEYS,
  ITER_KIND_ARRAY_ENTRIES,
} from "./iterator-native.js";
import { noJsHost } from "./js-errors.js";
import { ensureObjectRuntime, ensureObjVecBuilders } from "./object-runtime.js";
import { getOrRegisterVecType } from "./registry/types.js";
import { ensureLateImport, flushLateImportShifts } from "./shared.js";
import { undefinedSingletonActive } from "./any-helpers.js";
import { emitBrandCheckTypeError } from "./native-proto.js";
import { emitIteratorPrototypeSingleton } from "./array-object-proto.js";

const EXT: ValType = { kind: "externref" };
const F64: ValType = { kind: "f64" };
const ARRAY_PROTO_ITERATOR_MEMBERS: ReadonlySet<string> = new Set(["values", "keys", "entries"]);

/** Closure-param 1 is this. Decline unsupported lanes or missing dependencies. */
export function emitArrayProtoIteratorMemberBody(
  ctx: CodegenContext,
  fctx: FunctionContext,
  member: string,
): ValType | undefined {
  if (!noJsHost(ctx) || !ARRAY_PROTO_ITERATOR_MEMBERS.has(member)) return undefined;
  ensureObjectRuntime(ctx);
  ensureNativeIteratorRuntime(ctx);
  ensureLateImport(ctx, "__extern_length", [EXT], [F64]);
  ensureLateImport(ctx, "__extern_get_idx", [EXT, F64], [EXT]);
  ensureLateImport(ctx, "__box_number", [F64], [EXT]);
  if (member === "entries" && ensureObjVecBuilders(ctx) === undefined) return undefined;
  flushLateImportShifts(ctx, fctx);
  for (const name of ["__extern_length", "__extern_get_idx", "__box_number"]) {
    if (!ctx.funcMap.has(name)) return undefined;
  }
  const iterRecTypeIdx = getOrRegisterIterRecType(ctx);
  const canonVecTypeIdx = getOrRegisterVecType(ctx, "externref", EXT);
  if (iterRecTypeIdx < 0 || canonVecTypeIdx < 0) return undefined;

  // A reflective factory exposes an iterator to arbitrary Get/Call clients.
  // Its next method must exist even when the source never names it itself.
  if (emitIteratorPrototypeSingleton(ctx, fctx, "Array") === null) return undefined;
  fctx.body.push({ op: "drop" });

  // ToObject rejects null/undefined before any length read. Undefined may be
  // a non-null sentinel, not a null externref.
  const thisThrow: Instr[] = [];
  emitBrandCheckTypeError(ctx, thisThrow, `Array.prototype.${member} called on null or undefined`);
  fctx.body.push({ op: "local.get", index: 1 }, { op: "ref.is_null" });
  const isUndefinedIdx = undefinedSingletonActive(ctx) ? ctx.funcMap.get("__extern_is_undefined") : undefined;
  if (isUndefinedIdx !== undefined) {
    fctx.body.push({ op: "local.get", index: 1 }, { op: "call", funcIdx: isUndefinedIdx }, { op: "i32.or" });
  }
  fctx.body.push({ op: "if", blockType: { kind: "empty" }, then: thisThrow });
  fctx.body.push(
    {
      op: "i32.const",
      value: member === "keys" ? ITER_KIND_ARRAY_KEYS : member === "entries" ? ITER_KIND_ARRAY_ENTRIES : ITER_KIND_VEC,
    },
    { op: "ref.null", typeIdx: canonVecTypeIdx },
    { op: "i32.const", value: 0 },
    { op: "local.get", index: 1 },
    { op: "i32.const", value: ITER_FAMILY_ARRAY },
    { op: "struct.new", typeIdx: iterRecTypeIdx },
    { op: "extern.convert_any" },
  );
  return EXT;
}
