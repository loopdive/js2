/**
 * #2638 — standalone CLASS-instance → primitive (§7.1.1.1 OrdinaryToPrimitive)
 * for the runtime `__to_primitive` engine.
 *
 * ## Why a reserve/fill driver
 *
 * `__to_primitive` (object-runtime.ts) reduces a dynamic `$Object`
 * (`ref.test objectTypeIdx`) and, via #2358, a `$Vec` array. A **class
 * instance** is a distinct *nominal* WasmGC struct — neither `$Object` nor
 * `$Vec` — so both `ref.test`s miss and `__to_primitive` returns the struct
 * unchanged; the caller's `__unbox_number(struct)` → NaN (or a null string for
 * the string hint). That breaks `Number(new C() as any)`, `(new C() as any) - 8`,
 * etc. standalone, when the static class type has been erased to externref.
 *
 * The fix routes a class-instance struct through the EXISTING per-struct
 * `__call_valueOf` / `__call_toString` dispatchers (emitted by
 * `emitToPrimitiveMethodExports`, index.ts), honouring the §7.1.1.1 method
 * ordering by hint:
 *   - string hint:          toString → valueOf
 *   - number / default hint: valueOf → toString
 * Private dispatchers return `(matched, value)`: a real null/undefined result
 * remains distinct from no callable method. Public one-result exports retain
 * their existing ABI for host callers.
 * If both miss (a class with neither valueOf nor toString), the driver returns
 * the input unchanged — identical to today's "return unchanged" fall-through,
 * so no regression.
 *
 * ## Late-funcidx discipline (#2191 / #2043 hazard)
 *
 * `emitToPrimitiveMethodExports` runs at FINALIZE, AFTER `__to_primitive` is
 * built in `ensureObjectRuntime`. So `__to_primitive` cannot bake a `call` to
 * `__call_valueOf`/`__call_toString` directly (their funcIdxs don't exist yet
 * and any captured pre-shift idx would be wrong after the late import/type
 * shifts — the exact bug class root-caused in #2191 `7ae5c5df4`). Instead we
 * reserve a `__class_to_primitive` placeholder at `__to_primitive`-emit time
 * (so the `call` target is stable under the funcIdx-shift machinery), and fill
 * its body in post-processing (`fillClassToPrimitive`, AFTER
 * `emitToPrimitiveMethodExports`) once `__call_valueOf`/`__call_toString` are
 * registered. Same reserve/fill funcIdx-authority discipline as
 * `reserveArrayToPrimitiveString` / `reserveAccessorGetDriver`.
 */

import { ts } from "../ts-api.js";
import type { CodegenContext } from "./context/types.js";
import type { Instr, ValType, WasmFunction } from "../ir/types.js";
import { addFuncType } from "./registry/types.js";
import { undefinedSingletonActive } from "./any-helpers.js";
import { toPrimitivePresenceName } from "./to-primitive-dispatch-presence.js";
import { addStringConstantGlobal, ensureExnTag } from "./registry/imports.js";
import { stringConstantExternrefInstrs } from "./native-strings.js";
import { definedFuncAt, mintDefinedFunc, pushDefinedFunc } from "./func-space.js"; // (#1916 S2 read chokepoint / S3b stable-regime minting)
import { buildOrdinaryToPrimitiveProbe, resolveOrdinaryToPrimitiveProbeDeps } from "./ordinary-to-primitive-probe.js"; // (#4492 wave-5)
import { standaloneLinkBoundaryPeerIndex } from "./standalone-link-boundary.js"; // (#2917)

export const CLASS_TO_PRIMITIVE = "__class_to_primitive";

/**
 * Reserve the `__class_to_primitive(externref obj, i32 stringHint) -> externref`
 * placeholder and return its funcIdx. Body is a bare `unreachable` until
 * `fillClassToPrimitive` patches it (after `__call_valueOf`/`__call_toString`
 * are registered). Idempotent. Standalone only — the JS-host lane reduces class
 * instances via the host `_hostToPrimitive` OrdinaryToPrimitive loop, so this
 * driver is never reached there.
 */
export function reserveClassToPrimitive(ctx: CodegenContext): number {
  const existing = ctx.funcMap.get(CLASS_TO_PRIMITIVE);
  if (existing !== undefined) return existing;
  const sigIdx = addFuncType(
    ctx,
    [{ kind: "externref" }, { kind: "i32" }],
    [{ kind: "externref" }],
    "$class_to_primitive_type",
  );
  const funcIdx = mintDefinedFunc(ctx);
  const placeholder: WasmFunction = {
    name: CLASS_TO_PRIMITIVE,
    typeIdx: sigIdx,
    locals: [],
    // Placeholder; filled by fillClassToPrimitive in post-processing. The bare
    // `unreachable` keeps the stub valid (externref result) if the fill is ever
    // skipped (e.g. no nominal-struct dispatchers were emitted).
    body: [{ op: "unreachable" }],
    exported: false,
  };
  pushDefinedFunc(ctx, funcIdx, placeholder);
  ctx.funcMap.set(CLASS_TO_PRIMITIVE, funcIdx);
  ctx.classToPrimitiveReserved = true;
  return funcIdx;
}

/**
 * Fill after the nominal dispatchers are published. Presence is a separate
 * per-invocation result, not a sentinel value: null and canonical undefined
 * are primitive completions. Object results advance in hint order; misses
 * retain the existing prototype walk and unchanged-input fallback.
 */
export function fillClassToPrimitive(ctx: CodegenContext): void {
  if (!ctx.classToPrimitiveReserved) return;
  const driverIdx = ctx.funcMap.get(CLASS_TO_PRIMITIVE);
  if (driverIdx === undefined) return;
  const fn = definedFuncAt(ctx, driverIdx);
  if (!fn) return;

  const callValueOfIdx = ctx.funcMap.get(toPrimitivePresenceName("__call_valueOf"));
  const callToStringIdx = ctx.funcMap.get(toPrimitivePresenceName("__call_toString"));
  if (
    (callValueOfIdx === undefined && ctx.funcMap.has("__call_valueOf")) ||
    (callToStringIdx === undefined && ctx.funcMap.has("__call_toString"))
  )
    throw new Error("ToPrimitive dispatcher is missing its presence result");
  if (callValueOfIdx === undefined && callToStringIdx === undefined) {
    // A prototype override is not represented by a per-struct dispatcher, but
    // it is still observable through the runtime property chain. Keep the
    // ordinary-to-primitive walk active in this dispatcher-free module; it
    // will append its scratch locals when the runtime property helpers exist.
    // With no helpers, the walk is empty and this remains the old unchanged
    // fall-through.
    fn.locals = [
      { name: "rv", type: { kind: "externref" } },
      { name: "rs", type: { kind: "externref" } },
    ];
    const runtimeWalk = buildClassToPrimitiveRuntimeWalk(ctx, fn, exhaustiveWalkThrow(ctx));
    fn.body = [...runtimeWalk, { op: "local.get", index: 0 }];
    return;
  }

  const L_OBJ = 0; // externref param: the candidate class instance
  const L_HINT = 1; // i32 param: 1 = string hint, 0 = number/default
  const L_RV = 2; // externref: valueOf dispatcher result
  const L_RS = 3; // externref: toString dispatcher result

  const L_HAS_RV = 4;
  const L_HAS_RS = 5;

  // The same canonical carrier predicates as the dynamic $Object recipe.
  // No tag constants or layouts are duplicated; Symbol uses its actual type.
  const primitivePredicates = [
    "__typeof_number",
    "__typeof_boolean",
    "__typeof_string",
    "__typeof_undefined",
    "__typeof_bigint",
  ].flatMap((name) => {
    const index = ctx.funcMap.get(name);
    return index === undefined ? [] : [index];
  });
  const typeErrorCtorIdx = ctx.funcMap.get("__new_TypeError");

  // If the primitive-classification or TypeError machinery is unavailable for
  // some reason, retain the pre-#2891 first completed-method fallback so
  // we never emit invalid code (these are always present in the standalone
  // `__to_primitive` build that reserves this driver).
  if (!ctx.funcMap.has("__typeof_number") || !ctx.funcMap.has("__typeof_string") || typeErrorCtorIdx === undefined) {
    const tryDispatcher = (idx: number | undefined): Instr[] => {
      if (idx === undefined) return [];
      return [
        { op: "local.get", index: L_OBJ },
        { op: "call", funcIdx: idx },
        { op: "local.set", index: L_RV },
        // The remaining i32 is this invocation's matched result.
        {
          op: "if",
          blockType: { kind: "empty" },
          then: [{ op: "local.get", index: L_RV }, { op: "return" }],
        },
      ];
    };
    fn.locals = [{ name: "rv", type: { kind: "externref" } }];
    fn.body = [
      { op: "local.get", index: L_HINT },
      {
        op: "if",
        blockType: { kind: "empty" },
        then: [...tryDispatcher(callToStringIdx), ...tryDispatcher(callValueOfIdx)],
        else: [...tryDispatcher(callValueOfIdx), ...tryDispatcher(callToStringIdx)],
      },
      { op: "local.get", index: L_OBJ },
    ];
    return;
  }

  ensureExnTag(ctx);
  const OBJECT_TAG = "[object Object]";
  addStringConstantGlobal(ctx, OBJECT_TAG);
  addStringConstantGlobal(ctx, TYPE_ERR_MSG);

  // Null is primitive here; dispatcher presence is tested separately.
  const isPrimitive = (localIdx: number): Instr[] => [
    { op: "local.get", index: localIdx },
    { op: "ref.is_null" },
    ...primitivePredicates.flatMap((funcIdx): Instr[] => [
      { op: "local.get", index: localIdx },
      { op: "call", funcIdx },
      { op: "i32.or" },
    ]),
    ...(ctx.symbolTypeIdx < 0
      ? []
      : ([
          { op: "local.get", index: localIdx },
          { op: "any.convert_extern" },
          { op: "ref.test", typeIdx: ctx.symbolTypeIdx },
          { op: "i32.or" },
        ] satisfies Instr[])),
  ];

  const returnObjectTag = (): Instr[] => [...stringConstantExternrefInstrs(ctx, OBJECT_TAG), { op: "return" }];
  const throwTypeError = classToPrimitiveTypeError(ctx)!;

  // A matched call may return null, undefined, another primitive, or an object.
  // The separate local survives recursive conversions and never triggers a
  // second lookup/call merely to recover presence.
  const callAndReturnIfPrimitive = (idx: number | undefined, dst: number, present: number): Instr[] => {
    if (idx === undefined) {
      return [
        { op: "ref.null.extern" },
        { op: "local.set", index: dst },
        { op: "i32.const", value: 0 },
        { op: "local.set", index: present },
      ];
    }
    return [
      { op: "local.get", index: L_OBJ },
      { op: "call", funcIdx: idx },
      { op: "local.set", index: dst },
      { op: "local.set", index: present },
      { op: "local.get", index: present },
      {
        op: "if",
        blockType: { kind: "empty" },
        then: [
          ...isPrimitive(dst),
          {
            op: "if",
            blockType: { kind: "empty" },
            then: [{ op: "local.get", index: dst }, { op: "return" }],
          },
        ],
      },
    ];
  };
  const wasCalled = (localIdx: number): Instr[] => [{ op: "local.get", index: localIdx }];

  // number / default hint: valueOf → toString.
  const numberHint: Instr[] = [
    ...callAndReturnIfPrimitive(callValueOfIdx, L_RV, L_HAS_RV),
    ...callAndReturnIfPrimitive(callToStringIdx, L_RS, L_HAS_RS),
    // Neither own method produced a primitive. Classify by presence.
    ...wasCalled(L_HAS_RV), // valueOf present & object?
    {
      op: "if",
      blockType: { kind: "empty" },
      // valueOf present & object
      then: [
        ...wasCalled(L_HAS_RS), // toString present & object?
        {
          op: "if",
          blockType: { kind: "empty" },
          // both present-object → §7.1.1.1 TypeError
          then: throwTypeError(),
          // toString absent → inherited Object.prototype.toString → "[object Object]"
          else: returnObjectTag(),
        },
      ],
      // valueOf absent → inherited valueOf returns the object (non-primitive)
      else: [
        ...wasCalled(L_HAS_RS), // toString present & object?
        {
          op: "if",
          blockType: { kind: "empty" },
          // valueOf inherited-object + toString present-object → TypeError
          then: throwTypeError(),
          // both absent → fall through to the shared "return input unchanged" tail
          else: [],
        },
      ],
    },
  ];

  // string hint: toString → valueOf.
  //
  // (ES5 standalone lane) An ABSENT `toString` must NOT be answered here with
  // the inherited-`Object.prototype.toString` string "[object Object]". This
  // driver cannot tell "a class instance that happens to have no toString" from
  // "a value that is not a user object at all" — both miss every per-struct
  // dispatcher arm and land on this branch. And EVERY value that is neither a
  // `$Object` nor a `$Vec` reaches the driver: `undefined`, an `$AnyValue`
  // tagged box, a `$PropEntry` slot value, a RegExp match array, a boxed
  // primitive crossing the open-`any` boundary. Answering "[object Object]" for
  // those STOMPS a value the caller was about to render correctly, because
  // `__to_primitive` accepts the driver's primitive result and hands that
  // string on instead of the original carrier.
  //
  // That is an ACTION-AT-A-DISTANCE bug, not a local one: while a module emits
  // no `__call_toString` arm at all, `fillClassToPrimitive` leaves the
  // "return the input unchanged" stub and everything renders fine. The moment
  // any single struct in the module contributes one arm — one harness object
  // literal with a `toString` field is enough — this full body takes over and
  // every unrelated carrier in that module starts rendering "[object Object]".
  // Measured on the first full ES5 run after the callable-dynamic arm landed:
  // `"1" + undefined` → "1[object Object]", `undefined in obj` false,
  // `[0,"a"].join` → "[object Object], [object Object]", the
  // harness compare-array failure messages, the RegExp exec match arrays.
  // Two earlier fixes patched single carriers ($BoxedBoolean, $Error) with
  // early-outs in `__to_primitive`; this is the shared source of all of them.
  //
  // Returning the input UNCHANGED loses nothing for a real object: the two
  // callers both re-render it. `__any_to_string`'s terminal accepts only a
  // primitive from the driver and otherwise emits the same "[object Object]"
  // literal it emitted before, and `__to_primitive`'s class arm falls through
  // to its own "return unchanged" tail. So a genuine class instance with no
  // `toString` still stringifies to "[object Object]" — via the caller, which
  // knows whether the value is an object.
  //
  // The `numberHint` twin's `returnObjectTag` stays: it fires only when
  // `valueOf` MATCHED a dispatcher arm and returned an object, which proves the
  // receiver really is a user object this driver may describe.
  const stringHint: Instr[] = [
    ...callAndReturnIfPrimitive(callToStringIdx, L_RS, L_HAS_RS),
    ...wasCalled(L_HAS_RS),
    {
      op: "if",
      blockType: { kind: "empty" },
      // toString present & object → try valueOf next
      then: [
        ...callAndReturnIfPrimitive(callValueOfIdx, L_RV, L_HAS_RV),
        // valueOf absent (inherited → object) or present-object → both object → TypeError
        ...throwTypeError(),
      ],
      // toString absent → fall through to the shared "return input unchanged"
      // tail; the caller decides whether "[object Object]" is the right answer.
      else: [],
    },
  ];

  fn.locals = [
    { name: "rv", type: { kind: "externref" } },
    { name: "rs", type: { kind: "externref" } },
    { name: "has_rv", type: { kind: "i32" } },
    { name: "has_rs", type: { kind: "i32" } },
  ];

  const runtimeWalk = buildClassToPrimitiveRuntimeWalk(ctx, fn, exhaustiveWalkThrow(ctx));

  fn.body = [
    { op: "local.get", index: L_HINT },
    {
      op: "if",
      blockType: { kind: "empty" },
      then: stringHint,
      else: numberHint,
    },
    ...runtimeWalk,
    // Shared tail: reached only when BOTH methods are absent (number hint) —
    // a nominal struct with no valueOf/toString → return the input unchanged,
    // exactly as the pre-#2638 fall-through did (no regression).
    { op: "local.get", index: 0 },
  ];
}

const TYPE_ERR_MSG = "Cannot convert object to primitive value";

/**
 * (#6651 H1) Modules whose runtime walk must FINISH §7.1.1.1 (skip a
 * non-callable member, throw when nothing converts) instead of declining.
 *
 * Opt-in, and set only by a site that hands the runtime engine a value whose
 * members the compile-time dispatchers were never asked about — an
 * object-literal `String.prototype.*` argument (spec-arg-coercion.ts). The walk
 * is emitted into every standalone module that reserves this driver, and the
 * declining walk is what every other module was measured against; this keeps
 * their bytes identical rather than asking one slice to re-measure the corpus.
 */
const exhaustiveModules = new WeakSet<CodegenContext>();

export function requireExhaustiveClassToPrimitive(ctx: CodegenContext): void {
  exhaustiveModules.add(ctx);
}

/**
 * (#6771 S2d) The second opt-in: an object LITERAL whose `valueOf` / `toString`
 * member is written as a value that can never be callable (`null`, `undefined`,
 * `void 0`, a number / string / boolean / object / array literal). Its §7.1.1.1
 * answer hinges on step 2.b's IsCallable skip, which is exactly what the
 * declining walk cannot express: `{valueOf: null, toString: null}` must throw,
 * and the compile-time dispatchers see no method in either field, so the
 * driver returned the object UNCHANGED and ToNumber read NaN — `length` of such
 * an array-like was 0 instead of a TypeError
 * (`concat/Array.prototype.concat_array-like-to-length-throws.js`). Called from
 * the module pre-scan (array-holes.ts), so the driver is armed before it is
 * filled at finalize regardless of function compilation order. Answers whether
 * the module is armed (either opt-in) after looking at `node`.
 */
export function armExhaustiveForNonCallableMemberLiteral(ctx: CodegenContext, node: ts.Node): boolean {
  if (exhaustiveModules.has(ctx)) return true;
  if (!ctx.standalone || !ts.isPropertyAssignment(node) || !ts.isObjectLiteralExpression(node.parent)) return false;
  const name = node.name;
  const key = ts.isIdentifier(name) || ts.isStringLiteral(name) ? name.text : undefined;
  if (key !== "valueOf" && key !== "toString") return false;
  let init = node.initializer;
  while (ts.isParenthesizedExpression(init)) init = init.expression;
  const nonCallable =
    init.kind === ts.SyntaxKind.NullKeyword ||
    init.kind === ts.SyntaxKind.TrueKeyword ||
    init.kind === ts.SyntaxKind.FalseKeyword ||
    (ts.isIdentifier(init) && init.text === "undefined") ||
    ts.isVoidExpression(init) ||
    ts.isNumericLiteral(init) ||
    ts.isStringLiteralLike(init) ||
    ts.isObjectLiteralExpression(init) ||
    ts.isArrayLiteralExpression(init);
  if (nonCallable) requireExhaustiveClassToPrimitive(ctx);
  return nonCallable;
}

function exhaustiveWalkThrow(ctx: CodegenContext): (() => Instr[]) | undefined {
  return exhaustiveModules.has(ctx) ? classToPrimitiveTypeError(ctx) : undefined;
}

/**
 * The box for a `__call_valueOf`/`__call_toString` dispatcher's BRANDED i32
 * result in the same modules: `__box_symbol` / `__box_boolean`, where the
 * dispatchers box every i32 as a NUMBER. A `toString` returning `true` then
 * renders "1", and one returning a Symbol a digit instead of throwing — the
 * compile-time dispatch those modules' routed arguments no longer take read
 * the brand; this is the runtime twin. `undefined` → keep the number box.
 */
export function brandedI32ResultBoxIdx(ctx: CodegenContext, t: ValType | null | undefined): number | undefined {
  if (!exhaustiveModules.has(ctx) || !t || t.kind !== "i32") return undefined;
  if (t.symbol === true) return ctx.funcMap.get("__box_symbol");
  return t.boolean === true ? ctx.funcMap.get("__box_boolean") : undefined;
}

/**
 * §7.1.1.1 step 6's TypeError as a factory (fresh instructions per use), or
 * `undefined` without `__new_TypeError`. The tag and message constant register
 * on first USE, so a dispatcher-free driver whose runtime walk is empty
 * registers nothing new (#6651 H1).
 */
function classToPrimitiveTypeError(ctx: CodegenContext): (() => Instr[]) | undefined {
  const typeErrorCtorIdx = ctx.funcMap.get("__new_TypeError");
  if (typeErrorCtorIdx === undefined) return undefined;
  return () => {
    const exnTagIdx = ensureExnTag(ctx);
    addStringConstantGlobal(ctx, TYPE_ERR_MSG);
    return [
      ...stringConstantExternrefInstrs(ctx, TYPE_ERR_MSG),
      { op: "call", funcIdx: typeErrorCtorIdx },
      { op: "throw", tagIdx: exnTagIdx },
    ];
  };
}

/**
 * (#4492 wave-5) The RUNTIME §7.1.1.1 tail of `__class_to_primitive`, reached
 * only after every COMPILE-TIME dispatcher above it has missed.
 *
 * The per-struct `__call_valueOf` / `__call_toString` dispatchers are keyed by
 * struct TYPE, so they see a method only where the compiler could attach it to
 * the shape. The ES5 way to give an instance a `toString` is the PROTOTYPE —
 *
 *     function F(v){ this.value = v; }
 *     F.prototype.toString = function(){ return this.value + ""; };
 *
 * — and that write lands in the runtime prototype bag, where no dispatcher arm
 * can be minted for it. Measured on campaign HEAD `c42bdbe3e`
 * (`.tmp/probes/t3.js`, standalone): `new F(undefined).toString()` answered
 * `"undefined"` (the direct call resolves it statically) while
 * `String(new F(undefined))` and a borrowed `String.prototype.slice` on the same
 * receiver both answered `"[object Object]"` — one value, two renderings, and
 * the spelling a test reaches for is the one that was wrong.
 *
 * `__extern_get` walks own slots AND the prototype chain, so the shared walk
 * (ordinary-to-primitive-probe.ts) sees what the direct call sees. Placed at the
 * TAIL, it can only claim values this driver was about to return UNCHANGED — a
 * strictly-additive second chance, never a displacement.
 *
 * Appends the two scratch locals it needs to `fn.locals` (existing indices are
 * unaffected) and returns `[]` — emitting nothing, growing nothing — when the
 * walk's runtime natives are unavailable.
 */
function buildClassToPrimitiveRuntimeWalk(ctx: CodegenContext, fn: WasmFunction, onExhausted?: () => Instr[]): Instr[] {
  const probeDeps = resolveOrdinaryToPrimitiveProbeDeps(ctx);
  if (probeDeps === undefined) return [];
  const L_OBJ = 0;
  const L_HINT = 1;
  const L_PM = 2 + fn.locals.length; // externref: probe method slot
  const L_PR = L_PM + 1; // externref: probe result slot
  fn.locals.push({ name: "pm", type: { kind: "externref" } }, { name: "pr", type: { kind: "externref" } });

  // (#2917) A linked consumer hands a PROVIDER-owned instance's steps to the
  // provider (see `OrdinaryToPrimitiveProbeOpts.ownerCall`). Undefined — the
  // walk is byte-identical — in every module that consumes no provider.
  const ownsIdx = standaloneLinkBoundaryPeerIndex(ctx, "getPrototypeOf");
  const methodCallIdx = standaloneLinkBoundaryPeerIndex(ctx, "methodCall");
  const argsNewIdx = ctx.funcMap.get("__objvec_new");
  const ownerCall =
    ownsIdx !== undefined && methodCallIdx !== undefined && argsNewIdx !== undefined
      ? { ownsIdx, methodCallIdx, argsNewIdx }
      : undefined;

  const walk = (order: readonly ("toString" | "valueOf")[]): Instr[] =>
    buildOrdinaryToPrimitiveProbe(ctx, probeDeps, {
      recv: () => [{ op: "local.get", index: L_OBJ }],
      methodLocal: L_PM,
      resultLocal: L_PR,
      order,
      onPrimitive: () => [{ op: "local.get", index: L_PR }, { op: "return" }],
      // §7.1.1.1: only the STRING hint may stop on an absent first method — an
      // absent `toString` resolves to `Object.prototype.toString`, which returns
      // a primitive, so `valueOf` is unreachable. `built-ins/String/S9.8_A5_T1`
      // check #13 measures exactly that.
      stopWhenFirstAbsent: order[0] === "toString",
      ownerCall,
      onExhausted,
      nullResultIsPrimitive: onExhausted !== undefined && undefinedSingletonActive(ctx),
    });

  // The same object/function guard `emitAddOrdinaryToPrimitiveResidue` uses:
  // this driver is also reached by `undefined`, `$AnyValue` boxes, `$PropEntry`
  // slot values and boxed primitives (see the string-hint note above), and none
  // of those may be sent through a property read.
  return [
    { op: "local.get", index: L_OBJ },
    { op: "ref.is_null" },
    { op: "i32.eqz" },
    {
      op: "if",
      blockType: { kind: "empty" },
      then: [
        { op: "local.get", index: L_OBJ },
        { op: "call", funcIdx: probeDeps.typeofObjectIdx },
        { op: "local.get", index: L_OBJ },
        { op: "call", funcIdx: probeDeps.typeofFunctionIdx },
        { op: "i32.or" },
        {
          op: "if",
          blockType: { kind: "empty" },
          then: [
            { op: "local.get", index: L_HINT },
            {
              op: "if",
              blockType: { kind: "empty" },
              then: walk(["toString", "valueOf"]),
              else: walk(["valueOf", "toString"]),
            },
          ],
        },
      ],
    },
  ];
}
