// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { compile } from "../src/index.js";

// #3436 — Standalone universal harness-prelude host-import leak.
//
// The test262 "fyi" runtime prelude (`scripts/test262-fyi-runtime.js`) is
// prepended verbatim to EVERY test262 file. In standalone (`--target
// standalone`, no-JS-host) mode it used to leak two unsatisfiable `env.*` host
// imports that made every module fail to instantiate with `unknown import`:
//
//   1. `env.console_*` — the `print` shim's `console.log(value)` call.
//   2. `env.structuredClone` — the ambient global referenced by
//      `$262.detachArrayBuffer` (`typeof structuredClone !== "function"` guard
//      + call).
//
// Fix: don't register those host imports in standalone. `console.*` lowers to a
// native no-op sink (arguments evaluated for side effects, then dropped —
// test262 verdicts come from thrown exceptions, not printed output).
// `structuredClone` stays undefined, so `typeof structuredClone` is "undefined"
// and the shim's own guard throws the honest "unsupported by this host" error.

const preludePath = fileURLToPath(new URL("../scripts/test262-fyi-runtime.js", import.meta.url));
const PRELUDE = readFileSync(preludePath, "utf-8");

function envImports(r: Awaited<ReturnType<typeof compile>>): string[] {
  return r.imports.filter((i) => i.module === "env").map((i) => i.name);
}

async function standalone(src: string) {
  const r = await compile(src, { target: "standalone" });
  expect(r.success, r.errors.map((e) => e.message).join("\n")).toBe(true);
  return r;
}

describe("#3436 standalone harness-prelude host-import leak", () => {
  it("compiles the universal prelude + a trivial body with ZERO host imports", async () => {
    const r = await standalone(`${PRELUDE}\nexport function f(): number { return 1; }`);
    expect(envImports(r)).toEqual([]);
    // Instantiates host-free (the whole point — no `unknown import`).
    const { instance } = await WebAssembly.instantiate(r.binary, {});
    expect((instance.exports as { f: () => number }).f()).toBe(1);
  });

  it("emits no env.console_* import and lowers console.* to a side-effect-preserving no-op sink", async () => {
    const r = await standalone(`
      let c = 0;
      function bump(): number { c = c + 1; return c; }
      export function f(): number {
        console.log("literal", bump(), true);
        console.warn(bump());
        return c;
      }
    `);
    expect(envImports(r).filter((n) => n.startsWith("console_"))).toEqual([]);
    const { instance } = await WebAssembly.instantiate(r.binary, {});
    // Arguments are still evaluated (bump() ran twice) — the output is dropped,
    // not the side effects.
    expect((instance.exports as { f: () => number }).f()).toBe(2);
  });

  it('emits no env.structuredClone import; `typeof structuredClone` is "undefined"', async () => {
    const r = await standalone(
      `export function f(): number { return (typeof structuredClone === "function") ? 1 : 0; }`,
    );
    expect(envImports(r)).not.toContain("structuredClone");
    const { instance } = await WebAssembly.instantiate(r.binary, {});
    // Standalone has no structuredClone → typeof is "undefined" → 0.
    expect((instance.exports as { f: () => number }).f()).toBe(0);
  });

  it('throws the honest "unsupported" error on the $262.detachArrayBuffer guard path', async () => {
    const r = await standalone(`
      function detach(buffer: any): void {
        if (typeof structuredClone !== "function") {
          throw new Error("$262.detachArrayBuffer is unsupported by this host");
        }
        structuredClone(buffer);
      }
      export function f(): number { detach(null); return 1; }
    `);
    expect(envImports(r)).toEqual([]);
    const { instance } = await WebAssembly.instantiate(r.binary, {});
    // The guard fires (typeof is "undefined", not "function") → throws instead
    // of silently succeeding.
    expect(() => (instance.exports as { f: () => number }).f()).toThrow();
  });

  it('keeps a user-declared standalone `structuredClone` as "function"', async () => {
    const r = await standalone(`
      function structuredClone(x: number): number { return x; }
      export function f(): number { return (typeof structuredClone === "function") ? 1 : 0; }
    `);
    const { instance } = await WebAssembly.instantiate(r.binary, {});
    expect((instance.exports as { f: () => number }).f()).toBe(1);
  });

  it("host (gc) lane still registers the console + structuredClone host imports (byte-inert)", async () => {
    // The full prelude CALLS structuredClone (via $262.detachArrayBuffer) and
    // console.log (via print), so host mode must still emit both host imports —
    // proving the fix is standalone-scoped and did not regress the host lane.
    const r = await compile(`${PRELUDE}\nexport function f(): number { return 1; }`, { target: "gc" });
    expect(r.success, r.errors.map((e) => e.message).join("\n")).toBe(true);
    const env = envImports(r);
    expect(env).toContain("structuredClone");
    expect(env.some((n) => n.startsWith("console_"))).toBe(true);
  });
});
