// #1501 — Browser timer host imports.
//
// Bare-identifier calls to `setTimeout`, `setInterval`, `clearTimeout`, and
// `clearInterval` are now wired to the JS host. `preprocessImports` injects
// a thin TS shim that re-routes the calls to `__timer_*` host imports, and
// `runtime.resolveImport` binds them to `globalThis.{set,clear}{Timeout,
// Interval}` — bridging WasmGC closures through `_wrapWasmClosure`
// (`__call_fn_0` export) so the callback actually fires in the host event
// loop.
import { describe, it, expect } from "vitest";
import { compile, buildImports } from "../src/index.js";
import { getDefaultEnvironment, setDefaultEnvironment } from "../src/env.js";
import { preprocessImports } from "../src/import-resolver.js";

async function compileAndInstantiate(src: string) {
  const result = await compile(src, { fileName: "test.ts" });
  expect(result.success, JSON.stringify(result.errors)).toBe(true);
  const imports = buildImports(result.imports);
  const mod = new WebAssembly.Module(result.binary);
  const instance = new WebAssembly.Instance(mod, imports);
  if (imports.setExports) imports.setExports(instance.exports as Record<string, Function>);
  return { result, instance, imports };
}

describe("browser timer host imports (#1501) — preprocessImports shim", () => {
  it("keeps Node compiler capabilities when jsdom installs a window global", () => {
    const descriptor = Object.getOwnPropertyDescriptor(globalThis, "window");
    try {
      Object.defineProperty(globalThis, "window", { configurable: true, value: {} });
      setDefaultEnvironment(null);
      const environment = getDefaultEnvironment();
      expect(environment.fs).not.toBeNull();
      expect(environment.module).not.toBeNull();
    } finally {
      setDefaultEnvironment(null);
      if (descriptor) Object.defineProperty(globalThis, "window", descriptor);
      else Reflect.deleteProperty(globalThis, "window");
    }
  });

  it("injects a __timer_set_timeout shim when source calls setTimeout", () => {
    const src = `setTimeout(() => {}, 100);`;
    const { source, requiresTsGrammar } = preprocessImports(src);
    expect(source).toContain("__timer_set_timeout");
    expect(source).toContain("function setTimeout(");
    expect(requiresTsGrammar).toBe(true);
  });

  it("parses a JavaScript timer caller with the injected TypeScript shim", async () => {
    const result = await compile(
      `
        function tick() {}
        export function schedule() { return setTimeout(tick, 1); }
      `,
      { fileName: "timer-caller.js", skipSemanticDiagnostics: true },
    );

    expect(result.errors.filter((error) => error.code === 8010 || error.code === 8017)).toEqual([]);
    expect(result.success, JSON.stringify(result.errors)).toBe(true);
    expect(() => new WebAssembly.Module(result.binary)).not.toThrow();
  });

  it("keeps DOM globals available when the timer shim forces TypeScript grammar", async () => {
    const result = await compile(
      `
        function tick() {}
        export function probe() {
          var timer = setTimeout(tick, 1);
          clearTimeout(timer);
          return document;
        }
      `,
      { fileName: "timer-dom-caller.js", skipSemanticDiagnostics: true },
    );

    expect(result.success, JSON.stringify(result.errors)).toBe(true);
    expect(result.imports).toContainEqual({
      module: "env",
      name: "global_document",
      kind: "func",
      intent: { type: "declared_global", name: "document" },
    });
  });

  it("injects all four timer shims when each is referenced", () => {
    const src = `
      const a = setTimeout(() => {}, 1);
      clearTimeout(a);
      const b = setInterval(() => {}, 2);
      clearInterval(b);
    `;
    const { source } = preprocessImports(src);
    expect(source).toContain("__timer_set_timeout");
    expect(source).toContain("__timer_set_interval");
    expect(source).toContain("__timer_clear_timeout");
    expect(source).toContain("__timer_clear_interval");
  });

  it("does NOT inject the shim when no timer call sites are present", () => {
    const src = `let x = 1; export function add(a: number, b: number): number { return a + b; }`;
    const { source } = preprocessImports(src);
    expect(source).not.toContain("__timer_set_timeout");
    expect(source).not.toContain("// #1501 timer host-import shim");
  });

  it("does not shadow a user-defined setTimeout function", () => {
    // If the user defines their own setTimeout, the shim must skip that name
    // entirely so user code keeps using their definition.
    const src = `
      function setTimeout(_cb: any, _ms: number): number { return 42; }
      setTimeout(() => {}, 1);
    `;
    const { source } = preprocessImports(src);
    // Shim block should NOT redeclare setTimeout — the existing user function wins.
    // Heuristic: there must be exactly one `function setTimeout(` occurrence.
    const occurrences = source.split("function setTimeout(").length - 1;
    expect(occurrences).toBe(1);
  });
});

describe("browser timer host imports (#1501) — import classification", () => {
  it("classifies __timer_set_* and __timer_clear_* into timer_set / timer_clear intents", async () => {
    const src = `
      const a = setTimeout(() => {}, 1);
      clearTimeout(a);
      const b = setInterval(() => {}, 2);
      clearInterval(b);
    `;
    const { result } = await compileAndInstantiate(src);
    const timerImports = result.imports.filter((i) => i.name.startsWith("__timer_"));
    // We get a host import for each timer fn that the shim references.
    const intents = timerImports.map((i) => i.intent);
    expect(intents).toContainEqual({ type: "timer_set", mode: "timeout" });
    expect(intents).toContainEqual({ type: "timer_set", mode: "interval" });
    expect(intents).toContainEqual({ type: "timer_clear", mode: "timeout" });
    expect(intents).toContainEqual({ type: "timer_clear", mode: "interval" });
  });
});

describe("browser timer host imports (#1501) — runtime callback dispatch", () => {
  it("setTimeout fires the compiled-closure callback in the host event loop", async () => {
    const src = `
      let ticks = 0;
      function tick(): void { ticks++; }
      export function schedule(ms: number): any { return setTimeout(tick, ms); }
      export function getTicks(): number { return ticks; }
    `;
    const { instance } = await compileAndInstantiate(src);
    const schedule = instance.exports.schedule as (ms: number) => unknown;
    const getTicks = instance.exports.getTicks as () => number;
    schedule(10);
    expect(getTicks()).toBe(0);
    await new Promise((r) => setTimeout(r, 60));
    expect(getTicks()).toBe(1);
  });

  it("clearTimeout cancels the scheduled callback (no tick after cancel)", async () => {
    const src = `
      let ticks = 0;
      function tick(): void { ticks++; }
      export function scheduleAndCancel(ms: number): void {
        const h = setTimeout(tick, ms);
        clearTimeout(h);
      }
      export function getTicks(): number { return ticks; }
    `;
    const { instance } = await compileAndInstantiate(src);
    (instance.exports.scheduleAndCancel as (ms: number) => void)(10);
    await new Promise((r) => setTimeout(r, 50));
    expect((instance.exports.getTicks as () => number)()).toBe(0);
  });

  it("setInterval fires repeatedly until clearInterval cancels it", async () => {
    const src = `
      let ticks = 0;
      let handle: any = null;
      function tick(): void {
        ticks++;
        if (ticks >= 3 && handle !== null) {
          clearInterval(handle);
          handle = null;
        }
      }
      export function startTicking(ms: number): void { handle = setInterval(tick, ms); }
      export function getTicks(): number { return ticks; }
    `;
    const { instance } = await compileAndInstantiate(src);
    (instance.exports.startTicking as (ms: number) => void)(15);
    // Wait long enough for at least 3 ticks (15ms each) plus a buffer that
    // would have allowed a 4th if clearInterval weren't called.
    await new Promise((r) => setTimeout(r, 150));
    const ticks = (instance.exports.getTicks as () => number)();
    expect(ticks).toBeGreaterThanOrEqual(3);
    // After cleanup, give the host another window — count must not grow.
    await new Promise((r) => setTimeout(r, 60));
    expect((instance.exports.getTicks as () => number)()).toBe(ticks);
  });
});
