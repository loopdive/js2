// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * (#6944) A `[[Prototype]]` link that is itself a function-constructor INSTANCE.
 *
 * The pre-ES6 inheritance idiom stores a `new F()` result as another
 * constructor's prototype:
 *
 *   function Inheriter() {}
 *   Inheriter.prototype.hello = function () { … };
 *   function Derived() {}
 *   Derived.prototype = new Inheriter();   // a `$__fnctor_Inheriter` STRUCT
 *
 * Under `--target standalone` the per-fnctor prototype global of `Derived` then
 * holds a native `__fnctor_Inheriter` struct, not an `$Object`, and every
 * inherited-property walker started at `__fnctor_proto_start` and REQUIRED an
 * `$Object` — so `new Derived().hello` read `undefined` (and the per-key method
 * caches, which `ref.cast` the link to `$Object`, trapped `illegal cast`).
 *
 * §10.1.8.1 OrdinaryGet step 3 answers a miss with `parent.[[Get]](P, Receiver)`
 * and §10.1.7.1 OrdinaryHasProperty with `parent.[[HasProperty]](P)` — whatever
 * the parent's representation. So the walkers here do exactly that: when the
 * link is such a struct they re-enter the full `__extern_get` (through
 * `__reflect_get_receiver`, so an accessor found further up still receives the
 * ORIGINAL receiver as `this`) or `__extern_has` on it. The struct's own fields,
 * its expando bag and its own ctor's prototype are then resolved by the same
 * code that resolves them for a direct read.
 *
 * Termination: a struct link always leads to its OWN constructor's per-name
 * prototype global, so a chain of struct links that revisits a constructor is a
 * cycle (#6945's aliasing produces one). `__fnctor_struct_proto_ok` walks the
 * links up front — pure, no side effects — and declines a chain that has not
 * reached an `$Object` or a dead end within `MAX_STRUCT_HOPS`, so the
 * re-entry depth is bounded too; a declined link keeps the pre-#6944 answer
 * (the walk ends: `undefined` / absent).
 */
import type { FuncHandle, Instr, ValType } from "../ir/types.js";
import type { CodegenContext } from "./context/types.js";
import { definedFuncAt } from "./func-space.js";

const MAX_STRUCT_HOPS = 16;

type RegisterNative = (
  name: string,
  paramTypes: ValType[],
  resultTypes: ValType[],
  locals: { name: string; type: ValType }[],
  body: Instr[],
) => number;

/** Function indices of the three helpers; forwarder bodies are filled later. */
export interface FnctorStructProtoHelpers {
  /** `(link) -> i32`: the link is a fnctor struct whose struct chain terminates. */
  readonly ok: FuncHandle;
  /** `(link, key, receiver) -> externref`: `link.[[Get]](key, receiver)`. */
  readonly get: FuncHandle;
  /** `(link, key) -> i32`: `link.[[HasProperty]](key)`. */
  readonly has: FuncHandle;
}

/**
 * Reserve the helpers BEFORE `__extern_get`/`__extern_has` bake their calls.
 * The predicate is complete at once (it needs only the proto-start ladder,
 * itself filled at finalize); the forwarders are filled by
 * {@link fillFnctorStructProtoForwarders} once their targets exist.
 */
export function reserveFnctorStructProtoHelpers(
  registerNative: RegisterNative,
  protoStartIdx: FuncHandle,
  objectTypeIdx: number,
): FnctorStructProtoHelpers {
  const ok = registerNative(
    "__fnctor_struct_proto_ok",
    [{ kind: "externref" }],
    [{ kind: "i32" }],
    [
      { name: "cur", type: { kind: "externref" } },
      { name: "hops", type: { kind: "i32" } },
    ],
    [
      // An `$Object` link is walked by the caller's own loop.
      { op: "local.get", index: 0 },
      { op: "any.convert_extern" },
      { op: "ref.test", typeIdx: objectTypeIdx },
      { op: "if", blockType: { kind: "empty" }, then: [{ op: "i32.const", value: 0 }, { op: "return" }] },
      // Not a fnctor struct (or one without a prototype): nothing to re-enter.
      { op: "local.get", index: 0 },
      { op: "call", funcIdx: protoStartIdx },
      { op: "ref.is_null" },
      { op: "if", blockType: { kind: "empty" }, then: [{ op: "i32.const", value: 0 }, { op: "return" }] },
      { op: "local.get", index: 0 },
      { op: "local.set", index: 1 },
      {
        op: "block",
        blockType: { kind: "empty" },
        body: [
          {
            op: "loop",
            blockType: { kind: "empty" },
            body: [
              { op: "local.get", index: 1 },
              { op: "call", funcIdx: protoStartIdx },
              { op: "local.tee", index: 1 },
              { op: "ref.is_null" },
              { op: "br_if", depth: 1 },
              { op: "local.get", index: 1 },
              { op: "any.convert_extern" },
              { op: "ref.test", typeIdx: objectTypeIdx },
              { op: "br_if", depth: 1 },
              { op: "local.get", index: 2 },
              { op: "i32.const", value: 1 },
              { op: "i32.add" },
              { op: "local.tee", index: 2 },
              { op: "i32.const", value: MAX_STRUCT_HOPS },
              { op: "i32.ge_u" },
              { op: "if", blockType: { kind: "empty" }, then: [{ op: "i32.const", value: 0 }, { op: "return" }] },
              { op: "br", depth: 0 },
            ],
          },
        ],
      },
      { op: "i32.const", value: 1 },
    ],
  );
  const get = registerNative(
    "__fnctor_struct_proto_get",
    [{ kind: "externref" }, { kind: "externref" }, { kind: "externref" }],
    [{ kind: "externref" }],
    [],
    [{ op: "ref.null.extern" }],
  );
  const has = registerNative(
    "__fnctor_struct_proto_has",
    [{ kind: "externref" }, { kind: "externref" }],
    [{ kind: "i32" }],
    [],
    [{ op: "i32.const", value: 0 }],
  );
  return { ok, get, has };
}

/** Fill the forwarders once `__reflect_get_receiver` and `__extern_has` exist. */
export function fillFnctorStructProtoForwarders(
  ctx: CodegenContext,
  helpers: FnctorStructProtoHelpers,
  reflectGetReceiverIdx: FuncHandle,
  externHasIdx: FuncHandle,
): void {
  const getFn = definedFuncAt(ctx, helpers.get);
  if (getFn) {
    getFn.body = [
      { op: "local.get", index: 0 },
      { op: "local.get", index: 1 },
      { op: "local.get", index: 2 },
      { op: "call", funcIdx: reflectGetReceiverIdx },
    ];
  }
  const hasFn = definedFuncAt(ctx, helpers.has);
  if (hasFn) {
    hasFn.body = [
      { op: "local.get", index: 0 },
      { op: "local.get", index: 1 },
      { op: "call", funcIdx: externHasIdx },
    ];
  }
}

/**
 * The re-entry arm a walker emits right after it has the link in `linkLocal`:
 * a terminating struct link answers by re-entering the full walker on it;
 * anything else falls through to the caller's unchanged `$Object` test.
 * `forward` pushes the forwarder's remaining arguments and the call.
 */
export function fnctorStructProtoReentry(okIdx: FuncHandle, linkLocal: number, forward: Instr[]): Instr[] {
  return [
    { op: "local.get", index: linkLocal },
    { op: "call", funcIdx: okIdx },
    {
      op: "if",
      blockType: { kind: "empty" },
      then: [{ op: "local.get", index: linkLocal }, ...forward, { op: "return" }],
    },
  ];
}
