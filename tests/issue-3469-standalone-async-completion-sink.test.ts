// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import { describe, expect, it } from "vitest";
import { compile } from "../src/index.js";

// #3469 — Standalone async tests: originalHarness completion marker unobservable
// host-free (channel + drain gate).
//
// On `--target standalone` there is no host `console` import (kept out so the
// #2961 import-leak gate stays green) and no `fd_write` (unlike WASI), so
// `console.log`/`print` lowered to a pure no-op (#3436). The test262 async
// completion marker (`$DONE → print → console.log("Test262:AsyncTestComplete")`)
// therefore went nowhere and every host-free async test timed out with
// `async completion marker not observed` (~2,024 tests).
//
// Fix: a native host-free GC-string output sink — `console.log`/`print` append
// their rendered arguments to an in-module `$AnyString` accumulator; the runner
// drains the microtask ring (`__drain_microtasks`) so async continuations run,
// then reads the accumulated output back via the `__stdout_prepare`/
// `__stdout_char` exports. Stays 100% host-free (WasmGC), so #2961 still holds.

type Compiled = Awaited<ReturnType<typeof compile>>;

async function compileStandalone(src: string): Promise<Compiled> {
  const r = await compile(src, {
    fileName: "test.js",
    allowJs: true,
    skipSemanticDiagnostics: true,
    target: "standalone",
    hostBridge: "always",
  });
  expect(r.success, r.errors.map((e) => e.message).join("\n")).toBe(true);
  return r;
}

function envImports(r: Compiled): string[] {
  return r.imports.filter((i) => i.module === "env").map((i) => i.name);
}

/** Drain microtasks (if async) and read the in-module stdout sink, host-free. */
function drainAndReadSink(instance: WebAssembly.Instance): string {
  const exp = instance.exports as Record<string, any>;
  if (typeof exp.__drain_microtasks === "function") exp.__drain_microtasks();
  if (typeof exp.__stdout_prepare !== "function" || typeof exp.__stdout_char !== "function") {
    return "<no sink exports>";
  }
  const len = exp.__stdout_prepare() | 0;
  let out = "";
  for (let i = 0; i < len; i++) out += String.fromCharCode(exp.__stdout_char(i) & 0xffff);
  return out;
}

describe("#3469 standalone host-free console/print output sink", () => {
  it("captures a synchronous console.log marker with ZERO host imports", async () => {
    const r = await compileStandalone(`console.log("Test262:AsyncTestComplete");`);
    expect(envImports(r)).toEqual([]);
    const { instance } = await WebAssembly.instantiate(r.binary, {});
    expect(drainAndReadSink(instance)).toContain("Test262:AsyncTestComplete");
  });

  it("drives an async .then/await continuation to the completion marker host-free", async () => {
    // The load-bearing case: the marker is printed from a continuation on the
    // in-module microtask ring, which only runs once `__drain_microtasks` is
    // called — exactly what the runner now does on the standalone lane.
    const r = await compileStandalone(`
      async function run() {
        await Promise.resolve(1);
        console.log("Test262:AsyncTestComplete");
      }
      run();
    `);
    expect(envImports(r)).toEqual([]);
    const { instance } = await WebAssembly.instantiate(r.binary, {});
    // Before draining, the continuation has not run → no marker.
    const exp = instance.exports as Record<string, any>;
    expect(typeof exp.__drain_microtasks).toBe("function");
    // After draining, the marker is observable.
    expect(drainAndReadSink(instance)).toContain("Test262:AsyncTestComplete");
  });

  it("captures a string-typed failure marker built by concatenation", async () => {
    const r = await compileStandalone(`
      let e = { name: "TypeError", message: "boom" };
      console.log("Test262:AsyncTestFailure: " + e.name + ": " + e.message);
    `);
    expect(envImports(r)).toEqual([]);
    const { instance } = await WebAssembly.instantiate(r.binary, {});
    const out = drainAndReadSink(instance);
    expect(out).toContain("Test262:AsyncTestFailure");
    expect(out).toContain("TypeError");
    expect(out).toContain("boom");
  });

  it("does NOT leak a host import for object/any console.log arguments (#2961 gate holds)", async () => {
    // Object/any args would hit emitToString's dynamic-externref arm
    // (`__extern_toString`, a host import). They must be compiled-and-dropped
    // instead so the standalone binary stays host-free.
    const r = await compileStandalone(`
      const o = { a: 1 };
      function f(x) { console.log(x); }
      console.log(o);
      f(o);
    `);
    expect(envImports(r)).toEqual([]);
    // Still instantiates + runs clean (the object args are dropped host-free).
    const { instance } = await WebAssembly.instantiate(r.binary, {});
    expect(() => drainAndReadSink(instance)).not.toThrow();
  });

  it("only emits the sink exports for console-using standalone modules", async () => {
    const withConsole = await compileStandalone(`console.log("x");`);
    const wc = await WebAssembly.instantiate(withConsole.binary, {});
    expect(typeof (wc.instance.exports as Record<string, any>).__stdout_prepare).toBe("function");

    const noConsole = await compileStandalone(`function f() { return 1; } f();`);
    const nc = await WebAssembly.instantiate(noConsole.binary, {});
    expect((nc.instance.exports as Record<string, any>).__stdout_prepare).toBeUndefined();
    expect((nc.instance.exports as Record<string, any>).__stdout_char).toBeUndefined();
  });

  it("separates multiple console.log calls with newlines", async () => {
    const r = await compileStandalone(`
      console.log("first");
      console.log("second");
    `);
    const { instance } = await WebAssembly.instantiate(r.binary, {});
    const out = drainAndReadSink(instance);
    const lines = out.split("\n").filter((l) => l.length > 0);
    expect(lines).toContain("first");
    expect(lines).toContain("second");
  });
});
