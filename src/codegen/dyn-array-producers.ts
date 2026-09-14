// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * #6447 — native standalone bodies for the PURE Array.prototype producer
 * methods on a DYNAMIC (`any`/externref) receiver.
 *
 * The gap this closes is stated in `__extern_method_call`'s own comment
 * (object-runtime.ts): "Non-`$Object` brands ($Vec/string/Map/Set instance
 * methods on a genuinely-`any` receiver) … return undefined here for now". The
 * closed-method dispatcher grew brand arms for the callback family (#3098 /
 * #4394), the in-place mutators `push`/`pop` (#2927) and the collections
 * (#3309), but never for the producer methods — so under `--target standalone`
 *
 *     function f(n, r) { return n.concat(r); }   // n, r : any
 *
 * answered a value that is not the concatenation and not an Array, and inside
 * the compiled `@js-temporal/polyfill` provider it answered `undefined`
 * outright. That is the whole of the Temporal lane's property-bag surface:
 * `PrepareCalendarFields` is `const a = n.concat(r, i); … a.sort();`, so
 * `from(bag)` / `compare(bag, ·)` / `equals(bag)` / `with(bag)` every one died
 * with `Cannot read properties of undefined (reading 'sort')`.
 *
 * Two members are served here — `concat` and `sort`. They are the two on that
 * path and they COMPOSE: fixing `concat` alone moves the failure one statement
 * later, onto a `sort` that is broken in the same way. `slice`, `reverse`,
 * `includes`, `splice` and `flat` are the same defect; they are named in #6447
 * with their reduction rather than fixed here, because each needs its own
 * species / hole-semantics review and none of them is on the attributed path.
 *
 * Everything runs on the array-like substrate the #3098 HOF loops and the
 * #4394 generic mutators already use (`__extern_length`, `__extern_get_idx`,
 * `__extern_set`, `__extern_is_array`, `__extern_toString`,
 * `__extern_is_undefined`, `__objvec_new`/`__objvec_push`, `__apply_closure`),
 * NOT on a typed `$Vec` cast. That is deliberate: the arm has to serve a
 * `$ObjVec` (the carrier `concat` itself produces, and the one `Object.keys` /
 * `map` / `filter` produce) and an ordinary array-LIKE, not only a concrete
 * `__vec_<k>`. It is also why the helper never traps on a receiver it did not
 * expect — an unknown shape reads length 0 and answers an empty result, the
 * same contract the HOF loops have.
 *
 * Emitted at RESERVE time (append-only defined funcs — no funcIdx shift, the
 * `ensureNativeArrayHof` / `ensureObjectGroupBy` invariant), so
 * `fillClosedMethodDispatch` only READS `funcMap` (#1719). Standalone-only:
 * the `__extern_get_idx` array-like arms these bodies read through are emitted
 * only under `ctx.standalone` (`objArrayLikeArms` in `ensureObjectRuntime`),
 * which is the same gate `ensureNativeArrayHof` carries.
 */
import type { Instr, ValType } from "../ir/types.js";
import { undefinedExternInstrs } from "./any-helpers.js";
import type { CodegenContext } from "./context/types.js";
import { mintDefinedFunc, pushDefinedFunc } from "./func-space.js";
import { ensureNativeStringHelpers } from "./native-strings.js";
import { ensureObjectRuntime, reserveApplyClosure } from "./object-runtime.js";
import { addFuncType } from "./registry/types.js";
import { addUnionImportsViaRegistry } from "./shared.js";

/**
 * Method names served by {@link ensureNativeArrayProducer} — the single source
 * shared by the dispatcher's reserve gate and its fill arm.
 */
export const DYN_ARRAY_PRODUCER_METHODS: ReadonlySet<string> = new Set(["concat", "sort"]);

/**
 * Arity forms the dispatcher arm may claim. `concat` is variadic in the spec
 * and the dispatcher is minted per arity, so every arity is admissible; `sort`
 * takes at most one (the comparator). A form outside this set keeps the
 * pre-#6447 fall-through, so nothing that used to reach `__extern_method_call`
 * loses an answer it had.
 */
export function isDynArrayProducerForm(methodName: string, arity: number): boolean {
  if (methodName === "concat") return arity >= 0;
  if (methodName === "sort") return arity === 0 || arity === 1;
  return false;
}

interface ProducerDeps {
  externLength: number;
  externGetIdx: number;
  externSet: number;
  externIsArray: number;
  externToString: number;
  externIsUndefined: number;
  objVecNew: number;
  objVecPush: number;
  boxNumber: number;
  applyClosure: number;
}

function resolveDeps(ctx: CodegenContext): ProducerDeps | undefined {
  // All append-only + idempotent at this (reserve-time) point. Mirrors
  // `ensureNativeArrayHof`: call the registry wrapper explicitly so this helper
  // never depends on `ensureObjectRuntime`'s internal ordering.
  ensureObjectRuntime(ctx);
  addUnionImportsViaRegistry(ctx);
  // `sort`'s default (no-comparator) order is ToString order, and its
  // comparator is the native `__str_compare`. Register the native string
  // helpers here rather than at the comparison site: this is reserve time, so
  // the registration is append-only, whereas the same call from inside a
  // function body is the mid-body late-import shift hazard (#1839).
  if (ctx.nativeStrings) ensureNativeStringHelpers(ctx);
  const applyClosure = reserveApplyClosure(ctx);
  const externLength = ctx.funcMap.get("__extern_length");
  const externGetIdx = ctx.funcMap.get("__extern_get_idx");
  const externSet = ctx.funcMap.get("__extern_set");
  const externIsArray = ctx.funcMap.get("__extern_is_array");
  const externToString = ctx.funcMap.get("__extern_toString");
  const externIsUndefined = ctx.funcMap.get("__extern_is_undefined");
  const objVecNew = ctx.funcMap.get("__objvec_new");
  const objVecPush = ctx.funcMap.get("__objvec_push");
  const boxNumber = ctx.funcMap.get("__box_number");
  if (
    externLength === undefined ||
    externGetIdx === undefined ||
    externSet === undefined ||
    externIsArray === undefined ||
    externToString === undefined ||
    externIsUndefined === undefined ||
    objVecNew === undefined ||
    objVecPush === undefined ||
    boxNumber === undefined
  ) {
    return undefined; // defensive — every name is registered just above
  }
  return {
    externLength,
    externGetIdx,
    externSet,
    externIsArray,
    externToString,
    externIsUndefined,
    objVecNew,
    objVecPush,
    boxNumber,
    applyClosure,
  };
}

/** `for (i = <init>; i < <limitLocal>; i += 1) { body }` over f64 index locals. */
function f64CountLoop(iLocal: number, limitLocal: number, body: Instr[]): Instr[] {
  return [
    { op: "f64.const", value: 0 },
    { op: "local.set", index: iLocal },
    {
      op: "block",
      blockType: { kind: "empty" },
      body: [
        {
          op: "loop",
          blockType: { kind: "empty" },
          body: [
            { op: "local.get", index: iLocal },
            { op: "local.get", index: limitLocal },
            { op: "f64.ge" },
            { op: "br_if", depth: 1 },
            ...body,
            { op: "local.get", index: iLocal },
            { op: "f64.const", value: 1 },
            { op: "f64.add" },
            { op: "local.set", index: iLocal },
            { op: "br", depth: 0 },
          ],
        },
      ],
    },
  ];
}

/**
 * `__arrprod_concat(recv, args) -> externref` — ES2025 §23.1.3.1 minus
 * `@@isConcatSpreadable`.
 *
 * Spreading is decided by `__extern_is_array`, which is the module's OWN
 * IsArray predicate (filled at finalize over every registered array carrier),
 * so a `$ObjVec` argument spreads exactly like a `__vec_f64` one. The omitted
 * `@@isConcatSpreadable` consultation is the same simplification the typed
 * fast path makes when `concatMustConsultPrototypeChain` is false; a module
 * that can observe the symbol takes the §23.1.3.1 spec loop on the typed path
 * and does not reach here.
 *
 * The result is a `$ObjVec` — the established boxed-any dynamic array carrier
 * (`Object.keys`, `groupBy` groups, the #3098 `map`/`filter` results). It is
 * deliberately NOT a typed vec: the inputs are `any`, so the elements are
 * heterogeneous by construction (#2379).
 */
function buildConcatBody(ctx: CodegenContext, deps: ProducerDeps): { body: Instr[]; locals: ValType[] } {
  const OUT = 2;
  const LEN = 3;
  const I = 4;
  const ALEN = 5;
  const J = 6;
  const ARG = 7;
  const KLEN = 8;
  const K = 9;

  const pushFrom = (srcLocal: number, idxLocal: number): Instr[] => [
    { op: "local.get", index: OUT },
    { op: "local.get", index: srcLocal },
    { op: "local.get", index: idxLocal },
    { op: "call", funcIdx: deps.externGetIdx },
    { op: "call", funcIdx: deps.objVecPush },
  ];

  const body: Instr[] = [
    { op: "call", funcIdx: deps.objVecNew },
    { op: "local.set", index: OUT },
    // Receiver elements first.
    { op: "local.get", index: 0 },
    { op: "call", funcIdx: deps.externLength },
    { op: "local.set", index: LEN },
    ...f64CountLoop(I, LEN, pushFrom(0, I)),
    // Then each argument, spread when it is an Array.
    { op: "local.get", index: 1 },
    { op: "call", funcIdx: deps.externLength },
    { op: "local.set", index: ALEN },
    ...f64CountLoop(J, ALEN, [
      { op: "local.get", index: 1 },
      { op: "local.get", index: J },
      { op: "call", funcIdx: deps.externGetIdx },
      { op: "local.set", index: ARG },
      { op: "local.get", index: ARG },
      { op: "call", funcIdx: deps.externIsArray },
      {
        op: "if",
        blockType: { kind: "empty" },
        then: [
          { op: "local.get", index: ARG },
          { op: "call", funcIdx: deps.externLength },
          { op: "local.set", index: KLEN },
          ...f64CountLoop(K, KLEN, pushFrom(ARG, K)),
        ],
        else: [
          { op: "local.get", index: OUT },
          { op: "local.get", index: ARG },
          { op: "call", funcIdx: deps.objVecPush },
        ],
      },
    ]),
    { op: "local.get", index: OUT },
  ];

  const locals: ValType[] = [
    { kind: "externref" }, // OUT
    { kind: "f64" }, // LEN
    { kind: "f64" }, // I
    { kind: "f64" }, // ALEN
    { kind: "f64" }, // J
    { kind: "externref" }, // ARG
    { kind: "f64" }, // KLEN
    { kind: "f64" }, // K
  ];
  void ctx;
  return { body, locals };
}

/**
 * `__arrprod_sort_cmp(a, b, comparefn, hasCompare: i32) -> i32` — §23.1.3.30
 * SortCompare, answering a -1/0/1 sign.
 *
 * Two properties worth stating because a reader cannot re-derive them:
 *
 *  - The `undefined` rows come FIRST and are independent of `comparefn`
 *    (steps 1–3). Getting this wrong is not a mis-ordering, it is a call of the
 *    user comparator with `undefined`, which the spec forbids.
 *  - The default (no-comparator) order is ToString order, and the string
 *    comparison is GUARDED by `ref.test $AnyString` on both operands rather
 *    than an unguarded `ref.cast`. `__extern_toString` answers an externref
 *    whose payload is a native string in every shape this arm is reachable
 *    for, but an unguarded cast turns a shape we did not anticipate into an
 *    UNCATCHABLE trap; the guard degrades it to "compare equal", which an
 *    insertion sort renders as "leave the pair in its existing order". A wrong
 *    order is recoverable and visible; a trap in a sort is neither.
 */
function buildSortCompareBody(ctx: CodegenContext, deps: ProducerDeps): { body: Instr[]; locals: ValType[] } {
  const RES = 4; // externref — the comparator's result
  const RV = 5; // f64      — that result as a number
  const SA = 6; // anyref   — ToString(a)
  const SB = 7; // anyref   — ToString(b)
  const ARGS = 8; // externref — the $ObjVec (a, b) handed to the comparator

  const strCompare = ctx.nativeStrHelpers.get("__str_compare");
  const anyStrTypeIdx = ctx.anyStrTypeIdx;
  const typeofNumber = ctx.funcMap.get("__typeof_number");
  const unboxNumber = ctx.funcMap.get("__unbox_number");

  // Default ToString ordering. Unavailable (host-string lane / no `$AnyString`)
  // ⇒ "equal", i.e. the receiver keeps its order — the same no-op the typed
  // default sort takes when its own helpers are missing (#2502).
  const defaultOrder: Instr[] =
    strCompare === undefined || anyStrTypeIdx < 0
      ? [{ op: "i32.const", value: 0 }]
      : [
          { op: "local.get", index: 0 },
          { op: "call", funcIdx: deps.externToString },
          { op: "any.convert_extern" },
          { op: "local.set", index: SA },
          { op: "local.get", index: 1 },
          { op: "call", funcIdx: deps.externToString },
          { op: "any.convert_extern" },
          { op: "local.set", index: SB },
          { op: "local.get", index: SA },
          { op: "ref.test", typeIdx: anyStrTypeIdx },
          { op: "local.get", index: SB },
          { op: "ref.test", typeIdx: anyStrTypeIdx },
          { op: "i32.and" },
          {
            op: "if",
            blockType: { kind: "val", type: { kind: "i32" } },
            then: [
              { op: "local.get", index: SA },
              { op: "ref.cast", typeIdx: anyStrTypeIdx },
              { op: "local.get", index: SB },
              { op: "ref.cast", typeIdx: anyStrTypeIdx },
              { op: "call", funcIdx: strCompare },
            ],
            else: [{ op: "i32.const", value: 0 }],
          },
        ];

  // User comparator: sign(ToNumber(comparefn(a, b))). A non-numeric answer is
  // read as 0 rather than unboxed blindly — `__unbox_number` on a non-number
  // carrier has no defined answer here.
  const comparatorOrder: Instr[] =
    typeofNumber === undefined || unboxNumber === undefined
      ? defaultOrder
      : [
          { op: "call", funcIdx: deps.objVecNew },
          { op: "local.set", index: ARGS },
          { op: "local.get", index: ARGS },
          { op: "local.get", index: 0 },
          { op: "call", funcIdx: deps.objVecPush },
          { op: "local.get", index: ARGS },
          { op: "local.get", index: 1 },
          { op: "call", funcIdx: deps.objVecPush },
          { op: "local.get", index: 2 },
          ...(undefinedExternInstrs(ctx) ?? [{ op: "ref.null.extern" } satisfies Instr]),
          { op: "local.get", index: ARGS },
          { op: "call", funcIdx: deps.applyClosure },
          { op: "local.set", index: RES },
          { op: "local.get", index: RES },
          { op: "call", funcIdx: typeofNumber },
          {
            op: "if",
            blockType: { kind: "val", type: { kind: "f64" } },
            then: [
              { op: "local.get", index: RES },
              { op: "call", funcIdx: unboxNumber },
            ],
            else: [{ op: "f64.const", value: 0 }],
          },
          { op: "local.set", index: RV },
          { op: "local.get", index: RV },
          { op: "f64.const", value: 0 },
          { op: "f64.lt" },
          {
            op: "if",
            blockType: { kind: "val", type: { kind: "i32" } },
            then: [{ op: "i32.const", value: -1 }],
            else: [
              { op: "local.get", index: RV },
              { op: "f64.const", value: 0 },
              { op: "f64.gt" },
              {
                op: "if",
                blockType: { kind: "val", type: { kind: "i32" } },
                then: [{ op: "i32.const", value: 1 }],
                else: [{ op: "i32.const", value: 0 }],
              },
            ],
          },
        ];

  const body: Instr[] = [
    // §23.1.3.30 steps 1–3: undefined sorts to the end, before any comparator.
    { op: "local.get", index: 0 },
    { op: "call", funcIdx: deps.externIsUndefined },
    {
      op: "if",
      blockType: { kind: "val", type: { kind: "i32" } },
      then: [
        { op: "local.get", index: 1 },
        { op: "call", funcIdx: deps.externIsUndefined },
        {
          op: "if",
          blockType: { kind: "val", type: { kind: "i32" } },
          then: [{ op: "i32.const", value: 0 }],
          else: [{ op: "i32.const", value: 1 }],
        },
      ],
      else: [
        { op: "local.get", index: 1 },
        { op: "call", funcIdx: deps.externIsUndefined },
        {
          op: "if",
          blockType: { kind: "val", type: { kind: "i32" } },
          then: [{ op: "i32.const", value: -1 }],
          else: [
            { op: "local.get", index: 3 },
            {
              op: "if",
              blockType: { kind: "val", type: { kind: "i32" } },
              then: comparatorOrder,
              else: defaultOrder,
            },
          ],
        },
      ],
    },
  ];

  const locals: ValType[] = [
    { kind: "externref" }, // RES
    { kind: "f64" }, // RV
    { kind: "anyref" }, // SA
    { kind: "anyref" }, // SB
    { kind: "externref" }, // ARGS
  ];
  return { body, locals };
}

/**
 * `__arrprod_sort(recv, args) -> externref` — §23.1.3.30, in place, returning
 * the receiver.
 *
 * A stable INSERTION sort, and that is a deliberate choice rather than an
 * oversight: this arm is reached only by an `any`-receiver sort, never by the
 * typed path (which keeps its Timsort / merge sort in array-methods.ts), so
 * the O(n²) comparison count is paid only where the alternative today is
 * `undefined`. It also gets stability for free, which §23.1.3.30 requires.
 * Element access goes through `__extern_get_idx` / `__extern_set`, so the same
 * body sorts a `__vec_<k>`, a `$ObjVec` and an ordinary array-like.
 */
function buildSortBody(ctx: CodegenContext, deps: ProducerDeps, cmpIdx: number): { body: Instr[]; locals: ValType[] } {
  const CMP = 2; // externref — comparefn or undefined
  const HAS = 3; // i32
  const LEN = 4; // f64
  const I = 5; // f64
  const J = 6; // f64
  const CUR = 7; // externref
  const PREV = 8; // externref

  const typeofFunction = ctx.funcMap.get("__typeof_function");

  const setAt = (idxInstrs: Instr[], valueLocal: number): Instr[] => [
    { op: "local.get", index: 0 },
    ...idxInstrs,
    { op: "call", funcIdx: deps.boxNumber },
    { op: "local.get", index: valueLocal },
    { op: "call", funcIdx: deps.externSet },
  ];

  const body: Instr[] = [
    // comparefn = args[0] when present; hasCompare = IsCallable(comparefn).
    { op: "local.get", index: 1 },
    { op: "f64.const", value: 0 },
    { op: "call", funcIdx: deps.externGetIdx },
    { op: "local.set", index: CMP },
    ...(typeofFunction === undefined
      ? ([{ op: "i32.const", value: 0 }] satisfies Instr[])
      : ([
          { op: "local.get", index: CMP },
          { op: "call", funcIdx: typeofFunction },
        ] satisfies Instr[])),
    { op: "local.set", index: HAS },
    { op: "local.get", index: 0 },
    { op: "call", funcIdx: deps.externLength },
    { op: "local.set", index: LEN },
    // for (i = 1; i < len; i++) { cur = a[i]; j = i - 1; … }
    { op: "f64.const", value: 1 },
    { op: "local.set", index: I },
    {
      op: "block",
      blockType: { kind: "empty" },
      body: [
        {
          op: "loop",
          blockType: { kind: "empty" },
          body: [
            { op: "local.get", index: I },
            { op: "local.get", index: LEN },
            { op: "f64.ge" },
            { op: "br_if", depth: 1 },
            { op: "local.get", index: 0 },
            { op: "local.get", index: I },
            { op: "call", funcIdx: deps.externGetIdx },
            { op: "local.set", index: CUR },
            { op: "local.get", index: I },
            { op: "f64.const", value: 1 },
            { op: "f64.sub" },
            { op: "local.set", index: J },
            // while (j >= 0 && cmp(a[j], cur) > 0) { a[j+1] = a[j]; j--; }
            {
              op: "block",
              blockType: { kind: "empty" },
              body: [
                {
                  op: "loop",
                  blockType: { kind: "empty" },
                  body: [
                    { op: "local.get", index: J },
                    { op: "f64.const", value: 0 },
                    { op: "f64.lt" },
                    { op: "br_if", depth: 1 },
                    { op: "local.get", index: 0 },
                    { op: "local.get", index: J },
                    { op: "call", funcIdx: deps.externGetIdx },
                    { op: "local.set", index: PREV },
                    { op: "local.get", index: PREV },
                    { op: "local.get", index: CUR },
                    { op: "local.get", index: CMP },
                    { op: "local.get", index: HAS },
                    { op: "call", funcIdx: cmpIdx },
                    { op: "i32.const", value: 0 },
                    { op: "i32.le_s" },
                    { op: "br_if", depth: 1 },
                    ...setAt([{ op: "local.get", index: J }, { op: "f64.const", value: 1 }, { op: "f64.add" }], PREV),
                    { op: "local.get", index: J },
                    { op: "f64.const", value: 1 },
                    { op: "f64.sub" },
                    { op: "local.set", index: J },
                    { op: "br", depth: 0 },
                  ],
                },
              ],
            },
            ...setAt([{ op: "local.get", index: J }, { op: "f64.const", value: 1 }, { op: "f64.add" }], CUR),
            { op: "local.get", index: I },
            { op: "f64.const", value: 1 },
            { op: "f64.add" },
            { op: "local.set", index: I },
            { op: "br", depth: 0 },
          ],
        },
      ],
    },
    { op: "local.get", index: 0 },
  ];

  const locals: ValType[] = [
    { kind: "externref" }, // CMP
    { kind: "i32" }, // HAS
    { kind: "f64" }, // LEN
    { kind: "f64" }, // I
    { kind: "f64" }, // J
    { kind: "externref" }, // CUR
    { kind: "externref" }, // PREV
  ];
  return { body, locals };
}

function mintHelper(
  ctx: CodegenContext,
  name: string,
  params: ValType[],
  results: ValType[],
  build: () => { body: Instr[]; locals: ValType[] },
): number {
  const typeIdx = addFuncType(ctx, params, results);
  const funcIdx = mintDefinedFunc(ctx);
  ctx.funcMap.set(name, funcIdx);
  const { body, locals } = build();
  pushDefinedFunc(ctx, funcIdx, {
    name,
    typeIdx,
    locals: locals.map((type, i) => ({ name: `l${i}`, type })),
    body,
    exported: false,
  });
  return funcIdx;
}

/**
 * Reserve (or fetch) `__arrprod_<methodName>(recv: externref, args: externref)
 * -> externref` for a dynamic-receiver Array producer call. Idempotent;
 * returns `undefined` outside standalone or for an unserved member, in which
 * case the dispatcher keeps its pre-#6447 fall-through unchanged.
 */
export function ensureNativeArrayProducer(ctx: CodegenContext, methodName: string): number | undefined {
  if (!ctx.standalone) return undefined;
  if (!DYN_ARRAY_PRODUCER_METHODS.has(methodName)) return undefined;
  const helperName = `__arrprod_${methodName}`;
  const existing = ctx.funcMap.get(helperName);
  if (existing !== undefined) return existing;

  const deps = resolveDeps(ctx);
  if (deps === undefined) return undefined;

  const EXTERNREF: ValType = { kind: "externref" };
  if (methodName === "concat") {
    return mintHelper(ctx, helperName, [EXTERNREF, EXTERNREF], [EXTERNREF], () => buildConcatBody(ctx, deps));
  }

  // `sort` needs its SortCompare helper minted first so the loop can bake a
  // resolved funcIdx (append-only: minting the comparator before the sort keeps
  // both indices stable for every later reader).
  const cmpIdx = mintHelper(
    ctx,
    `${helperName}_cmp`,
    [EXTERNREF, EXTERNREF, EXTERNREF, { kind: "i32" }],
    [{ kind: "i32" }],
    () => buildSortCompareBody(ctx, deps),
  );
  return mintHelper(ctx, helperName, [EXTERNREF, EXTERNREF], [EXTERNREF], () => buildSortBody(ctx, deps, cmpIdx));
}
