// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * #3098 — native standalone array-HOF loops for dynamic (`any`/externref)
 * receivers. Subsystem module (kept out of object-runtime.ts per the #3102
 * LOC-regrowth ratchet / compiler-consolidation plan): object-runtime owns the
 * open-object MOP substrate; this module owns the callback-consuming HOF loops
 * built ON that substrate. Consumers: `closed-method-dispatch.ts` (reserve +
 * fill arm) and `expressions/calls.ts` (inline-arrow closure-compile gate).
 */
import type { Instr, ValType } from "../ir/types.js";
import type { CodegenContext } from "./context/types.js";
import { mintDefinedFunc, pushDefinedFunc } from "./func-space.js";
import { ensureObjectRuntime, reserveApplyClosure } from "./object-runtime.js";
import { addFuncType } from "./registry/types.js";
import { addUnionImportsViaRegistry } from "./shared.js";

/**
 * (#3098) Native standalone array HOF loops for DYNAMIC (`any`/externref)
 * receivers — `__hof_<name>(recv, cb, thisArg) -> externref` (predicate/map
 * family) and `__hof_reduce{,Right}(recv, cb, init, hasInit: i32) -> externref`.
 *
 * The typed-receiver HOF arms are already native (array-methods.ts); the
 * dynamic-receiver lane previously materialized the callback via the
 * `env.__make_callback` host bridge — the #2 leaked host import by file count
 * in the 2026-06-26 standalone JSONL — which is unsatisfiable without a JS
 * host, so the module failed to instantiate. These helpers run the element
 * loop natively over `__extern_length` / `__extern_get_idx` (real `$__vec_*`
 * arrays AND `$ObjVec` enumeration results) and invoke the callback through
 * the proven open-`any` closure bridge `__apply_closure` (the same path
 * Proxy traps / `__extern_method_call` / `Object.groupBy` use) — "reuse the
 * closure→funcref bridge, don't invent a calling convention".
 *
 * Semantics per ES2025 §23.1.3.*:
 *  - The callback receives `(value, index, array)` (`(acc, value, index,
 *    array)` for reduce/reduceRight); arity tolerance is `__apply_closure`'s
 *    job — a 1-param callback gets `value` and ignores the extras
 *    (`__call_fn_method_N` clamps to the closure's declared arity, #2939).
 *  - Length is read ONCE before the loop (HowMany is fixed for these methods).
 *  - `map`/`filter` results are `$ObjVec`s — the established boxed-any dynamic
 *    array carrier (same as `Object.keys`/`groupBy` groups; #2379: map results
 *    are heterogeneous, do NOT unbox to f64).
 *  - Truthiness of predicate results via the native `__is_truthy` (ToBoolean).
 *  - BOUNDARY (documented, not silent): `reduce` of an empty array with no
 *    initial value returns `undefined` instead of throwing the spec TypeError
 *    (§23.1.3.24 step 5) — same no-throw discipline as `__apply_closure` S1
 *    (emitting error machinery from a finalize-adjacent helper is the
 *    #1839-class late-registration index-shift hazard). Sparse-array holes are
 *    not skipped (vec/$ObjVec carriers are dense; the `$Hole` mapping is the
 *    open-`$Object` arm's concern, out of this arm's receiver set).
 *
 * Emitted at RESERVE time (append-only defined funcs — no funcIdx shift, same
 * invariant as `ensureObjectGroupBy`), so `fillClosedMethodDispatch` only
 * READS funcMap (#1719). Standalone-only: the `__extern_get_idx` array-like
 * arms this loop relies on are emitted only under `ctx.standalone` (see
 * `objArrayLikeArms` in `ensureObjectRuntime`). Idempotent per method name.
 */
const NATIVE_HOF_EACH = new Set([
  "forEach",
  "map",
  "filter",
  "find",
  "findIndex",
  "findLast",
  "findLastIndex",
  "every",
  "some",
]);
const NATIVE_HOF_REDUCE = new Set(["reduce", "reduceRight"]);

/** Method names served by {@link ensureNativeArrayHof} (single source for the
 *  call-site closure-compile gate and the dispatcher arm — #3098). */
export const NATIVE_HOF_METHODS: ReadonlySet<string> = new Set([...NATIVE_HOF_EACH, ...NATIVE_HOF_REDUCE]);

export function ensureNativeArrayHof(ctx: CodegenContext, methodName: string): number | undefined {
  if (!ctx.standalone) return undefined;
  if (!NATIVE_HOF_METHODS.has(methodName)) return undefined;
  const helperName = `__hof_${methodName}`;
  const existing = ctx.funcMap.get(helperName);
  if (existing !== undefined) return existing;

  // Dependencies — all append-only + idempotent at this (reserve-time) point:
  // the object runtime (`__extern_length`/`__extern_get_idx`/`__objvec_*`),
  // the native union helpers (`__box_number`/`__box_boolean`/`__is_truthy`),
  // and the closure bridge. ensureObjectRuntime already registers the union
  // natives under standalone, but call the registry wrapper explicitly so this
  // helper never depends on that internal ordering.
  ensureObjectRuntime(ctx);
  addUnionImportsViaRegistry(ctx);
  const applyClosureIdx = reserveApplyClosure(ctx);
  const externLengthIdx = ctx.funcMap.get("__extern_length");
  const externGetIdxIdx = ctx.funcMap.get("__extern_get_idx");
  const objVecNewIdx = ctx.funcMap.get("__objvec_new");
  const objVecPushIdx = ctx.funcMap.get("__objvec_push");
  const boxNumIdx = ctx.funcMap.get("__box_number");
  const boxBoolIdx = ctx.funcMap.get("__box_boolean");
  const isTruthyIdx = ctx.funcMap.get("__is_truthy");
  if (
    externLengthIdx === undefined ||
    externGetIdxIdx === undefined ||
    objVecNewIdx === undefined ||
    objVecPushIdx === undefined ||
    boxNumIdx === undefined ||
    boxBoolIdx === undefined ||
    isTruthyIdx === undefined
  ) {
    return undefined; // defensive — deps are registered just above
  }

  const isReduce = NATIVE_HOF_REDUCE.has(methodName);
  const backward = methodName === "findLast" || methodName === "findLastIndex" || methodName === "reduceRight";

  // ── Locals ──
  // each:   params 0=recv 1=cb 2=thisArg          locals 3=len 4=i 5=val 6=res 7=args 8=out
  // reduce: params 0=recv 1=cb 2=init 3=hasInit   locals 4=len 5=i 6=val 7=args 8=acc
  const L = isReduce
    ? { len: 4, i: 5, val: 6, args: 7, acc: 8, res: -1, out: -1 }
    : { len: 3, i: 4, val: 5, res: 6, args: 7, out: 8, acc: -1 };

  const loopExitTest: Instr[] = backward
    ? [{ op: "local.get", index: L.i } as Instr, { op: "f64.const", value: 0 } as Instr, { op: "f64.lt" } as Instr]
    : [{ op: "local.get", index: L.i } as Instr, { op: "local.get", index: L.len } as Instr, { op: "f64.ge" } as Instr];
  const loopStep: Instr[] = [
    { op: "local.get", index: L.i } as Instr,
    { op: "f64.const", value: 1 } as Instr,
    { op: backward ? "f64.sub" : "f64.add" } as Instr,
    { op: "local.set", index: L.i } as Instr,
  ];
  // val = __extern_get_idx(recv, i)
  const readVal: Instr[] = [
    { op: "local.get", index: 0 } as Instr,
    { op: "local.get", index: L.i } as Instr,
    { op: "call", funcIdx: externGetIdxIdx } as Instr,
    { op: "local.set", index: L.val } as Instr,
  ];
  // args = __objvec_new(); [acc,] val, boxNum(i), recv pushed in callback order.
  const buildArgs: Instr[] = [
    { op: "call", funcIdx: objVecNewIdx } as Instr,
    { op: "local.set", index: L.args } as Instr,
    ...(isReduce
      ? [
          { op: "local.get", index: L.args } as Instr,
          { op: "local.get", index: L.acc } as Instr,
          { op: "call", funcIdx: objVecPushIdx } as Instr,
        ]
      : []),
    { op: "local.get", index: L.args } as Instr,
    { op: "local.get", index: L.val } as Instr,
    { op: "call", funcIdx: objVecPushIdx } as Instr,
    { op: "local.get", index: L.args } as Instr,
    { op: "local.get", index: L.i } as Instr,
    { op: "call", funcIdx: boxNumIdx } as Instr,
    { op: "call", funcIdx: objVecPushIdx } as Instr,
    { op: "local.get", index: L.args } as Instr,
    { op: "local.get", index: 0 } as Instr,
    { op: "call", funcIdx: objVecPushIdx } as Instr,
  ];
  // invoke: __apply_closure(cb, thisArg | undefined, args)
  const invoke: Instr[] = [
    { op: "local.get", index: 1 } as Instr,
    ...(isReduce ? [{ op: "ref.null.extern" } as Instr] : [{ op: "local.get", index: 2 } as Instr]),
    { op: "local.get", index: L.args } as Instr,
    { op: "call", funcIdx: applyClosureIdx } as Instr,
    { op: "local.set", index: isReduce ? L.acc : L.res } as Instr,
  ];
  const truthyRes: Instr[] = [
    { op: "local.get", index: L.res } as Instr,
    { op: "call", funcIdx: isTruthyIdx } as Instr,
  ];
  const boxedBool = (v: 0 | 1): Instr[] => [
    { op: "i32.const", value: v } as Instr,
    { op: "call", funcIdx: boxBoolIdx } as Instr,
  ];
  const boxedIndex: Instr[] = [{ op: "local.get", index: L.i } as Instr, { op: "call", funcIdx: boxNumIdx } as Instr];

  // ── Method-specific per-iteration tail + final result ──
  let perIter: Instr[];
  let finalResult: Instr[];
  switch (methodName) {
    case "forEach":
      perIter = [];
      finalResult = [{ op: "ref.null.extern" } as Instr];
      break;
    case "map":
      perIter = [
        { op: "local.get", index: L.out } as Instr,
        { op: "local.get", index: L.res } as Instr,
        { op: "call", funcIdx: objVecPushIdx } as Instr,
      ];
      finalResult = [{ op: "local.get", index: L.out } as Instr];
      break;
    case "filter":
      perIter = [
        ...truthyRes,
        {
          op: "if",
          blockType: { kind: "empty" },
          then: [
            { op: "local.get", index: L.out } as Instr,
            { op: "local.get", index: L.val } as Instr,
            { op: "call", funcIdx: objVecPushIdx } as Instr,
          ],
        } as Instr,
      ];
      finalResult = [{ op: "local.get", index: L.out } as Instr];
      break;
    case "find":
    case "findLast":
      perIter = [
        ...truthyRes,
        {
          op: "if",
          blockType: { kind: "empty" },
          then: [{ op: "local.get", index: L.val } as Instr, { op: "return" } as Instr],
        } as Instr,
      ];
      finalResult = [{ op: "ref.null.extern" } as Instr];
      break;
    case "findIndex":
    case "findLastIndex":
      perIter = [
        ...truthyRes,
        {
          op: "if",
          blockType: { kind: "empty" },
          then: [...boxedIndex, { op: "return" } as Instr],
        } as Instr,
      ];
      finalResult = [{ op: "f64.const", value: -1 } as Instr, { op: "call", funcIdx: boxNumIdx } as Instr];
      break;
    case "every":
      perIter = [
        ...truthyRes,
        { op: "i32.eqz" } as Instr,
        {
          op: "if",
          blockType: { kind: "empty" },
          then: [...boxedBool(0), { op: "return" } as Instr],
        } as Instr,
      ];
      finalResult = boxedBool(1);
      break;
    case "some":
      perIter = [
        ...truthyRes,
        {
          op: "if",
          blockType: { kind: "empty" },
          then: [...boxedBool(1), { op: "return" } as Instr],
        } as Instr,
      ];
      finalResult = boxedBool(0);
      break;
    default:
      // reduce / reduceRight — acc already updated by `invoke`.
      perIter = [];
      finalResult = [{ op: "local.get", index: L.acc } as Instr];
      break;
  }

  // ── Prologue ──
  const prologue: Instr[] = [
    // len = __extern_length(recv)
    { op: "local.get", index: 0 } as Instr,
    { op: "call", funcIdx: externLengthIdx } as Instr,
    { op: "local.set", index: L.len } as Instr,
  ];
  const iInitForward: Instr[] = [{ op: "f64.const", value: 0 } as Instr, { op: "local.set", index: L.i } as Instr];
  const iInitBackward: Instr[] = [
    { op: "local.get", index: L.len } as Instr,
    { op: "f64.const", value: 1 } as Instr,
    { op: "f64.sub" } as Instr,
    { op: "local.set", index: L.i } as Instr,
  ];
  if (!isReduce) {
    if (methodName === "map" || methodName === "filter") {
      prologue.push({ op: "call", funcIdx: objVecNewIdx } as Instr, { op: "local.set", index: L.out } as Instr);
    }
    prologue.push(...(backward ? iInitBackward : iInitForward));
  } else {
    // hasInit ? (acc = init; i = first) : (empty → undefined; acc = first elem; i = second)
    prologue.push(
      { op: "local.get", index: 3 } as Instr,
      {
        op: "if",
        blockType: { kind: "empty" },
        then: [
          { op: "local.get", index: 2 } as Instr,
          { op: "local.set", index: L.acc } as Instr,
          ...(backward ? iInitBackward : iInitForward),
        ],
        else: [
          // len <= 0 → return undefined (boundary: spec TypeError, see header)
          { op: "local.get", index: L.len } as Instr,
          { op: "f64.const", value: 0 } as Instr,
          { op: "f64.le" } as Instr,
          {
            op: "if",
            blockType: { kind: "empty" },
            then: [{ op: "ref.null.extern" } as Instr, { op: "return" } as Instr],
          } as Instr,
          // acc = first-in-iteration-order element; i = the next one
          ...(backward
            ? [
                { op: "local.get", index: 0 } as Instr,
                { op: "local.get", index: L.len } as Instr,
                { op: "f64.const", value: 1 } as Instr,
                { op: "f64.sub" } as Instr,
                { op: "call", funcIdx: externGetIdxIdx } as Instr,
                { op: "local.set", index: L.acc } as Instr,
                { op: "local.get", index: L.len } as Instr,
                { op: "f64.const", value: 2 } as Instr,
                { op: "f64.sub" } as Instr,
                { op: "local.set", index: L.i } as Instr,
              ]
            : [
                { op: "local.get", index: 0 } as Instr,
                { op: "f64.const", value: 0 } as Instr,
                { op: "call", funcIdx: externGetIdxIdx } as Instr,
                { op: "local.set", index: L.acc } as Instr,
                { op: "f64.const", value: 1 } as Instr,
                { op: "local.set", index: L.i } as Instr,
              ]),
        ],
      } as Instr,
    );
  }

  const body: Instr[] = [
    ...prologue,
    {
      op: "block",
      blockType: { kind: "empty" },
      body: [
        {
          op: "loop",
          blockType: { kind: "empty" },
          body: [
            ...loopExitTest,
            { op: "br_if", depth: 1 } as Instr,
            ...readVal,
            ...buildArgs,
            ...invoke,
            ...perIter,
            ...loopStep,
            { op: "br", depth: 0 } as Instr,
          ],
        } as Instr,
      ],
    } as Instr,
    ...finalResult,
  ];

  const params: ValType[] = isReduce
    ? [{ kind: "externref" }, { kind: "externref" }, { kind: "externref" }, { kind: "i32" }]
    : [{ kind: "externref" }, { kind: "externref" }, { kind: "externref" }];
  const typeIdx = addFuncType(ctx, params, [{ kind: "externref" }]);
  const funcIdx = mintDefinedFunc(ctx);
  ctx.funcMap.set(helperName, funcIdx);
  const locals: { name: string; type: ValType }[] = isReduce
    ? [
        { name: "len", type: { kind: "f64" } },
        { name: "i", type: { kind: "f64" } },
        { name: "val", type: { kind: "externref" } },
        { name: "args", type: { kind: "externref" } },
        { name: "acc", type: { kind: "externref" } },
      ]
    : [
        { name: "len", type: { kind: "f64" } },
        { name: "i", type: { kind: "f64" } },
        { name: "val", type: { kind: "externref" } },
        { name: "res", type: { kind: "externref" } },
        { name: "args", type: { kind: "externref" } },
        { name: "out", type: { kind: "externref" } },
      ];
  pushDefinedFunc(ctx, funcIdx, {
    name: helperName,
    typeIdx,
    locals,
    body,
    exported: false,
  });
  return funcIdx;
}
