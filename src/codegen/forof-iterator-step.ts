// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * (#6651 cluster G, slice G4) The `for…of` statement's own IteratorStep for a
 * plain-object (`ITER_KIND_OBJ`) iterator record, standalone / WASI only.
 *
 * ## The two spec steps the shared `__iterator_next` does not model
 *
 * 1. **`next` is read ONCE** — §7.4.1 GetIteratorFromMethod step 3 stores
 *    `Get(iterator, "next")` in the Iterator Record, and §7.4.4 IteratorNext
 *    calls that cached value on every step. The shared OBJ step re-reads `next`
 *    per poll, so an iterator whose `next` accessor changes (or starts
 *    throwing) after the first step is observed wrongly
 *    (`for-of/iterator-next-reference.js`).
 * 2. **A non-Object result is a TypeError** — §7.4.4 step 3. The shared OBJ step
 *    deliberately degrades a falsy result to `done` (the GetIteratorFlattenable
 *    bridge and several internal drains rely on that), and reads a truthy
 *    primitive as a closed struct (`for-of/iterator-next-result-type.js`).
 *
 * ## Why a for-of-only twin instead of changing `__iterator_next`
 *
 * `__iterator_next` is the step of every internal drain (spread, `Array.from`,
 * destructuring materialisation, the Iterator-helper bridge). Its lenient
 * degradations are load-bearing there (#5131 kept the strict protocol in a
 * separate provider for the same reason), and caching `next` inside the shared
 * runtime would need a new `$__IterRec` field — a type change visible in every
 * module that iterates. The for-of statement owns its loop, so it can hold the
 * cached method in a LOCAL: `__forof_next_method(rec)` runs once right after
 * GetIterator, and `__forof_step(rec, next)` replaces the per-iteration
 * `__iterator_next` call. Every non-OBJ record forwards to `__iterator_next`
 * unchanged.
 *
 * Reserve-then-fill: the two functions are minted during body compilation with
 * forwarding bodies (valid, and exactly the old behaviour), and
 * `fillNativeIteratorLateArms` rebuilds them once the OBJ carrier deps exist.
 * A module whose fill never provides OBJ deps can never build an OBJ record, so
 * the forwarding bodies are then the complete answer.
 */
import type { TypeFact } from "../checker/oracle.js";
import type { Instr, ValType } from "../ir/types.js";
import type { ts } from "../ts-api.js";
import type { CodegenContext } from "./context/types.js";
import { definedFuncAt, mintDefinedFunc, pushDefinedFunc } from "./func-space.js";
import { stringConstantExternrefInstrs } from "./native-strings.js";
import { emitWasiErrorConstructor } from "./registry/error-types.js";
import { addStringConstantGlobal, ensureExnTag } from "./registry/imports.js";
import { addFuncType } from "./registry/types.js";

/** `$__IterRec.kind` for a plain-object iterator (mirrors `ITER_KIND_OBJ`). */
const KIND_OBJ = 4;
/** Same text as the IteratorClose result check, so the string global is shared. */
const RESULT_NOT_OBJECT_MSG = "iterator result is not an object";

/** The iterator-runtime geometry the bodies need. */
export interface ForOfStepTypes {
  iterRecTypeIdx: number;
  vecTypeIdx: number;
  arrTypeIdx: number;
}

/** The OBJ-carrier deps the fill reads (a structural subset of the runtime's). */
export interface ForOfStepObjDeps {
  externGetIdx: number;
  applyClosureIdx: number;
  isTruthyIdx: number;
  objectTypeIdx: number;
  proxyTypeIdx?: number;
  sgetValueIdx?: number;
  sgetDoneIdx?: number;
  sgetDoneIsExtern?: boolean;
  sgetNextIdx?: number;
  keyInstrs: (name: string) => Instr[];
  missInstrs: () => Instr[];
  /** (#6651 A9) Decodes a provider-created result's field read — see `readDecoder` in iterator-native.ts. */
  decodeRead?: (locals: { name: string; type: ValType }[], paramCount: number) => Instr[];
}

interface ForOfStepFuncs {
  primeIdx: number;
  stepIdx: number;
}

const reserved = new WeakMap<CodegenContext, ForOfStepFuncs>();

/** Builtin iterables whose GetIterator never yields a plain-object record. */
const NON_OBJECT_ITERABLE_BUILTINS = new Set([
  "Array",
  "Map",
  "Set",
  "String",
  "Generator",
  "Int8Array",
  "Uint8Array",
  "Uint8ClampedArray",
  "Int16Array",
  "Uint16Array",
  "Int32Array",
  "Uint32Array",
  "Float32Array",
  "Float64Array",
  "BigInt64Array",
  "BigUint64Array",
]);

function mayYieldObjectRecord(ctx: CodegenContext, fact: TypeFact): boolean {
  switch (fact.kind) {
    case "object":
    case "class":
    case "function":
      return true;
    case "array":
    case "tuple":
      // A program that replaced `Array.prototype[@@iterator]` can hand an array
      // a user iterator object.
      return ctx.arrayIteratorMaybeOverridden === true;
    case "builtin":
      return NON_OBJECT_ITERABLE_BUILTINS.has(fact.name)
        ? fact.name === "Array" && ctx.arrayIteratorMaybeOverridden === true
        : true;
    case "union":
      return fact.parts.some((p) => mayYieldObjectRecord(ctx, p));
    default:
      return false;
  }
}

/**
 * Does this for-of subject take the twin step? Only a subject STATICALLY typed
 * as an object (a literal, a class instance, a function, an `Iterable`-family
 * type) — the shapes whose GetIterator can produce a plain-object
 * (`ITER_KIND_OBJ`) record. A statically-known builtin iterable (array, string,
 * Map/Set, typed array, generator) never produces one, and an `any` / unknown
 * subject is left on the shared step deliberately: untyped code is the bulk of
 * the example / benchmark corpus, whose bytes this slice keeps identical.
 */
export function forOfSubjectMayYieldObjectIterator(ctx: CodegenContext, subject: ts.Expression): boolean {
  return mayYieldObjectRecord(ctx, ctx.oracle.typeFactOf(subject));
}

/**
 * Mint `__forof_next_method` / `__forof_step` (idempotent). Returns `undefined`
 * outside standalone / WASI or before the native iterator runtime exists — the
 * caller then keeps the plain `__iterator_next` step.
 */
export function reserveForOfIteratorStep(ctx: CodegenContext): ForOfStepFuncs | undefined {
  if (!ctx.standalone && !ctx.wasi) return undefined;
  const existing = reserved.get(ctx);
  if (existing) return existing;
  const iterRecTypeIdx = ctx.structMap.get("__IterRec");
  const iteratorNextIdx = ctx.funcMap.get("__iterator_next");
  if (iterRecTypeIdx === undefined || iteratorNextIdx === undefined) return undefined;
  // Eager, idempotent: the fill below only READS registered symbols.
  emitWasiErrorConstructor(ctx, "TypeError", 1);
  addStringConstantGlobal(ctx, RESULT_NOT_OBJECT_MSG);

  const ext: ValType = { kind: "externref" };
  const register = (
    name: string,
    params: ValType[],
    results: ValType[],
    locals: { name: string; type: ValType }[],
    body: Instr[],
  ): number => {
    const typeIdx = addFuncType(ctx, params, results);
    const funcIdx = mintDefinedFunc(ctx);
    ctx.funcMap.set(name, funcIdx);
    pushDefinedFunc(ctx, funcIdx, { name, typeIdx, locals, body, exported: false });
    return funcIdx;
  };
  const recRef: ValType = { kind: "ref", typeIdx: iterRecTypeIdx };
  // Locals are declared at their final shape now; the fill replaces bodies only.
  const primeIdx = register(
    "__forof_next_method",
    [ext],
    [ext],
    [{ name: "rec", type: recRef }],
    [{ op: "ref.null.extern" }],
  );
  const stepIdx = register(
    "__forof_step",
    [ext, ext],
    [{ kind: "i32" }, ext],
    [
      { name: "rec", type: recRef },
      { name: "res", type: ext },
      { name: "done", type: { kind: "i32" } },
      { name: "value", type: ext },
    ],
    [
      { op: "local.get", index: 0 },
      { op: "call", funcIdx: iteratorNextIdx },
    ],
  );
  const funcs = { primeIdx, stepIdx };
  reserved.set(ctx, funcs);
  return funcs;
}

/** `$Object` / `$Proxy` carrier test on the externref `load` pushes. */
function objCarrierTest(deps: ForOfStepObjDeps, load: () => Instr[]): Instr[] {
  return [
    ...load(),
    { op: "ref.test", typeIdx: deps.objectTypeIdx },
    ...(deps.proxyTypeIdx === undefined
      ? []
      : ([...load(), { op: "ref.test", typeIdx: deps.proxyTypeIdx }, { op: "i32.or" }] satisfies Instr[])),
  ];
}

/**
 * Rebuild the reserved bodies with the OBJ arm. Called from the native
 * iterator runtime's finalize fill once `deps` are resolved; a no-op when
 * nothing was reserved. `isObjectInstrs(local)` is the runtime's shared
 * Type(V)-is-Object test (fresh instrs per call).
 */
export function fillForOfIteratorStep(
  ctx: CodegenContext,
  types: ForOfStepTypes,
  deps: ForOfStepObjDeps,
  isObjectInstrs: (local: number) => Instr[] | undefined,
): void {
  const funcs = reserved.get(ctx);
  if (!funcs) return;
  const iteratorNextIdx = ctx.funcMap.get("__iterator_next");
  const ctorIdx = ctx.funcMap.get("__new_TypeError");
  const isObject = isObjectInstrs(5);
  if (iteratorNextIdx === undefined || ctorIdx === undefined || isObject === undefined) return;
  const prime = definedFuncAt(ctx, funcs.primeIdx);
  const step = definedFuncAt(ctx, funcs.stepIdx);
  if (!prime || !step) return;
  const { iterRecTypeIdx, vecTypeIdx, arrTypeIdx } = types;
  const tagIdx = ensureExnTag(ctx);

  // rec = ref.cast $__IterRec (any.convert_extern recExt)
  const castRec = (recLocal: number): Instr[] => [
    { op: "local.get", index: 0 },
    { op: "any.convert_extern" },
    { op: "ref.cast", typeIdx: iterRecTypeIdx },
    { op: "local.set", index: recLocal },
  ];
  const isObjRecord = (recLocal: number): Instr[] => [
    { op: "local.get", index: recLocal },
    { op: "struct.get", typeIdx: iterRecTypeIdx, fieldIdx: 0 },
    { op: "i32.const", value: KIND_OBJ },
    { op: "i32.eq" },
  ];
  const userIter = (recLocal: number): Instr[] => [
    { op: "local.get", index: recLocal },
    { op: "struct.get", typeIdx: iterRecTypeIdx, fieldIdx: 3 },
  ];

  // --- __forof_next_method(recExt) -> externref ---------------------------
  // locals: 0 recExt, 1 rec. The carrier-branched `next` read is the shared
  // OBJ step's, performed once.
  prime.body = [
    ...castRec(1),
    ...isObjRecord(1),
    {
      op: "if",
      blockType: { kind: "val", type: { kind: "externref" } },
      then: [
        ...objCarrierTest(deps, () => [...userIter(1), { op: "any.convert_extern" }]),
        {
          op: "if",
          blockType: { kind: "val", type: { kind: "externref" } },
          then: [...userIter(1), ...deps.keyInstrs("next"), { op: "call", funcIdx: deps.externGetIdx }],
          else:
            deps.sgetNextIdx !== undefined
              ? [...userIter(1), { op: "call", funcIdx: deps.sgetNextIdx }]
              : deps.missInstrs(),
        },
      ],
      else: [{ op: "ref.null.extern" }],
    },
  ];

  // --- __forof_step(recExt, next) -> (i32 done, externref value) ----------
  // locals: 0 recExt, 1 next, 2 rec, 3 res, 4 done, 5 value (also the
  // Type(V) scratch, before it is assigned).
  // Result reads are the shared OBJ step's, verbatim: `$Object`/`$Proxy`
  // results through `__extern_get`, closed `{value, done}` structs through the
  // field getters, with the same done-degrade when no getter exists.
  const decode = (): Instr[] => deps.decodeRead?.(step.locals, 2) ?? []; // (#6651 A9)
  const readObj: Instr[] = [
    { op: "local.get", index: 3 },
    ...deps.keyInstrs("done"),
    { op: "call", funcIdx: deps.externGetIdx },
    ...decode(),
    { op: "call", funcIdx: deps.isTruthyIdx },
    { op: "local.set", index: 4 },
    { op: "local.get", index: 4 },
    {
      op: "if",
      blockType: { kind: "val", type: { kind: "externref" } },
      then: deps.missInstrs(),
      else: [
        { op: "local.get", index: 3 },
        ...deps.keyInstrs("value"),
        { op: "call", funcIdx: deps.externGetIdx },
        ...decode(),
      ],
    },
    { op: "local.set", index: 5 },
  ];
  const readStruct: Instr[] =
    deps.sgetDoneIdx !== undefined && (deps.sgetValueIdx !== undefined || deps.sgetDoneIsExtern === true)
      ? [
          { op: "local.get", index: 3 },
          { op: "call", funcIdx: deps.sgetDoneIdx },
          { op: "call", funcIdx: deps.isTruthyIdx },
          { op: "local.set", index: 4 },
          { op: "local.get", index: 4 },
          {
            op: "if",
            blockType: { kind: "val", type: { kind: "externref" } },
            then: deps.missInstrs(),
            else:
              deps.sgetValueIdx !== undefined
                ? [
                    { op: "local.get", index: 3 },
                    { op: "call", funcIdx: deps.sgetValueIdx },
                  ]
                : deps.missInstrs(),
          },
          { op: "local.set", index: 5 },
        ]
      : [
          { op: "i32.const", value: 1 },
          { op: "local.set", index: 4 },
          ...deps.missInstrs(),
          { op: "local.set", index: 5 },
        ];
  step.body = [
    ...castRec(2),
    ...isObjRecord(2),
    { op: "i32.eqz" },
    {
      op: "if",
      blockType: { kind: "empty" },
      then: [{ op: "local.get", index: 0 }, { op: "call", funcIdx: iteratorNextIdx }, { op: "return" }],
      else: [],
    },
    // res = Call(next, iterator) — a non-callable `next` answers null here,
    // which the Object check below turns into the §7.4.4 TypeError.
    { op: "local.get", index: 1 },
    ...userIter(2),
    { op: "i32.const", value: 0 },
    { op: "i32.const", value: 0 },
    { op: "array.new_default", typeIdx: arrTypeIdx },
    { op: "struct.new", typeIdx: vecTypeIdx },
    { op: "extern.convert_any" },
    { op: "call", funcIdx: deps.applyClosureIdx },
    { op: "local.tee", index: 3 },
    { op: "local.set", index: 5 },
    ...isObject,
    { op: "i32.eqz" },
    {
      op: "if",
      blockType: { kind: "empty" },
      then: [
        ...stringConstantExternrefInstrs(ctx, RESULT_NOT_OBJECT_MSG),
        { op: "call", funcIdx: ctorIdx },
        { op: "throw", tagIdx },
      ],
      else: [],
    },
    ...objCarrierTest(deps, () => [{ op: "local.get", index: 3 }, { op: "any.convert_extern" }]),
    { op: "if", blockType: { kind: "empty" }, then: readObj, else: readStruct },
    { op: "local.get", index: 4 },
    { op: "local.get", index: 5 },
  ];
}
