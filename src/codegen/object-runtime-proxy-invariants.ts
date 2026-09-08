// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * (#5316 r4) §10.5 DESCRIPTOR-MODEL post-trap invariants for the standalone
 * Proxy runtime — the half #5140 deferred to "#1355 slice G".
 *
 * #5140 landed the target-INDEPENDENT invariants (getPrototypeOf /
 * setPrototypeOf / isExtensible / preventExtensions) inline in
 * `object-runtime-proxy.ts`, because they are expressible with
 * `__object_isExtensible`, `__getPrototypeOf`, `__is_truthy` and strict
 * equality alone. Everything in THIS module needs the target's own property
 * DESCRIPTOR, i.e. the standalone attribute model
 * (`__getOwnPropertyDescriptor` + `__extern_get`/`__extern_has` reads of the
 * descriptor object it materializes).
 *
 * ## Shape: one validator NATIVE per trap, not an inline splice
 * Each validator is a registered native `(target, key, …, trapResult) ->
 * externref` that either returns `trapResult` unchanged or throws the shared
 * `invariantMsg` TypeError. The dispatch arms in `object-runtime-proxy.ts`
 * append a single `call <validatorIdx>` after the trap driver call. This keeps
 * every local index local to the validator (the dispatch builders hardcode
 * their own layouts) and keeps each body under one function's `locals` vector.
 *
 * ## Why `__getOwnPropertyDescriptor` and not a field read
 * `fillProxyDispatch` unshifts a `ref.test $Proxy` front-guard onto
 * `__getOwnPropertyDescriptor`, so a target that is ITSELF a `$Proxy` re-enters
 * its own `getOwnPropertyDescriptor` dispatch (recursion, one hop at a time) —
 * which is exactly what §10.5 requires (`target.[[GetOwnProperty]](P)`), and
 * what a raw struct field read would get wrong.
 *
 * ## Conservative by construction
 * Every check is a REFINEMENT: it can only turn a spec-violating trap answer
 * into a TypeError. Where the full §6.2.6.6 `IsCompatiblePropertyDescriptor`
 * would need a completion the standalone model cannot express, the validator
 * declines rather than guessing — a missed throw is a residual row, a wrong
 * throw is a regression in a working program.
 *
 * Every emitter is a FACTORY returning a FRESH `Instr[]`: the FINALIZE
 * dead-code `remapFuncIdxInBody` walk has no dedup set, so a shared array
 * embedded twice is double-remapped (the #5140 comment block records the same
 * hazard).
 */
import type { Instr, ValType } from "../ir/types.js";
import type { CodegenContext } from "./context/types.js";
import { stringConstantExternrefInstrs } from "./native-strings.js";
import { addStringConstantGlobal, ensureExnTag } from "./registry/imports.js";
import { ensureExternStrictEqHelper } from "./any-helpers.js";

const EXTERNREF: ValType = { kind: "externref" };
const I32: ValType = { kind: "i32" };

/** funcIdx of each §10.5 descriptor-model validator, or `null` when the
 *  standalone primitives they need are not all present in this module. */
export interface ProxyInvariantValidators {
  gopd: number;
  define: number;
  has: number;
  get: number;
  set: number;
  deleteProperty: number;
  ownKeys: number;
}

type RegisterNative = (
  name: string,
  paramTypes: ValType[],
  resultTypes: ValType[],
  locals: { name: string; type: ValType }[],
  body: Instr[],
) => number;

/**
 * Registers `__proxy_inv_*` and returns their funcIdx. Returns `null` when any
 * required primitive is missing — callers then keep the pre-#5316 behaviour
 * (trap result returned unvalidated) rather than emitting a half-check.
 *
 * MUST be called from `ensureProxyRuntime` BEFORE the dispatch bodies are
 * built, so the returned indices can be baked into them.
 */
export function registerProxyInvariantValidators(
  ctx: CodegenContext,
  registerNative: RegisterNative,
): ProxyInvariantValidators | null {
  // (#5316 r4, review round 1) TARGET GATE — these validators are sound only
  // where the attribute model they consume is. `--target wasi` sets `ctx.wasi`
  // and leaves `ctx.standalone` false, and under it three of the primitives
  // below answer WRONGLY for an ordinary object literal (measured on
  // `origin/main`, i.e. pre-#5316, with Proxy-free probes —
  // `.tmp/rev5316/p/w5`): `Object.isExtensible({a:1,b:2})` -> `false`,
  // `Object.getOwnPropertyNames({a:1,b:2})` -> length 0, and
  // `Object.getOwnPropertyDescriptor({a:1},'a')` traps. Feeding those answers
  // to a sound §10.5 check turns COMPLIANT Proxy programs into TypeErrors: 10
  // probe programs that are correct on base and on node all threw on the
  // unguarded lane. The wasi attribute-model primitives are the pre-existing
  // owner of that defect; until they are fixed, wasi keeps the pre-#5316
  // (unvalidated) dispatch byte-for-byte. Standalone, where all three answer
  // correctly, is unaffected.
  if (ctx.wasi) return null;
  const gopdIdx = ctx.funcMap.get("__getOwnPropertyDescriptor");
  const externGetIdx = ctx.funcMap.get("__extern_get");
  const externHasIdx = ctx.funcMap.get("__extern_has");
  const isTruthyIdx = ctx.funcMap.get("__is_truthy");
  const isExtIdx = ctx.funcMap.get("__object_isExtensible");
  const isUndefinedIdx = ctx.funcMap.get("__extern_is_undefined");
  const ownNamesIdx = ctx.funcMap.get("__getOwnPropertyNames");
  const lengthIdx = ctx.funcMap.get("__extern_length");
  const getIdxIdx = ctx.funcMap.get("__extern_get_idx");
  const typeErrorCtorIdx = ctx.funcMap.get("__new_TypeError");
  const sameValueIdx =
    ctx.funcMap.get("__object_is") ?? ensureExternStrictEqHelper(ctx) ?? ctx.funcMap.get("__host_eq");
  if (
    gopdIdx === undefined ||
    externGetIdx === undefined ||
    externHasIdx === undefined ||
    isTruthyIdx === undefined ||
    isExtIdx === undefined ||
    isUndefinedIdx === undefined ||
    ownNamesIdx === undefined ||
    lengthIdx === undefined ||
    getIdxIdx === undefined ||
    typeErrorCtorIdx === undefined ||
    sameValueIdx === undefined
  ) {
    return null;
  }
  const exnTagIdx = ensureExnTag(ctx);

  // The SAME message #5140 minted for the target-independent half — one proxy
  // invariant message for the whole of §10.5, per the r4 plan.
  const invariantMsg = "Proxy trap result violates a Proxy invariant";
  addStringConstantGlobal(ctx, invariantMsg);
  const throwInvariant = (): Instr[] => [
    ...stringConstantExternrefInstrs(ctx, invariantMsg),
    { op: "call", funcIdx: typeErrorCtorIdx },
    { op: "throw", tagIdx: exnTagIdx },
  ];
  /** `if (<i32 on stack>) throw TypeError` — consumes the condition. */
  const throwIf = (): Instr[] => [{ op: "if", blockType: { kind: "empty" }, then: throwInvariant() }];

  for (const key of ["configurable", "enumerable", "writable", "value", "get", "set"]) {
    addStringConstantGlobal(ctx, key);
  }
  const keyOf = (name: string): Instr[] => stringConstantExternrefInstrs(ctx, name);

  /** i32 1 when the descriptor in `l` is "absent" — null OR the undefined
   *  singleton. `__getOwnPropertyDescriptor` answers a miss with whichever of
   *  the two the module's undefined regime uses (#2106). */
  const isAbsent = (l: number): Instr[] => [
    { op: "local.get", index: l },
    { op: "ref.is_null" },
    { op: "local.get", index: l },
    { op: "call", funcIdx: isUndefinedIdx },
    { op: "i32.or" },
  ];
  // `__typeof_object` alone is NOT a usable Object test here: a boxed boolean
  // carrier answers it true, so `getOwnPropertyDescriptor` returning `false`
  // read as an Object and step 9 never fired (measured 2026-09-04 on
  // `result-type-is-not-object-nor-undefined.js`). Classify by EXCLUSION the
  // way `buildOwnKeysDispatch`'s CreateListFromArrayLike check already does:
  // not-Object ⇔ null, a boxed primitive, or a native `$Symbol` carrier.
  const primitiveTestIdx = ["__typeof_number", "__typeof_boolean", "__typeof_string", "__typeof_bigint"]
    .map((name) => ctx.funcMap.get(name))
    .filter((idx): idx is number => idx !== undefined);
  const symbolTypeIdx = ctx.symbolTypeIdx;
  const isObject = (l: number): Instr[] => {
    const out: Instr[] = [{ op: "local.get", index: l }, { op: "ref.is_null" }];
    for (const funcIdx of [...primitiveTestIdx, isUndefinedIdx]) {
      out.push({ op: "local.get", index: l }, { op: "call", funcIdx }, { op: "i32.or" });
    }
    if (symbolTypeIdx >= 0) {
      out.push(
        { op: "local.get", index: l },
        { op: "any.convert_extern" },
        { op: "ref.test", typeIdx: symbolTypeIdx },
        { op: "i32.or" },
      );
    }
    out.push({ op: "i32.eqz" });
    return out;
  };
  /** §7.3.12 HasProperty on a descriptor object (chain-inclusive, like
   *  ToPropertyDescriptor's own `HasProperty` calls). */
  const hasField = (l: number, name: string): Instr[] => [
    { op: "local.get", index: l },
    ...keyOf(name),
    { op: "call", funcIdx: externHasIdx },
  ];
  const getField = (l: number, name: string): Instr[] => [
    { op: "local.get", index: l },
    ...keyOf(name),
    { op: "call", funcIdx: externGetIdx },
  ];
  const truthyField = (l: number, name: string): Instr[] => [
    ...getField(l, name),
    { op: "call", funcIdx: isTruthyIdx },
  ];
  /** `td = target.[[GetOwnProperty]](key)` into local `dst`. Recurses through a
   *  `$Proxy` target's own gopd dispatch via the front-guard. */
  const loadTargetDesc = (targetLocal: number, keyLocal: number, dst: number): Instr[] => [
    { op: "local.get", index: targetLocal },
    { op: "local.get", index: keyLocal },
    { op: "call", funcIdx: gopdIdx },
    { op: "local.set", index: dst },
  ];
  const notExtensible = (targetLocal: number): Instr[] => [
    { op: "local.get", index: targetLocal },
    { op: "call", funcIdx: isExtIdx },
    { op: "i32.eqz" },
  ];
  const sameValueOf = (a: Instr[], b: Instr[]): Instr[] => [...a, ...b, { op: "call", funcIdx: sameValueIdx }];

  // ── §10.5.5 [[GetOwnProperty]] steps 9-17 ─────────────────────────────────
  // params 0=target 1=key 2=trapResult ; locals 3=td
  const gopd = registerNative(
    "__proxy_inv_gopd",
    [EXTERNREF, EXTERNREF, EXTERNREF],
    [EXTERNREF],
    [{ name: "td", type: EXTERNREF }],
    [
      ...loadTargetDesc(0, 1, 3),
      // Step 11/14 — trap answered `undefined`.
      ...isAbsent(2),
      {
        op: "if",
        blockType: { kind: "empty" },
        then: [
          ...isAbsent(3),
          { op: "i32.eqz" },
          {
            op: "if",
            blockType: { kind: "empty" },
            then: [
              // 14.b: a non-configurable target property may not be hidden.
              ...truthyField(3, "configurable"),
              { op: "i32.eqz" },
              ...throwIf(),
              // 14.d: nor may any property of a non-extensible target.
              ...notExtensible(0),
              ...throwIf(),
            ],
          },
          { op: "local.get", index: 2 },
          { op: "return" },
        ],
      },
      // Step 9: anything other than undefined must be an Object.
      ...isObject(2),
      { op: "i32.eqz" },
      ...throwIf(),
      // §6.2.6.5 ToPropertyDescriptor step 4: data AND accessor fields is a
      // TypeError before any invariant is consulted.
      ...hasField(2, "value"),
      ...hasField(2, "writable"),
      { op: "i32.or" },
      ...hasField(2, "get"),
      ...hasField(2, "set"),
      { op: "i32.or" },
      { op: "i32.and" },
      ...throwIf(),
      // Step 16 — IsCompatiblePropertyDescriptor with an undefined targetDesc
      // reduces to `extensibleTarget`. With a PRESENT targetDesc the full
      // §6.2.6.6 completion is beyond the standalone attribute model, so this
      // validator declines that arm rather than guessing.
      ...isAbsent(3),
      { op: "if", blockType: { kind: "empty" }, then: [...notExtensible(0), ...throwIf()] },
      // Step 17 — a non-configurable answer must be backed by the target.
      ...truthyField(2, "configurable"),
      { op: "i32.eqz" },
      {
        op: "if",
        blockType: { kind: "empty" },
        then: [
          ...isAbsent(3),
          ...throwIf(),
          ...truthyField(3, "configurable"),
          ...throwIf(),
          // 17.b: a non-writable answer needs a non-writable target property.
          ...hasField(2, "writable"),
          ...truthyField(2, "writable"),
          { op: "i32.eqz" },
          { op: "i32.and" },
          { op: "if", blockType: { kind: "empty" }, then: [...truthyField(3, "writable"), ...throwIf()] },
        ],
      },
      { op: "local.get", index: 2 },
    ],
  );

  // ── §10.5.6 [[DefineOwnProperty]] steps 9-16 ──────────────────────────────
  // params 0=target 1=key 2=Desc 3=trapResult ; locals 4=td 5=settingConfigFalse
  const define = registerNative(
    "__proxy_inv_define",
    [EXTERNREF, EXTERNREF, EXTERNREF, EXTERNREF],
    [EXTERNREF],
    [
      { name: "td", type: EXTERNREF },
      { name: "scf", type: I32 },
    ],
    [
      // Step 10: a falsy trap result is `false`, not an error.
      { op: "local.get", index: 3 },
      { op: "call", funcIdx: isTruthyIdx },
      { op: "i32.eqz" },
      { op: "if", blockType: { kind: "empty" }, then: [{ op: "local.get", index: 3 }, { op: "return" }] },
      ...loadTargetDesc(0, 1, 4),
      // settingConfigFalse = Desc has [[Configurable]] and it is false.
      ...hasField(2, "configurable"),
      ...truthyField(2, "configurable"),
      { op: "i32.eqz" },
      { op: "i32.and" },
      { op: "local.set", index: 5 },
      ...isAbsent(4),
      {
        op: "if",
        blockType: { kind: "empty" },
        // Step 15: nothing may be added to a non-extensible target, and a
        // brand-new property may not be born non-configurable.
        then: [...notExtensible(0), ...throwIf(), { op: "local.get", index: 5 }, ...throwIf()],
        else: [
          // 16.b.i: a configurable target property may not be redefined
          // non-configurable through the trap.
          { op: "local.get", index: 5 },
          ...truthyField(4, "configurable"),
          { op: "i32.and" },
          ...throwIf(),
          // The §6.2.6.6 compatibility rules that bite only over a
          // NON-configurable target property.
          ...truthyField(4, "configurable"),
          { op: "i32.eqz" },
          {
            op: "if",
            blockType: { kind: "empty" },
            then: [
              // non-configurable ⇒ may not become configurable
              ...hasField(2, "configurable"),
              ...truthyField(2, "configurable"),
              { op: "i32.and" },
              ...throwIf(),
              // …nor flip [[Enumerable]]
              ...hasField(2, "enumerable"),
              ...truthyField(2, "enumerable"),
              ...truthyField(4, "enumerable"),
              { op: "i32.ne" },
              { op: "i32.and" },
              ...throwIf(),
              ...hasField(4, "writable"),
              {
                op: "if",
                blockType: { kind: "empty" },
                // target property is a DATA property
                then: [
                  // …so an accessor redefinition is incompatible
                  ...hasField(2, "get"),
                  ...hasField(2, "set"),
                  { op: "i32.or" },
                  ...throwIf(),
                  ...truthyField(4, "writable"),
                  {
                    op: "if",
                    blockType: { kind: "empty" },
                    // 16.b.ii — §10.5.6 is STRICTER than ordinary
                    // [[DefineOwnProperty]]: a trap may not report success for
                    // making a non-configurable writable property read-only.
                    then: [
                      ...hasField(2, "writable"),
                      ...truthyField(2, "writable"),
                      { op: "i32.eqz" },
                      { op: "i32.and" },
                      ...throwIf(),
                    ],
                    // non-configurable AND non-writable: neither [[Writable]]
                    // nor [[Value]] may change.
                    else: [
                      ...hasField(2, "writable"),
                      ...truthyField(2, "writable"),
                      { op: "i32.and" },
                      ...throwIf(),
                      ...hasField(2, "value"),
                      {
                        op: "if",
                        blockType: { kind: "empty" },
                        then: [
                          ...sameValueOf(getField(2, "value"), getField(4, "value")),
                          { op: "i32.eqz" },
                          ...throwIf(),
                        ],
                      },
                    ],
                  },
                ],
                // target property is an ACCESSOR property
                else: [
                  ...hasField(2, "value"),
                  ...hasField(2, "writable"),
                  { op: "i32.or" },
                  ...throwIf(),
                  ...hasField(2, "get"),
                  {
                    op: "if",
                    blockType: { kind: "empty" },
                    then: [...sameValueOf(getField(2, "get"), getField(4, "get")), { op: "i32.eqz" }, ...throwIf()],
                  },
                  ...hasField(2, "set"),
                  {
                    op: "if",
                    blockType: { kind: "empty" },
                    then: [...sameValueOf(getField(2, "set"), getField(4, "set")), { op: "i32.eqz" }, ...throwIf()],
                  },
                ],
              },
            ],
          },
        ],
      },
      { op: "local.get", index: 3 },
    ],
  );

  // ── §10.5.7 [[HasProperty]] step 9 ────────────────────────────────────────
  //
  // (#5316) Step 9.b.ii (`IsExtensible(target)` is false ⇒ throw) was DECLINED
  // in r4 because it turned two rows that pass on `origin/main` into TypeErrors
  // over ordinary extensible `{attr: 1}` targets. The r4 note read that as "the
  // dispatch-internal `__object_isExtensible` call is special"; it is not. An
  // object literal lowers to an `__anon_*` closed struct, which is neither a
  // `$Object` nor any carrier `__integrity_bag` had an arm for, so the helper
  // fell through to its NON-object terminal (`extensible = false`) — the same
  // wrong answer a pristine class instance got (probe `x1`). The source-level
  // `Object.isExtensible(t)` looked right only because `provenJsObject` picks
  // the `_obj` variant there, whose terminal is the opposite constant.
  //
  // The instance-carrier arm added to `__integrity_bag` in this issue's step 1
  // makes the helper answer from a real flags slot for those receivers, so the
  // clause states what §10.5.7 says and is restored here.
  //
  // params 0=target 1=key 2=trapResult ; locals 3=td
  const has = registerNative(
    "__proxy_inv_has",
    [EXTERNREF, EXTERNREF, EXTERNREF],
    [EXTERNREF],
    [{ name: "td", type: EXTERNREF }],
    [
      { op: "local.get", index: 2 },
      { op: "call", funcIdx: isTruthyIdx },
      { op: "if", blockType: { kind: "empty" }, then: [{ op: "local.get", index: 2 }, { op: "return" }] },
      ...loadTargetDesc(0, 1, 3),
      ...isAbsent(3),
      { op: "i32.eqz" },
      {
        op: "if",
        blockType: { kind: "empty" },
        then: [
          // Step 9.b.i: the target's own property must be configurable …
          ...truthyField(3, "configurable"),
          { op: "i32.eqz" },
          ...throwIf(),
          // … and step 9.b.ii: the target must be extensible. Fresh `Instr[]`
          // from the factories on every splice — the finalize funcIdx walk has
          // no dedup set, so a shared array is remapped once per occurrence.
          ...notExtensible(0),
          ...throwIf(),
        ],
      },
      { op: "local.get", index: 2 },
    ],
  );

  // ── §10.5.8 [[Get]] step 10 ───────────────────────────────────────────────
  // params 0=target 1=key 2=trapResult ; locals 3=td 4=getter
  const get = registerNative(
    "__proxy_inv_get",
    [EXTERNREF, EXTERNREF, EXTERNREF],
    [EXTERNREF],
    [
      { name: "td", type: EXTERNREF },
      { name: "getter", type: EXTERNREF },
    ],
    [
      ...loadTargetDesc(0, 1, 3),
      ...isAbsent(3),
      { op: "i32.eqz" },
      {
        op: "if",
        blockType: { kind: "empty" },
        then: [
          ...truthyField(3, "configurable"),
          { op: "i32.eqz" },
          {
            op: "if",
            blockType: { kind: "empty" },
            then: [
              ...hasField(3, "writable"),
              {
                op: "if",
                blockType: { kind: "empty" },
                // 10.a: a non-configurable non-writable data property pins the
                // observable value.
                then: [
                  ...truthyField(3, "writable"),
                  { op: "i32.eqz" },
                  {
                    op: "if",
                    blockType: { kind: "empty" },
                    then: [
                      ...sameValueOf([{ op: "local.get", index: 2 }], getField(3, "value")),
                      { op: "i32.eqz" },
                      ...throwIf(),
                    ],
                  },
                ],
                // 10.b: a non-configurable accessor with no getter must read
                // as undefined.
                else: [
                  ...getField(3, "get"),
                  { op: "local.set", index: 4 },
                  ...isAbsent(4),
                  {
                    op: "if",
                    blockType: { kind: "empty" },
                    then: [...isAbsent(2), { op: "i32.eqz" }, ...throwIf()],
                  },
                ],
              },
            ],
          },
        ],
      },
      { op: "local.get", index: 2 },
    ],
  );

  // ── §10.5.9 [[Set]] step 9 ────────────────────────────────────────────────
  // params 0=target 1=key 2=value 3=trapResult ; locals 4=td 5=setter
  const set = registerNative(
    "__proxy_inv_set",
    [EXTERNREF, EXTERNREF, EXTERNREF, EXTERNREF],
    [EXTERNREF],
    [
      { name: "td", type: EXTERNREF },
      { name: "setter", type: EXTERNREF },
    ],
    [
      // A falsy trap result is a refused write — nothing to reconcile.
      { op: "local.get", index: 3 },
      { op: "call", funcIdx: isTruthyIdx },
      { op: "i32.eqz" },
      { op: "if", blockType: { kind: "empty" }, then: [{ op: "local.get", index: 3 }, { op: "return" }] },
      ...loadTargetDesc(0, 1, 4),
      ...isAbsent(4),
      { op: "i32.eqz" },
      {
        op: "if",
        blockType: { kind: "empty" },
        then: [
          ...truthyField(4, "configurable"),
          { op: "i32.eqz" },
          {
            op: "if",
            blockType: { kind: "empty" },
            then: [
              ...hasField(4, "writable"),
              {
                op: "if",
                blockType: { kind: "empty" },
                then: [
                  ...truthyField(4, "writable"),
                  { op: "i32.eqz" },
                  {
                    op: "if",
                    blockType: { kind: "empty" },
                    then: [
                      ...sameValueOf([{ op: "local.get", index: 2 }], getField(4, "value")),
                      { op: "i32.eqz" },
                      ...throwIf(),
                    ],
                  },
                ],
                // 9.b: a non-configurable accessor with no setter cannot have
                // accepted the write.
                else: [...getField(4, "set"), { op: "local.set", index: 5 }, ...isAbsent(5), ...throwIf()],
              },
            ],
          },
        ],
      },
      { op: "local.get", index: 3 },
    ],
  );

  // ── §10.5.10 [[Delete]] steps 11-13 ───────────────────────────────────────
  // params 0=target 1=key 2=trapResult ; locals 3=td
  const deleteProperty = registerNative(
    "__proxy_inv_delete",
    [EXTERNREF, EXTERNREF, EXTERNREF],
    [EXTERNREF],
    [{ name: "td", type: EXTERNREF }],
    [
      { op: "local.get", index: 2 },
      { op: "call", funcIdx: isTruthyIdx },
      { op: "i32.eqz" },
      { op: "if", blockType: { kind: "empty" }, then: [{ op: "local.get", index: 2 }, { op: "return" }] },
      ...loadTargetDesc(0, 1, 3),
      ...isAbsent(3),
      { op: "i32.eqz" },
      {
        op: "if",
        blockType: { kind: "empty" },
        then: [
          // Step 12: a non-configurable property cannot have been deleted.
          ...truthyField(3, "configurable"),
          { op: "i32.eqz" },
          ...throwIf(),
          // Step 13 (ES2020+): nor any property of a non-extensible target.
          // Restored with the `has` clause above — same root cause, same fix.
          ...notExtensible(0),
          ...throwIf(),
        ],
      },
      { op: "local.get", index: 2 },
    ],
  );

  // ── §10.5.11 [[OwnPropertyKeys]] steps 16-23 ──────────────────────────────
  // The trap-result list has already been materialized and duplicate-checked by
  // the ownKeys dispatch (#1355 slice E). What remains is the KEY-SET
  // reconciliation against the target:
  //   • every non-configurable own key of the target must appear, and
  //   • over a NON-EXTENSIBLE target the two key sets must be equal.
  // Membership is compared with the same strict-equality helper the dispatch's
  // duplicate check uses. Own SYMBOL keys of the target are outside
  // `__getOwnPropertyNames` and are therefore not reconciled — a residual, not
  // a wrong throw: an unlisted symbol key simply goes unchecked.
  // params 0=target 1=trapResult ; locals 2=tkeys 3=tlen 4=rlen 5=i 6=j 7=k
  //        8=found 9=extensible 10=td
  const ownKeys = registerNative(
    "__proxy_inv_ownkeys",
    [EXTERNREF, EXTERNREF],
    [EXTERNREF],
    [
      { name: "tkeys", type: EXTERNREF },
      { name: "tlen", type: I32 },
      { name: "rlen", type: I32 },
      { name: "i", type: I32 },
      { name: "j", type: I32 },
      { name: "k", type: EXTERNREF },
      { name: "found", type: I32 },
      { name: "ext", type: I32 },
      { name: "td", type: EXTERNREF },
    ],
    [
      { op: "local.get", index: 0 },
      { op: "call", funcIdx: ownNamesIdx },
      { op: "local.set", index: 2 },
      { op: "local.get", index: 2 },
      { op: "call", funcIdx: lengthIdx },
      { op: "i32.trunc_sat_f64_s" },
      { op: "local.set", index: 3 },
      { op: "local.get", index: 1 },
      { op: "call", funcIdx: lengthIdx },
      { op: "i32.trunc_sat_f64_s" },
      { op: "local.set", index: 4 },
      { op: "local.get", index: 0 },
      { op: "call", funcIdx: isExtIdx },
      { op: "local.set", index: 9 },
      { op: "i32.const", value: 0 },
      { op: "local.set", index: 5 },
      {
        op: "block",
        blockType: { kind: "empty" },
        body: [
          {
            op: "loop",
            blockType: { kind: "empty" },
            body: [
              { op: "local.get", index: 5 },
              { op: "local.get", index: 3 },
              { op: "i32.ge_s" },
              { op: "br_if", depth: 1 },
              { op: "local.get", index: 2 },
              { op: "local.get", index: 5 },
              { op: "f64.convert_i32_s" },
              { op: "call", funcIdx: getIdxIdx },
              { op: "local.set", index: 7 },
              { op: "i32.const", value: 0 },
              { op: "local.set", index: 8 },
              { op: "i32.const", value: 0 },
              { op: "local.set", index: 6 },
              {
                op: "block",
                blockType: { kind: "empty" },
                body: [
                  {
                    op: "loop",
                    blockType: { kind: "empty" },
                    body: [
                      { op: "local.get", index: 6 },
                      { op: "local.get", index: 4 },
                      { op: "i32.ge_s" },
                      { op: "br_if", depth: 1 },
                      { op: "local.get", index: 7 },
                      { op: "local.get", index: 1 },
                      { op: "local.get", index: 6 },
                      { op: "f64.convert_i32_s" },
                      { op: "call", funcIdx: getIdxIdx },
                      { op: "call", funcIdx: sameValueIdx },
                      {
                        op: "if",
                        blockType: { kind: "empty" },
                        then: [
                          { op: "i32.const", value: 1 },
                          { op: "local.set", index: 8 },
                        ],
                      },
                      { op: "local.get", index: 6 },
                      { op: "i32.const", value: 1 },
                      { op: "i32.add" },
                      { op: "local.set", index: 6 },
                      { op: "br", depth: 0 },
                    ],
                  },
                ],
              },
              { op: "local.get", index: 8 },
              { op: "i32.eqz" },
              {
                op: "if",
                blockType: { kind: "empty" },
                then: [
                  // Step 22: a non-extensible target's key set must be reported in full.
                  { op: "local.get", index: 9 },
                  { op: "i32.eqz" },
                  ...throwIf(),
                  // Step 20: a non-configurable own key must be reported.
                  { op: "local.get", index: 0 },
                  { op: "local.get", index: 7 },
                  { op: "call", funcIdx: gopdIdx },
                  { op: "local.set", index: 10 },
                  ...isAbsent(10),
                  { op: "i32.eqz" },
                  {
                    op: "if",
                    blockType: { kind: "empty" },
                    then: [...truthyField(10, "configurable"), { op: "i32.eqz" }, ...throwIf()],
                  },
                ],
              },
              { op: "local.get", index: 5 },
              { op: "i32.const", value: 1 },
              { op: "i32.add" },
              { op: "local.set", index: 5 },
              { op: "br", depth: 0 },
            ],
          },
        ],
      },
      // Step 23: over a non-extensible target the trap may not INVENT keys.
      { op: "local.get", index: 9 },
      { op: "i32.eqz" },
      {
        op: "if",
        blockType: { kind: "empty" },
        then: [
          { op: "i32.const", value: 0 },
          { op: "local.set", index: 6 },
          {
            op: "block",
            blockType: { kind: "empty" },
            body: [
              {
                op: "loop",
                blockType: { kind: "empty" },
                body: [
                  { op: "local.get", index: 6 },
                  { op: "local.get", index: 4 },
                  { op: "i32.ge_s" },
                  { op: "br_if", depth: 1 },
                  { op: "local.get", index: 1 },
                  { op: "local.get", index: 6 },
                  { op: "f64.convert_i32_s" },
                  { op: "call", funcIdx: getIdxIdx },
                  { op: "local.set", index: 7 },
                  { op: "i32.const", value: 0 },
                  { op: "local.set", index: 8 },
                  { op: "i32.const", value: 0 },
                  { op: "local.set", index: 5 },
                  {
                    op: "block",
                    blockType: { kind: "empty" },
                    body: [
                      {
                        op: "loop",
                        blockType: { kind: "empty" },
                        body: [
                          { op: "local.get", index: 5 },
                          { op: "local.get", index: 3 },
                          { op: "i32.ge_s" },
                          { op: "br_if", depth: 1 },
                          { op: "local.get", index: 7 },
                          { op: "local.get", index: 2 },
                          { op: "local.get", index: 5 },
                          { op: "f64.convert_i32_s" },
                          { op: "call", funcIdx: getIdxIdx },
                          { op: "call", funcIdx: sameValueIdx },
                          {
                            op: "if",
                            blockType: { kind: "empty" },
                            then: [
                              { op: "i32.const", value: 1 },
                              { op: "local.set", index: 8 },
                            ],
                          },
                          { op: "local.get", index: 5 },
                          { op: "i32.const", value: 1 },
                          { op: "i32.add" },
                          { op: "local.set", index: 5 },
                          { op: "br", depth: 0 },
                        ],
                      },
                    ],
                  },
                  { op: "local.get", index: 8 },
                  { op: "i32.eqz" },
                  ...throwIf(),
                  { op: "local.get", index: 6 },
                  { op: "i32.const", value: 1 },
                  { op: "i32.add" },
                  { op: "local.set", index: 6 },
                  { op: "br", depth: 0 },
                ],
              },
            ],
          },
        ],
      },
      { op: "local.get", index: 1 },
    ],
  );

  return { gopd, define, has, get, set, deleteProperty, ownKeys };
}
