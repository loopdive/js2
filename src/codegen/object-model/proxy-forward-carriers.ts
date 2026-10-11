// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * (#6651 V1) Trapless Proxy forwarding over a Proxy / native-carrier target,
 * standalone.
 *
 * The §10.5 dispatches in `object-runtime-proxy.ts` forward a trap-absent
 * operation to the generic runtime entry on `[[ProxyTarget]]`, and those entries
 * carry a `ref.test $Proxy` front-guard, so a Proxy-of-Proxy re-enters the
 * dispatch one hop at a time. What was missing are the generic entries that
 * never learned about `$Proxy` at all, and the spots where a forward lost the
 * information the target needs. Each arm here is one such spot; every one is a
 * guard PREPENDED to an existing native, and every one is gated on the
 * pre-scan having seen `Proxy` (`ctx.proxyDirty`), so a Proxy-free module keeps
 * its bytes.
 *
 * Arms:
 *  - `__hasOwnProperty` / `__object_hasOwn` — §20.1.3.2 / §20.1.2.13
 *    HasOwnProperty(O, P) is `O.[[GetOwnProperty]](P) !== undefined`; for a
 *    `$Proxy` that is §10.5.5 (the gopd trap, or the target's own answer). The
 *    natives had no proxy arm, so `Object.prototype.hasOwnProperty.call(p, k)`
 *    walked the `$Proxy` carrier's empty own table and answered false.
 *  - `__propertyIsEnumerable` — §20.1.3.4: `desc = O.[[GetOwnProperty]](P)`,
 *    false when undefined, else `desc.[[Enumerable]]`. Same missing arm.
 */
import type { Instr } from "../../ir/types.js";
import type { CodegenContext } from "../context/types.js";
import { bound } from "./ports.js"; // core helpers, injected — keeps this leaf out of the import SCC

const addStringConstantGlobal = bound("addStringConstantGlobal");
const stringConstantExternrefInstrs = bound("stringConstantExternrefInstrs");

/** Dependencies `ensureProxyRuntime` hands in (no value import of the SCC). */
export interface ProxyForwardDeps {
  proxyTypeIdx: number;
  findBody: (name: string) => Instr[] | undefined;
}

/** Install every V1 forward arm. No-op outside standalone or without `Proxy`. */
export function installProxyForwardArms(ctx: CodegenContext, deps: ProxyForwardDeps): void {
  if (!ctx.standalone || ctx.proxyDirty !== true) return;
  installDispatchKeyCanonicalization(ctx, deps);
  installHasOwnArm(ctx, deps);
  installPropertyIsEnumerableArm(ctx, deps);
}

/** The §10.5 dispatches that take a property key in param 1. */
const KEYED_DISPATCHES = [
  "__proxy_get_dispatch",
  "__proxy_set_dispatch",
  "__proxy_set_receiver_dispatch",
  "__proxy_has_dispatch",
  "__proxy_delete_dispatch",
  "__proxy_gopd_dispatch",
  "__proxy_define_dispatch",
];

/**
 * Every §10.5 internal method receives a property KEY: `p[10]` evaluates
 * ToPropertyKey(10) = "10" (§13.3.3 EvaluatePropertyAccessWithExpressionKey)
 * before `[[Get]]` runs. The standalone access lowering hands the boxed number
 * straight to `__extern_get`, so a trap saw `typeof key === "number"` and a
 * trapless forward to a String-wrapper target missed the String-exotic index
 * arm (which reads string keys only). Canonicalize once at dispatch entry with
 * the runtime's own `__to_property_key` (idempotent on strings and symbols).
 */
function installDispatchKeyCanonicalization(ctx: CodegenContext, deps: ProxyForwardDeps): void {
  const tpkIdx = ctx.funcMap.get("__to_property_key");
  if (tpkIdx === undefined) return;
  for (const name of KEYED_DISPATCHES) {
    deps
      .findBody(name)
      ?.unshift({ op: "local.get", index: 1 }, { op: "call", funcIdx: tpkIdx }, { op: "local.set", index: 1 });
  }
}

/** `i32 1` when the externref on top of the stack is absent (null or undefined). */
function absentTest(ctx: CodegenContext): Instr[] | undefined {
  const nullish = ctx.funcMap.get("__extern_is_nullish");
  if (nullish !== undefined) return [{ op: "call", funcIdx: nullish }];
  return undefined;
}

function installHasOwnArm(ctx: CodegenContext, deps: ProxyForwardDeps): void {
  const gopdDispatchIdx = ctx.funcMap.get("__proxy_gopd_dispatch");
  const absent = absentTest(ctx);
  if (gopdDispatchIdx === undefined || absent === undefined) return;
  for (const name of ["__hasOwnProperty", "__object_hasOwn"]) {
    const body = deps.findBody(name);
    if (!body) continue;
    body.unshift(
      { op: "local.get", index: 0 },
      { op: "any.convert_extern" },
      { op: "ref.test", typeIdx: deps.proxyTypeIdx },
      {
        op: "if",
        blockType: { kind: "empty" },
        then: [
          { op: "local.get", index: 0 },
          { op: "local.get", index: 1 },
          { op: "local.get", index: 0 }, // unused receiver placeholder (3-param dispatch)
          { op: "call", funcIdx: gopdDispatchIdx },
          ...absent,
          { op: "i32.eqz" },
          { op: "return" },
        ],
      },
    );
  }
}

function installPropertyIsEnumerableArm(ctx: CodegenContext, deps: ProxyForwardDeps): void {
  const gopdDispatchIdx = ctx.funcMap.get("__proxy_gopd_dispatch");
  const externGetIdx = ctx.funcMap.get("__extern_get");
  const isTruthyIdx = ctx.funcMap.get("__is_truthy");
  const absent = absentTest(ctx);
  const fn = ctx.mod.functions.find((f) => f.name === "__propertyIsEnumerable");
  if (gopdDispatchIdx === undefined || externGetIdx === undefined || isTruthyIdx === undefined) return;
  if (absent === undefined || fn === undefined) return;
  addStringConstantGlobal(ctx, "enumerable");
  const descLocal = 2 + fn.locals.length;
  fn.locals.push({ name: "__v1_pie_desc", type: { kind: "externref" } });
  fn.body.unshift(
    { op: "local.get", index: 0 },
    { op: "any.convert_extern" },
    { op: "ref.test", typeIdx: deps.proxyTypeIdx },
    {
      op: "if",
      blockType: { kind: "empty" },
      then: [
        { op: "local.get", index: 0 },
        { op: "local.get", index: 1 },
        { op: "local.get", index: 0 },
        { op: "call", funcIdx: gopdDispatchIdx },
        { op: "local.tee", index: descLocal },
        ...absent,
        {
          op: "if",
          blockType: { kind: "val", type: { kind: "i32" } },
          then: [{ op: "i32.const", value: 0 }],
          else: [
            { op: "local.get", index: descLocal },
            ...stringConstantExternrefInstrs(ctx, "enumerable"),
            { op: "call", funcIdx: externGetIdx },
            { op: "call", funcIdx: isTruthyIdx },
          ],
        },
        { op: "return" },
      ],
    },
  );
}
