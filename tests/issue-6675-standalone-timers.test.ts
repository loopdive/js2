// #6675 — a standalone module that merely CONTAINED a timer call (lodash-es
// debounce/throttle/delay) retained `env.setTimeout` / `env.clearTimeout`
// imports and could not be instantiated host-free. A standalone module has no
// event loop: the timer globals do not exist there, so `typeof` answers
// "undefined" and a call throws ReferenceError — no import.
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { compileProject } from "../src/index.js";

async function compileProjectFiles(files: Record<string, string>, target: "standalone" | "gc") {
  const dir = mkdtempSync(join(tmpdir(), "issue-6675-"));
  for (const [name, text] of Object.entries(files)) writeFileSync(join(dir, name), text);
  const result = await compileProject(join(dir, "main.js"), { allowJs: true, skipSemanticDiagnostics: true, target });
  expect(result.success, result.errors.map((e) => e.message).join("\n")).toBe(true);
  const module = await WebAssembly.compile(result.binary);
  return { module, imports: WebAssembly.Module.imports(module).map((i) => `${i.module}.${i.name}`) };
}

async function run(module: WebAssembly.Module) {
  const instance = await WebAssembly.instantiate(module, {});
  (instance.exports.__module_init as (() => void) | undefined)?.();
  return instance.exports as Record<string, (...args: unknown[]) => unknown>;
}

const DEBOUNCE_LIKE = `
export function schedule(fn, wait) { return setTimeout(fn, wait); }
export function cancel(id) { clearTimeout(id); }
export function every(fn, wait) { return setInterval(fn, wait); }
export function stopEvery(id) { clearInterval(id); }
export function probe() {
  return (typeof setTimeout === "undefined" ? 1 : 0) + (typeof clearTimeout === "undefined" ? 10 : 0) +
    (typeof setInterval === "undefined" ? 100 : 0) + (typeof clearInterval === "undefined" ? 1000 : 0);
}
`;

const MAIN = `
import { schedule, cancel, every, stopEvery, probe } from "./timers.js";
export function pure(x) { return x + 1; }
export function kinds() { return probe(); }
function classify(f) { try { f(); return 0; } catch (e) { return e instanceof ReferenceError ? 1 : 2; } }
export function callSet() { return classify(() => schedule(() => {}, 5)); }
export function callClear() { return classify(() => cancel(1)); }
export function callEvery() { return classify(() => every(() => {}, 5)); }
export function callStopEvery() { return classify(() => stopEvery(1)); }
export function argsNotEvaluated() {
  let hit = 0;
  try { setTimeout((hit = 1, () => {}), (hit = 2, 0)); } catch (e) { return hit === 0 && e instanceof ReferenceError ? 1 : 2; }
  return 3;
}
`;

describe("#6675 — timer globals on --target standalone", () => {
  it("compiles with zero imports; typeof is undefined and calls throw ReferenceError", async () => {
    const { module, imports } = await compileProjectFiles(
      { "timers.js": DEBOUNCE_LIKE, "main.js": MAIN },
      "standalone",
    );
    expect(imports).toEqual([]);
    const ex = await run(module);
    expect(ex.pure(1)).toBe(2);
    expect(ex.kinds()).toBe(1111);
    expect(ex.callSet()).toBe(1);
    expect(ex.callClear()).toBe(1);
    expect(ex.callEvery()).toBe(1);
    expect(ex.callStopEvery()).toBe(1);
    expect(ex.argsNotEvaluated()).toBe(1);
  });

  it("a user-defined setTimeout keeps its own binding (control)", async () => {
    const { module, imports } = await compileProjectFiles(
      {
        "main.js": `
function setTimeout(fn, ms) { return fn() + ms; }
export function test() { return setTimeout(() => 40, 2); }
export function kind() { return typeof setTimeout === "function" ? 1 : 0; }
`,
      },
      "standalone",
    );
    expect(imports).toEqual([]);
    const ex = await run(module);
    expect(ex.test()).toBe(42);
    expect(ex.kind()).toBe(1);
  });

  it("the JS-host target still imports the host timer (control)", async () => {
    const { imports } = await compileProjectFiles({ "timers.js": DEBOUNCE_LIKE, "main.js": MAIN }, "gc");
    expect(imports.some((name) => /setTimeout|__timer_set/.test(name))).toBe(true);
  });
});
