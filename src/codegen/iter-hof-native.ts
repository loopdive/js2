// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * #2903 (sub-front 2) — native standalone EAGER Iterator-helper loops for
 * dynamic (`any`/externref) iterator receivers: `%Iterator.prototype%.find /
 * every / some / forEach / reduce / toArray` (ES2025 §27.1.4.*).
 *
 * Subsystem module (kept out of object-runtime.ts / closed-method-dispatch.ts
 * per the #3102 LOC-regrowth ratchet): hof-native.ts owns the INDEXED
 * array-HOF loops; this module owns the STEPPED iterator-helper loops built on
 * the native iteration substrate (`__iterator` / `__iterator_next` /
 * `__iterator_return`, iterator-native.ts). Consumers: closed-method-dispatch
 * (reserve + the iterator fallback arm in the fill).
 *
 * Why this exists (the #2903 re-ground): the issue's original premise — that
 * `.find(cb)` on a generator leaks `env.__make_callback` — no longer holds on
 * main; the callback compiles natively and the module instantiates host-free.
 * The RESIDUAL is silently-wrong results: a generator/iterator receiver
 * matches neither the closed-struct arms (no `<Struct>_find` method) nor the
 * vec/$ObjVec HOF arm, so `__call_m_find_1` falls to `__extern_method_call`,
 * whose non-`$Object` arm answers `undefined`. Measured 2026-07-12:
 * `built-ins/Iterator/prototype` standalone = 72/373 pass, with every
 * callback-helper test failing on that silent `undefined`.
 *
 * Semantics per §27.1.4 (find 27.1.4.4, every 27.1.4.3, some 27.1.4.9,
 * forEach 27.1.4.6, reduce 27.1.4.8, toArray 27.1.4.10):
 *  - GetIteratorDirect(O) is approximated by the module's `__iterator`
 *    GetIterator ladder — identical for every self-iterable receiver
 *    (generators, array/Map/Set iterators return `this` from `@@iterator`).
 *    A plain `{next(){…}}` object without `@@iterator` becomes drivable when
 *    the #3146 OBJ-arm additions land in `buildIteratorBody` — this module
 *    only consumes `__iterator`, so it inherits that for free.
 *  - The predicate/callback receives `(value, counter)` — exactly two args,
 *    NO third receiver arg (unlike the array HOFs) — via the proven open-`any`
 *    closure bridge `__apply_closure` (arity clamping is the bridge's job,
 *    #2939).
 *  - Early exits (find hit, every-false, some-true) run IteratorClose via
 *    `__iterator_return` (§27.1.4.3/4/9 step 5.b.iii — "Return ?
 *    IteratorClose(iterated, …)"); exhaustion does NOT close (§7.4.9).
 *  - Truthiness via the native `__is_truthy` (ToBoolean); every/some results
 *    are boxed booleans; forEach/miss-find return `undefined`
 *    (`ref.null.extern`, the established dynamic-undefined carrier).
 *  - `reduce` with no initial value seeds the accumulator from the first
 *    step; `counter` still advances per step so the first callback call sees
 *    counter 1 (§27.1.4.8 step 5). BOUNDARY (documented, same no-throw
 *    discipline as `__hof_reduce`, #3098): an exhausted iterator with no
 *    initial value returns `undefined` instead of the spec TypeError —
 *    emitting error machinery from a reserve-adjacent helper is the
 *    #1839-class late-registration hazard.
 *  - BOUNDARY: a callback that THROWS propagates as a wasm exception without
 *    the spec's IteratorClose-on-abrupt (§27.1.4.* step 5.b.* "?" semantics
 *    are partially honored: the throw itself propagates; only the close side
 *    effect is skipped). Same discipline as the array-HOF loops.
 *  - `toArray` delegates to `__array_from_iter_n(recv, -1)` (the unbounded
 *    drain, #2904) and returns its canonical `$Vec`.
 *
 * Emitted at RESERVE time (append-only defined funcs — no funcIdx shift), so
 * `fillClosedMethodDispatch` only READS funcMap (#1719). Standalone only.
 * Idempotent per method name.
 */
import type { Instr, ValType } from "../ir/types.js";
import type { CodegenContext } from "./context/types.js";
import { RESULT_DONE_FIELD, RESULT_VALUE_FIELD } from "./frame-core.js";
import { definedFuncAt, mintDefinedFunc, pushDefinedFunc } from "./func-space.js";
import { sentinelAwareF64BoxInstrs } from "./generators-native.js";
import { ensureNativeIteratorRuntime } from "./iterator-native.js";
import { ensureObjectRuntime, reserveApplyClosure } from "./object-runtime.js";
import { addFuncType } from "./registry/types.js";
import { addUnionImportsViaRegistry } from "./shared.js";

/** Callback-taking eager helpers: `__iter_hof_<name>(recv, cb) -> externref`
 *  (`reduce` adds `(init externref, hasInit i32)`). */
const ITER_HOF_CB = new Set(["find", "every", "some", "forEach", "reduce"]);

/** Method names served by {@link ensureNativeIterHof} — the single source for
 *  the dispatcher's iterator fallback arm (#2903, mirrors NATIVE_HOF_METHODS'
 *  role for the vec arm). `toArray` is callback-free (arity 0). */
export const NATIVE_ITER_HOF_METHODS: ReadonlySet<string> = new Set([...ITER_HOF_CB, "toArray"]);

/** True when `methodName`/`arity` is a form the iterator arm services. */
export function isIterHofForm(methodName: string, arity: number): boolean {
  if (methodName === "toArray") return arity === 0;
  if (methodName === "reduce") return arity >= 1; // (cb) or (cb, initialValue)
  return ITER_HOF_CB.has(methodName) && arity >= 1;
}

/**
 * Emit (or fetch) the native `__iter_hof_<methodName>` loop. Returns its
 * funcIdx, or undefined when unavailable (non-standalone, or a dep is
 * missing). Append-only — safe at reserve time, forbidden at fill time.
 */
export function ensureNativeIterHof(ctx: CodegenContext, methodName: string): number | undefined {
  if (!ctx.standalone) return undefined;
  if (!NATIVE_ITER_HOF_METHODS.has(methodName)) return undefined;
  const helperName = `__iter_hof_${methodName}`;
  const existing = ctx.funcMap.get(helperName);
  if (existing !== undefined) return existing;

  // `toArray` gets its own stepped drain below (NOT an `__array_from_iter_n`
  // alias — that helper passes a non-drainable source through UNCHANGED, so
  // `someClassInstance.toArray()` would answer the receiver instead of the
  // legacy `undefined`).

  // Dependencies — all append-only + idempotent at reserve time. The iterator
  // runtime's USER/OBJ/vec-family arms are late-FILLED (finalize), but the
  // funcIdx of `__iterator`/`__iterator_next`/`__iterator_return` is stable
  // from registration, which is all this body bakes in.
  ensureObjectRuntime(ctx);
  addUnionImportsViaRegistry(ctx);
  ensureNativeIteratorRuntime(ctx);
  const applyClosureIdx = reserveApplyClosure(ctx);
  const objVecNewIdx = ctx.funcMap.get("__objvec_new");
  const objVecPushIdx = ctx.funcMap.get("__objvec_push");
  const boxNumIdx = ctx.funcMap.get("__box_number");
  const boxBoolIdx = ctx.funcMap.get("__box_boolean");
  const isTruthyIdx = ctx.funcMap.get("__is_truthy");
  const steppers = reserveIterHofSteppers(ctx);
  if (
    steppers === undefined ||
    objVecNewIdx === undefined ||
    objVecPushIdx === undefined ||
    boxNumIdx === undefined ||
    boxBoolIdx === undefined ||
    isTruthyIdx === undefined
  ) {
    return undefined; // defensive — deps are registered just above
  }
  const { openIdx: iteratorIdx, nextIdx: iteratorNextIdx, closeIdx: iteratorReturnIdx } = steppers;

  const isReduce = methodName === "reduce";
  const isToArray = methodName === "toArray";

  // ── Locals ──
  // cb family:  params 0=recv 1=cb                 locals 2=rec 3=counter 4=done 5=val 6=res 7=args
  // reduce:     params 0=recv 1=cb 2=init 3=hasInit locals 4=rec 5=counter 6=done 7=val 8=acc 9=hasAcc 10=args
  // toArray:    params 0=recv                       locals 1=rec 2=done 3=val 4=out
  const L = isReduce
    ? { rec: 4, counter: 5, done: 6, val: 7, acc: 8, hasAcc: 9, args: 10, res: -1, out: -1 }
    : isToArray
      ? { rec: 1, counter: -1, done: 2, val: 3, out: 4, res: -1, args: -1, acc: -1, hasAcc: -1 }
      : { rec: 2, counter: 3, done: 4, val: 5, res: 6, args: 7, acc: -1, hasAcc: -1, out: -1 };

  // (done, value) = __iterator_next(rec); if done → br exit (depth 1 from loop)
  const step: Instr[] = [
    { op: "local.get", index: L.rec },
    { op: "call", funcIdx: iteratorNextIdx },
    { op: "local.set", index: L.val }, // value (top of stack)
    { op: "local.set", index: L.done }, // done
    { op: "local.get", index: L.done },
    { op: "br_if", depth: 1 }, // exhausted ⇒ [[Done]] ⇒ NO IteratorClose (§7.4.9)
  ];

  // args = __objvec_new(); [acc,] value, boxNum(counter) — (value, counter) per §27.1.4.
  const buildArgs: Instr[] = [
    { op: "call", funcIdx: objVecNewIdx },
    { op: "local.set", index: L.args },
    ...(isReduce
      ? ([
          { op: "local.get", index: L.args },
          { op: "local.get", index: L.acc },
          { op: "call", funcIdx: objVecPushIdx },
        ] satisfies Instr[])
      : []),
    { op: "local.get", index: L.args },
    { op: "local.get", index: L.val },
    { op: "call", funcIdx: objVecPushIdx },
    { op: "local.get", index: L.args },
    { op: "local.get", index: L.counter },
    { op: "call", funcIdx: boxNumIdx },
    { op: "call", funcIdx: objVecPushIdx },
  ];

  // res|acc = __apply_closure(cb, undefined, args) — helpers pass undefined this.
  const invoke: Instr[] = [
    { op: "local.get", index: 1 },
    { op: "ref.null.extern" },
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
  // IteratorClose on early exit (§27.1.4.3/4/9): a VEC record no-ops; a USER
  // record dispatches the receiver's `return` when it has one.
  const close: Instr[] =
    iteratorReturnIdx !== undefined
      ? [
          { op: "local.get", index: L.rec },
          { op: "call", funcIdx: iteratorReturnIdx },
        ]
      : [];

  // ── Method-specific per-iteration tail + final (exhausted) result ──
  let perIter: Instr[];
  let finalResult: Instr[];
  switch (methodName) {
    case "find":
      perIter = [
        ...buildArgs,
        ...invoke,
        ...truthyRes,
        {
          op: "if",
          blockType: { kind: "empty" },
          then: [...close, { op: "local.get", index: L.val }, { op: "return" }],
        },
      ];
      finalResult = [{ op: "ref.null.extern" }];
      break;
    case "every":
      perIter = [
        ...buildArgs,
        ...invoke,
        ...truthyRes,
        { op: "i32.eqz" },
        {
          op: "if",
          blockType: { kind: "empty" },
          then: [...close, ...boxedBool(0), { op: "return" }],
        },
      ];
      finalResult = boxedBool(1);
      break;
    case "some":
      perIter = [
        ...buildArgs,
        ...invoke,
        ...truthyRes,
        {
          op: "if",
          blockType: { kind: "empty" },
          then: [...close, ...boxedBool(1), { op: "return" }],
        },
      ];
      finalResult = boxedBool(0);
      break;
    case "forEach":
      perIter = [...buildArgs, ...invoke];
      finalResult = [{ op: "ref.null.extern" }];
      break;
    case "toArray":
      // out.push(value) per step; the $ObjVec is the established boxed-any
      // dynamic array carrier (same as map/filter HOF results, #2379).
      perIter = [
        { op: "local.get", index: L.out },
        { op: "local.get", index: L.val },
        { op: "call", funcIdx: objVecPushIdx },
      ];
      finalResult = [{ op: "local.get", index: L.out }];
      break;
    default: {
      // reduce — no-initial-value seeds acc from the first step (§27.1.4.8
      // step 4); the callback runs from the second step on.
      perIter = [
        { op: "local.get", index: L.hasAcc },
        { op: "i32.eqz" },
        {
          op: "if",
          blockType: { kind: "empty" },
          then: [
            { op: "local.get", index: L.val },
            { op: "local.set", index: L.acc },
            { op: "i32.const", value: 1 },
            { op: "local.set", index: L.hasAcc },
          ],
          else: [...buildArgs, ...invoke],
        },
      ];
      // Exhausted with no accumulator (empty iterator, no init) → undefined
      // (BOUNDARY: spec TypeError, see header). Else the accumulator.
      finalResult = [
        { op: "local.get", index: L.hasAcc },
        { op: "i32.eqz" },
        {
          op: "if",
          blockType: { kind: "val", type: { kind: "externref" } },
          then: [{ op: "ref.null.extern" }],
          else: [{ op: "local.get", index: L.acc }],
        },
      ];
      break;
    }
  }

  const counterStep: Instr[] = isToArray
    ? []
    : [
        { op: "local.get", index: L.counter },
        { op: "f64.const", value: 1 },
        { op: "f64.add" },
        { op: "local.set", index: L.counter },
      ];

  const body: Instr[] = [
    // rec = __iter_hof_open(recv) — pass-through for a driven generator frame,
    // the `__iterator` GetIterator ladder for admitted iterable carriers, and
    // the NULL SENTINEL for everything else (a class instance, a string, an
    // arbitrary data struct — receivers the ladder would hard-cast-trap on).
    { op: "local.get", index: 0 },
    { op: "call", funcIdx: iteratorIdx },
    { op: "local.set", index: L.rec },
    // Null handle → the receiver is not an admissible iterator: answer the
    // legacy `undefined` (exactly the pre-#2903 open-arm miss result) instead
    // of trapping. Spec-wise this SHOULD be a TypeError (no `next`), but the
    // no-throw discipline holds (see the reduce boundary note above).
    { op: "local.get", index: L.rec },
    { op: "ref.is_null" },
    {
      op: "if",
      blockType: { kind: "empty" },
      then: [{ op: "ref.null.extern" }, { op: "return" }],
    },
    ...(isToArray
      ? ([
          { op: "call", funcIdx: objVecNewIdx },
          { op: "local.set", index: L.out },
        ] satisfies Instr[])
      : ([
          { op: "f64.const", value: 0 },
          { op: "local.set", index: L.counter },
        ] satisfies Instr[])),
    ...(isReduce
      ? ([
          { op: "local.get", index: 3 }, // hasInit
          { op: "local.set", index: L.hasAcc },
          { op: "local.get", index: 2 }, // init (null.extern when absent)
          { op: "local.set", index: L.acc },
        ] satisfies Instr[])
      : []),
    {
      op: "block",
      blockType: { kind: "empty" },
      body: [
        {
          op: "loop",
          blockType: { kind: "empty" },
          body: [...step, ...perIter, ...counterStep, { op: "br", depth: 0 }],
        },
      ],
    },
    ...finalResult,
  ];

  const params: ValType[] = isReduce
    ? [{ kind: "externref" }, { kind: "externref" }, { kind: "externref" }, { kind: "i32" }]
    : isToArray
      ? [{ kind: "externref" }]
      : [{ kind: "externref" }, { kind: "externref" }];
  const typeIdx = addFuncType(ctx, params, [{ kind: "externref" }]);
  const funcIdx = mintDefinedFunc(ctx);
  ctx.funcMap.set(helperName, funcIdx);
  const locals: { name: string; type: ValType }[] = isReduce
    ? [
        { name: "rec", type: { kind: "externref" } },
        { name: "counter", type: { kind: "f64" } },
        { name: "done", type: { kind: "i32" } },
        { name: "val", type: { kind: "externref" } },
        { name: "acc", type: { kind: "externref" } },
        { name: "hasAcc", type: { kind: "i32" } },
        { name: "args", type: { kind: "externref" } },
      ]
    : isToArray
      ? [
          { name: "rec", type: { kind: "externref" } },
          { name: "done", type: { kind: "i32" } },
          { name: "val", type: { kind: "externref" } },
          { name: "out", type: { kind: "externref" } },
        ]
      : [
          { name: "rec", type: { kind: "externref" } },
          { name: "counter", type: { kind: "f64" } },
          { name: "done", type: { kind: "i32" } },
          { name: "val", type: { kind: "externref" } },
          { name: "res", type: { kind: "externref" } },
          { name: "args", type: { kind: "externref" } },
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
 * (#2903) Reserve the three iteration STEPPERS the helper loops call —
 * `__iter_hof_open(recv) -> handle`, `__iter_hof_next(handle) -> (i32 done,
 * externref value)`, `__iter_hof_close(handle) -> ()`. Their reserve-time
 * bodies simply delegate to the generic `__iterator` / `__iterator_next` /
 * `__iterator_return` runtime (a valid, conservative default);
 * {@link fillIterHofSteppers} REBUILDS them at finalize with a DRIVEN-GENERATOR
 * arm per registered native sync generator.
 *
 * Why the indirection: a native sync generator is a compile-time-DRIVEN state
 * machine — `for…of gen()` calls its `__gen_resume_<name>` directly at the
 * call site (generators-native.ts) and the generic `__iterator` ladder has NO
 * arm for its frame struct, so an `any`-held generator reaching it traps on
 * the legacy vec hard-cast ("illegal cast", measured 2026-07-12). The steppers
 * cannot bake the resume funcIdx at reserve time (a generator declared later
 * in the file hasn't registered yet), but by FINALIZE every constructible
 * generator has its resume emitted (`compileNativeGeneratorFunction` ensures
 * it at factory-compile time) — so the fill only READS `ctx.nativeGenerators`
 * + funcMap (#1719 discipline; append-only reserve, read-only fill).
 */
export function reserveIterHofSteppers(
  ctx: CodegenContext,
): { openIdx: number; nextIdx: number; closeIdx: number } | undefined {
  const existing = ctx.funcMap.get("__iter_hof_open");
  if (existing !== undefined) {
    const nextIdx = ctx.funcMap.get("__iter_hof_next");
    const closeIdx = ctx.funcMap.get("__iter_hof_close");
    if (nextIdx !== undefined && closeIdx !== undefined) return { openIdx: existing, nextIdx, closeIdx };
    return undefined;
  }
  ensureNativeIteratorRuntime(ctx);
  const iteratorIdx = ctx.funcMap.get("__iterator");
  const iteratorNextIdx = ctx.funcMap.get("__iterator_next");
  const iteratorReturnIdx = ctx.funcMap.get("__iterator_return");
  if (iteratorIdx === undefined || iteratorNextIdx === undefined || iteratorReturnIdx === undefined) return undefined;

  const register = (name: string, results: ValType[], delegateIdx: number): number => {
    const typeIdx = addFuncType(ctx, [{ kind: "externref" }], results);
    const funcIdx = mintDefinedFunc(ctx);
    ctx.funcMap.set(name, funcIdx);
    pushDefinedFunc(ctx, funcIdx, {
      name,
      typeIdx,
      // Scratch locals the fill's generator arms use; declared NOW so the fill
      // only swaps the body (same discipline as `fillNativeIteratorLateArms`).
      locals: [
        { name: "__any", type: { kind: "anyref" } },
        { name: "__resAny", type: { kind: "anyref" } },
        { name: "__f64tmp", type: { kind: "f64" } },
      ],
      body: [
        { op: "local.get", index: 0 },
        { op: "call", funcIdx: delegateIdx },
      ],
      exported: false,
    });
    return funcIdx;
  };
  // `open`'s reserve default is the NULL SENTINEL for every receiver (the
  // helpers then answer the legacy `undefined`) — NOT `__iterator` delegation,
  // whose ladder hard-cast-traps on inadmissible receivers (a class instance,
  // a string). The finalize fill installs the positive-admission classifier.
  const openTypeIdx = addFuncType(ctx, [{ kind: "externref" }], [{ kind: "externref" }]);
  const openIdx = mintDefinedFunc(ctx);
  ctx.funcMap.set("__iter_hof_open", openIdx);
  pushDefinedFunc(ctx, openIdx, {
    name: "__iter_hof_open",
    typeIdx: openTypeIdx,
    locals: [
      { name: "__any", type: { kind: "anyref" } },
      { name: "__resAny", type: { kind: "anyref" } },
      { name: "__f64tmp", type: { kind: "f64" } },
    ],
    body: [{ op: "ref.null.extern" }],
    exported: false,
  });
  return {
    openIdx,
    nextIdx: register("__iter_hof_next", [{ kind: "i32" }, { kind: "externref" }], iteratorNextIdx),
    closeIdx: register("__iter_hof_close", [], iteratorReturnIdx),
  };
}

/**
 * (#2903) Closed-struct types the `__iterator` USER arm can drive —
 * `<Struct>_@@iterator` (iterable) or `<Struct>_next` (iterator object).
 * Replicates iterator-native.ts's private `collectUserIterableStructTypeIdxs`
 * (the `__array_from_iter_n` drainability set) so the `open` classifier and
 * the drain guard admit the same receivers.
 */
function collectIterableStructTypeIdxs(ctx: CodegenContext): number[] {
  const out: number[] = [];
  for (const [structName] of ctx.structFields) {
    if (
      structName.startsWith("Wrapper") ||
      structName === "$AnyValue" ||
      structName.startsWith("__vec_") ||
      structName.startsWith("__arr_")
    )
      continue;
    const typeIdx = ctx.structMap.get(structName);
    if (typeIdx === undefined) continue;
    if (ctx.funcMap.has(`${structName}_@@iterator`) || ctx.funcMap.has(`${structName}_next`)) {
      out.push(typeIdx);
    }
  }
  out.sort((a, b) => a - b);
  return out;
}

/**
 * (#2903) FINALIZE fill: rebuild the stepper bodies with a driven-generator
 * arm per registered native sync generator (deduped by frame struct type).
 * Call AFTER all function bodies are compiled (so every constructible
 * generator's `resumeFuncIdx` is set) and alongside the other fills in
 * index.ts's finalize sequence. No-op when the steppers were never reserved
 * or the module has no driven generators (bodies keep the reserve-time
 * delegation — byte-identical).
 *
 * Stepper semantics for a generator frame `g` (state struct `T`, resume `R`,
 * result struct `RT` {value: E, done: i32}):
 *   open(g)  → g (pass-through; the frame IS the handle)
 *   next(g)  → res = R(cast g); (res.done, box_E(res.value))
 *   close(g) → no-op. BOUNDARY: a generator's `.return()` (finally-block
 *              semantics, §27.5.3.3) is not triggered on helper early-exit;
 *              the frame is simply abandoned. Same-class boundary as the
 *              reduce no-throw discipline above.
 */
export function fillIterHofSteppers(ctx: CodegenContext): void {
  const openIdx = ctx.funcMap.get("__iter_hof_open");
  const nextIdx = ctx.funcMap.get("__iter_hof_next");
  const closeIdx = ctx.funcMap.get("__iter_hof_close");
  if (openIdx === undefined || nextIdx === undefined || closeIdx === undefined) return;

  // Collect the driven-generator producers (deduped by frame struct type).
  // Only generators whose resume function actually EMITTED participate —
  // reading `funcMap` per #2941 (the shift-maintained single source of truth)
  // rather than the cached `resumeFuncIdx` number.
  const producers: { stateTypeIdx: number; resumeIdx: number; resultTypeIdx: number; elemValType: ValType }[] = [];
  const seen = new Set<number>();
  for (const info of ctx.nativeGenerators.values()) {
    if (info.resumeFuncIdx === undefined || seen.has(info.stateTypeIdx)) continue;
    seen.add(info.stateTypeIdx);
    producers.push({
      stateTypeIdx: info.stateTypeIdx,
      resumeIdx: info.resumeFuncIdx,
      resultTypeIdx: info.resultTypeIdx,
      elemValType: info.elemValType,
    });
  }
  producers.sort((a, b) => a.stateTypeIdx - b.stateTypeIdx);

  const boxNumIdx = ctx.funcMap.get("__box_number");
  const iteratorIdx = ctx.funcMap.get("__iterator");
  const iteratorNextIdx = ctx.funcMap.get("__iterator_next");
  const iteratorReturnIdx = ctx.funcMap.get("__iterator_return");
  if (iteratorIdx === undefined || iteratorNextIdx === undefined || iteratorReturnIdx === undefined) return;

  // (#2903 R3) Lazy Iterator-helper wrapper (`$LazyIterHelper`, iter-lazy-native.ts)
  // arms. When the module built any `g().map/filter/take/drop(...)` wrapper, its
  // struct type + the shared `__lazy_iter_step`/`__lazy_iter_close` steppers are
  // registered (append-only). A wrapper handle reaching `__iter_hof_open` (a
  // downstream eager helper / `.toArray()` / chained lazy helper) is its OWN
  // iterator: open passes it through, next delegates to `__lazy_iter_step`, close
  // to `__lazy_iter_close`. Read by funcMap/structMap (no import of the lazy
  // module — one-directional dep).
  const lazyHelperTypeIdx = ctx.structMap.get("$LazyIterHelper");
  const lazyStepIdx = ctx.funcMap.get("__lazy_iter_step");
  const lazyCloseIdx = ctx.funcMap.get("__lazy_iter_close");
  const lazyArm =
    lazyHelperTypeIdx !== undefined && lazyStepIdx !== undefined && lazyCloseIdx !== undefined
      ? { typeIdx: lazyHelperTypeIdx, stepIdx: lazyStepIdx, closeIdx: lazyCloseIdx }
      : undefined;

  // The `__iterator` GetIterator ladder is only SAFE for receivers one of its
  // arms admits — everything else hits the legacy vec hard-cast. Admissible
  // here: the canonical externref `$Vec` (the always-present vec arm) and,
  // when the USER-arm deps exist (same condition as
  // `fillNativeIteratorLateArms`), the closed structs carrying an
  // `@@iterator`/`next` method.
  const userArmAvailable =
    ctx.funcMap.has("__call_@@iterator") &&
    ctx.funcMap.has("__call_next") &&
    ctx.funcMap.has("__sget_value") &&
    ctx.funcMap.has("__sget_done") &&
    ctx.funcMap.has("__is_truthy");
  const iterableStructTypeIdxs = userArmAvailable ? collectIterableStructTypeIdxs(ctx) : [];
  const canonicalVecTypeIdx = ctx.structMap.get("__vec_externref");

  // Locals (declared at reserve): 1 = __any (anyref), 2 = __resAny (anyref),
  // 3 = __f64tmp (f64). Param 0 = the externref handle.
  const ANY = 1;
  const RES_ANY = 2;
  const F64_TMP = 3;

  const convert: Instr[] = [
    { op: "local.get", index: 0 },
    { op: "any.convert_extern" },
    { op: "local.set", index: ANY },
  ];

  // Boxed-externref read of `res.value` for elem carrier E.
  const valueRead = (p: (typeof producers)[number]): Instr[] => {
    const read: Instr[] = [
      { op: "local.get", index: RES_ANY },
      { op: "ref.cast", typeIdx: p.resultTypeIdx },
      { op: "struct.get", typeIdx: p.resultTypeIdx, fieldIdx: RESULT_VALUE_FIELD },
    ];
    if (p.elemValType.kind === "externref") return read;
    if (p.elemValType.kind === "f64" && boxNumIdx !== undefined) {
      return [...read, ...sentinelAwareF64BoxInstrs(F64_TMP, boxNumIdx)];
    }
    if (p.elemValType.kind === "i32" && boxNumIdx !== undefined) {
      return [...read, { op: "f64.convert_i32_s" }, { op: "call", funcIdx: boxNumIdx }];
    }
    if (p.elemValType.kind === "ref" || p.elemValType.kind === "ref_null") {
      return [...read, { op: "extern.convert_any" }];
    }
    // Unboxable carrier (defensive): undefined.
    return [...read, { op: "drop" }, { op: "ref.null.extern" }];
  };

  const openFn = definedFuncAt(ctx, openIdx);
  if (openFn) {
    const arms: Instr[] = [];
    // Lazy Iterator-helper wrapper → the wrapper IS the handle (pass-through).
    if (lazyArm) {
      arms.push(
        { op: "local.get", index: ANY },
        { op: "ref.test", typeIdx: lazyArm.typeIdx },
        {
          op: "if",
          blockType: { kind: "empty" },
          then: [{ op: "local.get", index: 0 }, { op: "return" }],
        },
      );
    }
    // Driven generator frame → the frame IS the handle (pass-through).
    for (const p of producers) {
      arms.push(
        { op: "local.get", index: ANY },
        { op: "ref.test", typeIdx: p.stateTypeIdx },
        {
          op: "if",
          blockType: { kind: "empty" },
          then: [{ op: "local.get", index: 0 }, { op: "return" }],
        },
      );
    }
    // Ladder-admissible carriers → GetIterator. Everything else falls through
    // to the null sentinel (helpers answer the legacy `undefined`) so a
    // receiver the ladder would hard-cast-trap on (class instance, string,
    // arbitrary data struct) can never trap here.
    const ladderTypeIdxs = [
      ...(canonicalVecTypeIdx !== undefined ? [canonicalVecTypeIdx] : []),
      ...iterableStructTypeIdxs,
    ];
    for (const t of ladderTypeIdxs) {
      arms.push(
        { op: "local.get", index: ANY },
        { op: "ref.test", typeIdx: t },
        {
          op: "if",
          blockType: { kind: "empty" },
          then: [{ op: "local.get", index: 0 }, { op: "call", funcIdx: iteratorIdx }, { op: "return" }],
        },
      );
    }
    openFn.body = [...convert, ...arms, { op: "ref.null.extern" }];
  }

  const nextFn = definedFuncAt(ctx, nextIdx);
  if (nextFn) {
    const arms: Instr[] = [];
    // Lazy Iterator-helper wrapper → delegate the step to `__lazy_iter_step`
    // (which itself drives the wrapper's source via `__iter_hof_next`).
    if (lazyArm) {
      arms.push(
        { op: "local.get", index: ANY },
        { op: "ref.test", typeIdx: lazyArm.typeIdx },
        {
          op: "if",
          blockType: { kind: "empty" },
          then: [{ op: "local.get", index: 0 }, { op: "call", funcIdx: lazyArm.stepIdx }, { op: "return" }],
        },
      );
    }
    for (const p of producers) {
      arms.push(
        { op: "local.get", index: ANY },
        { op: "ref.test", typeIdx: p.stateTypeIdx },
        {
          op: "if",
          blockType: { kind: "empty" },
          then: [
            { op: "local.get", index: ANY },
            { op: "ref.cast", typeIdx: p.stateTypeIdx },
            { op: "call", funcIdx: p.resumeIdx },
            { op: "local.set", index: RES_ANY }, // (ref RT) <: anyref
            // done
            { op: "local.get", index: RES_ANY },
            { op: "ref.cast", typeIdx: p.resultTypeIdx },
            { op: "struct.get", typeIdx: p.resultTypeIdx, fieldIdx: RESULT_DONE_FIELD },
            // value (boxed to externref)
            ...valueRead(p),
            { op: "return" },
          ],
        },
      );
    }
    nextFn.body = [...convert, ...arms, { op: "local.get", index: 0 }, { op: "call", funcIdx: iteratorNextIdx }];
  }

  const closeFn = definedFuncAt(ctx, closeIdx);
  if (closeFn) {
    const arms: Instr[] = [];
    // Lazy Iterator-helper wrapper → close its source via `__lazy_iter_close`.
    if (lazyArm) {
      arms.push(
        { op: "local.get", index: ANY },
        { op: "ref.test", typeIdx: lazyArm.typeIdx },
        {
          op: "if",
          blockType: { kind: "empty" },
          then: [{ op: "local.get", index: 0 }, { op: "call", funcIdx: lazyArm.closeIdx }, { op: "return" }],
        },
      );
    }
    for (const p of producers) {
      arms.push(
        { op: "local.get", index: ANY },
        { op: "ref.test", typeIdx: p.stateTypeIdx },
        { op: "if", blockType: { kind: "empty" }, then: [{ op: "return" }] },
      );
    }
    closeFn.body = [...convert, ...arms, { op: "local.get", index: 0 }, { op: "call", funcIdx: iteratorReturnIdx }];
  }
}
