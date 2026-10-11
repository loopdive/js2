// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * #6651 slice U1b — re-land U1's realm-global seeds without the Temporal trap.
 *
 * U1 seeded `String Boolean Number Date RegExp Map Set WeakMap WeakSet` on the
 * standalone realm global of a runtime-eval module. That alone turned 158
 * standalone `built-ins/Temporal/**` rows into `RuntimeError: illegal cast in
 * __call_fn_method_1`, so the seeds were reverted (PR #6504 park).
 *
 * ROOT CAUSE (measured on `Temporal/Duration/prototype/round/
 * balance-subseconds.js`, linked standalone provider, in-process). The
 * polyfill's `n.toPrecision(o)` misses in the provider and takes the #6605
 * reverse method-call hop into the consumer, which resolves it to the
 * PROVIDER's `Number.prototype.toPrecision` closure. The consumer's
 * `__call_fn_method_1` claims native-prototype closures by a `ref.test` on
 * the per-(brand, member) meta struct plus an exact `bfnid` compare — and the
 * `bfnid` is a MODULE-LOCAL type index. Meta structs are structurally equal in
 * every module, so the provider's closure (bfnid 719) passed the family test,
 * and with `Set` seeded the consumer's own `Set.prototype.values` meta type was
 * ALSO index 719. The arm cast the `(self, this, arg)` funcref to `values`'
 * `(self, this)` signature and trapped. Unseeded, nothing local was 719 and the
 * foreign closure fell through to the funcref-type ladder, which is correct.
 *
 * THE FIX (`linkedSignatureGuard`, now in `builtin-fn-meta.ts` — #6651 V0): in a
 * canonically linked module the claim additionally requires the funcref to
 * have the entry's exact signature. A same-signature collision is harmless —
 * the arm calls through field 0, the peer's own function. Unlinked modules
 * keep their bytes.
 *
 * Eval-free: the seed case needs a runtime-eval MODULE (the seed list is gated
 * on one), so `never()` carries an `eval` call that is never executed; the
 * module has no imports and no evaluator runs.
 */
import { describe, expect, it } from "vitest";
import { compile } from "../src/index.js";

const SEEDED = ["String", "Boolean", "Number", "Date", "RegExp", "Map", "Set", "WeakMap", "WeakSet"];

async function runStandalone(source: string): Promise<number> {
  const result = await compile(source, { target: "standalone", skipSemanticDiagnostics: true });
  expect(result.success, result.errors.map((error) => error.message).join("\n")).toBe(true);
  expect(result.imports).toEqual([]);
  const { instance } = await WebAssembly.instantiate(result.binary, {});
  return (instance.exports.run as () => number)();
}

const EVAL_MODULE_TAIL = `\nexport function never(): any { return eval("1"); }\n`;

describe("#6651 U1b — realm-global seeds in a runtime-eval module", () => {
  it("exposes the nine constructors as realm-global properties", async () => {
    await expect(
      runStandalone(
        `declare const globalThis: any;
        export function run(): number {
          const g: any = globalThis;
          const names = ${JSON.stringify(SEEDED)};
          let n = 0;
          for (let i = 0; i < names.length; i++) if (g[names[i]] !== undefined && g[names[i]] !== null) n |= 1 << i;
          return n;
        }` + EVAL_MODULE_TAIL,
      ),
    ).resolves.toBe((1 << SEEDED.length) - 1);
  });

  it("seeds the same carrier the bare identifier reads", async () => {
    await expect(
      runStandalone(
        `declare const globalThis: any;
        export function run(): number {
          const g: any = globalThis;
          let n = 0;
          if (g.String === String) n |= 1;
          if (g.Boolean === Boolean) n |= 2;
          if (g.Number === Number) n |= 4;
          if (g.Date === Date) n |= 8;
          if (g.RegExp === RegExp) n |= 16;
          if (g.Map === Map) n |= 32;
          if (g.Set === Set) n |= 64;
          if (g.WeakMap === WeakMap) n |= 128;
          if (g.WeakSet === WeakSet) n |= 256;
          return n;
        }` + EVAL_MODULE_TAIL,
      ),
    ).resolves.toBe(511);
  });

  it("reaches the realm prototype through a member-read realm global (proto-from-ctor-realm shape)", async () => {
    // The `$262.createRealm().global` shim builds its realm object from MEMBER
    // reads off `globalThis`; before the seeds `other.Map` was undefined and the
    // row died on `undefined.prototype`.
    await expect(
      runStandalone(
        `declare const globalThis: any;
        export function run(): number {
          const other: any = { Map: globalThis.Map, Set: globalThis.Set, Date: globalThis.Date };
          let n = 0;
          if (other.Map !== undefined && other.Map.prototype === Map.prototype) n |= 1;
          if (other.Set !== undefined && other.Set.prototype === Set.prototype) n |= 2;
          if (other.Date !== undefined && other.Date.prototype === Date.prototype) n |= 4;
          return n;
        }` + EVAL_MODULE_TAIL,
      ),
    ).resolves.toBe(7);
  });
});

describe("#6651 U1b — linked modules do not claim a peer closure by bfnid alone", () => {
  // Two transferred native-prototype methods, so `__call_fn_method_1` has
  // bfnid arms with different signatures.
  const SOURCE = `
    export function run(): number {
      const o: any = { v: 1 };
      o.p = String.prototype.charAt;
      o.s = Set.prototype.has;
      const r: any = o.p.call("abc", 1);
      return r === "b" ? 1 : 0;
    }`;

  const BFNID_ARM =
    /struct\.get (\d+) 4\s+i32\.const \1\s+i32\.eq\s+(local\.get \d+\s+(?:any\.convert_extern\s+)?ref\.cast \(ref \1\)\s+struct\.get \1 0\s+ref\.test \(ref \d+\)\s+i32\.and)?/g;

  async function dispatcherArms(canonicalRuntimeTypes: boolean): Promise<{ arms: number; guarded: number }> {
    const result = await compile(SOURCE, {
      target: "standalone",
      skipSemanticDiagnostics: true,
      emitWat: true,
      canonicalRuntimeTypes,
    } as never);
    expect(result.success, result.errors.map((error) => error.message).join("\n")).toBe(true);
    const wat = (result as { wat?: string }).wat ?? "";
    const start = wat.indexOf("(func $__call_fn_method_1 ");
    expect(start).toBeGreaterThanOrEqual(0);
    const end = wat.indexOf("\n  (func ", start + 1);
    const body = wat.slice(start, end < 0 ? undefined : end);
    let arms = 0;
    let guarded = 0;
    for (const match of body.matchAll(BFNID_ARM)) {
      arms++;
      if (match[2] !== undefined) guarded++;
    }
    return { arms, guarded };
  }

  it("guards every bfnid arm with the entry's funcref signature when canonically linked", async () => {
    const linked = await dispatcherArms(true);
    expect(linked.arms).toBeGreaterThanOrEqual(2);
    expect(linked.guarded).toBe(linked.arms);
  });

  it("leaves an unlinked module's arms unguarded (bytes unchanged)", async () => {
    const unlinked = await dispatcherArms(false);
    expect(unlinked.arms).toBeGreaterThanOrEqual(2);
    expect(unlinked.guarded).toBe(0);
  });

  it("still dispatches a transferred native-prototype method in a linked module", async () => {
    const result = await compile(SOURCE, {
      target: "standalone",
      skipSemanticDiagnostics: true,
      canonicalRuntimeTypes: true,
    } as never);
    expect(result.success).toBe(true);
    const { instance } = await WebAssembly.instantiate(result.binary, {});
    expect((instance.exports.run as () => number)()).toBe(1);
  });
});
