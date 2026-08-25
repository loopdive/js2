// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * #3983 — the standalone STRICT [[Set]] helper, `__extern_set_strict`.
 *
 * ## What was wrong
 *
 * `ensureObjectRuntime` used to register this name as a bare `ctx.funcMap`
 * alias of `__extern_set`:
 *
 * ```ts
 * ctx.funcMap.set("__extern_set_strict", externSetIdx);   // #2017 .. #3983
 * ```
 *
 * Every refusal inside `__extern_set` is a silent `return` — correct SLOPPY
 * behaviour. So under `--target standalone` every strict-mode write that
 * ECMA-262 §6.2.5.6 (PutValue) steps 3.d–e require to throw a TypeError did
 * nothing at all instead:
 *
 *   - assignment to an own accessor whose `set` is `undefined` (§10.1.5.3)
 *   - assignment to an own data property with `writable: false`
 *   - any data write to a frozen object
 *   - a NEW key on a non-extensible object
 *
 * The front end was never the problem. `member-set-dispatch.ts` and
 * `compilePropertyAssignmentExternSet` (`expressions/assignment.ts`) already
 * choose between `__extern_set_strict` and `__extern_set` from
 * `isStrictContext`, which correctly honours the test262 harness's
 * `inferModuleStrict=false` for sloppy (`[noStrict]`) script tests. Both names
 * simply resolved to the same silent function. JS-host/gc mode has always
 * carried the spec-correct catchable TypeError through the sidecar; only
 * standalone was open.
 *
 * ## Why it is layered over `__reflect_set` rather than re-deriving the flags
 *
 * `__reflect_set` already computes exactly the [[Set]] boolean this needs, over
 * the same `$PropEntry` flag bits, and delegates a *permitted* write back to
 * `__extern_set` — so an allowed write still runs the accessor driver / insert
 * path exactly once, not twice. A second copy of the predicate here would be a
 * second thing to keep in sync with descriptor semantics.
 *
 * ## Why the non-`$Object` receiver short-circuit is load-bearing
 *
 * `__reflect_set` answers **false** for any receiver that is not a `$Object`:
 * arrays (`$Vec`), closures, native strings, `$Proxy` and genuine host
 * externrefs all take that arm. Those writes are legal — `__extern_set` routes
 * them into the #3468 closure / #3537 vec expando side tables. Throwing on
 * `__reflect_set === 0` unconditionally would turn `"use strict"; a[0] = 1` on
 * an array into a TypeError. The receiver test is therefore required, not
 * defensive.
 *
 * There is in-tree precedent for the shape: `ensureDynMemberSet`
 * (`dyn-read.ts`) already does `__reflect_set` + throw-on-false for the
 * standalone/wasi *dynamic* member-set path. This applies the same rule to the
 * static-name path, which is where the test262 shapes live.
 *
 * ## Deliberately NOT handled here
 *
 * A non-writable data property inherited from the PROTOTYPE. `__obj_find` walks
 * the own table only, so `__reflect_set` returns true and the write lands as a
 * new own property. That is pre-existing behaviour and is unchanged by this
 * module — closing it needs a proto-chain walk inside `__reflect_set`, which
 * risks the ordinary shadowing write, so it is scoped separately.
 */
import type { Instr, ValType } from "../ir/types.js";
import type { CodegenContext } from "./context/types.js";
import { stringConstantExternrefInstrs } from "./native-strings.js";
import { emitWasiErrorConstructor } from "./registry/error-types.js";
import { addStringConstantGlobal, ensureExnTag } from "./registry/imports.js";

/** What this builder needs from the enclosing `ensureObjectRuntime` scope. */
export interface StrictSetHelperState {
  /** The defined-func minter from `ensureObjectRuntime` (captures `ctx`). */
  registerNative: (
    name: string,
    paramTypes: ValType[],
    resultTypes: ValType[],
    locals: { name: string; type: ValType }[],
    body: Instr[],
  ) => number;
  /** `$Object` struct type index — the receiver discriminator. */
  objectTypeIdx: number;
  /** #4504's completed-set result channel, absent in flag-clear modules. */
  externSetResultGlobalIdx?: number;
}

/**
 * Register `__extern_set_strict(externref obj, externref key, externref value)`.
 *
 * MUST be called after both `__extern_set` and `__reflect_set` are registered:
 * the emitted body bakes their funcIdx values directly.
 *
 * ```
 * if (!ref.test $Object)        -> __extern_set(o, k, v); return   // no throw
 * if (__reflect_set(o,k,v) == 0) -> throw new TypeError(...)
 * ```
 */
export function buildStrictSetHelper(ctx: CodegenContext, s: StrictSetHelperState): void {
  const externSetIdx = ctx.funcMap.get("__extern_set");
  const reflectSetIdx = ctx.funcMap.get("__reflect_set");
  if (externSetIdx === undefined || reflectSetIdx === undefined) return;

  emitWasiErrorConstructor(ctx, "TypeError", 1);
  const typeErrorCtorIdx = ctx.funcMap.get("__new_TypeError");
  if (typeErrorCtorIdx === undefined) return;
  const exnTagIdx = ensureExnTag(ctx);
  const message = "TypeError: Cannot assign to read only property";
  addStringConstantGlobal(ctx, message);

  // params: 0=obj 1=key 2=value
  const legacyBody: Instr[] = [
    // Non-$Object receiver → the ordinary (side-table aware) write, no throw.
    { op: "local.get", index: 0 },
    { op: "any.convert_extern" },
    { op: "ref.test", typeIdx: s.objectTypeIdx },
    { op: "i32.eqz" },
    {
      op: "if",
      blockType: { kind: "empty" },
      then: [
        { op: "local.get", index: 0 },
        { op: "local.get", index: 1 },
        { op: "local.get", index: 2 },
        { op: "call", funcIdx: externSetIdx },
        { op: "return" },
      ],
    },
    // $Object receiver: perform the write and observe the [[Set]] boolean.
    { op: "local.get", index: 0 },
    { op: "local.get", index: 1 },
    { op: "local.get", index: 2 },
    { op: "call", funcIdx: reflectSetIdx },
    { op: "i32.eqz" },
    {
      op: "if",
      blockType: { kind: "empty" },
      then: [
        ...stringConstantExternrefInstrs(ctx, message),
        { op: "call", funcIdx: typeErrorCtorIdx },
        { op: "throw", tagIdx: exnTagIdx },
      ],
    },
  ];
  const body: Instr[] =
    s.externSetResultGlobalIdx === undefined
      ? legacyBody
      : [
          // `__reflect_set` performs one write and leaves the detailed outcome
          // behind it.  Its public result remains boolean; strict assignment
          // reads the adjacent tri-state so an unadmitted host boundary stays
          // lenient while a real refusal throws catchably.
          // A finalize-prepended specialised Reflect arm (for example the
          // dynamic TypedArray lane) can return before `__reflect_set` reaches
          // its core reset. Clear the channel here as well so a prior refusal
          // cannot poison that unadmitted strict write.
          { op: "i32.const", value: 0 }, // SET_RESULT_UNADMITTED
          { op: "global.set", index: s.externSetResultGlobalIdx },
          { op: "local.get", index: 0 },
          { op: "local.get", index: 1 },
          { op: "local.get", index: 2 },
          { op: "call", funcIdx: reflectSetIdx },
          { op: "drop" },
          { op: "global.get", index: s.externSetResultGlobalIdx },
          { op: "i32.const", value: 2 }, // SET_RESULT_REFUSED
          { op: "i32.eq" },
          {
            op: "if",
            blockType: { kind: "empty" },
            then: [
              ...stringConstantExternrefInstrs(ctx, message),
              { op: "call", funcIdx: typeErrorCtorIdx },
              { op: "throw", tagIdx: exnTagIdx },
            ],
          },
        ];

  s.registerNative(
    "__extern_set_strict",
    [{ kind: "externref" }, { kind: "externref" }, { kind: "externref" }],
    [],
    [],
    body,
  );
}
