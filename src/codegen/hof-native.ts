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
import { undefinedExternInstrs } from "./any-helpers.js";
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
// Exported (#4394) so the Array.prototype value-read arm can tell the
// `(recv, cb, thisArg)` members apart from the `(recv, cb, init, hasInit)` ones.
export const NATIVE_HOF_REDUCE: ReadonlySet<string> = new Set(["reduce", "reduceRight"]);

/** Method names served by {@link ensureNativeArrayHof} (single source for the
 *  call-site closure-compile gate and the dispatcher arm — #3098). */
export const NATIVE_HOF_METHODS: ReadonlySet<string> = new Set([...NATIVE_HOF_EACH, ...NATIVE_HOF_REDUCE]);

interface NativeArrayHofOptions {
  helperName?: string;
  forceHasProperty?: boolean;
}

export function ensureNativeArrayHof(
  ctx: CodegenContext,
  methodName: string,
  options: NativeArrayHofOptions = {},
): number | undefined {
  if (!ctx.standalone) return undefined;
  if (!NATIVE_HOF_METHODS.has(methodName)) return undefined;
  const helperName = options.helperName ?? `__hof_${methodName}`;
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
  const externHasIdxIdx = ctx.funcMap.get("__extern_has_idx");
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

  // (#4160) Per-iteration HasProperty gate. §23.1.3's presence-sensitive
  // methods (forEach/map/filter/some/every/reduce/reduceRight — NOT the
  // find* family, which visits every index) run `HasProperty(O, ToString(k))`
  // before each Get and SKIP absent indices; the chain-inclusive check is what
  // makes an index inherited from `Object.prototype[i] = v` visitable while a
  // genuinely absent own index on an array-like is skipped. Emitted ONLY when
  // the module dirtied a prototype index (`ctx.protoIndexDirty`, a pre-scan
  // flag fixed before any body compiles) — the flag-clear helper body is
  // byte-identical by construction. The own-absent-visit-with-undefined
  // behaviour of flag-CLEAR modules is #3185/#2001 scope, deliberately not
  // widened here.
  const PRESENCE_SENSITIVE = new Set(["forEach", "map", "filter", "some", "every", "reduce", "reduceRight"]);
  const hasGateIdx =
    (ctx.protoIndexDirty || options.forceHasProperty === true) &&
    PRESENCE_SENSITIVE.has(methodName) &&
    externHasIdxIdx !== undefined
      ? externHasIdxIdx
      : undefined;

  // (#2872 slice 5) S1-producer discipline for every "returns `undefined`"
  // result of these helpers (`find`/`findLast` miss, `forEach`'s void result,
  // reduce-of-empty-no-init). Under the #2106 `undefinedSingleton` regime
  // (default ON) a null externref is JS `null`, NOT `undefined` —
  // `__extern_is_undefined` answers 0 for it — so a legacy `ref.null.extern`
  // here made `result === undefined` / `assert.sameValue(result, undefined)`
  // FALSE on a spec-mandated undefined (the miss-sentinel bug the findLast
  // slice surfaced; it silently affected the shipped `find`/`findIndex`
  // identically). Emit the `$undefined` singleton instead; regime-off builds
  // keep the legacy null extern (byte-identical). Reserve-time global/type
  // minting only — no funcIdx shift (#1839 discipline).
  const undefExtern: Instr[] = undefinedExternInstrs(ctx) ?? [{ op: "ref.null.extern" }];

  // ── Locals ──
  // each:   params 0=recv 1=cb 2=thisArg          locals 3=len 4=i 5=val 6=res 7=args 8=out
  // reduce: params 0=recv 1=cb 2=init 3=hasInit   locals 4=len 5=i 6=val 7=args 8=acc
  const L = isReduce
    ? { len: 4, i: 5, val: 6, args: 7, acc: 8, res: -1, out: -1 }
    : { len: 3, i: 4, val: 5, res: 6, args: 7, out: 8, acc: -1 };

  const loopExitTest: Instr[] = backward
    ? [{ op: "local.get", index: L.i }, { op: "f64.const", value: 0 }, { op: "f64.lt" }]
    : [{ op: "local.get", index: L.i }, { op: "local.get", index: L.len }, { op: "f64.ge" }];
  const loopStep: Instr[] = [
    { op: "local.get", index: L.i },
    { op: "f64.const", value: 1 },
    { op: backward ? "f64.sub" : "f64.add" },
    { op: "local.set", index: L.i },
  ];
  // val = __extern_get_idx(recv, i)
  const readVal: Instr[] = [
    { op: "local.get", index: 0 },
    { op: "local.get", index: L.i },
    { op: "call", funcIdx: externGetIdxIdx },
    { op: "local.set", index: L.val },
  ];
  // args = __objvec_new(); [acc,] val, boxNum(i), recv pushed in callback order.
  const buildArgs: Instr[] = [
    { op: "call", funcIdx: objVecNewIdx },
    { op: "local.set", index: L.args },
    ...((isReduce
      ? [
          { op: "local.get", index: L.args },
          { op: "local.get", index: L.acc },
          { op: "call", funcIdx: objVecPushIdx },
        ]
      : []) satisfies Instr[]),
    { op: "local.get", index: L.args },
    { op: "local.get", index: L.val },
    { op: "call", funcIdx: objVecPushIdx },
    { op: "local.get", index: L.args },
    { op: "local.get", index: L.i },
    { op: "call", funcIdx: boxNumIdx },
    { op: "call", funcIdx: objVecPushIdx },
    { op: "local.get", index: L.args },
    { op: "local.get", index: 0 },
    { op: "call", funcIdx: objVecPushIdx },
  ];
  // invoke: __apply_closure(cb, thisArg | undefined, args)
  const invoke: Instr[] = [
    { op: "local.get", index: 1 },
    ...((isReduce ? [{ op: "ref.null.extern" }] : [{ op: "local.get", index: 2 }]) satisfies Instr[]),
    { op: "local.get", index: L.args },
    { op: "call", funcIdx: applyClosureIdx },
    { op: "local.set", index: isReduce ? L.acc : L.res },
  ];
  const truthyRes: Instr[] = [
    { op: "local.get", index: L.res },
    { op: "call", funcIdx: isTruthyIdx },
  ];
  const boxedBool = (v: 0 | 1): Instr[] => [
    { op: "i32.const", value: v },
    { op: "call", funcIdx: boxBoolIdx },
  ];
  const boxedIndex: Instr[] = [
    { op: "local.get", index: L.i },
    { op: "call", funcIdx: boxNumIdx },
  ];

  // ── Method-specific per-iteration tail + final result ──
  let perIter: Instr[];
  let finalResult: Instr[];
  switch (methodName) {
    case "forEach":
      perIter = [];
      finalResult = [...undefExtern];
      break;
    case "map":
      perIter = [
        { op: "local.get", index: L.out },
        { op: "local.get", index: L.res },
        { op: "call", funcIdx: objVecPushIdx },
      ];
      finalResult = [{ op: "local.get", index: L.out }];
      break;
    case "filter":
      perIter = [
        ...truthyRes,
        {
          op: "if",
          blockType: { kind: "empty" },
          then: [
            { op: "local.get", index: L.out },
            { op: "local.get", index: L.val },
            { op: "call", funcIdx: objVecPushIdx },
          ],
        },
      ];
      finalResult = [{ op: "local.get", index: L.out }];
      break;
    case "find":
    case "findLast":
      perIter = [
        ...truthyRes,
        {
          op: "if",
          blockType: { kind: "empty" },
          then: [{ op: "local.get", index: L.val }, { op: "return" }],
        },
      ];
      finalResult = [...undefExtern];
      break;
    case "findIndex":
    case "findLastIndex":
      perIter = [
        ...truthyRes,
        {
          op: "if",
          blockType: { kind: "empty" },
          then: [...boxedIndex, { op: "return" }],
        },
      ];
      finalResult = [
        { op: "f64.const", value: -1 },
        { op: "call", funcIdx: boxNumIdx },
      ];
      break;
    case "every":
      perIter = [
        ...truthyRes,
        { op: "i32.eqz" },
        {
          op: "if",
          blockType: { kind: "empty" },
          then: [...boxedBool(0), { op: "return" }],
        },
      ];
      finalResult = boxedBool(1);
      break;
    case "some":
      perIter = [
        ...truthyRes,
        {
          op: "if",
          blockType: { kind: "empty" },
          then: [...boxedBool(1), { op: "return" }],
        },
      ];
      finalResult = boxedBool(0);
      break;
    default:
      // reduce / reduceRight — acc already updated by `invoke`.
      perIter = [];
      finalResult = [{ op: "local.get", index: L.acc }];
      break;
  }

  // ── Prologue ──
  const prologue: Instr[] = [
    // len = __extern_length(recv)
    { op: "local.get", index: 0 },
    { op: "call", funcIdx: externLengthIdx },
    { op: "local.set", index: L.len },
  ];
  const iInitForward: Instr[] = [
    { op: "f64.const", value: 0 },
    { op: "local.set", index: L.i },
  ];
  const iInitBackward: Instr[] = [
    { op: "local.get", index: L.len },
    { op: "f64.const", value: 1 },
    { op: "f64.sub" },
    { op: "local.set", index: L.i },
  ];
  if (!isReduce) {
    if (methodName === "map" || methodName === "filter") {
      prologue.push({ op: "call", funcIdx: objVecNewIdx }, { op: "local.set", index: L.out });
    }
    prologue.push(...(backward ? iInitBackward : iInitForward));
  } else {
    // (#4160) Flag-dirty no-init seed: §23.1.3.24 step 8.b scans for the FIRST
    // PRESENT index in iteration order (skipping absent ones through the
    // HasProperty gate) before consuming it as the accumulator; running off
    // the end without a present element is the spec's TypeError, kept as the
    // documented return-undefined boundary (see module header). The scan's
    // range test also covers the empty receiver, so the explicit `len <= 0`
    // preflight of the ungated body is subsumed.
    const reduceSeedScan = (): Instr[] => [
      ...(backward
        ? ([
            { op: "local.get", index: L.len },
            { op: "f64.const", value: 1 },
            { op: "f64.sub" },
            { op: "local.set", index: L.i },
          ] satisfies Instr[])
        : ([
            { op: "f64.const", value: 0 },
            { op: "local.set", index: L.i },
          ] satisfies Instr[])),
      {
        op: "block",
        blockType: { kind: "empty" },
        body: [
          {
            op: "loop",
            blockType: { kind: "empty" },
            body: [
              // out of range → no present element anywhere → undefined boundary
              ...((backward
                ? [{ op: "local.get", index: L.i }, { op: "f64.const", value: 0 }, { op: "f64.lt" }]
                : [
                    { op: "local.get", index: L.i },
                    { op: "local.get", index: L.len },
                    { op: "f64.ge" },
                  ]) satisfies Instr[]),
              {
                op: "if",
                blockType: { kind: "empty" },
                then: [...(undefinedExternInstrs(ctx) ?? [{ op: "ref.null.extern" }]), { op: "return" }],
              },
              // present? → seed found, exit the scan
              { op: "local.get", index: 0 },
              { op: "local.get", index: L.i },
              { op: "call", funcIdx: hasGateIdx! },
              { op: "br_if", depth: 1 },
              { op: "local.get", index: L.i },
              { op: "f64.const", value: 1 },
              { op: backward ? "f64.sub" : "f64.add" },
              { op: "local.set", index: L.i },
              { op: "br", depth: 0 },
            ],
          },
        ],
      },
      // acc = Get(recv, i) ; advance i past the seed
      { op: "local.get", index: 0 },
      { op: "local.get", index: L.i },
      { op: "call", funcIdx: externGetIdxIdx },
      { op: "local.set", index: L.acc },
      { op: "local.get", index: L.i },
      { op: "f64.const", value: 1 },
      { op: backward ? "f64.sub" : "f64.add" },
      { op: "local.set", index: L.i },
    ];
    // hasInit ? (acc = init; i = first) : (empty → undefined; acc = first elem; i = second)
    prologue.push(
      { op: "local.get", index: 3 },
      {
        op: "if",
        blockType: { kind: "empty" },
        then: [
          { op: "local.get", index: 2 },
          { op: "local.set", index: L.acc },
          ...(backward ? iInitBackward : iInitForward),
        ],
        else:
          hasGateIdx !== undefined
            ? reduceSeedScan()
            : [
                // len <= 0 → return undefined (boundary: spec TypeError, see header)
                { op: "local.get", index: L.len },
                { op: "f64.const", value: 0 },
                { op: "f64.le" },
                {
                  op: "if",
                  blockType: { kind: "empty" },
                  then: [...undefExtern, { op: "return" }],
                },
                // acc = first-in-iteration-order element; i = the next one
                ...((backward
                  ? [
                      { op: "local.get", index: 0 },
                      { op: "local.get", index: L.len },
                      { op: "f64.const", value: 1 },
                      { op: "f64.sub" },
                      { op: "call", funcIdx: externGetIdxIdx },
                      { op: "local.set", index: L.acc },
                      { op: "local.get", index: L.len },
                      { op: "f64.const", value: 2 },
                      { op: "f64.sub" },
                      { op: "local.set", index: L.i },
                    ]
                  : [
                      { op: "local.get", index: 0 },
                      { op: "f64.const", value: 0 },
                      { op: "call", funcIdx: externGetIdxIdx },
                      { op: "local.set", index: L.acc },
                      { op: "f64.const", value: 1 },
                      { op: "local.set", index: L.i },
                    ]) satisfies Instr[]),
              ],
      },
    );
  }

  // (#4160) Under the gate, each iteration's Get + callback runs only when
  // `HasProperty(recv, k)` holds; an absent index is SKIPPED (map keeps its
  // result aligned by pushing the undefined the hole reads back as — the
  // dense `$ObjVec` carrier cannot represent a result hole). Gate-off (the
  // flag-clear default) emits the exact pre-existing sequence.
  const iterCore: Instr[] = [...readVal, ...buildArgs, ...invoke, ...perIter];
  const iterBody: Instr[] =
    hasGateIdx === undefined
      ? iterCore
      : [
          { op: "local.get", index: 0 },
          { op: "local.get", index: L.i },
          { op: "call", funcIdx: hasGateIdx },
          {
            op: "if",
            blockType: { kind: "empty" },
            then: iterCore,
            else:
              methodName === "map"
                ? [
                    { op: "local.get", index: L.out },
                    ...(undefinedExternInstrs(ctx) ?? [{ op: "ref.null.extern" } satisfies Instr]),
                    { op: "call", funcIdx: objVecPushIdx },
                  ]
                : [],
          },
        ];
  const body: Instr[] = [
    ...prologue,
    {
      op: "block",
      blockType: { kind: "empty" },
      body: [
        {
          op: "loop",
          blockType: { kind: "empty" },
          body: [...loopExitTest, { op: "br_if", depth: 1 }, ...iterBody, ...loopStep, { op: "br", depth: 0 }],
        },
      ],
    },
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

/**
 * (#4222 ES5 residual) Filter provider for the branded sparse carrier.
 * It reuses the native closure protocol but always asks HasProperty first;
 * only the carrier-specific `__extern_has_idx` arm knows about `$Hole`.
 */
export function ensureHoleyArrayFilter(ctx: CodegenContext): number | undefined {
  return ensureNativeArrayHof(ctx, "filter", {
    helperName: "__hof_holey_array_filter",
    forceHasProperty: true,
  });
}
