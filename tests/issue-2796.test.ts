// #2796 — host-path dynamic-object own-key enumeration: a top-level `for…in`
// (and other top-level struct-introspecting code) must enumerate the receiver's
// own enumerable keys.
//
// Root cause (the part this change fixes): a HARNESS exports-timing artifact.
// In the default JS-host (WasmGC) target the compiler runs top-level code via
// the wasm `start` section — i.e. DURING `WebAssembly.instantiate`, BEFORE the
// host can call `setExports(instance.exports)`. A `for…in` over a WasmGC-struct
// receiver enumerates its keys through `__for_in_keys`, which resolves the
// struct's field names via the `__struct_field_names` / `__sget_*` EXPORTS —
// and those only exist once the instance is constructed. So a top-level `for…in`
// enumerated ZERO keys (control/12-for-in-object.js printed "" instead of
// "a,b"). The standalone/WASI path never hits this: it runs top-level code via
// an explicitly-called `_start` export AFTER instantiation, when every export
// is reachable.
//
// Fix: the `deferTopLevelInit` compile option (used by `scripts/diff-test.ts`)
// makes the compiler export `__module_init` and NOT wire it to the wasm `start`
// section, so the host runs top-level code by calling `instance.exports.
// __module_init()` AFTER `setExports` — symmetric with the standalone `_start`
// model. With the runtime fully wired, the for-in codegen (which is correct —
// it works whenever the struct-introspection exports are reachable) enumerates
// the keys.
//
// Surfaced by the #2787 differential corpus:
//   - control/12-for-in-object.js : `for (const k in {a:1,b:2})` enumerated nothing
//
// NOTE: object/02-spread.js and object/12-assign.js are a SEPARATE codegen
// representation bug (the spread/assign result is read back as NaN / loses
// source keys even when run with the runtime fully wired), tracked as a
// follow-up — not fixed here.

import { describe, expect, it } from "vitest";

import { compile } from "../src/index.js";
import { buildImports, instantiateWasm } from "../src/runtime.js";

/**
 * Compile `src` and run its top-level code the way `scripts/diff-test.ts` does
 * under `deferTopLevelInit`: instantiate, wire `setExports`, THEN invoke the
 * exported `__module_init`. Captures everything top-level `console.log` prints.
 */
async function runDeferred(src: string): Promise<string[]> {
  const result = await compile(src, { fileName: "t.ts", deferTopLevelInit: true });
  if (!result.success) throw new Error(`compile failed: ${result.errors[0]?.message}`);
  const lines: string[] = [];
  const origLog = console.log;
  // eslint-disable-next-line no-console
  console.log = (...args: unknown[]) =>
    lines.push(args.map((a) => (typeof a === "object" ? JSON.stringify(a) : String(a))).join(" "));
  try {
    const imports = buildImports(result.imports, {}, result.stringPool);
    const { instance } = await instantiateWasm(result.binary, imports.env, imports.string_constants);
    imports.setExports?.(instance.exports as Record<string, () => unknown>);
    const moduleInit = (instance.exports as Record<string, unknown>).__module_init;
    if (typeof moduleInit === "function") (moduleInit as () => void)();
  } finally {
    console.log = origLog;
  }
  return lines;
}

/**
 * The DEFAULT compile path (#3049): host/GC modules now defer top-level init —
 * `__module_init` is exported and NOT wired to the wasm `start` section. A
 * program with no exported entry the caller invokes runs its top-level code by
 * calling the exported `__module_init()` AFTER `setExports` (exactly what the
 * in-repo host consumers — `compileAndInstantiate`, playground, generated runner
 * — do). No explicit `deferTopLevelInit` option needed anymore.
 */
async function runDefaultNoEntry(src: string): Promise<string[]> {
  const result = await compile(src, { fileName: "t.ts" });
  if (!result.success) throw new Error(`compile failed: ${result.errors[0]?.message}`);
  const lines: string[] = [];
  const origLog = console.log;
  // eslint-disable-next-line no-console
  console.log = (...args: unknown[]) =>
    lines.push(args.map((a) => (typeof a === "object" ? JSON.stringify(a) : String(a))).join(" "));
  try {
    const imports = buildImports(result.imports, {}, result.stringPool);
    const { instance } = await instantiateWasm(result.binary, imports.env, imports.string_constants);
    imports.setExports?.(instance.exports as Record<string, () => unknown>);
    const mi = (instance.exports as Record<string, unknown>).__module_init;
    if (typeof mi === "function") (mi as () => void)();
  } finally {
    console.log = origLog;
  }
  return lines;
}

/**
 * (#3049) The C2a guard: a program WITH an exported function self-inits on the
 * FIRST export call — no explicit `__module_init()` needed. The compiler
 * prepends a self-guarded `call __module_init` to every export, so calling `run`
 * runs top-level code first (AFTER `setExports`), then the export body.
 */
async function runViaFirstExportCall(src: string, entry: string): Promise<string[]> {
  const result = await compile(src, { fileName: "t.ts" });
  if (!result.success) throw new Error(`compile failed: ${result.errors[0]?.message}`);
  const lines: string[] = [];
  const origLog = console.log;
  // eslint-disable-next-line no-console
  console.log = (...args: unknown[]) =>
    lines.push(args.map((a) => (typeof a === "object" ? JSON.stringify(a) : String(a))).join(" "));
  try {
    const imports = buildImports(result.imports, {}, result.stringPool);
    const { instance } = await instantiateWasm(result.binary, imports.env, imports.string_constants);
    imports.setExports?.(instance.exports as Record<string, () => unknown>);
    // NOTE: deliberately NO explicit __module_init() call — the guard must run it.
    (instance.exports as Record<string, () => unknown>)[entry]!();
  } finally {
    console.log = origLog;
  }
  return lines;
}

describe("#2796 — top-level for…in enumerates own keys when the runtime is fully wired", () => {
  it("for (const k in {a,b}) yields the own keys (deferred-init / diff-test path)", async () => {
    const src = `
      const o = { a: 1, b: 2 };
      const keys: string[] = [];
      for (const k in o) keys.push(k);
      console.log(keys.sort().join(","));
    `;
    expect(await runDeferred(src)).toEqual(["a,b"]);
  });

  it("for…in reads each value and orders own keys by insertion (deferred-init path)", async () => {
    const src = `
      const o = { a: 1, b: 2, c: 3 };
      const out: string[] = [];
      for (const k in o) out.push(k);
      console.log(out.join(","));
    `;
    expect(await runDeferred(src)).toEqual(["a,b,c"]);
  });

  it("exports __module_init when deferTopLevelInit is set and the module has top-level code", async () => {
    const result = await compile(`const o = { a: 1 }; for (const k in o) console.log(k);`, {
      fileName: "t.ts",
      deferTopLevelInit: true,
    });
    if (!result.success) throw new Error("compile failed");
    const imports = buildImports(result.imports, {}, result.stringPool);
    const { instance } = await instantiateWasm(result.binary, imports.env, imports.string_constants);
    imports.setExports?.(instance.exports as Record<string, () => unknown>);
    expect(typeof (instance.exports as Record<string, unknown>).__module_init).toBe("function");
  });

  it("DEFAULT path now defers: a no-entry program runs top-level code via the exported __module_init (#3049)", async () => {
    // #3049 made deferred top-level init the host/GC DEFAULT (was opt-in via
    // deferTopLevelInit). A program with no exported entry runs its top-level
    // code by calling the exported __module_init() after setExports.
    const src = `console.log(1 + 2); console.log("hi");`;
    expect(await runDefaultNoEntry(src)).toEqual(["3", "hi"]);
  });

  it("exports __module_init by DEFAULT for a host module with top-level code (#3049)", async () => {
    const result = await compile(`console.log(1 + 2);`, { fileName: "t.ts" });
    if (!result.success) throw new Error("compile failed");
    const imports = buildImports(result.imports, {}, result.stringPool);
    const { instance } = await instantiateWasm(result.binary, imports.env, imports.string_constants);
    imports.setExports?.(instance.exports as Record<string, () => unknown>);
    expect(typeof (instance.exports as Record<string, unknown>).__module_init).toBe("function");
  });

  it("C2a guard: a program with an export self-inits on the first export call, no explicit __module_init (#3049)", async () => {
    // The prepended `call __module_init` on `run` runs top-level code (AFTER
    // setExports) before the export body — no explicit __module_init() call.
    const src = `
      console.log("top-level");
      export function run(): number { console.log("in run"); return 1; }
    `;
    expect(await runViaFirstExportCall(src, "run")).toEqual(["top-level", "in run"]);
  });
});
