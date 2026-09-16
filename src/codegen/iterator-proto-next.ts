// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * (#6484 S1/S2) The reachable half of the intrinsic iterator prototypes.
 *
 * `emitIteratorPrototypeSingleton` (array-object-proto.ts) already materializes
 * one identity-stable `$Object` per iterator FAMILY. What was missing is the two
 * ways a program actually reaches them:
 *
 *   - `__iter_rec_proto(rec)` — a RUN-TIME resolver keyed on the `$__IterRec`
 *     `family` tag (#6484 S1), so `Object.getPrototypeOf(<iterator>)` answers a
 *     genuine prototype even when the checker cannot name the argument's type.
 *     A non-record argument, and an `ITER_FAMILY_UNKNOWN` record, answer
 *     `ref.null.extern` — the historical result, so nothing that resolves today
 *     can regress.
 *   - `emitIteratorFamilyNextBody` — the §23.1.5.2 / §24.1.5.2 / §24.2.5.2
 *     `next` body: brand-check the receiver against the family, then step the
 *     record. A receiver that is not a record of the matching family throws a
 *     CATCHABLE TypeError (never a `ref.cast` trap) — the same discipline as
 *     `recoverRegExpStructFromExternref` and #2100 M2. This is what makes
 *     `iterator.next.call(false)` a TypeError and
 *     `iterator.next.call(map[Symbol.iterator]())` a genuine step.
 */
import type { Instr, ValType } from "../ir/types.js";
import type { CodegenContext, FunctionContext } from "./context/types.js";
import { mintDefinedFunc, pushDefinedFunc } from "./func-space.js";
import { addFuncType } from "./registry/types.js";
import { emitThrowTypeError } from "./js-errors.js";
import {
  ensureNativeIteratorRuntime,
  ITER_FAMILY_ARRAY,
  ITER_FAMILY_MAP,
  ITER_FAMILY_SET,
  ITER_FAMILY_STRING,
  ITER_REC_FAMILY_FIELD,
} from "./iterator-native.js";
import {
  emitIteratorPrototypeSingleton,
  ensureArrayIteratorNativeProtoGlue,
  ensureCollectionIteratorNativeProtoGlue,
  ensureStringNativeProtoGlue,
  type NativeIteratorPrototypeKind,
} from "./array-object-proto.js";
import { ensureStandaloneNativeMethodClosure } from "./native-proto.js";
import { pushBuiltinFnSingletonValueInstrs } from "./builtin-fn-meta.js";

const EXTERNREF: ValType = { kind: "externref" };

/**
 * The four families, in the order `__iter_rec_proto` tests them. Built lazily,
 * not as a module-level constant: this module and `iterator-native.ts` import
 * each other through `array-object-proto.ts`, and a top-level array would read
 * the `ITER_FAMILY_*` bindings before that cycle's other half has initialized.
 */
function families(): ReadonlyArray<readonly [number, NativeIteratorPrototypeKind]> {
  return [
    [ITER_FAMILY_ARRAY, "Array"],
    [ITER_FAMILY_MAP, "Map"],
    [ITER_FAMILY_SET, "Set"],
    [ITER_FAMILY_STRING, "String"],
  ];
}

/** A throwaway `FunctionContext` for building a helper body off to the side. */
function scratchFctx(name: string, params: ValType[]): FunctionContext {
  return {
    name,
    params: params.map((type, i) => ({ name: `p${i}`, type })),
    locals: [],
    localMap: new Map(),
    returnType: EXTERNREF,
    body: [],
    blockDepth: 0,
    breakStack: [],
    continueStack: [],
    labelMap: new Map(),
    savedBodies: [],
  };
}

/**
 * (#6484 S1) Register (idempotently) `__iter_rec_proto(externref) -> externref`
 * and return its funcIdx, or `undefined` when this module has no iterator
 * records at all (then the caller keeps its existing behaviour byte-for-byte).
 *
 * CALL ORDER: the singleton emission below can add late imports, which shifts
 * every defined-function index. Call this BEFORE compiling any argument into
 * the caller's body, and `flushLateImportShifts` on the caller afterwards —
 * the same discipline `compileNativeArrayIterator` documents for its builders.
 */
export function ensureIterRecPrototypeHelper(ctx: CodegenContext): number | undefined {
  const existing = ctx.funcMap.get("__iter_rec_proto");
  if (existing !== undefined) return existing;
  if (!(ctx.standalone || ctx.wasi)) return undefined;
  const recTypeIdx = ctx.structMap.get("__IterRec");
  if (recTypeIdx === undefined) return undefined;

  // locals: 0 = rec (param, externref); 1 = family (i32).
  const fctx = scratchFctx("__iter_rec_proto", [EXTERNREF]);
  fctx.locals.push({ name: "family", type: { kind: "i32" } });
  const familyLocal = 1;
  const loadRec = (): Instr[] => [{ op: "local.get", index: 0 }, { op: "any.convert_extern" }];

  // Bail out on a non-record subject FIRST (the historical null), then fall
  // through to the family switch at the body's top level: each singleton arm is
  // emitted by appending to `fctx.body` and spliced back out, which a
  // pre-declared nested `then:` array could not capture.
  fctx.body.push(
    ...loadRec(),
    { op: "ref.test", typeIdx: recTypeIdx },
    { op: "i32.eqz" },
    {
      op: "if",
      blockType: { kind: "empty" },
      then: [{ op: "ref.null.extern" }, { op: "return" }],
      else: [],
    },
    ...loadRec(),
    { op: "ref.cast", typeIdx: recTypeIdx },
    { op: "struct.get", typeIdx: recTypeIdx, fieldIdx: ITER_REC_FAMILY_FIELD },
    { op: "local.set", index: familyLocal },
  );

  for (const [family, kind] of families()) {
    // Emit the singleton off to the side, then hang it under the family test.
    const before = fctx.body.length;
    const emitted = emitIteratorPrototypeSingleton(ctx, fctx, kind);
    const armBody = fctx.body.splice(before);
    if (!emitted) continue;
    armBody.push({ op: "return" });
    fctx.body.push({ op: "local.get", index: familyLocal }, { op: "i32.const", value: family }, { op: "i32.eq" }, {
      op: "if",
      blockType: { kind: "empty" },
      then: armBody,
      else: [],
    } satisfies Instr);
  }
  fctx.body.push({ op: "ref.null.extern" });

  const typeIdx = addFuncType(ctx, [EXTERNREF], [EXTERNREF]);
  const funcIdx = mintDefinedFunc(ctx);
  ctx.funcMap.set("__iter_rec_proto", funcIdx);
  pushDefinedFunc(ctx, funcIdx, {
    name: "__iter_rec_proto",
    typeIdx,
    locals: fctx.locals,
    body: fctx.body,
    exported: false,
  });
  return funcIdx;
}

/**
 * (#6484 S2) `%XIteratorPrototype%.next` — the native method-closure body.
 *
 * ABI (native-proto.ts): local 0 = the closure struct, local 1 = the JavaScript
 * receiver as externref. Returns the §7.4.11 result object, or throws.
 *
 * Returns `null` (the factory then mints its catchable-TypeError refusal body,
 * i.e. today's behaviour) when this module carries no iterator runtime to step.
 */
export function emitIteratorFamilyNextBody(
  ctx: CodegenContext,
  fctx: FunctionContext,
  family: number,
  label: string,
): ValType | null {
  if (!(ctx.standalone || ctx.wasi)) return null;
  const recTypeIdx = ctx.structMap.get("__IterRec");
  const stepIdx = ctx.funcMap.get("__iter_next_result");
  if (recTypeIdx === undefined || stepIdx === undefined) return null;

  const loadThis = (): Instr[] => [{ op: "local.get", index: 1 }, { op: "any.convert_extern" }];
  fctx.body.push(...loadThis(), { op: "ref.test", typeIdx: recTypeIdx }, {
    op: "if",
    blockType: { kind: "empty" },
    then: [
      // §23.1.5.2 step 3: the record must belong to THIS family — a Map
      // iterator handed to `%SetIteratorPrototype%.next` is as wrong as a
      // primitive. `family` is immutable, so one read decides it.
      ...loadThis(),
      { op: "ref.cast", typeIdx: recTypeIdx },
      { op: "struct.get", typeIdx: recTypeIdx, fieldIdx: ITER_REC_FAMILY_FIELD },
      { op: "i32.const", value: family },
      { op: "i32.eq" },
      {
        op: "if",
        blockType: { kind: "empty" },
        then: [{ op: "local.get", index: 1 }, { op: "call", funcIdx: stepIdx }, { op: "return" }],
        else: [],
      },
    ],
    else: [],
  } satisfies Instr);
  // Steps 1-3 rejection. A primitive receiver (`false`, `1`, `''`, `undefined`,
  // `null`, a Symbol) and a plain object both land here, and both must be a
  // CATCHABLE TypeError — never the `ref.cast` trap a bare recovery would give.
  emitThrowTypeError(ctx, fctx, `${label} called on incompatible receiver`);
  return EXTERNREF;
}

/**
 * (#6484 S2) Map a checker symbol name to its iterator family, or `undefined`.
 * These four are the names TypeScript gives the results of every native
 * iterator producer (`[].values()` → `ArrayIterator`, `map.entries()` →
 * `MapIterator`, …), and they are mutually exclusive.
 */
export function iteratorPrototypeKindOfSymbolName(name: string | undefined): NativeIteratorPrototypeKind | undefined {
  switch (name) {
    case "ArrayIterator":
      return "Array";
    case "MapIterator":
      return "Map";
    case "SetIterator":
      return "Set";
    case "StringIterator":
      return "String";
    default:
      return undefined;
  }
}

/**
 * (#6484 S2) Push `%<kind>IteratorPrototype%.next` as a VALUE. Returns false
 * (having pushed nothing) when the family's glue or closure is unavailable, so
 * the caller falls through to its existing lowering.
 *
 * This is the read `iterator.next.call(…)` needs. It answers off the FAMILY,
 * not off the receiver's carrier, which is what makes it work for the eager
 * `$Vec` producers (`map.entries()`) as well as for live `$__IterRec` cursors —
 * both report the same prototype, so both must report the same `next`.
 */
export function resolveIteratorFamilyNextClosure(
  ctx: CodegenContext,
  kind: NativeIteratorPrototypeKind,
): { type: { kind: "ref"; typeIdx: number }; funcIdx: number } | null {
  // The closure's body steps a `$__IterRec`, so the record runtime must exist
  // BEFORE the body is emitted — otherwise the factory mints its throwing
  // refusal stand-in and caches it under the same funcMap key forever. A module
  // that reads `iterator.next` has an iterator either way, so this demands
  // nothing it does not already need.
  //
  // Registering is SPLIT from emitting on purpose: everything below can add a
  // late import, and doing that once a receiver is already compiled into the
  // caller's body is the #2043 index-shift hazard. Callers resolve first,
  // `flushLateImportShifts`, and only then compile and push.
  ensureNativeIteratorRuntime(ctx);
  const brand =
    kind === "Array"
      ? ensureArrayIteratorNativeProtoGlue(ctx)
      : kind === "String"
        ? ensureStringNativeProtoGlue(ctx)
        : ensureCollectionIteratorNativeProtoGlue(ctx, kind);
  if (brand === undefined) return null;
  return ensureStandaloneNativeMethodClosure(ctx, brand, "next", "method", { refusalBodyFallback: true });
}

/** Push an already-resolved `next` closure as an externref VALUE. Emit-only. */
export function pushIteratorFamilyNextValue(
  ctx: CodegenContext,
  fctx: FunctionContext,
  closure: { type: { kind: "ref"; typeIdx: number }; funcIdx: number },
): void {
  fctx.body.push(...pushBuiltinFnSingletonValueInstrs(ctx, closure), { op: "extern.convert_any" });
}

/**
 * (#6484 S2) `__extern_get` prologue for an `$__IterRec` receiver.
 *
 * A record carries NO own properties, so every read off one is a prototype
 * read: resolve `__iter_rec_proto(rec)` and re-enter with the prototype as the
 * receiver. One source of truth for the prototype, and S1's own `next` on each
 * family singleton is picked up for free. A record whose family is UNKNOWN
 * resolves to null and keeps falling through to the historical miss.
 *
 * No-op unless `__iter_rec_proto` was already demanded by this module.
 */
export function unshiftExternGetIterRecArm(ctx: CodegenContext): void {
  if (!(ctx.standalone || ctx.wasi)) return;
  const protoIdx = ctx.funcMap.get("__iter_rec_proto");
  const getIdx = ctx.funcMap.get("__extern_get");
  const recTypeIdx = ctx.structMap.get("__IterRec");
  if (protoIdx === undefined || getIdx === undefined || recTypeIdx === undefined) return;
  const fn = ctx.mod.functions.find((candidate) => candidate.name === "__extern_get");
  if (!fn) return;
  // params: 0 = obj, 1 = key. Append the scratch slot rather than reusing one:
  // the arm runs before every other prologue, so no existing local is free.
  const protoLocal = 2 + fn.locals.length;
  fn.locals.push({ name: "__iterrec_proto", type: { kind: "externref" } });
  fn.body.unshift(
    { op: "local.get", index: 0 },
    { op: "any.convert_extern" },
    { op: "ref.test", typeIdx: recTypeIdx },
    {
      op: "if",
      blockType: { kind: "empty" },
      then: [
        { op: "local.get", index: 0 },
        { op: "call", funcIdx: protoIdx },
        { op: "local.tee", index: protoLocal },
        { op: "ref.is_null" },
        {
          op: "if",
          blockType: { kind: "empty" },
          then: [],
          else: [
            { op: "local.get", index: protoLocal },
            { op: "local.get", index: 1 },
            { op: "call", funcIdx: getIdx },
            { op: "return" },
          ],
        },
      ],
      else: [],
    },
  );
}
