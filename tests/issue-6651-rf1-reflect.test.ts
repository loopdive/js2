/**
 * #6651 lane RF1 — `Reflect.construct(proxy, args, NewTarget)` must deliver the
 * CALLER's NewTarget to the `construct` trap (§10.5.13 steps 8–9), and must keep
 * delivering the same one when the trap is absent and the proxy forwards to its
 * [[ProxyTarget]] (step 6b).
 *
 * Base behaviour on `--target standalone`: the general `Reflect.construct`
 * lowering performs the ordinary `new target(...)` and patches the result's
 * prototype afterwards. That shape cannot carry a NewTarget IDENTITY, and the
 * driver's proxy arm substituted the proxy itself ("Ordinary `new proxy(...)`
 * uses the proxy itself as NewTarget" in `native-construct.ts` — correct for
 * `new P()`, wrong here). With the trap absent it forwarded to [[ProxyTarget]]
 * and re-derived NewTarget from the INNER proxy, losing it a second time.
 *
 * Measured RED on the reverted sources (`.tmp/base-*.ts`), GREEN with the fix;
 * the four test262 rows this pins are
 * `built-ins/Proxy/construct/{call-parameters-new-target,trap-is-undefined,
 * trap-is-null,trap-is-undefined-no-property}.js`.
 *
 * The last two cases are CONTROLS: `new P()` (no Reflect.construct) must keep
 * using the proxy itself as NewTarget, and a non-proxy target must keep the
 * pre-existing construct-then-patch-prototype answer.
 */
import { describe, expect, it } from "vitest";
import { compile } from "../src/index.ts";

type Compiled = { success: boolean; binary: Uint8Array; errors?: unknown };

async function run(src: string): Promise<unknown> {
  const r = (await compile(src, { fileName: "t.ts", target: "standalone" })) as unknown as Compiled;
  expect(r.success, `compile failed: ${JSON.stringify(r.errors).slice(0, 400)}`).toBe(true);
  // Instantiating with NO import object is itself the host-free assertion.
  const { instance } = await WebAssembly.instantiate(r.binary, {});
  return (instance.exports as { test: () => unknown }).test();
}

describe("#6651 RF1 · Reflect.construct(proxy, args, NewTarget) threads NewTarget", () => {
  it("the construct trap receives the caller's NewTarget as its third argument", async () => {
    // built-ins/Proxy/construct/call-parameters-new-target.js
    const src = `function Target() {}
function NewTarget() {}
const handler: any = {
  construct: function (target: any, args: any, newTarget: any) {
    return { ok: (this === handler ? 1 : 0) + (target === Target ? 2 : 0) + (newTarget === NewTarget ? 4 : 0),
             sum: args[0] + args[1] };
  },
};
const P: any = new Proxy(Target, handler);
export function test(): number {
  const res: any = Reflect.construct(P, [1, 2], NewTarget);
  return res.ok * 10 + res.sum;
}`;
    expect(await run(src)).toBe(73);
  });

  it("an absent trap forwards to [[ProxyTarget]] with the SAME NewTarget", async () => {
    // built-ins/Proxy/construct/trap-is-undefined-no-property.js
    const src = `let calls = 0;
let seen: any = null;
const Inner: any = new Proxy(function () {}, {
  construct: function (_t: any, args: any, NT: any) {
    calls += 1;
    seen = NT;
    return { sum: args[0] + args[1] };
  },
});
const P: any = new Proxy(Inner, {});
const NewTarget = function () {};
export function test(): number {
  const obj: any = Reflect.construct(P, [3, 4], NewTarget);
  return calls * 1000 + (seen === NewTarget ? 100 : 0) + obj.sum;
}`;
    expect(await run(src)).toBe(1107);
  });

  it("a `construct: undefined` / `construct: null` trap is ABSENT, not a TypeError", async () => {
    // trap-is-undefined.js + trap-is-null.js — GetMethod treats both as absent.
    const src = `let seenU: any = null;
let seenN: any = null;
const TargetU: any = new Proxy(function () {}, { construct: function (_t: any, _a: any, NT: any) { seenU = NT; return {}; } });
const TargetN: any = new Proxy(function () {}, { construct: function (_t: any, _a: any, NT: any) { seenN = NT; return {}; } });
const PU: any = new Proxy(TargetU, { construct: undefined });
const PN: any = new Proxy(TargetN, { construct: null });
const NewTarget = function () {};
export function test(): number {
  Reflect.construct(PU, [], NewTarget);
  Reflect.construct(PN, [], NewTarget);
  return (seenU === NewTarget ? 10 : 0) + (seenN === NewTarget ? 1 : 0);
}`;
    expect(await run(src)).toBe(11);
  });

  it("CONTROL: `new P()` still uses the proxy itself as NewTarget", async () => {
    const src = `let seen: any = null;
const P: any = new Proxy(function () {}, {
  construct: function (_t: any, _a: any, NT: any) { seen = NT; return {}; },
});
export function test(): number {
  new P();
  return seen === P ? 1 : 0;
}`;
    expect(await run(src)).toBe(1);
  });

  it("CONTROL: a non-proxy target keeps the construct-then-patch-prototype answer", async () => {
    const src = `function Target(this: any) { this.v = 5; }
function NewTarget() {}
export function test(): number {
  const o: any = Reflect.construct(Target, [], NewTarget);
  return (o.v === 5 ? 10 : 0) + (Object.getPrototypeOf(o) === (NewTarget as any).prototype ? 1 : 0);
}`;
    expect(await run(src)).toBe(11);
  });
});
