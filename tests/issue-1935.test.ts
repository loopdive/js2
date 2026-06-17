// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * #1935 — Retire the undefined-as-sentinel protocol in the property-getter
 * lookup path of runtime.ts.
 *
 * `safeGetField`/`invokeGetter` used `undefined` as the in-band "no getter"
 * signal (`const v = invokeGetter(g); if (v !== undefined) return v;`). That
 * conflates two distinct outcomes: "no getter is callable" (a genuine miss →
 * fall through) versus "the getter RAN and returned `undefined`" (a hit → the
 * accessor's value IS undefined). The fix introduces a unique `_MISS` sentinel
 * (unified with the existing ToPrimitive `_PRIM_ABSENT`): `invokeGetter`
 * returns `_MISS` only when nothing was callable, and the call sites test
 * `!== _MISS`, so an accessor returning `undefined` is correctly a hit.
 *
 * These are differential tests via `assertEquivalent` (compile+run vs V8). They
 * cover the accessor-property cases the sentinel fix governs directly — an
 * accessor that returns `undefined` must read back as `undefined`, and a
 * value-returning accessor must be unaffected.
 *
 * NOT in scope here (tracked by #1934 — "the four lookup paths must agree"):
 * the *precedence* between a Wasm struct field and a same-named accessor
 * installed over it. That precedence question is orthogonal to the sentinel
 * retirement and is its own issue.
 */
import { describe, it } from "vitest";
import { assertEquivalent } from "./equivalence/helpers.js";

describe("#1935 — undefined-returning accessor reads back as undefined", () => {
  it("Object.defineProperty getter returning a real value works (no regression)", async () => {
    await assertEquivalent(
      `
      export function test(): number {
        const o: any = {};
        Object.defineProperty(o, "x", { get() { return 99; }, configurable: true });
        return o.x;
      }
      `,
      [{ fn: "test", args: [] }],
    );
  });

  it("object-literal getter returning undefined → typeof is 'undefined'", async () => {
    await assertEquivalent(
      `
      export function test(): string {
        const o = { get v(): any { return undefined; } };
        return typeof o.v;
      }
      `,
      [{ fn: "test", args: [] }],
    );
  });

  it("a getter returning 0 is not misread as a miss (0 is a real value)", async () => {
    await assertEquivalent(
      `
      export function test(): number {
        const o: any = {};
        Object.defineProperty(o, "z", { get() { return 0; }, configurable: true });
        return o.z;
      }
      `,
      [{ fn: "test", args: [] }],
    );
  });

  it("class instance accessor returning a value reads correctly", async () => {
    await assertEquivalent(
      `
      class C { get doubled(): number { return 21 * 2; } }
      export function test(): number { return new C().doubled; }
      `,
      [{ fn: "test", args: [] }],
    );
  });
});
