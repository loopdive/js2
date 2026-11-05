// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
// #2960 — dynamic `eval` / `new Function` no longer fail silently.
//
// Two verified defects addressed:
//  1. Host-mode DYNAMIC `new Function(<non-const body>)` compiled to a silent
//     `ref.null.extern` no-op stub (wrong value). Now routed to the
//     meta-circular runtime-eval shim (`__extern_new_function`), producing a
//     REAL callable value; the immediate-call form goes through
//     `__call_function`.
//  2. Standalone dynamic direct `eval` still throws catchably without leaking a
//     host import because caller-scope reification belongs to #2929. Indirect
//     eval and dynamic `new Function` import the core-Wasm runtime-eval provider;
//     #2928's linked acceptance test proves execution.
import { describe, it, expect } from "vitest";
import { compile } from "../src/index.js";
import { buildImports } from "../src/runtime.js";
import {
  RUNTIME_EVAL_IMPORT_MODULE,
  RUNTIME_EVAL_PROVIDER_COMPILE_OPTIONS,
  buildRuntimeEvalRefusalProviderSource,
  instantiateRuntimeEvalNamespace,
} from "../scripts/runtime-eval-provider.mjs";

function importNames(bin: Uint8Array): string[] {
  return WebAssembly.Module.imports(new WebAssembly.Module(bin)).map((i) => `${i.module}::${i.name}`);
}

// (#6979 S7-a) The meta-circular host shim (`__extern_new_function` under the
// hostEval policy) was the retired host-assisted profile. On the default
// profile (the native regime in a JS environment) dynamic `new Function`
// imports the core-Wasm runtime-eval provider instead; these rows pin that
// route with the refusal provider linked. Executing the dynamic body needs a
// real provider and is covered by the QuickJS eval-engine suites.
let refusalNamespacePromise: Promise<WebAssembly.ModuleExports> | undefined;
function refusalNamespace(): Promise<WebAssembly.ModuleExports> {
  refusalNamespacePromise ??= compile(buildRuntimeEvalRefusalProviderSource(), {
    ...RUNTIME_EVAL_PROVIDER_COMPILE_OPTIONS,
    fileName: "issue-2960-default-refusal-provider.ts",
  }).then((refusal) => {
    expect(refusal.success, JSON.stringify(refusal.errors)).toBe(true);
    return instantiateRuntimeEvalNamespace(new WebAssembly.Module(refusal.binary));
  });
  return refusalNamespacePromise;
}

async function defaultResult(src: string): Promise<number> {
  const r = await compile(src, { fileName: "t.ts" });
  expect(r.success, JSON.stringify(r.errors)).toBe(true);
  const io = buildImports(r.imports, undefined, r.stringPool) as unknown as Record<string, unknown> & {
    setExports?: (exports: Record<string, Function>) => void;
  };
  if (importNames(r.binary).some((name) => name.startsWith(`${RUNTIME_EVAL_IMPORT_MODULE}::`))) {
    io[RUNTIME_EVAL_IMPORT_MODULE] = await refusalNamespace();
  }
  const { instance } = await WebAssembly.instantiate(r.binary, io as unknown as WebAssembly.Imports);
  io.setExports?.(instance.exports as Record<string, Function>);
  return (instance.exports as { test(): number }).test();
}

const DYNAMIC_NEW_FUNCTION = `let op = "+"; op = op + ""; return new Function("a","b","return a"+op+"b")`;

describe("#2960 — dynamic new Function routes to the runtime-eval provider (default profile)", () => {
  it("dynamic immediate-call: the provider call is catchable when the provider refuses", async () => {
    // (#1102) `let` + reassignment keeps this genuinely dynamic — a `const`
    // string binding const-folds into the Tier-0 compile-away.
    expect(
      await defaultResult(
        `export function test(): number { try { ${DYNAMIC_NEW_FUNCTION}(1,2); } catch (e) { return 42; } }`,
      ),
    ).toBe(42);
  });

  it("constant immediate-call still compiles away (unchanged #2924 path): === 3", async () => {
    const src = `export function test(): number { return new Function("a","b","return a+b")(1,2); }`;
    const r = await compile(src, { fileName: "t.ts" });
    expect(r.success, JSON.stringify(r.errors)).toBe(true);
    expect(importNames(r.binary).some((name) => name.startsWith(`${RUNTIME_EVAL_IMPORT_MODULE}::`))).toBe(false);
    expect(await defaultResult(src)).toBe(3);
  });

  it("imports the provider's __runtime_new_function, never the host __extern_new_function shim", async () => {
    const r = await compile(`export function test(): any { ${DYNAMIC_NEW_FUNCTION}; }`, { fileName: "t.ts" });
    expect(r.success).toBe(true);
    const names = importNames(r.binary);
    expect(names).toContain(`${RUNTIME_EVAL_IMPORT_MODULE}::__runtime_new_function`);
    expect(names.some((n) => n.includes("__extern_new_function"))).toBe(false);
  });
});

describe("#2960/#2929 — standalone dynamic direct eval links the runtime provider", () => {
  it("uses the core-Wasm direct-eval boundary without leaking env::__extern_eval", async () => {
    const r = await compile(`export function test(): number { let s = "1"; s = s + "+1"; return eval(s) as number; }`, {
      target: "standalone",
    });
    expect(r.success, JSON.stringify(r.errors)).toBe(true);
    expect(importNames(r.binary)).toEqual([
      `${RUNTIME_EVAL_IMPORT_MODULE}::__runtime_apply_interpreted`,
      `${RUNTIME_EVAL_IMPORT_MODULE}::__runtime_direct_eval`,
    ]);
    expect((r.errors ?? []).some((e) => (e as { severity?: string }).severity === "warning")).toBe(false);
  });

  it("keeps provider refusal catchable at the call site", async () => {
    const r = await compile(
      `export function test(): number { let s = "1"; s = s + "+1"; try { return eval(s) as number; } catch (e) { return 42; } }`,
      { target: "standalone" },
    );
    expect(r.success, JSON.stringify(r.errors)).toBe(true);
    const refusal = await compile(buildRuntimeEvalRefusalProviderSource(), {
      ...RUNTIME_EVAL_PROVIDER_COMPILE_OPTIONS,
      fileName: "issue-2960-refusal-provider.ts",
    });
    expect(refusal.success, JSON.stringify(refusal.errors)).toBe(true);
    const namespace = instantiateRuntimeEvalNamespace(new WebAssembly.Module(refusal.binary));
    const { instance } = await WebAssembly.instantiate(r.binary, { [RUNTIME_EVAL_IMPORT_MODULE]: namespace });
    expect((instance.exports as { test(): number }).test()).toBe(42);
  });
});

describe("#2928 — standalone dynamic indirect eval links the runtime provider", () => {
  it("keeps literal indirect eval on the provider-free compile-away path", async () => {
    const r = await compile(`export function test(): number { return (0, eval)("2 + 3") as number; }`, {
      target: "standalone",
    });
    expect(r.success, JSON.stringify(r.errors)).toBe(true);
    expect(importNames(r.binary)).toEqual([]);
    const { instance } = await WebAssembly.instantiate(r.binary, {});
    expect((instance.exports as { test(): number }).test()).toBe(5);
  });

  it("emits one core-Wasm provider import and no unsupported-code warning", async () => {
    const r = await compile(
      `export function test(): number { let s = "1"; s = s + "+1"; return (0, eval)(s) as number; }`,
      { target: "standalone" },
    );
    expect(r.success, JSON.stringify(r.errors)).toBe(true);
    expect(importNames(r.binary)).toEqual([
      "js2wasm:runtime-eval::__runtime_apply_interpreted",
      "js2wasm:runtime-eval::__runtime_indirect_eval",
    ]);
    expect((r.errors ?? []).some((e) => (e as { severity?: string }).severity === "warning")).toBe(false);
  });
});

describe("#4013 — runtime-eval boundary classification", () => {
  // (#6979 S7-a) Re-pinned from the retired host-assisted lane. On the native
  // regime (default and standalone alike) a module that observes `eval` links
  // the runtime-eval callable carrier, which is still owned by the direct
  // frontend, so `add` demotes with late-preparation-unsupported. A regime gap
  // against #5385, kept as an inverted sentinel.
  it.fails("does not demote IR merely because a source observes eval as a value (regime gap)", async () => {
    const r = await compile(
      `const intrinsic: any = eval;
       export function add(a: number, b: number): number { return a + b; }`,
      { experimentalIR: true, trackIrOutcomes: true },
    );
    expect(r.success, JSON.stringify(r.errors)).toBe(true);
    expect(r.irCompiledFuncs ?? []).toContain("add");
  });

  it("does not treat Function.prototype member reads as an escaped Function constructor", async () => {
    const r = await compile(
      `const call: any = Function.prototype.call;
       export function add(a: number, b: number): number { return a + b; }`,
      { target: "standalone", experimentalIR: true, trackIrOutcomes: true },
    );
    expect(r.success, JSON.stringify(r.errors)).toBe(true);
    expect(importNames(r.binary)).toEqual([]);
    expect(r.irCompiledFuncs ?? []).toContain("add");
  });

  it("still recognizes a first-class Function constructor escape", async () => {
    const r = await compile(
      `const Dynamic: any = Function;
       export function make(body: string): any { return Dynamic(body); }`,
      { target: "standalone", experimentalIR: true, trackIrOutcomes: true },
    );
    expect(r.success, JSON.stringify(r.errors)).toBe(true);
    expect(importNames(r.binary)).toEqual([
      "js2wasm:runtime-eval::__runtime_apply_interpreted",
      "js2wasm:runtime-eval::__runtime_indirect_eval",
    ]);
    expect(r.irCompiledFuncs ?? []).not.toContain("make");
  });
});

describe("#2960/#2928 — standalone dynamic new Function links the runtime provider", () => {
  it("emits one core-Wasm provider import and no unsupported-code warning", async () => {
    const r = await compile(
      `export function test(): number { let op = "+"; op = op + ""; const f: any = new Function("a","b","return a"+op+"b"); return 7; }`,
      { target: "standalone" },
    );
    expect(r.success, JSON.stringify(r.errors)).toBe(true);
    expect(importNames(r.binary)).toEqual([
      "js2wasm:runtime-eval::__runtime_apply_interpreted",
      "js2wasm:runtime-eval::__runtime_new_function",
    ]);
    expect((r.errors ?? []).some((e) => (e as { severity?: string }).severity === "warning")).toBe(false);
  });

  it("uses the same provider import for the Function(...) call form", async () => {
    const r = await compile(
      `export function test(): any { let op = "+"; op = op + ""; return Function("a","b","return a"+op+"b"); }`,
      { target: "standalone" },
    );
    expect(r.success, JSON.stringify(r.errors)).toBe(true);
    expect(importNames(r.binary)).toEqual([
      "js2wasm:runtime-eval::__runtime_apply_interpreted",
      "js2wasm:runtime-eval::__runtime_new_function",
    ]);
  });
});
