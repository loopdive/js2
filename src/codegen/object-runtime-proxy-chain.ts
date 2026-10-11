// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * (#6766) A Proxy as `[[Prototype]]` under `--target standalone`.
 *
 * ## The gap
 *
 * `$Object.$proto` is `(ref null $Object)` and `$Proxy` is a sibling struct, not
 * a subtype (the #2009 canonicalization hazard, see the `$Object` type comment in
 * object-runtime.ts). So `Object.create(proxy)` / `Object.setPrototypeOf(o,
 * proxy)` / `{ __proto__: proxy }` could not store the proxy: the writers
 * unwrapped it to its target (#4721) or, with a `get` trap, stored `null`. No
 * trap fired on an inherited read, write or `in`, and `Object.getPrototypeOf`
 * of the heir was not the proxy.
 *
 * ## The representation: a LINK
 *
 * A proxy in prototype position is stored as a fresh, empty `$Object` whose
 * `$proto` is null, whose flags are 0 and whose appended `protoLink` field
 * ({@link PROTO_LINK_FIELD}) holds the `$Proxy`. A link is never handed to the
 * program — `__getPrototypeOf` answers the proxy — so the non-null field IS the
 * discriminator; no flag bit is spent. Because a link has no properties and a
 * null `$proto`, every walker that has NOT been taught about links ends its walk
 * there; that is a chain CUT, so every walker that reads `$proto` is either
 * given an arm here or recorded (issue file) as needing none.
 *
 * ## The arms
 *
 * Each prototype walker gets one arm at the top of its loop, right after the
 * cursor null check: `cursor.protoLink != null → <proxy op>(proxy, key,
 * ORIGINAL receiver)`. The receiver is the object the program named (param 0,
 * or `__extern_get`'s explicit Reflect.get receiver), never the cursor; the trap
 * `this` is the handler, which the dispatch drivers already thread.
 *
 * ## Byte identity
 *
 * The field append changes every module's `$Object` (one more `ref.null any` per
 * `struct.new`) — unconditional, because linked standalone modules canonicalize
 * their runtime types across the link. Everything else is emitted only under
 * {@link protoLinkActive}: standalone, and the pre-scan saw the identifier
 * `Proxy` (`ctx.proxyDirty`, #6651 H6).
 */
import type { Instr, ValType } from "../ir/types.js";
import type { CodegenContext } from "./context/types.js";
import type { ObjectRuntimeTypes } from "./object-runtime.js";
import { definedFuncAt, mintDefinedFunc, pushDefinedFunc } from "./func-space.js";
import { SET_DECISION_HANDLED, SET_DECISION_REFUSED } from "./proto-index-store.js";
import { addFuncType } from "./registry/types.js";
import { proxyTrapAbsentTail } from "./object-model/proxy-trap-read.js"; // (#6770 S8)

/** `$Object` field index of the appended `protoLink` anyref (object-runtime.ts `objectFields`). */
export const PROTO_LINK_FIELD = 6;

const PROTO_LINK_WRAP = "__proto_link_wrap";
const PROTO_LINK_SAME = "__proto_link_same";
const PROTO_LINK_SET_WALK = "__proto_link_set_walk";
const PROTO_LINK_CHAIN_FROM = "__proto_link_chain_from";

/** `ref.null any` — WasmGC `any` heap type as signed LEB (0x6e = -18), as object-runtime.ts' `NONE_HEAP`. */
const ANY_HEAP = -18;

type RegisterNative = (
  name: string,
  paramTypes: ValType[],
  resultTypes: ValType[],
  locals: { name: string; type: ValType }[],
  body: Instr[],
) => number;

const externref = (): ValType => ({ kind: "externref" });
const i32 = (): ValType => ({ kind: "i32" });

/** Links are live: standalone, and the module can hold a Proxy value at all. */
export function protoLinkActive(ctx: CodegenContext): boolean {
  return ctx.standalone === true && ctx.proxyDirty === true;
}

/** The `protoLink` operand every `struct.new $Object` pushes last. A factory (no shared Instr objects). */
export function protoLinkNull(): Instr {
  return { op: "ref.null", typeIdx: ANY_HEAP };
}

/**
 * Push the `protoLink` null before each top-level `struct.new $Object` of a body
 * built by a builder shared with the (6-field) native-backend layout
 * (`buildOrdinaryObjectCreateBody` also serves `ordinary-object-storage-definitions.ts`).
 */
export function withProtoLinkNull(body: Instr[], objectTypeIdx: number): Instr[] {
  const out: Instr[] = [];
  for (const ins of body) {
    if (ins.op === "struct.new" && ins.typeIdx === objectTypeIdx) out.push(protoLinkNull());
    out.push(ins);
  }
  return out;
}

/** `cursor.protoLink` (anyref) for a `(ref null $Object)` cursor local known non-null. */
function linkOf(objectTypeIdx: number, cursor: number): Instr[] {
  return [
    { op: "local.get", index: cursor },
    { op: "ref.as_non_null" },
    { op: "struct.get", typeIdx: objectTypeIdx, fieldIdx: PROTO_LINK_FIELD },
  ];
}

/** `if (cursor is a link) { then }` — `then` must leave the stack empty (it returns). */
function ifLink(objectTypeIdx: number, cursor: number, then: Instr[]): Instr[] {
  return [
    ...linkOf(objectTypeIdx, cursor),
    { op: "ref.is_null" },
    { op: "i32.eqz" },
    { op: "if", blockType: { kind: "empty" }, then },
  ];
}

/** The linked `$Proxy` as an externref. */
function proxyOf(objectTypeIdx: number, cursor: number): Instr[] {
  return [...linkOf(objectTypeIdx, cursor), { op: "extern.convert_any" }];
}

/** WasmGC `eq` abstract heap type (signed LEB 0x6d = -19). */
const EQ_HEAP = -19;

/** i32: the externref params `a` and `b` are the same GC object (both `eq`, `ref.eq`). */
function identityOf(a: number, b: number): Instr[] {
  const asEq = (p: number): Instr[] => [
    { op: "local.get", index: p },
    { op: "any.convert_extern" },
    { op: "ref.cast", typeIdx: EQ_HEAP },
  ];
  const isEq = (p: number): Instr[] => [
    { op: "local.get", index: p },
    { op: "any.convert_extern" },
    { op: "ref.test", typeIdx: EQ_HEAP },
  ];
  return [
    ...isEq(b),
    {
      op: "if",
      blockType: { kind: "val", type: i32() },
      then: [
        ...isEq(a),
        {
          op: "if",
          blockType: { kind: "val", type: i32() },
          then: [...asEq(b), ...asEq(a), { op: "ref.eq" }],
          else: [{ op: "i32.const", value: 0 }],
        },
      ],
      else: [{ op: "i32.const", value: 0 }],
    },
  ];
}

export interface ProtoLinkNatives {
  /** `__proto_link_wrap(externref) -> externref`: a `$Proxy` → a fresh link; anything else unchanged. */
  wrapIdx: number;
  /** `__proto_link_same(current, requested) -> i32`: both links, same Proxy. */
  sameIdx: number;
}

/**
 * Register the two natives the prototype WRITERS need, before
 * `buildObjectPrototypeHelpers` bakes their calls. `undefined` off the link regime.
 */
export function registerProtoLinkNatives(
  ctx: CodegenContext,
  registerNative: RegisterNative,
  t: { objectTypeIdx: number; propMapTypeIdx: number; proxyTypeIdx: number; initialCapacity: number },
): ProtoLinkNatives | undefined {
  if (!protoLinkActive(ctx)) return undefined;
  const { objectTypeIdx, propMapTypeIdx, proxyTypeIdx } = t;
  const wrapIdx = registerNative(
    PROTO_LINK_WRAP,
    [externref()],
    [externref()],
    [],
    [
      { op: "local.get", index: 0 },
      { op: "any.convert_extern" },
      { op: "ref.test", typeIdx: proxyTypeIdx },
      {
        op: "if",
        blockType: { kind: "val", type: externref() },
        then: [
          // new $Object { proto: null, props: $PropMap[cap], 0, 0, flags 0, 0, protoLink: proxy }
          { op: "ref.null", typeIdx: objectTypeIdx },
          { op: "i32.const", value: t.initialCapacity },
          { op: "array.new_default", typeIdx: propMapTypeIdx },
          { op: "i32.const", value: 0 },
          { op: "i32.const", value: 0 },
          { op: "i32.const", value: 0 },
          { op: "i32.const", value: 0 },
          { op: "local.get", index: 0 },
          { op: "any.convert_extern" },
          { op: "struct.new", typeIdx: objectTypeIdx },
          { op: "extern.convert_any" },
        ],
        else: [{ op: "local.get", index: 0 }],
      },
    ],
  );
  const objRefNull = (): ValType => ({ kind: "ref_null", typeIdx: objectTypeIdx });
  const proxyOfParam = (p: number): Instr[] => [
    { op: "local.get", index: p },
    { op: "struct.get", typeIdx: objectTypeIdx, fieldIdx: PROTO_LINK_FIELD },
    { op: "ref.cast_null", typeIdx: proxyTypeIdx },
  ];
  const zeroIfNotLink = (p: number): Instr[] => [
    { op: "local.get", index: p },
    { op: "ref.is_null" },
    { op: "if", blockType: { kind: "empty" }, then: [{ op: "i32.const", value: 0 }, { op: "return" }] },
    { op: "local.get", index: p },
    { op: "struct.get", typeIdx: objectTypeIdx, fieldIdx: PROTO_LINK_FIELD },
    { op: "ref.is_null" },
    { op: "if", blockType: { kind: "empty" }, then: [{ op: "i32.const", value: 0 }, { op: "return" }] },
  ];
  // §10.1.2.1 step 2 SameValue(V, current): a link is minted per write, so two
  // links for ONE proxy must compare equal by the proxy they hold.
  const sameIdx = registerNative(
    PROTO_LINK_SAME,
    [objRefNull(), objRefNull()],
    [i32()],
    [],
    [...zeroIfNotLink(0), ...zeroIfNotLink(1), ...proxyOfParam(0), ...proxyOfParam(1), { op: "ref.eq" }],
  );
  return { wrapIdx, sameIdx };
}

/**
 * `__getPrototypeOf`'s answer for a NON-null `$proto`: the linked Proxy when the
 * field holds a link, else `raw`. `anyLocal` holds the receiver as anyref.
 */
export function protoLinkAnswerOr(objectTypeIdx: number, anyLocal: number, raw: Instr[]): Instr[] {
  const field: Instr[] = [
    { op: "local.get", index: anyLocal },
    { op: "ref.cast", typeIdx: objectTypeIdx },
    { op: "struct.get", typeIdx: objectTypeIdx, fieldIdx: 0 },
    { op: "struct.get", typeIdx: objectTypeIdx, fieldIdx: PROTO_LINK_FIELD },
  ];
  return [
    ...field,
    { op: "ref.is_null" },
    {
      op: "if",
      blockType: { kind: "val", type: externref() },
      then: raw,
      else: [
        { op: "local.get", index: anyLocal },
        { op: "ref.cast", typeIdx: objectTypeIdx },
        { op: "struct.get", typeIdx: objectTypeIdx, fieldIdx: 0 },
        { op: "struct.get", typeIdx: objectTypeIdx, fieldIdx: PROTO_LINK_FIELD },
        { op: "extern.convert_any" },
      ],
    },
  ];
}

/**
 * `__object_setPrototypeOf{,_status}` step 2 for links: `o` (local 2) already
 * links the SAME Proxy the canonicalized request `v` (local 3) links.
 */
export function protoLinkSameValueArm(
  natives: ProtoLinkNatives | undefined,
  objectTypeIdx: number,
  onSame: () => Instr[],
): Instr[] {
  if (natives === undefined) return [];
  return [
    { op: "local.get", index: 2 },
    { op: "ref.as_non_null" },
    { op: "struct.get", typeIdx: objectTypeIdx, fieldIdx: 0 },
    { op: "local.get", index: 3 },
    { op: "call", funcIdx: natives.sameIdx },
    { op: "if", blockType: { kind: "empty" }, then: onSame() },
  ];
}

/**
 * RESERVE `__proto_link_set_walk(obj, key, value) -> i32` for the [[Set]] path
 * that has no #4504 decide walk (`__extern_set` / `__reflect_set` with
 * `inheritedSetAnyDirty` clear). Filled by {@link fillProtoLinkArms}; the
 * placeholder answers 0 ("no link"), the pre-#6766 behaviour.
 */
export function reserveProtoLinkSetWalk(ctx: CodegenContext): number | undefined {
  if (!protoLinkActive(ctx)) return undefined;
  const existing = ctx.funcMap.get(PROTO_LINK_SET_WALK);
  if (existing !== undefined) return existing;
  const typeIdx = addFuncType(ctx, [externref(), externref(), externref()], [i32()]);
  const funcIdx = mintDefinedFunc(ctx);
  pushDefinedFunc(ctx, funcIdx, {
    name: PROTO_LINK_SET_WALK,
    typeIdx,
    locals: [],
    body: [{ op: "i32.const", value: 0 }],
    exported: false,
  });
  ctx.funcMap.set(PROTO_LINK_SET_WALK, funcIdx);
  return funcIdx;
}

/**
 * The call into the reserved walk, spliced where an own-miss write would create
 * the property. Without `resultLocal` (`__extern_set`, void): return when a link
 * took the write. With it (`__reflect_set`, i32): return the link's boolean.
 */
export function protoLinkSetWalkArm(walkIdx: number | undefined, resultLocal?: number): Instr[] {
  if (walkIdx === undefined) return [];
  const call: Instr[] = [
    { op: "local.get", index: 0 },
    { op: "local.get", index: 1 },
    { op: "local.get", index: 2 },
    { op: "call", funcIdx: walkIdx },
  ];
  if (resultLocal === undefined) return [...call, { op: "if", blockType: { kind: "empty" }, then: [{ op: "return" }] }];
  return [
    ...call,
    { op: "local.tee", index: resultLocal },
    {
      op: "if",
      blockType: { kind: "empty" },
      then: [
        { op: "local.get", index: resultLocal },
        { op: "i32.const", value: 1 },
        { op: "i32.eq" },
        { op: "return" },
      ],
    },
  ];
}

/** `$Proxy` / `$ProxyTraps` layout the 3-argument [[Set]] dispatch reads. */
export interface ProxySetLayout {
  proxyTypeIdx: number;
  proxyTrapsTypeIdx: number;
  targetField: number;
  trapsField: number;
  gopdTrap: number;
  defineTrap: number;
}

/**
 * (#6766) `__proxy_set_dispatch`'s trap-ABSENT arm, §10.5.9 step 6
 * `target.[[Set]](P, V, Receiver)` with Receiver = the proxy (param 0). The
 * plain forward `__extern_set(target, …)` drops the receiver, which is only
 * observable when the proxy itself answers the receiver-side
 * [[GetOwnProperty]] / [[DefineOwnProperty]] of §10.1.9.2 — a gopd or
 * defineProperty trap. Such a proxy (link regime) forwards through
 * `__reflect_set_receiver` and publishes its boolean on the #4504 channel;
 * every other proxy falls through to the unchanged forward.
 */
export function protoLinkReceiverSetForward(ctx: CodegenContext, P: number, d: ProxySetLayout): Instr[] {
  const setWithReceiver = protoLinkActive(ctx) ? ctx.funcMap.get("__reflect_set_receiver") : undefined;
  if (setWithReceiver === undefined) return [];
  const channel = ctx.externSetResultGlobalIdx;
  const traps = (): Instr[] => [
    { op: "local.get", index: P },
    { op: "struct.get", typeIdx: d.proxyTypeIdx, fieldIdx: d.trapsField },
  ];
  // (#6770 S8) the handler's trap NOW (a `$Proxy` handler counts as present).
  const trapPresent = (field: number): Instr[] => [
    { op: "local.get", index: P },
    ...proxyTrapAbsentTail(ctx, field),
    { op: "i32.eqz" },
  ];
  return [
    ...traps(),
    { op: "ref.is_null" },
    {
      op: "if",
      blockType: { kind: "val", type: i32() },
      then: [{ op: "i32.const", value: 0 }],
      else: [...trapPresent(d.gopdTrap), ...trapPresent(d.defineTrap), { op: "i32.or" }],
    },
    {
      op: "if",
      blockType: { kind: "empty" },
      then: [
        { op: "local.get", index: P },
        { op: "struct.get", typeIdx: d.proxyTypeIdx, fieldIdx: d.targetField },
        { op: "extern.convert_any" },
        { op: "local.get", index: 1 },
        { op: "local.get", index: 2 },
        { op: "local.get", index: 0 },
        { op: "call", funcIdx: setWithReceiver },
        ...(channel === undefined
          ? ([{ op: "drop" }] satisfies Instr[])
          : ([
              {
                op: "if",
                blockType: { kind: "val", type: i32() },
                then: [{ op: "i32.const", value: 1 }], // SET_RESULT_SUCCESS
                else: [{ op: "i32.const", value: 2 }], // SET_RESULT_REFUSED
              },
              { op: "global.set", index: channel },
            ] satisfies Instr[])),
        { op: "ref.null.extern" },
        { op: "return" },
      ],
    },
  ];
}

/** Is `body` a prototype walk over `cursor`: opens with the cursor null check, hops via `$proto`. */
function isProtoWalkLoop(body: Instr[], objectTypeIdx: number, cursor: number): boolean {
  const first = body[0];
  const second = body[1];
  if (first?.op !== "local.get" || first.index !== cursor || second?.op !== "ref.is_null") return false;
  for (let i = 0; i + 1 < body.length; i++) {
    const hop = body[i]!;
    const store = body[i + 1]!;
    if (
      hop.op === "struct.get" &&
      hop.typeIdx === objectTypeIdx &&
      hop.fieldIdx === 0 &&
      store.op === "local.set" &&
      store.index === cursor
    ) {
      return true;
    }
  }
  return false;
}

/** Splice `arm()` after the cursor null check of every prototype walk loop in `body`. */
function spliceIntoWalkLoops(body: Instr[], objectTypeIdx: number, cursor: number, arm: () => Instr[]): number {
  let spliced = 0;
  const visit = (list: Instr[]): void => {
    for (const ins of list) {
      if (ins.op === "loop") {
        if (isProtoWalkLoop(ins.body, objectTypeIdx, cursor)) {
          ins.body.splice(3, 0, ...arm());
          spliced++;
        }
        visit(ins.body);
      } else if (ins.op === "block") {
        visit(ins.body);
      } else if (ins.op === "if") {
        visit(ins.then);
        if (ins.else) visit(ins.else);
      }
    }
  };
  visit(body);
  return spliced;
}

function namedFunction(ctx: CodegenContext, name: string) {
  const idx = ctx.funcMap.get(name);
  return idx === undefined ? undefined : definedFuncAt(ctx, idx);
}

/** Absolute local index of the named local of `fn` (params first). */
function localIndexOf(ctx: CodegenContext, name: string, localName: string, paramCount: number): number {
  const fn = namedFunction(ctx, name);
  const at = fn?.locals.findIndex((l) => l.name === localName) ?? -1;
  if (at < 0) throw new Error(`#6766: ${name} has no local ${localName}`);
  return paramCount + at;
}

/** A walker that must exist in the link regime: fail loudly rather than cut the chain silently. */
function spliceRequired(ctx: CodegenContext, name: string, objectTypeIdx: number, cursor: number, arm: () => Instr[]) {
  const fn = namedFunction(ctx, name);
  if (!fn) throw new Error(`#6766: prototype walker ${name} is not registered`);
  if (spliceIntoWalkLoops(fn.body, objectTypeIdx, cursor, arm) === 0) {
    throw new Error(`#6766: no prototype walk loop over local ${cursor} in ${name}`);
  }
}

/**
 * Splice the per-hop Proxy arms into the prototype walkers and fill the
 * reserved set walk. Runs in `ensureObjectRuntime` right after
 * `ensureProxyRuntime`, when every dispatch helper exists and every walker body
 * is still the one its builder produced (the proxy front guards only unshift).
 */
export function fillProtoLinkArms(
  ctx: CodegenContext,
  types: ObjectRuntimeTypes,
  registerNative: RegisterNative,
): void {
  if (!protoLinkActive(ctx)) return;
  const { objectTypeIdx, proxyTypeIdx } = types;
  const fm = (name: string): number | undefined => ctx.funcMap.get(name);
  // Every arm hands the PROXY to an existing chokepoint whose `$Proxy` front
  // guard owns the §10.5 protocol (revocation, trap, invariants, ToBoolean):
  // `[[Get]]` → `__proxy_get_dispatch`; `[[HasProperty]]` → `__extern_has`;
  // `[[Set]]` with a receiver → `__reflect_set_receiver`, whose loop sends a
  // `$Proxy` `O` to `__proxy_set_receiver_dispatch` and answers an i32.
  const getDispatch = fm("__proxy_get_dispatch");
  const externHas = fm("__extern_has");
  const setWithReceiver = fm("__reflect_set_receiver");
  const objFind = fm("__obj_find");
  const getProto = fm("__getPrototypeOf");
  if (getDispatch === undefined || externHas === undefined || objFind === undefined) {
    throw new Error("#6766: Proxy dispatch helpers missing in the link regime");
  }
  // A trap receives ToPropertyKey(P) — `0 in heir` asks the `has` trap for "0".
  const toKey = fm("__to_property_key");
  const key = (local: number): Instr[] => [
    { op: "local.get", index: local },
    ...(toKey === undefined ? [] : ([{ op: "call", funcIdx: toKey }] satisfies Instr[])),
  ];

  // [[Get]]: §10.1.8.1 step 3.c `parent.[[Get]](P, Receiver)`.
  const getRecv = localIndexOf(ctx, "__extern_get", "explicitReceiver", 2);
  spliceRequired(ctx, "__extern_get", objectTypeIdx, 2, () =>
    ifLink(objectTypeIdx, 2, [
      ...proxyOf(objectTypeIdx, 2),
      ...key(1),
      { op: "local.get", index: getRecv },
      { op: "call", funcIdx: getDispatch },
      { op: "return" },
    ]),
  );

  // [[HasProperty]]: §10.1.7.1 step 4 `parent.[[HasProperty]](P)`.
  spliceRequired(ctx, "__extern_has", objectTypeIdx, 2, () =>
    ifLink(objectTypeIdx, 2, [
      ...proxyOf(objectTypeIdx, 2),
      ...key(1),
      { op: "call", funcIdx: externHas },
      { op: "return" },
    ]),
  );

  // A chain that ends in a link has no implicit Object.prototype terminal: the
  // Proxy already answered for everything past it.
  spliceRequired(ctx, "__object_terminal_allows_implicit_proto", objectTypeIdx, 1, () =>
    ifLink(objectTypeIdx, 1, [{ op: "i32.const", value: 0 }, { op: "return" }]),
  );

  // [[Set]]: §10.1.9.2 step 2.b `parent.[[Set]](P, V, Receiver)`, answered as
  // the boolean the #4504 decision channel carries.
  const decide = namedFunction(ctx, "__extern_set_decide");
  if (decide && setWithReceiver !== undefined) {
    const spliced = spliceIntoWalkLoops(decide.body, objectTypeIdx, 9, () =>
      ifLink(objectTypeIdx, 9, [
        ...proxyOf(objectTypeIdx, 9),
        ...key(2),
        { op: "local.get", index: 3 },
        { op: "local.get", index: 0 },
        { op: "call", funcIdx: setWithReceiver },
        {
          op: "if",
          blockType: { kind: "val", type: i32() },
          then: [{ op: "i32.const", value: SET_DECISION_HANDLED }],
          else: [{ op: "i32.const", value: SET_DECISION_REFUSED }],
        },
        { op: "return" },
      ]),
    );
    if (spliced === 0) throw new Error("#6766: no prototype walk loop in __extern_set_decide");
  }
  fillSetWalk(ctx, objectTypeIdx, setWithReceiver, objFind, key);

  // §20.1.3.3 Object.prototype.isPrototypeOf: a link hop continues through the
  // Proxy's own [[GetPrototypeOf]] (its trap), comparing the PROXY identity.
  const isProto = namedFunction(ctx, "__isPrototypeOf");
  if (isProto && getProto !== undefined) {
    const isUndefined = fm("__extern_is_undefined");
    const chainFrom = registerNative(
      PROTO_LINK_CHAIN_FROM,
      [externref(), externref()],
      [i32()],
      [],
      [
        {
          op: "block",
          blockType: { kind: "empty" },
          body: [
            {
              op: "loop",
              blockType: { kind: "empty" },
              body: [
                { op: "local.get", index: 1 },
                { op: "ref.is_null" },
                { op: "br_if", depth: 1 },
                ...(isUndefined === undefined
                  ? []
                  : ([
                      { op: "local.get", index: 1 },
                      { op: "call", funcIdx: isUndefined },
                      { op: "br_if", depth: 1 },
                    ] satisfies Instr[])),
                // SameValue(O, V) on two Objects is identity: both `eq`, `ref.eq`.
                ...identityOf(0, 1),
                { op: "if", blockType: { kind: "empty" }, then: [{ op: "i32.const", value: 1 }, { op: "return" }] },
                { op: "local.get", index: 1 },
                { op: "call", funcIdx: getProto },
                { op: "local.set", index: 1 },
                { op: "br", depth: 0 },
              ],
            },
          ],
        },
        { op: "i32.const", value: 0 },
      ],
    );
    // Walk arm: V's chain reached a link → is O that Proxy, or in its chain?
    const spliced = spliceIntoWalkLoops(isProto.body, objectTypeIdx, 3, () =>
      ifLink(objectTypeIdx, 3, [
        { op: "local.get", index: 0 },
        ...proxyOf(objectTypeIdx, 3),
        { op: "call", funcIdx: chainFrom },
        { op: "return" },
      ]),
    );
    if (spliced === 0) throw new Error("#6766: no prototype walk loop in __isPrototypeOf");
    // A Proxy RECEIVER (`proxy.isPrototypeOf(v)`) is only ever reachable through
    // links, so walk V's chain generically from its first link.
    isProto.body.unshift(
      { op: "local.get", index: 0 },
      { op: "any.convert_extern" },
      { op: "ref.test", typeIdx: proxyTypeIdx },
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
}

/**
 * Fill `__proto_link_set_walk(obj, key, value) -> i32`: from `obj.$proto`, the
 * FIRST of (a link, an own entry for `key`) decides — a link takes the write
 * (`1` success / `2` refused), an entry ends the walk with `0` so the caller's
 * existing own-create/accessor path runs unchanged.
 */
function fillSetWalk(
  ctx: CodegenContext,
  objectTypeIdx: number,
  setWithReceiver: number | undefined,
  objFind: number,
  key: (local: number) => Instr[],
): void {
  // Without the receiver-threaded [[Set]] (`__reflect_set_receiver` was not
  // reservable) the placeholder's "no link" answer stands.
  const fn = namedFunction(ctx, PROTO_LINK_SET_WALK);
  if (!fn || setWithReceiver === undefined) return;
  const CUR = 3;
  fn.locals = [{ name: "cursor", type: { kind: "ref_null", typeIdx: objectTypeIdx } }];
  fn.body = [
    { op: "local.get", index: 0 },
    { op: "any.convert_extern" },
    { op: "ref.test", typeIdx: objectTypeIdx },
    { op: "i32.eqz" },
    { op: "if", blockType: { kind: "empty" }, then: [{ op: "i32.const", value: 0 }, { op: "return" }] },
    { op: "local.get", index: 0 },
    { op: "any.convert_extern" },
    { op: "ref.cast", typeIdx: objectTypeIdx },
    { op: "struct.get", typeIdx: objectTypeIdx, fieldIdx: 0 },
    { op: "local.set", index: CUR },
    {
      op: "block",
      blockType: { kind: "empty" },
      body: [
        {
          op: "loop",
          blockType: { kind: "empty" },
          body: [
            { op: "local.get", index: CUR },
            { op: "ref.is_null" },
            { op: "br_if", depth: 1 },
            ...ifLink(objectTypeIdx, CUR, [
              ...proxyOf(objectTypeIdx, CUR),
              ...key(1),
              { op: "local.get", index: 2 },
              { op: "local.get", index: 0 },
              { op: "call", funcIdx: setWithReceiver },
              {
                op: "if",
                blockType: { kind: "val", type: i32() },
                then: [{ op: "i32.const", value: 1 }],
                else: [{ op: "i32.const", value: 2 }],
              },
              { op: "return" },
            ]),
            { op: "local.get", index: CUR },
            { op: "ref.as_non_null" },
            { op: "local.get", index: 1 },
            { op: "call", funcIdx: objFind },
            { op: "ref.is_null" },
            { op: "i32.eqz" },
            { op: "br_if", depth: 1 },
            { op: "local.get", index: CUR },
            { op: "ref.as_non_null" },
            { op: "struct.get", typeIdx: objectTypeIdx, fieldIdx: 0 },
            { op: "local.set", index: CUR },
            { op: "br", depth: 0 },
          ],
        },
      ],
    },
    { op: "i32.const", value: 0 },
  ];
}
