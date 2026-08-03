// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #4034 — the native-string prelude must not register as user array usage.
//
// Before the fix, `ensureNativeStringHelpers` (emitted for essentially every
// module, because the compiler interns "undefined") emitted `split`, whose
// result-array vec type flipped `ctx.usesVecValue`. That gated the `__vec_*`
// host-bridge exports → whose emission registered the `$exc` tag → which gated
// `__exn_render_*` → which pulled `__any_to_string` → `number_toString` → Ryu
// and its ~12.6 kB of constant tables. An arith-only standalone module paid
// ~21 kB of exports wasm-opt cannot strip, because exports are GC roots.
//
// The two directions that matter are asserted together on purpose: shrinking
// the no-array case is only correct if the genuine-array cases keep their
// bridge exports.

import { describe, expect, it } from "vitest";
import { compile } from "../src/index.js";

// (#4035) These cases assert on the presence/absence of the host-bridge
// exports, which is now a POLICY decision — standalone defaults to omitting
// them. Pin `hostBridge: "always"` so this file keeps testing what it was
// written to test: whether the string prelude fabricates *array usage*. With
// the bridge off by default the bridge-presence assertions below would pass
// vacuously and stop guarding #4034 at all.
const STANDALONE = {
  target: "wasi",
  nativeStrings: true,
  optimize: 3,
  hostBridge: "always",
} as const;

async function compileStandalone(source: string) {
  const result = await compile(source, {
    fileName: "issue-4034.js",
    ...STANDALONE,
  });
  expect(result.success, result.errors?.[0]?.message).toBe(true);
  const binary = result.binary as Uint8Array;
  // Export names are plain bytes in the export section; substring search over a
  // latin1 view is enough to tell whether a bridge export was emitted.
  const bytes = Buffer.from(binary).toString("latin1");
  return {
    size: binary.length,
    hasVecBridge: bytes.includes("__vec_get"),
    hasExnRender: bytes.includes("__exn_render_prepare"),
  };
}

describe("#4034 standalone prelude does not fabricate array usage", () => {
  it("keeps an arith-only module small instead of pulling the whole runtime", async () => {
    const { size, hasVecBridge, hasExnRender } = await compileStandalone("export function run(n){return n;}");

    // Was 21,043 bytes before the fix. The bound is deliberately loose — this
    // guards the cascade, not a byte count.
    expect(size).toBeLessThan(5_000);
    expect(hasVecBridge).toBe(false);
    expect(hasExnRender).toBe(false);
  });

  it("keeps the landing fib benchmark small", async () => {
    // The shape the landing-page Module-size chart measures.
    const { size } = await compileStandalone(`
      /** @param {number} n @returns {number} */
      export function run(n) {
        let a = 0;
        let b = 1;
        for (let i = 0; i < n; i++) {
          const next = (a + b) | 0;
          a = b;
          b = next;
        }
        return a | 0;
      }
    `);

    expect(size).toBeLessThan(5_000); // was 21,774
  });

  it("still emits the vec host bridge when an array crosses the module boundary", async () => {
    const literal = await compileStandalone("export function run(){return [1,2,3];}");
    expect(literal.hasVecBridge).toBe(true);

    // A `split` result returned to the caller is a real array crossing the
    // boundary — the case the suppression must NOT swallow.
    const split = await compileStandalone("export function run(){return 'a,b'.split(',');}");
    expect(split.hasVecBridge).toBe(true);
  });

  it("still emits the exception renderer for a module that really throws", async () => {
    const { hasExnRender } = await compileStandalone(
      "export function run(n){ if (n < 0) throw new TypeError('neg'); return n; }",
    );
    expect(hasExnRender).toBe(true);
  });

  it("does not disturb the js-host lane's vec bridge", async () => {
    // The cascade is standalone-only (js-host stringifies through the host, so
    // no Ryu, no renderer). Measured byte-identical across 14 shapes when the
    // fix landed; asserted here as the property that actually matters — a
    // js-host array user still exports the bridge `src/runtime.ts` needs to
    // materialize the array for its JS caller.
    for (const [source, expectBridge] of [
      ["export function run(n){return n;}", false],
      ["export function run(){return [1,2,3];}", true],
      ["export function run(){return 'a,b'.split(',');}", true],
    ] as const) {
      const result = await compile(source, {
        fileName: "issue-4034-host.js",
        optimize: 3,
      });
      expect(result.success).toBe(true);
      const bytes = Buffer.from(result.binary as Uint8Array).toString("latin1");
      expect(bytes.includes("__vec_get"), source).toBe(expectBridge);
      // js-host was never anywhere near the standalone floor.
      expect((result.binary as Uint8Array).length).toBeLessThan(2_000);
    }
  });
});
