// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * (#4394) Make the builtin PRIMITIVE-WRAPPER constructor carriers callable
 * through the dynamic-call bridge — the standalone `String`-as-a-callback fix.
 *
 * The bare identifiers `String` / `Number` / `Boolean` resolve (standalone) to
 * the identity-stable `__builtin_ctor_<Name>` `$Object` singletons
 * (builtin-static-globals.ts, #3006/#4223). That identity is load-bearing:
 * `new String(NaN).constructor === String` compares against the SAME object.
 * #4394 records the reverted shortcut — substituting a conversion CLOSURE for
 * the bare value fixed `Array.prototype.map.call(arrayLike, String)` but broke
 * the identity (S15.5.2.1_A1_T5..T7), 3 regressions for 1 gain.
 *
 * The correct shape, recorded there: keep the carrier's single identity and
 * make CALLING it perform the spec's no-`new` conversion (§22.1.1.1 String(x) =
 * ToString(x) / "" for no args; §21.1.1.1 Number(x) = ToNumber(x) / +0;
 * §20.3.1.1 Boolean(x) = ToBoolean(x)). Every dynamic invocation — a HOF
 * callback (`__hof_map` → `__apply_closure`), `fn.call(...)` through
 * `__extern_method_call`, an accessor driver — funnels through
 * `__apply_closure`, so ONE front-guard arm there covers them all: when the
 * callee is identity-equal (`ref.eq`) to a materialized carrier singleton,
 * dispatch to the native conversion instead of falling into the closure-cast
 * ladder (where a `$Object` matches nothing and the bridge answers the
 * undefined sentinel — the `[null, null, null]` of the compare-array harness
 * self-tests).
 *
 * Identity, not brand: the arm compares the callee against the carrier GLOBAL
 * (`ref.eq` on the cast `$Object`s), so a plain user object — or a DIFFERENT
 * builtin's carrier — can never match. A carrier that was never demanded has a
 * null global and its arm short-circuits; a module with no wrapper-ctor value
 * read emits no arm at all (byte-identical).
 *
 * Emitted at FINALIZE from `fillApplyClosure` (the guard splices into the
 * bridge body like the $Proxy / $__bound_fn guards). Everything it calls
 * (`__extern_length`, `__extern_toString`, `__unbox_number`/`__box_number`,
 * `__is_truthy`/`__box_boolean`) is already registered by the object runtime /
 * union helpers, and the ""-literal global mint is index-shift-free (globals
 * never shift funcIdxs).
 */

import type { Instr, ValType } from "../ir/types.js";
import type { CodegenContext } from "./context/types.js";
import { runtimeToNumberInstrs } from "./coercion-engine.js";
import { nativeStringLiteralInstrs } from "./native-string-literals.js";
import { addUnionImportsViaRegistry } from "./shared.js";

type CallableArmLocals = { name: string; type: { kind: "f64" } | { kind: "externref" } };

/**
 * Build the `[[Call]]` arms for the identity-stable Object and Array
 * constructor carriers. The Array constructor callback is supplied by the
 * object-runtime owner to keep this subsystem independent of that god-file.
 */
export function builtinObjectArrayCallableArmInstrs(
  ctx: CodegenContext,
  argOf: (k: number) => Instr[],
  arrayConstructor: (ctx: CodegenContext, argCount: number) => number | undefined,
  localBaseIndex: number,
): { instrs: Instr[]; locals: CallableArmLocals[] } {
  if (!ctx.standalone) return { instrs: [], locals: [] };
  const objectTypeIdx = ctx.objectRuntimeTypes?.objectTypeIdx;
  const externLengthIdx = ctx.funcMap.get("__extern_length");
  const newPlainObjectIdx = ctx.funcMap.get("__new_plain_object");
  const arrayGlobalIdx = ctx.builtinObjectGlobals.get("Array");
  const objectGlobalIdx = ctx.builtinObjectGlobals.get("Object");
  if (
    objectTypeIdx === undefined ||
    externLengthIdx === undefined ||
    newPlainObjectIdx === undefined ||
    (arrayGlobalIdx === undefined && objectGlobalIdx === undefined)
  ) {
    return { instrs: [], locals: [] };
  }

  const argCountLocal = 3 + localBaseIndex;
  const argLocal = argCountLocal + 1;
  const locals: CallableArmLocals[] = [
    { name: "builtinCtorArgCount", type: { kind: "f64" } },
    { name: "builtinCtorArg", type: { kind: "externref" } },
  ];
  const identityArm = (globalIdx: number, result: Instr[]): Instr[] => [
    { op: "global.get", index: globalIdx },
    { op: "ref.is_null" },
    { op: "i32.eqz" },
    {
      op: "if",
      blockType: { kind: "empty" },
      then: [
        { op: "local.get", index: 0 },
        { op: "any.convert_extern" },
        { op: "ref.test", typeIdx: objectTypeIdx },
        {
          op: "if",
          blockType: { kind: "empty" },
          then: [
            { op: "local.get", index: 0 },
            { op: "any.convert_extern" },
            { op: "ref.cast", typeIdx: objectTypeIdx },
            { op: "global.get", index: globalIdx },
            { op: "any.convert_extern" },
            { op: "ref.cast", typeIdx: objectTypeIdx },
            { op: "ref.eq" },
            { op: "if", blockType: { kind: "empty" }, then: result },
          ],
        },
      ],
    },
  ];

  const undefinedIdx = ctx.funcMap.get("__extern_is_undefined");
  const undefinedCheck: Instr[] =
    undefinedIdx === undefined
      ? []
      : [{ op: "local.get", index: argLocal }, { op: "call", funcIdx: undefinedIdx }, { op: "i32.or" }];
  const objectElse: Instr[] = [
    ...argOf(0),
    { op: "local.set", index: argLocal },
    { op: "local.get", index: argLocal },
    { op: "ref.is_null" },
    ...undefinedCheck,
    {
      op: "if",
      blockType: { kind: "val", type: { kind: "externref" } },
      then: [{ op: "call", funcIdx: newPlainObjectIdx }],
      else: (() => {
        addUnionImportsViaRegistry(ctx);
        const numberType = ctx.funcMap.get("__typeof_number");
        const stringType = ctx.funcMap.get("__typeof_string");
        const booleanType = ctx.funcMap.get("__typeof_boolean");
        const unboxNumber = runtimeToNumberInstrs(ctx);
        const newNumber = ctx.funcMap.get("__new_Number");
        const newString = ctx.funcMap.get("__new_String");
        const newBoolean = ctx.funcMap.get("__new_Boolean");
        let value: Instr[] = [{ op: "local.get", index: argLocal }];
        if (booleanType !== undefined && unboxNumber !== null && newBoolean !== undefined) {
          value = [
            { op: "local.get", index: argLocal },
            { op: "call", funcIdx: booleanType },
            {
              op: "if",
              blockType: { kind: "val", type: { kind: "externref" } },
              then: [{ op: "local.get", index: argLocal }, ...unboxNumber, { op: "call", funcIdx: newBoolean }],
              else: value,
            },
          ];
        }
        if (stringType !== undefined && newString !== undefined) {
          value = [
            { op: "local.get", index: argLocal },
            { op: "call", funcIdx: stringType },
            {
              op: "if",
              blockType: { kind: "val", type: { kind: "externref" } },
              then: [
                { op: "local.get", index: argLocal },
                { op: "call", funcIdx: newString },
              ],
              else: value,
            },
          ];
        }
        if (numberType !== undefined && unboxNumber !== null && newNumber !== undefined) {
          value = [
            { op: "local.get", index: argLocal },
            { op: "call", funcIdx: numberType },
            {
              op: "if",
              blockType: { kind: "val", type: { kind: "externref" } },
              then: [{ op: "local.get", index: argLocal }, ...unboxNumber, { op: "call", funcIdx: newNumber }],
              else: value,
            },
          ];
        }
        return value;
      })(),
    },
  ];
  const objectCall: Instr[] = [
    { op: "local.get", index: 2 },
    { op: "call", funcIdx: externLengthIdx },
    { op: "local.set", index: argCountLocal },
    { op: "local.get", index: argCountLocal },
    { op: "f64.const", value: 0 },
    { op: "f64.eq" },
    {
      op: "if",
      blockType: { kind: "val", type: { kind: "externref" } },
      then: [{ op: "call", funcIdx: newPlainObjectIdx }],
      else: objectElse,
    },
    { op: "return" },
  ];

  const instrs: Instr[] = [];
  if (objectGlobalIdx !== undefined) instrs.push(...identityArm(objectGlobalIdx, objectCall));
  if (arrayGlobalIdx !== undefined) {
    let dispatch: Instr[] = [];
    for (let n = 8; n >= 0; n--) {
      const ctorIdx = arrayConstructor(ctx, n);
      if (ctorIdx === undefined) continue;
      const call: Instr[] = [];
      for (let k = 0; k < n; k++) call.push(...argOf(k));
      call.push({ op: "call", funcIdx: ctorIdx }, { op: "return" });
      dispatch = [
        { op: "local.get", index: argCountLocal },
        { op: "f64.const", value: n },
        { op: "f64.eq" },
        { op: "if", blockType: { kind: "empty" }, then: call, else: dispatch },
      ];
    }
    instrs.push(
      ...identityArm(arrayGlobalIdx, [
        { op: "local.get", index: 2 },
        { op: "call", funcIdx: externLengthIdx },
        { op: "local.set", index: argCountLocal },
        ...dispatch,
      ]),
    );
  }
  return { instrs, locals };
}

/** Append Object/Array carrier locals and return their front-guard arms. */
export function appendBuiltinObjectArrayCallableArms(
  ctx: CodegenContext,
  argOf: (k: number) => Instr[],
  arrayConstructor: (ctx: CodegenContext, argCount: number) => number | undefined,
  locals: Array<{ name: string; type: ValType }>,
): Instr[] {
  const arm = builtinObjectArrayCallableArmInstrs(ctx, argOf, arrayConstructor, locals.length);
  locals.push(...arm.locals);
  return arm.instrs;
}

/**
 * Build the identity-gated constructor arms for `__bind_dyn`. Constructor
 * carriers are `$Object` values, so they must enter the bound-function
 * carrier path before the ordinary closure classifier runs.
 */
export function builtinConstructorBindArmInstrs(ctx: CodegenContext, anyLocal: number, mintArm: Instr[]): Instr[] {
  const objectTypeIdx = ctx.objectRuntimeTypes?.objectTypeIdx;
  if (objectTypeIdx === undefined) return [];
  const instrs: Instr[] = [];
  for (const [key, globalIdx] of ctx.builtinObjectGlobals) {
    if (key !== "Object" && key !== "Array" && !key.startsWith("ctor:")) continue;
    instrs.push(
      { op: "local.get", index: anyLocal },
      { op: "ref.test", typeIdx: objectTypeIdx },
      {
        op: "if",
        blockType: { kind: "empty" },
        then: [
          { op: "global.get", index: globalIdx },
          { op: "ref.is_null" },
          { op: "i32.eqz" },
          {
            op: "if",
            blockType: { kind: "empty" },
            then: [
              { op: "local.get", index: 0 },
              { op: "any.convert_extern" },
              { op: "ref.cast", typeIdx: objectTypeIdx },
              { op: "global.get", index: globalIdx },
              { op: "any.convert_extern" },
              { op: "ref.cast", typeIdx: objectTypeIdx },
              { op: "ref.eq" },
              { op: "if", blockType: { kind: "empty" }, then: [...mintArm] },
            ],
          },
        ],
      },
    );
  }
  return instrs;
}

/** The wrapper builtins whose carrier gets a callable arm. Must stay a subset
 *  of `BUILTIN_CONSTRUCTOR_IDENTITY_NAMES` (builtin-static-globals.ts). */
const CALLABLE_WRAPPER_CTORS = ["String", "Number", "Boolean"] as const;

/**
 * Build the `[[Call]]` front-guard arm(s) for the wrapper-constructor carriers.
 *
 * `__apply_closure(externref fn = param 0, externref recv = param 1, externref
 * args = param 2) -> externref`. `argOf(k)` is the caller's ARG_OF builder (null-safe
 * before the fast-carrier locals initialize). Returns `[]` when no carrier was
 * demanded or a structural prerequisite is missing, so the caller can splice
 * unconditionally.
 */
export function builtinCtorCallableArmInstrs(ctx: CodegenContext, argOf: (k: number) => Instr[]): Instr[] {
  if (!ctx.standalone) return [];
  const objectTypeIdx = ctx.objectRuntimeTypes?.objectTypeIdx;
  const externLengthIdx = ctx.funcMap.get("__extern_length");
  if (objectTypeIdx === undefined || externLengthIdx === undefined) return [];

  const toStringIdx = ctx.funcMap.get("__extern_toString");
  const unboxNumberIdx = ctx.funcMap.get("__unbox_number");
  const boxNumberIdx = ctx.funcMap.get("__box_number");
  const isTruthyIdx = ctx.funcMap.get("__is_truthy");
  const boxBooleanIdx = ctx.funcMap.get("__box_boolean");

  /** `__extern_length(args) < 1` — i32 on the stack. */
  const zeroArgTest = (): Instr[] => [
    { op: "local.get", index: 2 },
    { op: "call", funcIdx: externLengthIdx },
    { op: "f64.const", value: 1 },
    { op: "f64.lt" },
  ];

  /** ToString/ToNumber/ToBoolean of `argOf(0)`, or the zero-arg constant. Each
   *  leaves one externref. Returns undefined when the natives are missing (the
   *  arm for that builtin is then skipped — the legacy sentinel answer stays). */
  const conversionOf = (name: (typeof CALLABLE_WRAPPER_CTORS)[number]): Instr[] | undefined => {
    switch (name) {
      case "String": {
        if (toStringIdx === undefined) return undefined;
        // String() = "" (§22.1.1.1 step 1.a); String(x) = ToString(x). The
        // symbol-descriptive-string special case rides inside the shared
        // `__extern_toString` boundary to whatever extent the symbol carrier
        // supports it (#2610 owns the rest).
        return [
          ...zeroArgTest(),
          {
            op: "if",
            blockType: { kind: "val", type: { kind: "externref" } },
            then: [...nativeStringLiteralInstrs(ctx, ""), { op: "extern.convert_any" }],
            else: [...argOf(0), { op: "call", funcIdx: toStringIdx }],
          },
        ];
      }
      case "Number": {
        if (unboxNumberIdx === undefined || boxNumberIdx === undefined) return undefined;
        // Number() = +0; Number(x) = ToNumber(x) (`__unbox_number` is the shared
        // standalone ToNumber boundary).
        return [
          ...zeroArgTest(),
          {
            op: "if",
            blockType: { kind: "val", type: { kind: "f64" } },
            then: [{ op: "f64.const", value: 0 }],
            else: [...argOf(0), { op: "call", funcIdx: unboxNumberIdx }],
          },
          { op: "call", funcIdx: boxNumberIdx },
        ];
      }
      case "Boolean": {
        if (isTruthyIdx === undefined || boxBooleanIdx === undefined) return undefined;
        // Boolean() = false; Boolean(x) = ToBoolean(x) (`__is_truthy`).
        return [
          ...zeroArgTest(),
          {
            op: "if",
            blockType: { kind: "val", type: { kind: "i32" } },
            then: [{ op: "i32.const", value: 0 }],
            else: [...argOf(0), { op: "call", funcIdx: isTruthyIdx }],
          },
          { op: "call", funcIdx: boxBooleanIdx },
        ];
      }
    }
  };

  const instrs: Instr[] = [];
  for (const name of CALLABLE_WRAPPER_CTORS) {
    const globalIdx = ctx.builtinObjectGlobals.get(`ctor:${name}`);
    if (globalIdx === undefined) continue; // carrier never demanded
    const conversion = conversionOf(name);
    if (conversion === undefined) continue;
    instrs.push(
      // Arm only live once the carrier singleton materialized (first read).
      { op: "global.get", index: globalIdx },
      { op: "ref.is_null" },
      { op: "i32.eqz" },
      {
        op: "if",
        blockType: { kind: "empty" },
        then: [
          { op: "local.get", index: 0 },
          { op: "any.convert_extern" },
          { op: "ref.test", typeIdx: objectTypeIdx },
          {
            op: "if",
            blockType: { kind: "empty" },
            then: [
              { op: "local.get", index: 0 },
              { op: "any.convert_extern" },
              { op: "ref.cast", typeIdx: objectTypeIdx },
              { op: "global.get", index: globalIdx },
              { op: "any.convert_extern" },
              { op: "ref.cast", typeIdx: objectTypeIdx },
              { op: "ref.eq" },
              {
                op: "if",
                blockType: { kind: "empty" },
                then: [...conversion, { op: "return" }],
              },
            ],
          },
        ],
      },
    );
  }
  return instrs;
}
