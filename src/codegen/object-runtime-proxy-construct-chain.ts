// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import type { Instr, ValType } from "../ir/types.js";

/**
 * (#6651 RF1) NewTarget-preserving [[Construct]] chain walk.
 *
 * §10.5.13 step 6b: with the `construct` trap absent, a proxy forwards to
 * `Construct(target, argumentsList, newTarget)` — the SAME newTarget it was
 * given, not a freshly-derived one. `__proxy_construct_dispatch` answers null
 * for "trap absent, caller must forward", and the only forwarder was
 * `native-construct.ts`'s driver, which re-enters its proxy arm and substitutes
 * the INNER proxy for newTarget. So `Reflect.construct(new Proxy(P, {}), args,
 * NT)` delivered the intermediate proxy to P's trap.
 *
 * These two helpers make the walk explicit and newTarget-invariant. They are
 * loops rather than a self-recursive dispatch because the dispatch's own
 * funcIdx is not available inside its own body (reserve-then-fill, #1719), and
 * a loop also cannot blow the stack on a long proxy chain.
 *
 * `__proxy_construct_chain(v, argumentsList, newTarget)` walks the
 * [[ProxyTarget]] chain from `v`, invoking each proxy's construct trap with the
 * UNCHANGED `newTarget`, and returns the first trap result. It answers null
 * exactly when no proxy in the chain has a trap — the caller then does the
 * ordinary construct on `__proxy_ultimate_target(v)`. A non-proxy `v` answers
 * null immediately, so the helper is safe on any value.
 *
 * `__proxy_ultimate_target(v)` is the first non-proxy value reachable by
 * following [[ProxyTarget]]; identity on a non-proxy.
 *
 * (#6651 V4) `__proxy_construct_newtarget_proto(p)` is §10.1.14
 * GetPrototypeFromConstructor(p) for a proxy used as newTarget: `Get(p,
 * "prototype")` through the proxy's `get` trap; an Object answers itself; a
 * non-Object makes step 4 call GetFunctionRealm(p), which throws TypeError for
 * a proxy revoked meanwhile (§7.3.22 step 4.a — the trap itself may revoke).
 * A live proxy then answers null, and the caller keeps its target-prototype
 * fallback (the realm's %Object.prototype% is not reachable here — residual).
 */
export interface NewTargetProtoDeps {
  getDispatchIdx: number;
  protoKeyInstrs: () => Instr[];
  objectTest: (local: number) => Instr[];
  throwRevoked: () => Instr[];
  fieldRevoked: number;
}

/**
 * (#6651 V4) The construct driver's trap-absent forward: the prototype it hands
 * the target's [[Construct]] — the caller-supplied one (driver local 1), else
 * GetPrototypeFromConstructor(proxy newTarget). The caller reads
 * [[ProxyTarget]] BEFORE this runs: the `get` trap may revoke and null it.
 */
export function proxyNewTargetProtoInstrs(newTargetProtoIdx: number | undefined): Instr[] {
  if (newTargetProtoIdx === undefined) return [{ op: "local.get", index: 1 }];
  return [
    { op: "local.get", index: 1 },
    { op: "ref.is_null" },
    {
      op: "if",
      blockType: { kind: "val", type: { kind: "externref" } },
      then: [
        { op: "local.get", index: 0 },
        { op: "call", funcIdx: newTargetProtoIdx },
      ],
      else: [{ op: "local.get", index: 1 }],
    },
  ];
}

export function registerProxyConstructChainNatives(
  registerNative: (
    name: string,
    paramTypes: ValType[],
    resultTypes: ValType[],
    locals: { name: string; type: ValType }[],
    body: Instr[],
  ) => number,
  proxyTypeIdx: number,
  fieldPtarget: number,
  constructDispatchIdx: number,
  newTargetProto?: NewTargetProtoDeps,
): void {
  const externref: ValType = { kind: "externref" };
  if (newTargetProto !== undefined) {
    const d = newTargetProto;
    registerNative(
      "__proxy_construct_newtarget_proto",
      [externref],
      [externref],
      [{ name: "proto", type: externref }],
      [
        { op: "local.get", index: 0 },
        ...d.protoKeyInstrs(),
        { op: "local.get", index: 0 },
        { op: "call", funcIdx: d.getDispatchIdx },
        { op: "local.tee", index: 1 },
        { op: "ref.is_null" },
        { op: "i32.eqz" },
        {
          op: "if",
          blockType: { kind: "empty" },
          then: [
            ...d.objectTest(1),
            { op: "if", blockType: { kind: "empty" }, then: [{ op: "local.get", index: 1 }, { op: "return" }] },
          ],
        },
        { op: "local.get", index: 0 },
        { op: "any.convert_extern" },
        { op: "ref.cast", typeIdx: proxyTypeIdx },
        { op: "struct.get", typeIdx: proxyTypeIdx, fieldIdx: d.fieldRevoked },
        { op: "if", blockType: { kind: "empty" }, then: d.throwRevoked() },
        { op: "ref.null.extern" },
      ],
    );
  }
  registerNative(
    "__proxy_construct_chain",
    [externref, externref, externref],
    [externref],
    [
      { name: "cur", type: externref },
      { name: "res", type: externref },
    ],
    [
      { op: "local.get", index: 0 },
      { op: "local.set", index: 3 },
      {
        op: "block",
        blockType: { kind: "empty" },
        body: [
          {
            op: "loop",
            blockType: { kind: "empty" },
            body: [
              // Chain end: `cur` is not a proxy — nothing trapped.
              { op: "local.get", index: 3 },
              { op: "any.convert_extern" },
              { op: "ref.test", typeIdx: proxyTypeIdx },
              { op: "i32.eqz" },
              { op: "br_if", depth: 1 },
              // The trap (and the revoked / not-constructible TypeErrors) for
              // this link, with the caller's newTarget threaded through.
              { op: "local.get", index: 3 },
              { op: "local.get", index: 1 },
              { op: "local.get", index: 2 },
              { op: "call", funcIdx: constructDispatchIdx },
              { op: "local.tee", index: 4 },
              { op: "ref.is_null" },
              { op: "i32.eqz" },
              {
                op: "if",
                blockType: { kind: "empty" },
                then: [{ op: "local.get", index: 4 }, { op: "return" }],
              },
              // Trap absent → forward to [[ProxyTarget]], same newTarget.
              { op: "local.get", index: 3 },
              { op: "any.convert_extern" },
              { op: "ref.cast", typeIdx: proxyTypeIdx },
              { op: "struct.get", typeIdx: proxyTypeIdx, fieldIdx: fieldPtarget },
              { op: "extern.convert_any" },
              { op: "local.set", index: 3 },
              { op: "br", depth: 0 },
            ],
          },
        ],
      },
      { op: "ref.null.extern" },
    ],
  );

  registerNative(
    "__proxy_ultimate_target",
    [externref],
    [externref],
    [{ name: "cur", type: externref }],
    [
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
              { op: "any.convert_extern" },
              { op: "ref.test", typeIdx: proxyTypeIdx },
              { op: "i32.eqz" },
              { op: "br_if", depth: 1 },
              { op: "local.get", index: 1 },
              { op: "any.convert_extern" },
              { op: "ref.cast", typeIdx: proxyTypeIdx },
              { op: "struct.get", typeIdx: proxyTypeIdx, fieldIdx: fieldPtarget },
              { op: "extern.convert_any" },
              { op: "local.set", index: 1 },
              { op: "br", depth: 0 },
            ],
          },
        ],
      },
      { op: "local.get", index: 1 },
    ],
  );
}
