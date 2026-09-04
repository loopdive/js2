// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// `__class_call_<method>_vararg` must export the bridge, not a helper.
//
// `emitMethodDispatch` computed the export's function index BEFORE building the
// body. The vararg arm's body calls `ensureVecNewSized` / `ensureVecElemSet` to
// pack the host argument array into the rest vec, and those MINT AND APPEND
// functions of their own — so by the time the bridge itself was pushed, the
// precomputed index belonged to the first helper minted. `mod.exports` then
// published that helper under the bridge's name.
//
// The symptom is not a validation failure; the module is well-formed. The
// exported `__class_call_<m>_vararg` simply had the helper's `(f64) -> …`
// signature, so `class-method-host-bridge.ts`'s `callFn(receiver, argsArray)`
// coerced the receiver toward a number and threw
//   TypeError: Cannot convert object to primitive value
// at the JS→Wasm boundary, with no Wasm frame below it.
//
// The fixtures use `as any` on the call deliberately: a typed member access
// resolves to a direct call and never reaches the host bridge, so it cannot
// exercise this at all.
//
// Reached whenever the receiver is a MUTABLE binding — a `let` puts it in a
// live-binding global, so it reads back as externref and the call goes through
// the host bridge instead of a direct typed call. `const` receivers were fine,
// which is what made this look like a `let`-vs-`const` mystery.

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { compileProject } from "../src/index.js";
import { buildCompiledImports } from "../src/runtime.js";

const roots: string[] = [];
afterAll(() => {
  while (roots.length > 0) rmSync(roots.pop()!, { recursive: true, force: true });
});

async function instantiate(entrySource: string): Promise<WebAssembly.Exports> {
  const root = mkdtempSync(join(tmpdir(), "js2-vararg-bridge-"));
  roots.push(root);
  mkdirSync(root, { recursive: true });
  writeFileSync(join(root, "entry.ts"), entrySource);
  const result = await compileProject(join(root, "entry.ts"), {
    allowJs: true,
    skipSemanticDiagnostics: true,
    target: "gc",
    platform: "node",
  });
  expect(result.success, result.errors.map((error) => error.message).join("\n")).toBe(true);
  const imports = buildCompiledImports(result, {}) as Record<string, unknown> & WebAssembly.Imports;
  const { instance } = await WebAssembly.instantiate(result.binary, imports);
  (imports.setInstance as ((i: WebAssembly.Instance) => void) | undefined)?.(instance);
  (imports.__setInstance as ((i: WebAssembly.Instance) => void) | undefined)?.(instance);
  (instance.exports.__module_init as (() => void) | undefined)?.();
  return instance.exports;
}

const REST_CLASS = `class C { use(...e) { return e.length; } }`;

describe("class vararg bridge export", () => {
  it("exports a two-parameter bridge, not the vec helper", async () => {
    const exports = await instantiate(
      `${REST_CLASS}\nlet g; g = new C();\nexport function test(): number { return (g as any).use({}); }`,
    );
    const bridge = exports.__class_call_use_vararg as unknown as
      | ((recv: unknown, args: unknown[]) => number)
      | undefined;
    expect(typeof bridge).toBe("function");
    // An exported Wasm function's `length` is its declared parameter count.
    // The mis-exported helper reported 1.
    expect((bridge as unknown as { length: number }).length).toBe(2);
  });

  it("packs the host argument array into the rest vec", async () => {
    const exports = await instantiate(
      `${REST_CLASS}\nlet g; g = new C();\nexport function mk(): any { return g; }\nexport function test(): number { return (g as any).use({}); }`,
    );
    const bridge = exports.__class_call_use_vararg as unknown as (recv: unknown, args: unknown[]) => number;
    const receiver = (exports.mk as () => unknown)();
    expect(bridge(receiver, [{}, {}])).toBe(2);
    expect(bridge(receiver, [])).toBe(0);
  });

  it("calls a rest method on a `let`-bound receiver", async () => {
    const exports = await instantiate(
      `${REST_CLASS}\nlet g; g = new C();\nexport function test(): number { return (g as any).use({}); }`,
    );
    expect((exports.test as () => number)()).toBe(1);
  });

  it("keeps a `const`-bound receiver working", async () => {
    const exports = await instantiate(
      `${REST_CLASS}\nconst g = new C();\nexport function test(): number { return (g as any).use({}); }`,
    );
    expect((exports.test as () => number)()).toBe(1);
  });

  it("threads `this` through the rest method", async () => {
    const exports = await instantiate(
      `class C { constructor() { this.n = 0; } use(...e) { e.forEach(() => { this.n += 1; }); return this.n; } }
let g; g = new C();
export function test(): number { return (g as any).use({}, {}); }`,
    );
    expect((exports.test as () => number)()).toBe(2);
  });
});
