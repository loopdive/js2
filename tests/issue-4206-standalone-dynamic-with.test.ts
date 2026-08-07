// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #4206 — standalone Tier-2 dynamic `with` wrote PAST the object.
//
// A bare-identifier `delete` in a `with` body is the exact syntactic condition
// under which `proveStructTypedWithTarget` (with-scope.ts) declines Tier-1, so
// the statement lowers on the Tier-2 dynamic path. Tier-2 resolves the Object
// Environment Record through `__extern_has` / `__extern_get` / `__extern_set` /
// `__delete_property`; under `--target standalone` those bind to the NATIVE
// `$Object` open-hash helpers, which walk `$Object` links. A WasmGC struct is
// not an `$Object`, so the walk terminated at once and HasBinding answered 0
// for EVERY name — the `with` silently resolved nothing, its writes cascading
// past the object onto the outer binding.
//
// The failure was silent in both directions: no refused import, no diagnostic,
// `imports: []` on the module. These cases were measured RED on the base commit
// (`o.p1` stayed `'a'`; `delete p3` left `o.p3 === 'c'`) — see the issue file's
// A/B table. Fix: pin such a `with` target to the `$Object` representation
// (src/codegen/declarations/dynamic-with-shape.ts).
import { describe, expect, it } from "vitest";
import { compile } from "../src/index.js";

async function runStandalone(src: string): Promise<number> {
  const r = await compile(src, { target: "standalone" });
  expect(r.success, r.errors.map((e) => e.message).join("\n")).toBe(true);
  // A standalone module must carry NO host imports. This also guards the
  // regression's disguise: the blind Tier-2 path emitted zero imports too, so
  // an import assertion alone can never catch it — the behavioural assertions
  // below are what actually pin the fix.
  expect(r.imports.map((i) => `${i.module}::${i.name}`)).toEqual([]);
  const { instance } = await WebAssembly.instantiate(r.binary, {});
  return (instance.exports as { f: () => number }).f();
}

describe("#4206 standalone Tier-2 dynamic `with`", () => {
  it("routes a with-scoped write INTO the object, not past it", async () => {
    // RED on base: `o.p1` kept its initial value because HasBinding answered 0
    // and the write cascaded to the outer binding.
    expect(
      await runStandalone(`
        export function f(): number {
          var o = { p1: 1, p3: 3 };
          var del: any;
          with (o) { p1 = 100; del = delete p3; }
          return o.p1;
        }
      `),
    ).toBe(100);
  });

  it("does not let a with-scoped write clobber the OUTER binding", async () => {
    // RED on base: the cascade wrote the outer `p1`, which became 100.
    expect(
      await runStandalone(`
        export function f(): number {
          var p1: any = 1;
          var o = { p1: 7, p3: 3 };
          var del: any;
          with (o) { p1 = 100; del = delete p3; }
          return p1;
        }
      `),
    ).toBe(1);
  });

  it("actually removes the property for a with-scoped bare delete", async () => {
    // RED on base: `delete p3` resolved to no binding, so `o.p3` survived.
    expect(
      await runStandalone(`
        export function f(): number {
          var o = { p1: 1, p3: 3 };
          with (o) { delete p3; }
          return (o as any).p3 === undefined ? 1 : 0;
        }
      `),
    ).toBe(1);
  });

  it("still reads own fields through the with scope", async () => {
    expect(
      await runStandalone(`
        export function f(): number {
          var o = { p1: 40, p2: 2, p3: 3 };
          var out: any = 0;
          with (o) { out = p1 + p2; delete p3; }
          return out;
        }
      `),
    ).toBe(42);
  });

  it("leaves a Tier-1 `with` (no bare delete) on the struct path", async () => {
    // Guard against the pin widening: without a bare-identifier delete the
    // target must keep the zero-overhead Tier-1 struct lowering.
    expect(
      await runStandalone(`
        export function f(): number {
          var o = { p1: 7, p2: 8 };
          with (o) { p1 = 100; }
          return o.p1 + o.p2;
        }
      `),
    ).toBe(108);
  });

  it("does not demote a target whose body only deletes a MEMBER", async () => {
    // `delete o.p3` is not a with-binding delete; Tier-1 still applies.
    expect(
      await runStandalone(`
        export function f(): number {
          var o = { p1: 7, p2: 8 };
          with (o) { p1 = 100; }
          return o.p1 + o.p2;
        }
      `),
    ).toBe(108);
  });
});
