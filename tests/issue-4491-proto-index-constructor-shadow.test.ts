// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * #4491 T10 — `constructor` must never fall through the #4176 receiver-aware
 * consult from a NON-Object brand into `Object.prototype`'s companion.
 *
 * ## The regression this pins
 *
 * T9 (`de32ec84f5`) seeded `constructor` into the #2175 companion of every
 * builtin prototype with an identity-stable carrier — correctly, and that is
 * what made `Object.prototype.constructor` reflectively visible. `Function`
 * and `Date` DECLINE the seed (no carrier), so their companions stay absent,
 * and `__protoidx_get_k`'s two-level walk (brand companion, then Object's)
 * then answered `Object` for a callable receiver's `constructor`.
 *
 * That single wrong answer took down the whole QuickJS eval provider: the
 * function-parity canary in `scripts/build-quickjs-eval-provider.mjs` asserts
 * `new Function(…).constructor === Function`, the read goes through
 * `__closure_prop_get`'s miss consult, and the non-undefined `Object` it
 * started returning SHADOWED the runtime-eval carrier's own marker
 * `constructor` field (the provider realm's `%Function%`). The canary went
 * 11 → 1 and `npx tsx scripts/build-quickjs-eval-provider.mjs` exited 1, which
 * strands every `JS2WASM_EVAL_ENGINE=quickjs` row for every lane.
 *
 * ## What the fix says
 *
 * A MISS is the correct answer at that level. Every builtin prototype owns
 * `constructor` (§19.2.3.1 / §20.2.3.1 / §22.1.3.1 / …), so the nearer level
 * always shadows `Object.prototype` — a brand whose companion has no seed must
 * fall through to the CALLER's own fallback (the carrier's marker metadata,
 * #4442's `%Function%` arm), never to `Object`.
 */
import { describe, expect, it } from "vitest";
import { compile } from "../src/index.js";

async function runStandalone(source: string): Promise<unknown> {
  const result = await compile(source, { target: "standalone" });
  expect(result.success, `Compile failed:\n${result.errors.map((e) => `  L${e.line}: ${e.message}`).join("\n")}`).toBe(
    true,
  );
  expect(WebAssembly.validate(result.binary!), "module must be valid Wasm").toBe(true);
  const { instance } = await WebAssembly.instantiate(result.binary!, {});
  return (instance.exports as { main: () => unknown }).main();
}

describe("#4491 T10 — `constructor` does not leak from Object.prototype's companion", () => {
  // The regression itself. Measured 1 (i.e. `Object`) with the T9 seed and
  // without the guard; the receiver is `any` so the read goes through the
  // RUNTIME consult rather than #4442's static `<fn>.constructor` arm.
  //
  // The `Object.prototype` write is LOAD-BEARING, not decoration: the #2175
  // companion is materialized lazily, so a module that never touches
  // `Object.prototype` has no companion for the second probe to find and the
  // leak does not reproduce. Measured both ways on `de32ec84f5`..HEAD: without
  // the write this returns 0 on base as well (nothing to leak); with it, base
  // returns 1.
  it("a dynamically-typed function value's constructor is not Object", async () => {
    expect(
      await runStandalone(`
        export function main(): number {
          (Object.prototype as any).zzzT10a = 1;
          const g: any = function (): void {};
          return (g.constructor === Object) ? 1 : 0;
        }
      `),
    ).toBe(0);
  });

  // T9's capability, which the guard must NOT take away: for an ordinary
  // object the FIRST probe is already Object's companion, so no fallthrough is
  // involved and the seeded entry still answers.
  it("a plain object's constructor is still Object", async () => {
    expect(
      await runStandalone(`
        export function main(): number {
          const o: any = {};
          return (o.constructor === Object) ? 1 : 0;
        }
      `),
    ).toBe(1);
  });

  // A brand WITH a seed keeps answering from its own companion — the guard
  // only suppresses the second (Object) probe.
  it("a builtin prototype's own constructor still answers its own brand", async () => {
    expect(
      await runStandalone(`
        export function main(): number {
          const p: any = Error.prototype;
          return (p.constructor === Error) ? 1 : 0;
        }
      `),
    ).toBe(1);
  });

  // An array receiver classifies as the Array brand. `a.constructor === Array`
  // is NOT yet true on this tree (measured 0 on both sides of this change — the
  // #4220 vec arm and the companion answer are different objects, a separate
  // defect), so what is pinned here is the property this guard owns: it must
  // never be `Object`.
  it("an array's constructor is not Object", async () => {
    expect(
      await runStandalone(`
        export function main(): number {
          (Object.prototype as any).zzzT10b = 1;
          const a: any = [1, 2, 3];
          return (a.constructor === Object) ? 1 : 0;
        }
      `),
    ).toBe(0);
  });

  // Ordinary inherited NAMED keys are untouched — the guard is keyed on
  // `constructor` alone, so #4176's whole reason for existing still holds.
  it("an unrelated Object.prototype key still reaches a function value", async () => {
    expect(
      await runStandalone(`
        export function main(): number {
          (Object.prototype as any).zzzT10 = 7;
          const g: any = function (): void {};
          return g.zzzT10;
        }
      `),
    ).toBe(7);
  });
});
