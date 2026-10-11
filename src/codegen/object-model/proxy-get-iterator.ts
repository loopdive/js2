// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * (#6651 U3) GetIterator (§7.4.1) over a `$Proxy` whose target is an Array and
 * whose handler has no `get` trap, under `--target standalone`.
 *
 * ```js
 * var p = new Proxy([1, 2, 3], {});
 * for (var v of p) …;        // threw "value is not iterable"
 * p[Symbol.iterator]();      // same
 * ```
 *
 * `__iterator`'s OBJ arm reads `@@iterator` through the proxy, which forwards
 * to the target vec's `[[Get]]` — and a vec answers no inherited
 * `%Array.prototype%[@@iterator]` closure unless the module happened to
 * materialize one, so GetIterator found nothing callable.
 *
 * With the `get` trap absent the spec steps collapse onto the target:
 * `GetMethod(p, @@iterator)` is `target.[[Get]](@@iterator, p)` — the
 * inherited `%Array.prototype.values%` — and `Call(values, p)` yields
 * `CreateArrayIterator(p)`, whose every `next()` reads `p.length` / `p[i]`,
 * i.e. `target.[[Get]](k, p)` again. No other trap is consulted on that path,
 * so iterating the target directly is observably the same iteration. The arm
 * therefore re-enters `__iterator` with the target (a nested proxy takes this
 * arm again).
 *
 * Deliberately narrow: an array TARGET only (`__extern_is_array`, which also
 * unwraps a nested proxy) — an ordinary target's own `@@iterator` method must
 * see the PROXY as `this`, which re-entering with the target would not give
 * it. A revoked proxy, a handler that is itself a Proxy (conservatively
 * "trap present", see `proxyTrapAbsentTail`), or a present `get` trap keep
 * the existing OBJ arm, which performs the single observable trap read.
 */
import type { Instr } from "../../ir/types.js";
import type { CodegenContext } from "../context/types.js";
import { definedFuncAt } from "../func-space.js";
import { proxyTrapAbsentTail } from "./proxy-trap-read.js";

/** `$Proxy` field indices — duplicated from object-runtime-proxy.ts (ESM-cycle-free). */
const F_PTARGET = 1;
const F_REVOKED = 4;
/** `$ProxyTraps` field of the `get` trap. */
const TRAP_GET = 0;

/** FINALIZE (after `fillNativeIteratorLateArms` rebuilt `__iterator`): prepend the arm. */
export function prependProxyArrayGetIteratorArm(ctx: CodegenContext): void {
  // `proxyDirty`: the pre-scan saw the identifier `Proxy` (#6651 H6). A module
  // whose proxy runtime was reserved for any other reason keeps its bytes.
  if (!ctx.standalone || ctx.proxyDirty !== true) return;
  const proxyTypeIdx = ctx.objectRuntimeTypes?.proxyTypeIdx;
  const iteratorIdx = ctx.funcMap.get("__iterator");
  const isArrayIdx = ctx.funcMap.get("__extern_is_array");
  if (proxyTypeIdx === undefined || iteratorIdx === undefined || isArrayIdx === undefined) return;
  const fn = definedFuncAt(ctx, iteratorIdx);
  if (!fn) return;
  const target: Instr[] = [
    { op: "local.get", index: 0 },
    { op: "any.convert_extern" },
    { op: "ref.cast", typeIdx: proxyTypeIdx },
    { op: "struct.get", typeIdx: proxyTypeIdx, fieldIdx: F_PTARGET },
    { op: "extern.convert_any" },
  ];
  const arm: Instr[] = [
    { op: "local.get", index: 0 },
    { op: "any.convert_extern" },
    { op: "ref.test", typeIdx: proxyTypeIdx },
    {
      op: "if",
      blockType: { kind: "empty" },
      then: [
        { op: "local.get", index: 0 },
        { op: "any.convert_extern" },
        { op: "ref.cast", typeIdx: proxyTypeIdx },
        { op: "struct.get", typeIdx: proxyTypeIdx, fieldIdx: F_REVOKED },
        { op: "i32.eqz" },
        {
          op: "if",
          blockType: { kind: "empty" },
          then: [
            { op: "local.get", index: 0 },
            { op: "any.convert_extern" },
            { op: "ref.cast", typeIdx: proxyTypeIdx },
            ...proxyTrapAbsentTail(ctx, TRAP_GET),
            {
              op: "if",
              blockType: { kind: "empty" },
              then: [
                ...target,
                { op: "call", funcIdx: isArrayIdx },
                {
                  op: "if",
                  blockType: { kind: "empty" },
                  then: [...target.map((i) => ({ ...i })), { op: "call", funcIdx: iteratorIdx }, { op: "return" }],
                },
              ],
            },
          ],
        },
      ],
    },
  ];
  fn.body = [...arm, ...fn.body];
}
