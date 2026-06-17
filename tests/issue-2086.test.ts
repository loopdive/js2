// #2086 — cross-lane regression guard for implicit-derived-ctor synthesis.
//
// The rule "an implicit derived constructor forwards all args to super"
// (spec §15.7.14 — `constructor(...args) { super(...args); }`) is realized in
// THREE representation lanes that historically drifted apart: each point fix
// (#1833 externref-backed, #2082 WasmGC-struct, #2078 standalone) landed in one
// lane while the others stayed broken. This file pins the SAME forwarding
// behavior across all three lanes so a future change that breaks one lane fails
// here immediately, regardless of which lane the author was thinking about.
//
// Lane A — WasmGC-struct parent, JS-host mode (the #2082 lane)
// Lane B — externref-backed built-in parent (the #1833 lane)
// Lane C — standalone target, no `env` host imports (the #2078 lane)
import { describe, expect, it } from "vitest";

import { compile } from "../src/index.js";
import { buildImports, compileAndInstantiate } from "../src/runtime.js";

// Lane A: default WasmGC-struct path under JS host.
async function runHost(source: string): Promise<unknown> {
  const exports = await compileAndInstantiate(source);
  return (exports as { test: () => unknown }).test();
}

// Lane C: standalone — additionally assert NO `env::` host imports leaked, the
// invariant #2078 guards. A drift that re-routes the synthesized ctor through a
// host import would surface here.
async function runStandalone(source: string): Promise<number> {
  const r = await compile(source, { target: "standalone" });
  expect(r.success, r.errors.map((e) => e.message).join("\n")).toBe(true);
  const env = r.imports.filter((i) => i.module === "env").map((i) => i.name);
  expect(env, `standalone leaked env imports: ${env.join(", ")}`).toEqual([]);
  expect(WebAssembly.validate(r.binary), "module must be valid Wasm").toBe(true);
  const { instance } = await WebAssembly.instantiate(r.binary, {});
  return (instance.exports as Record<string, () => number>).test();
}

describe("#2086 implicit derived ctor forwards args — all three repr lanes", () => {
  // --- Lane A: WasmGC-struct parent, single forwarded arg (#2082 repro) ---
  it("Lane A (host struct): forwards a constructor arg through the implicit ctor", async () => {
    expect(
      await runHost(
        `class Animal { name: string; constructor(name: string){ this.name = name; } }
         class Dog extends Animal {}
         export function test(): string { return new Dog("rex").name; }`,
      ),
    ).toBe("rex");
  });

  it("Lane A (host struct): replays the parent ctor BODY assignment through the implicit ctor", async () => {
    expect(
      await runHost(
        `class Base { x: number; constructor(){ this.x = 7; } }
         class Sub extends Base {}
         export function test(): number { return new Sub().x; }`,
      ),
    ).toBe(7);
  });

  // --- Lane B: externref-backed built-in parent (#1833 repro) ---
  it("Lane B (externref built-in): forwards every arg to the built-in parent", async () => {
    expect(
      await runHost(
        `class Sub extends DataView {}
         export function test(): number {
           const buf = new ArrayBuffer(16);
           const view = new Sub(buf, 4, 4);
           return view.byteOffset;
         }`,
      ),
    ).toBe(4);
  });

  // --- Lane C: standalone target (#2078 repro), env-import-free ---
  it("Lane C (standalone): replays the parent ctor body assignment, no env leak", async () => {
    expect(
      await runStandalone(
        `class Base { x: number; constructor(){ this.x = 7; } }
         class Sub extends Base {}
         export function test(): number { return new Sub().x; }`,
      ),
    ).toBe(7);
  });

  it("Lane C (standalone): forwards a numeric ctor arg through the implicit ctor, no env leak", async () => {
    expect(
      await runStandalone(
        `class Base { v: number; constructor(v: number){ this.v = v; } }
         class Sub extends Base {}
         export function test(): number { return new Sub(42).v; }`,
      ),
    ).toBe(42);
  });
});
