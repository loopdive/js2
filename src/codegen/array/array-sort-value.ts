// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * (#6912, S3-m of #5385) `Array.prototype.sort` / `toSorted` as callable
 * VALUES on the native regime.
 *
 * The generic receiver is an array-LIKE, so the body is SortIndexedProperties
 * (§23.1.3.30.1) on the dynamic substrate:
 *
 *   1. comparefn neither undefined nor callable → TypeError, BEFORE ToObject.
 *   2. ToObject(this) guard; len = LengthOfArrayLike(O). `toSorted` checks
 *      ArrayCreate(len) (RangeError above 2^32-1) before reading anything.
 *   3. Collect: `sort` skips holes (HasProperty), `toSorted` reads through
 *      them (Get → undefined).
 *   4. A stable insertion sort with SortCompare (§23.1.3.30.2): undefined
 *      sorts last without calling comparefn; comparefn's result is ToNumber'd
 *      (NaN → +0); without comparefn the ToString forms compare by code unit.
 *   5. `sort` writes the sorted items back with Set(O, k, v, true) and deletes
 *      O[itemCount .. len) (DeletePropertyOrThrow), returning O; `toSorted`
 *      returns a fresh `$ObjVec`.
 *
 * The comparefn is called through `__apply_closure(fn, undefined, args)` with
 * a two-element `$ObjVec` argument carrier. Both members take the variadic
 * ABI (`.length` stays 1): under the undefined-singleton regime a padded
 * fixed slot reads `null` for an omitted comparator, which must be undefined,
 * while an explicit `null` must throw. Gated on the native regime.
 */
import type { Instr, ValType } from "../../ir/types.js";
import type { CodegenContext, FunctionContext } from "../context/types.js";
import { allocLocal } from "../context/locals.js";
import { canonicalUndefinedExternInstrs, undefinedSingletonActive } from "../any-helpers.js";
import { emitArrayProtoHofReceiverGuard, emitVariadicArgsUnpack } from "../array-reduce-proto-value.js";
import { prepareArrayLikeToString } from "../array-like-native.js";
import { buildThrowJsErrorInstrs } from "../js-errors.js";
import { ensureObjectRuntime } from "../object-runtime.js";
import { ensureNativeStringHelpers } from "../native-strings.js";
import { getOrRegisterArrayType } from "../registry/types.js";
import { coerceType, ensureLateImport, flushLateImportShifts } from "../shared.js";

const EXT: ValType = { kind: "externref" };
const F64: ValType = { kind: "f64" };
const I32: ValType = { kind: "i32" };

const get = (index: number): Instr => ({ op: "local.get", index });
const set = (index: number): Instr => ({ op: "local.set", index });
const f64 = (value: number): Instr => ({ op: "f64.const", value });
const i32 = (value: number): Instr => ({ op: "i32.const", value });
const call = (funcIdx: number): Instr => ({ op: "call", funcIdx });

/** `block { loop { <exit-cond> br_if 1; body; br 0 } }` */
function loop(exit: Instr[], body: Instr[]): Instr {
  return {
    op: "block",
    blockType: { kind: "empty" },
    body: [
      {
        op: "loop",
        blockType: { kind: "empty" },
        body: [...exit, { op: "br_if", depth: 1 }, ...body, { op: "br", depth: 0 }],
      },
    ],
  };
}

/** sort / toSorted take the packed variadic ABI so an omitted comparator is distinguishable from `null`. */
export function isArraySortVariadicMember(ctx: CodegenContext, member: string): boolean {
  return (member === "sort" || member === "toSorted") && (ctx.standalone || ctx.wasi);
}

const NAMES = [
  "__extern_length",
  "__extern_get_idx",
  "__extern_has_idx",
  "__extern_set_strict",
  "__delete_property",
  "__box_number",
  "__objvec_new",
  "__objvec_push",
  "__apply_closure",
  "__is_callable",
  "__extern_is_undefined",
] as const;

/**
 * Emit the sort / toSorted closure body. Returns `undefined`, emitting
 * nothing, for any other member, off the native regime, or when a dependency
 * is unavailable — the caller keeps its refusal.
 */
export function emitArraySortMemberBody(
  ctx: CodegenContext,
  fctx: FunctionContext,
  member: string,
): ValType | undefined {
  if (member !== "sort" && member !== "toSorted") return undefined;
  if (!ctx.standalone && !ctx.wasi) return undefined;
  if (fctx.params.length < 3 || ctx.anyStrTypeIdx < 0) return undefined;
  const isCopy = member === "toSorted";

  // Every late-import-adding ensure BEFORE the first body instruction.
  ensureObjectRuntime(ctx);
  ensureNativeStringHelpers(ctx);
  ensureLateImport(ctx, "__extern_length", [EXT], [F64]);
  ensureLateImport(ctx, "__extern_get_idx", [EXT, F64], [EXT]);
  ensureLateImport(ctx, "__extern_has_idx", [EXT, F64], [I32]);
  ensureLateImport(ctx, "__delete_property", [EXT, EXT], [I32]);
  ensureLateImport(ctx, "__box_number", [F64], [EXT]);
  ensureLateImport(ctx, "__objvec_new", [], [EXT]);
  ensureLateImport(ctx, "__objvec_push", [EXT, EXT], []);
  ensureLateImport(ctx, "__apply_closure", [EXT, EXT, EXT], [EXT]);
  ensureLateImport(ctx, "__is_callable", [EXT], [I32]);
  ensureLateImport(ctx, "__extern_is_undefined", [EXT], [I32]);
  const realBody = fctx.body;
  fctx.body = [{ op: "ref.null.extern" }]; // pre-register the ToNumber lowering's imports
  try {
    coerceType(ctx, fctx, EXT, F64);
  } finally {
    fctx.body = realBody;
  }
  flushLateImportShifts(ctx, fctx);
  if (prepareArrayLikeToString(ctx, fctx) === undefined) return undefined;
  const fn: Record<string, number> = {};
  for (const name of NAMES) {
    const idx = ctx.funcMap.get(name);
    if (idx === undefined) return undefined;
    fn[name] = idx;
  }
  // Re-read after every ensure above: the shared element ToString funcIdx.
  const toStringIdx = prepareArrayLikeToString(ctx, fctx)!;
  const strCompare = ctx.nativeStrHelpers.get("__str_compare");
  if (strCompare === undefined) return undefined;
  const arrType = getOrRegisterArrayType(ctx, "externref");
  const undef = canonicalUndefinedExternInstrs(ctx);

  // The comparator comes from the packed argument vector: an omitted one is
  // `undefined`, while an explicit `null` stays `null` (a TypeError). A padded
  // fixed slot would read null for both.
  const vecArgs = emitVariadicArgsUnpack(ctx, fctx, member);
  if (vecArgs === undefined) throw new Error(`Array.prototype.${member} value body lacks its argument vector`);
  const cmpFn = allocLocal(fctx, `__${member}_cmp_${fctx.locals.length}`, EXT);
  fctx.body.push(...vecArgs.argAt(0, undef), set(cmpFn));
  // `undefined` only — under the undefined-singleton regime a null externref is
  // JS `null`, which is NOT undefined: `sort(null)` is a TypeError and a `null`
  // element sorts by its ToString "null", not last. Without the singleton,
  // undefined and null share the null externref and `ref.is_null` is the test.
  const singleton = undefinedSingletonActive(ctx);
  const isUndef = (value: Instr[]): Instr[] =>
    singleton ? [...value, call(fn.__extern_is_undefined!)] : [...value, { op: "ref.is_null" }];
  // Step 1: comparefn must be undefined or callable — checked before ToObject.
  fctx.body.push(
    ...isUndef([get(cmpFn)]),
    { op: "i32.eqz" },
    {
      op: "if",
      blockType: { kind: "empty" },
      then: [
        get(cmpFn),
        call(fn.__is_callable!),
        { op: "i32.eqz" },
        {
          op: "if",
          blockType: { kind: "empty" },
          then: buildThrowJsErrorInstrs(
            ctx,
            "TypeError",
            `The comparison function must be either a function or undefined`,
          ),
        },
      ],
    },
  );
  emitArrayProtoHofReceiverGuard(ctx, fctx, member);

  const loc = (name: string, type: ValType): number =>
    allocLocal(fctx, `__${member}_${name}_${fctx.locals.length}`, type);
  const len = loc("len", F64);
  const k = loc("k", F64);
  const items = loc("items", EXT);
  const n = loc("n", I32);
  const arr = loc("arr", { kind: "ref_null", typeIdx: arrType });
  const i = loc("i", I32);
  const j = loc("j", I32);
  const x = loc("x", EXT);
  const y = loc("y", EXT);
  const v = loc("v", F64);
  const args = loc("args", EXT);

  fctx.body.push(get(1), call(fn.__extern_length!), set(len));
  if (isCopy) {
    fctx.body.push(
      get(len),
      f64(4294967295),
      { op: "f64.gt" },
      {
        op: "if",
        blockType: { kind: "empty" },
        then: buildThrowJsErrorInstrs(ctx, "RangeError", "Invalid array length"),
      },
    );
  }
  // Step 3: collect.
  const pushK: Instr[] = [get(items), get(1), get(k), call(fn.__extern_get_idx!), call(fn.__objvec_push!)];
  fctx.body.push(
    call(fn.__objvec_new!),
    set(items),
    f64(0),
    set(k),
    loop(
      [get(k), get(len), { op: "f64.ge" }],
      [
        ...(isCopy
          ? pushK
          : [
              get(1),
              get(k),
              call(fn.__extern_has_idx!),
              { op: "if", blockType: { kind: "empty" }, then: pushK } satisfies Instr,
            ]),
        get(k),
        f64(1),
        { op: "f64.add" },
        set(k),
      ],
    ),
    get(items),
    call(fn.__extern_length!),
    { op: "i32.trunc_sat_f64_u" },
    set(n),
    get(n),
    { op: "array.new_default", typeIdx: arrType },
    set(arr),
    i32(0),
    set(i),
    loop(
      [get(i), get(n), { op: "i32.ge_u" }],
      [
        get(arr),
        { op: "ref.as_non_null" },
        get(i),
        get(items),
        get(i),
        { op: "f64.convert_i32_u" },
        call(fn.__extern_get_idx!),
        { op: "array.set", typeIdx: arrType },
        get(i),
        i32(1),
        { op: "i32.add" },
        set(i),
      ],
    ),
  );

  const greater = sortCompareGreater(ctx, fctx, { fn, toStringIdx, strCompare, cmpFn, x, y, v, args, undef, isUndef });
  // Step 4: stable insertion sort.
  fctx.body.push(
    i32(1),
    set(i),
    loop(
      [get(i), get(n), { op: "i32.ge_u" }],
      [
        get(arr),
        { op: "ref.as_non_null" },
        get(i),
        { op: "array.get", typeIdx: arrType },
        set(x),
        get(i),
        i32(1),
        { op: "i32.sub" },
        set(j),
        loop(
          [
            get(j),
            i32(0),
            { op: "i32.lt_s" },
            {
              op: "if",
              blockType: { kind: "val", type: I32 },
              then: [i32(1)],
              else: [
                get(arr),
                { op: "ref.as_non_null" },
                get(j),
                { op: "array.get", typeIdx: arrType },
                set(y),
                ...greater,
                { op: "i32.eqz" },
              ],
            },
          ],
          [
            get(arr),
            { op: "ref.as_non_null" },
            get(j),
            i32(1),
            { op: "i32.add" },
            get(y),
            { op: "array.set", typeIdx: arrType },
            get(j),
            i32(1),
            { op: "i32.sub" },
            set(j),
          ],
        ),
        get(arr),
        { op: "ref.as_non_null" },
        get(j),
        i32(1),
        { op: "i32.add" },
        get(x),
        { op: "array.set", typeIdx: arrType },
        get(i),
        i32(1),
        { op: "i32.add" },
        set(i),
      ],
    ),
  );

  // Step 5: write back / build the copy.
  const elemAt: Instr[] = [get(arr), { op: "ref.as_non_null" }, get(i), { op: "array.get", typeIdx: arrType }];
  if (isCopy) {
    fctx.body.push(
      call(fn.__objvec_new!),
      set(items),
      i32(0),
      set(i),
      loop(
        [get(i), get(n), { op: "i32.ge_u" }],
        [get(items), ...elemAt, call(fn.__objvec_push!), get(i), i32(1), { op: "i32.add" }, set(i)],
      ),
      get(items),
    );
  } else {
    fctx.body.push(
      i32(0),
      set(i),
      loop(
        [get(i), get(n), { op: "i32.ge_u" }],
        [
          get(1),
          get(i),
          { op: "f64.convert_i32_u" },
          call(fn.__box_number!),
          ...elemAt,
          call(fn.__extern_set_strict!),
          get(i),
          i32(1),
          { op: "i32.add" },
          set(i),
        ],
      ),
      get(n),
      { op: "f64.convert_i32_u" },
      set(k),
      loop(
        [get(k), get(len), { op: "f64.ge" }],
        [
          get(1),
          get(k),
          call(fn.__box_number!),
          call(fn.__delete_property!),
          { op: "i32.eqz" },
          {
            op: "if",
            blockType: { kind: "empty" },
            then: buildThrowJsErrorInstrs(
              ctx,
              "TypeError",
              "Cannot delete property of the Array.prototype.sort receiver",
            ),
          },
          get(k),
          f64(1),
          { op: "f64.add" },
          set(k),
        ],
      ),
      get(1),
    );
  }
  return EXT;
}

interface SortCompareParts {
  readonly fn: Record<string, number>;
  readonly toStringIdx: number;
  readonly strCompare: number;
  readonly cmpFn: number;
  readonly x: number;
  readonly y: number;
  readonly v: number;
  readonly args: number;
  readonly undef: Instr[];
  readonly isUndef: (value: Instr[]) => Instr[];
}

/**
 * `SortCompare(y, x) > 0` as an i32 (§23.1.3.30.2) — y = arr[j], x = the
 * element being inserted. undefined sorts last without calling comparefn; the
 * comparefn result is ToNumber'd (a NaN result reads as +0, since NaN > 0 is
 * false); without comparefn the ToString forms compare by code unit.
 */
function sortCompareGreater(ctx: CodegenContext, fctx: FunctionContext, p: SortCompareParts): Instr[] {
  const { fn, toStringIdx, strCompare, cmpFn, x, y, v, args, undef, isUndef } = p;
  const realBody = fctx.body;
  const lower = (emit: () => void): Instr[] => {
    const out: Instr[] = [];
    fctx.body = out;
    try {
      emit();
    } finally {
      fctx.body = realBody;
    }
    return out;
  };
  const toNumber = lower(() => {
    fctx.body.push(
      call(fn.__objvec_new!),
      set(args),
      get(args),
      get(y),
      call(fn.__objvec_push!),
      get(args),
      get(x),
      call(fn.__objvec_push!),
      get(cmpFn),
      ...undef,
      get(args),
      call(fn.__apply_closure!),
    );
    coerceType(ctx, fctx, EXT, F64);
  });
  const toStr = (value: number): Instr[] => [
    get(value),
    call(toStringIdx),
    { op: "any.convert_extern" },
    { op: "ref.cast", typeIdx: ctx.anyStrTypeIdx },
  ];
  return [
    // y undefined → y sorts after x (1 > 0); x undefined → -1; both → 0.
    ...isUndef([get(y)]),
    {
      op: "if",
      blockType: { kind: "val", type: I32 },
      then: [...isUndef([get(x)]), { op: "i32.eqz" }],
      else: [
        ...isUndef([get(x)]),
        {
          op: "if",
          blockType: { kind: "val", type: I32 },
          then: [i32(0)],
          else: [
            ...isUndef([get(cmpFn)]),
            {
              op: "if",
              blockType: { kind: "val", type: I32 },
              then: [...toStr(y), ...toStr(x), call(strCompare), i32(0), { op: "i32.gt_s" }],
              else: [...toNumber, set(v), get(v), f64(0), { op: "f64.gt" }],
            },
          ],
        },
      ],
    },
  ];
}
