// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * (#7009) A function-constructor STRUCT instance as an `$Object`'s `[[Prototype]]`
 * under `--target standalone` / WASI.
 *
 * ## The gap
 *
 * TypeScript's classic `__extends` helper, and every pre-ES6 inherit idiom with a
 * non-empty helper constructor, stores `new __()` as the subclass prototype:
 *
 *   function __() { this.constructor = d; }
 *   __.prototype = b.prototype; d.prototype = new __();   // a `$__fnctor___` STRUCT
 *
 * A static `new d()` builds a `$__fnctor_d` struct whose walk starts at the
 * per-fnctor prototype global and re-enters a struct link through #6944's
 * helpers. A runtime-VALUE `new D()` (`var D = d; new D()`) goes through
 * `__native_construct_N`, which seeds an ordinary `$Object` with
 * `__object_create(D.prototype)` — and `$Object.$proto` is `(ref null $Object)`,
 * so the struct was stored as null: the instance lost every inherited method
 * (Octane `typescript`: "called value is not a function").
 *
 * ## The representation: the #6766 LINK, generalized
 *
 * The prototype writers (`__object_create`, `__object_setPrototypeOf{,_status}`)
 * already map a Proxy to a link `$Object` (empty, null `$proto`, the Proxy in the
 * `protoLink` field). `__proto_link_wrap` now links a fnctor struct the same way
 * when `__fnctor_struct_proto_ok` accepts it — a struct whose own struct-link
 * chain provably terminates. `__getPrototypeOf` answers the struct and two links
 * compare by the object they hold, exactly as for a Proxy.
 *
 * ## The arms
 *
 * Each walker gets one arm right after its cursor null check. A link whose
 * object passes `ok` answers through #6944's forwarders, which re-enter the full
 * walker on the struct — its fields, expando bag and own prototype chain:
 * `[[Get]]` → `__fnctor_struct_proto_get(link, key, ORIGINAL receiver)`;
 * `[[HasProperty]]` → `__fnctor_struct_proto_has`; `isPrototypeOf` continues
 * from the struct through `__getPrototypeOf`. Proxy links keep their own arms
 * (`ifLink` now TESTS for `$Proxy`, so neither family sees the other's link).
 *
 * Not covered (a link ends the walk, the pre-#7009 answer): an inherited SETTER
 * or non-writable data property reached through a struct link — a write still
 * creates the own property; and `for-in` enumeration of inherited keys.
 */
import type { Instr, ValType } from "../../ir/types.js";
import type { CodegenContext } from "../context/types.js";
import type { ObjectRuntimeTypes } from "../object-runtime.js";
import {
  ensureProtoLinkChainFrom,
  ifAnyLink,
  linkOf,
  localIndexOf,
  namedFunction,
  protoLinkActive,
  spliceIntoWalkLoops,
  spliceRequired,
} from "../object-runtime-proxy-chain.js";

type RegisterNative = (
  name: string,
  paramTypes: ValType[],
  resultTypes: ValType[],
  locals: { name: string; type: ValType }[],
  body: Instr[],
) => number;

/**
 * `__fnctor_struct_proto_ok` when fnctor-struct links are live: a native target
 * (the gc lane constructs through the host and stays byte-identical) whose
 * module reserved the #6944 struct-link helpers. `undefined` otherwise.
 */
export function structProtoLinkOk(ctx: CodegenContext): number | undefined {
  if (!ctx.standalone && !ctx.wasi) return undefined;
  return ctx.funcMap.get("__fnctor_struct_proto_ok");
}

/** `if (cursor links an object `ok` accepts) { then }` — `then` returns. */
function ifStructLink(objectTypeIdx: number, cursor: number, okIdx: number, then: Instr[]): Instr[] {
  return ifAnyLink(objectTypeIdx, cursor, [
    ...linkedStruct(objectTypeIdx, cursor),
    { op: "call", funcIdx: okIdx },
    { op: "if", blockType: { kind: "empty" }, then },
  ]);
}

/** The linked object as an externref. */
function linkedStruct(objectTypeIdx: number, cursor: number): Instr[] {
  return [...linkOf(objectTypeIdx, cursor), { op: "extern.convert_any" }];
}

/**
 * Splice the struct-link arms into the prototype walkers. Runs right after
 * `fillProtoLinkArms`, when every walker body is still the one its builder
 * produced and both forwarders exist.
 */
export function fillStructProtoLinkArms(
  ctx: CodegenContext,
  types: ObjectRuntimeTypes,
  registerNative: RegisterNative,
): void {
  const okIdx = structProtoLinkOk(ctx);
  const getIdx = ctx.funcMap.get("__fnctor_struct_proto_get");
  const hasIdx = ctx.funcMap.get("__fnctor_struct_proto_has");
  if (okIdx === undefined || getIdx === undefined || hasIdx === undefined) return;
  const { objectTypeIdx } = types;

  // [[Get]]: §10.1.8.1 step 3.c `parent.[[Get]](P, Receiver)`.
  const getRecv = localIndexOf(ctx, "__extern_get", "explicitReceiver", 2);
  spliceRequired(ctx, "__extern_get", objectTypeIdx, 2, () =>
    ifStructLink(objectTypeIdx, 2, okIdx, [
      ...linkedStruct(objectTypeIdx, 2),
      { op: "local.get", index: 1 },
      { op: "local.get", index: getRecv },
      { op: "call", funcIdx: getIdx },
      { op: "return" },
    ]),
  );

  // [[HasProperty]]: §10.1.7.1 step 4 `parent.[[HasProperty]](P)`.
  spliceRequired(ctx, "__extern_has", objectTypeIdx, 2, () =>
    ifStructLink(objectTypeIdx, 2, okIdx, [
      ...linkedStruct(objectTypeIdx, 2),
      { op: "local.get", index: 1 },
      { op: "call", funcIdx: hasIdx },
      { op: "return" },
    ]),
  );

  // A chain that ends in a link has no implicit Object.prototype terminal: the
  // linked object answered for everything past it. (The Proxy regime already
  // spliced this arm for links of either kind.)
  if (!protoLinkActive(ctx)) {
    spliceRequired(ctx, "__object_terminal_allows_implicit_proto", objectTypeIdx, 1, () =>
      ifAnyLink(objectTypeIdx, 1, [{ op: "i32.const", value: 0 }, { op: "return" }]),
    );
  }

  // §20.1.3.3 Object.prototype.isPrototypeOf / `instanceof`.
  const isProto = namedFunction(ctx, "__isPrototypeOf");
  const getProto = ctx.funcMap.get("__getPrototypeOf");
  if (!isProto || getProto === undefined) return;
  const chainFrom = ensureProtoLinkChainFrom(ctx, registerNative, getProto);
  // V's chain reached a struct link → is O that struct, or in its chain?
  const spliced = spliceIntoWalkLoops(isProto.body, objectTypeIdx, 3, () =>
    ifStructLink(objectTypeIdx, 3, okIdx, [
      { op: "local.get", index: 0 },
      ...linkedStruct(objectTypeIdx, 3),
      { op: "call", funcIdx: chainFrom },
      { op: "return" },
    ]),
  );
  if (spliced === 0) throw new Error("#7009: no prototype walk loop in __isPrototypeOf");
  // A struct RECEIVER (`D.prototype` in `x instanceof D`) is not an `$Object`,
  // which the walk below requires of O: walk V's chain generically instead.
  isProto.body.unshift(
    { op: "local.get", index: 0 },
    { op: "call", funcIdx: okIdx },
    {
      op: "if",
      blockType: { kind: "empty" },
      then: [
        { op: "local.get", index: 0 },
        { op: "local.get", index: 1 },
        { op: "call", funcIdx: getProto },
        { op: "call", funcIdx: chainFrom },
        { op: "return" },
      ],
    },
  );
}
