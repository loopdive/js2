// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #2620 (gc/host arm) — inherited collection methods on a builtin-collection
// subclass must actually MUTATE the instance in the default `--target gc`
// JS-host lane.
//
// ## What was wrong
//
// #2620's resolution note states that its standalone refusal leaves "gc/host
// mode untouched — the externClass host path still compiles the subclass
// there". It does compile there. It also silently computed the wrong answer:
//
//   | operation on `class R extends Map {}`     | expected | measured on main |
//   | ----------------------------------------- | -------- | ---------------- |
//   | `m.set("k", 7)` then `m.get("k")`         | 7        | undefined        |
//   | `m.set(a,1); m.set(b,2)` then `m.size`    | 2        | 0                |
//   | `m.set("a", 1)` then `m.has("a")`         | true     | false            |
//   | `class B extends Set {}`, `add` then size | 2        | 0                |
//
// No diagnostic, no trap, valid Wasm — the mutation was simply dropped, so the
// reads then faithfully reported an empty collection. That is strictly worse
// than the standalone lane, which refuses the same program loudly (#2620).
//
// ## Mechanism
//
// `compileReceiverMethodCall` (src/codegen/expressions/call-receiver-method.ts)
// coerced an externref receiver to the receiver class's struct type whenever
// such a struct existed, regardless of what the callee expected. For a
// builtin-collection subclass the instance is a REAL host `Map`/`Set` produced
// by the `__new_Map`/`__new_Set` import — never a `$R` struct — so
// `emitGuardedRefCast` always failed, produced null, and the ref_null
// null-guard returned the default instead of emitting the call:
//
//   ref.test (ref $R)
//   (if (result externref)
//     (then ref.null extern)          ;; <- receiver "wrong struct type", call DROPPED
//     (else … call $Map_set_import))
//
// The cast was pointless even on paper: the callee is a host import taking
// `externref` self, so the very next coercion converted the struct straight
// back with `extern.convert_any`. It could only ever destroy the receiver.
//
// The fix gates that coercion on the callee's declared param type — coerce only
// when the method actually expects a struct. Genuine struct-receiver calls,
// including own methods of externref-backed classes, keep the guarded-cast path.
//
// ## Non-vacuity
//
// Every subclass rung is paired with a PLAIN-collection control performing the
// identical operations. The controls passed before the fix too; if one of them
// ever goes red the harness is broken, not the subclass path — which is the
// distinction that makes the subclass rungs meaningful.

import { describe, expect, it } from "vitest";

import { compileAndRunTestSyncNumber } from "./helpers/compile.js";

describe("#2620 (gc/host) — plain-collection controls", () => {
  it("plain Map set + get", async () => {
    expect(
      await compileAndRunTestSyncNumber(`
const m = new Map<string, number>();
m.set("k", 7);
export function test(): number { return m.get("k") ?? -1; }
`),
    ).toBe(7);
  });

  it("plain Map size", async () => {
    expect(
      await compileAndRunTestSyncNumber(`
const m = new Map<string, number>();
m.set("a", 1); m.set("b", 2);
export function test(): number { return m.size; }
`),
    ).toBe(2);
  });

  it("plain Set add + size", async () => {
    expect(
      await compileAndRunTestSyncNumber(`
const s = new Set<number>();
s.add(1); s.add(2);
export function test(): number { return s.size; }
`),
    ).toBe(2);
  });
});

describe("#2620 (gc/host) — inherited collection methods mutate the subclass instance", () => {
  it("Map subclass: set is not dropped — get reads it back", async () => {
    expect(
      await compileAndRunTestSyncNumber(`
class R extends Map<string, number> {}
const m = new R();
m.set("k", 7);
export function test(): number { return m.get("k") ?? -1; }
`),
      "inherited `set` on a Map subclass was dropped again (guarded cast is back on a host-import callee)",
    ).toBe(7);
  });

  it("Map subclass: size reflects inherited sets", async () => {
    expect(
      await compileAndRunTestSyncNumber(`
class R extends Map<string, number> {}
const m = new R();
m.set("a", 1); m.set("b", 2);
export function test(): number { return m.size; }
`),
    ).toBe(2);
  });

  it("Map subclass: has sees an inherited set", async () => {
    expect(
      await compileAndRunTestSyncNumber(`
class R extends Map<string, number> {}
const m = new R();
m.set("a", 1);
export function test(): number { return m.has("a") ? 1 : 0; }
`),
    ).toBe(1);
  });

  it("Set subclass: add is not dropped", async () => {
    expect(
      await compileAndRunTestSyncNumber(`
class B extends Set<number> {}
const s = new B();
s.add(1); s.add(2);
export function test(): number { return s.size; }
`),
    ).toBe(2);
  });

  it("a subclass OWN method still resolves (the guarded-cast path is not broken)", async () => {
    expect(
      await compileAndRunTestSyncNumber(`
class R extends Map<string, number> { own(): number { return 42; } }
const m = new R();
export function test(): number { return m.own(); }
`),
    ).toBe(42);
  });

  it("keeps inherited collection calls on this inside an own method", async () => {
    expect(
      await compileAndRunTestSyncNumber(`
class R extends Map<string, number> {
  seed(): void { this.set("x", 3); }
}
const m = new R();
m.seed();
m.set("y", 4);
export function test(): number { return (m.get("x") ?? 0) * 10 + (m.get("y") ?? 0) + m.size * 100; }
`),
    ).toBe(234);
  });
});
