// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.

import { describe, expect, it } from "vitest";
import binaryen from "binaryen";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { compile, compileFiles, type CompileOptions, type CompileResult } from "../src/index.js";
import { buildImports } from "../src/runtime.js";

const DELAY_BODY = `
export function delay(ms: number, value: number): Promise<number> {
  return new Promise<number>((resolve) => {
    setTimeout(() => resolve(value), ms);
  });
}
`;

const INDEPENDENT_LEAF = `export function independent(n: number): number { return n + 1; }`;

async function compileDelay(source = DELAY_BODY, options: CompileOptions = {}): Promise<CompileResult> {
  return compile(source, {
    fileName: "issue-2856-async-delay-ir.ts",
    experimentalIR: true,
    trackFallbacks: true,
    skipSemanticDiagnostics: true,
    ...options,
  });
}

function importNames(result: CompileResult): string[] {
  return WebAssembly.Module.imports(new WebAssembly.Module(result.binary)).map(
    (entry) => `${entry.module}.${entry.name}`,
  );
}

function manifestImportNames(result: CompileResult): string[] {
  return result.imports.map((entry) => `${entry.module}.${entry.name}`);
}

interface WasmFuncSignature {
  readonly params: number[];
  readonly results: number[];
}

/** Binaryen resolves the post-pruning binary's type table, unlike the diagnostic WAT's stale numeric refs. */
function wasmFunctionImports(binary: Uint8Array): Map<string, WasmFuncSignature> {
  const module = binaryen.readBinary(binary);
  try {
    const imports = new Map<string, WasmFuncSignature>();
    for (let i = 0; i < module.getNumFunctions(); i++) {
      const info = binaryen.getFunctionInfo(module.getFunctionByIndex(i));
      if (info.module === null || info.base === null) continue;
      imports.set(`${info.module}.${info.base}`, {
        params: binaryen.expandType(info.params),
        results: binaryen.expandType(info.results),
      });
    }
    return imports;
  } finally {
    module.dispose();
  }
}

function expectEnvImportSignature(
  imports: ReadonlyMap<string, WasmFuncSignature>,
  name: string,
  params: readonly number[],
  results: readonly number[],
): void {
  const signature = imports.get(`env.${name}`);
  expect(signature, `missing env.${name} function import`).toBeDefined();
  expect(signature?.params, `${name} params`).toEqual(params);
  expect(signature?.results, `${name} results`).toEqual(results);
}

async function settled<T>(value: T | Promise<T>, ms = 4000): Promise<T> {
  let watchdog: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      Promise.resolve(value),
      new Promise<never>((_, reject) => {
        watchdog = setTimeout(() => reject(new Error("delay result never settled")), ms);
      }),
    ]);
  } finally {
    if (watchdog !== undefined) clearTimeout(watchdog);
  }
}

describe("#2856 exact Promise timer delay IR slice", () => {
  it.each([false, true])("IR-emits and settles concurrent calls (optimize=%s)", async (optimize) => {
    const result = await compileDelay(DELAY_BODY, { optimize });
    expect(result.success, result.errors.map((error) => error.message).join("\n")).toBe(true);
    expect(WebAssembly.validate(result.binary)).toBe(true);
    expect(result.irPostClaimErrors ?? []).toEqual([]);
    expect(result.irCompiledFuncs ?? []).toEqual(
      expect.arrayContaining(["delay", "delay__closure_0", "delay__closure_0__closure_1"]),
    );
    expect(result.irFirstSkipped ?? []).toContain("delay");

    const names = importNames(result);
    expect(names).toEqual(
      expect.arrayContaining(["env.Promise_new", "env.__timer_set_timeout", "env.__box_number", "env.__call_1_f64"]),
    );
    expect(names).not.toContain("env.__make_callback");
    expect(result.wat).toContain("(func $delay__closure_0");
    expect(result.wat).toContain("(func $delay__closure_0__closure_1");
    expect(result.wat).toContain('(export "__call_fn_2"');
    expect(result.wat).toContain('(export "__call_fn_0"');
    const functionImports = wasmFunctionImports(result.binary);
    expectEnvImportSignature(functionImports, "Promise_new", [binaryen.externref], [binaryen.externref]);
    expectEnvImportSignature(
      functionImports,
      "__timer_set_timeout",
      [binaryen.externref, binaryen.externref],
      [binaryen.externref],
    );
    expectEnvImportSignature(functionImports, "__box_number", [binaryen.f64], [binaryen.externref]);
    expectEnvImportSignature(functionImports, "__call_1_f64", [binaryen.externref, binaryen.f64], [binaryen.f64]);

    const imports = buildImports(result.imports, undefined, result.stringPool);
    const { instance } = await WebAssembly.instantiate(result.binary, imports);
    imports.setExports?.(instance.exports as Record<string, Function>);
    const delay = instance.exports.delay as (ms: number, value: number) => Promise<number>;
    const slow = delay(20, 111);
    const fast = delay(2, 222);
    expect(typeof slow?.then).toBe("function");
    expect(typeof fast?.then).toBe("function");
    await expect(settled(fast)).resolves.toBe(222);
    await expect(settled(slow)).resolves.toBe(111);
  });

  it("composes callback, Date, and Promise finalization in one module", async () => {
    const result = await compileDelay(`
      export function stamp(): number {
        const snapshot = new Date();
        return snapshot.getFullYear();
      }
      export function install(target: EventTarget, sink: HTMLElement): void {
        target.addEventListener("tick", () => { sink.textContent = "ready"; });
      }
      ${DELAY_BODY}
    `);

    expect(result.success, result.errors.map((error) => error.message).join("\n")).toBe(true);
    expect(WebAssembly.validate(result.binary)).toBe(true);
    expect(result.irPostClaimErrors ?? []).toEqual([]);
    expect(result.irCompiledFuncs ?? []).toEqual(
      expect.arrayContaining([
        "stamp",
        "install",
        "install__closure_0",
        "delay",
        "delay__closure_0",
        "delay__closure_0__closure_1",
      ]),
    );
    expect(importNames(result)).toEqual(
      expect.arrayContaining([
        "env.__make_callback",
        "env.Date_new",
        "env.Date_getFullYear",
        "env.Promise_new",
        "env.__timer_set_timeout",
        "env.__box_number",
        "env.__call_1_f64",
      ]),
    );

    const imports = buildImports(result.imports, undefined, result.stringPool);
    const { instance } = await WebAssembly.instantiate(result.binary, imports);
    imports.setExports?.(instance.exports as Record<string, Function>);
    expect((instance.exports.stamp as () => number)()).toBeGreaterThan(2000);

    let listener: (() => void) | undefined;
    const target = { addEventListener: (_name: string, callback: () => void) => void (listener = callback) };
    const sink = { textContent: "" };
    (instance.exports.install as (target: object, sink: object) => void)(target, sink);
    expect(listener).toBeDefined();
    listener!();
    expect(sink.textContent).toBe("ready");
    await expect(
      settled((instance.exports.delay as (ms: number, value: number) => Promise<number>)(1, 333)),
    ).resolves.toBe(333);
  });

  it("IR-emits and settles when source functions reuse the Promise lifted display names", async () => {
    const result = await compileDelay(`
      function delay__closure_0(): number { return 0; }
      function delay__closure_0__closure_1(): number { return 0; }
      ${DELAY_BODY}
    `);

    expect(result.success, result.errors.map((error) => error.message).join("\n")).toBe(true);
    expect(WebAssembly.validate(result.binary)).toBe(true);
    expect(result.irCompiledFuncs ?? []).toContain("delay");
    expect(result.irPostClaimErrors ?? []).toEqual([]);

    const imports = buildImports(result.imports, undefined, result.stringPool);
    const { instance } = await WebAssembly.instantiate(result.binary, imports);
    imports.setExports?.(instance.exports as Record<string, Function>);
    await expect(
      settled((instance.exports.delay as (ms: number, value: number) => Promise<number>)(1, 444)),
    ).resolves.toBe(444);
  });

  it("is byte-deterministic across repeated optimized compiles", async () => {
    const [a, b] = await Promise.all([
      compileDelay(DELAY_BODY, { optimize: true }),
      compileDelay(DELAY_BODY, { optimize: true }),
    ]);
    expect(a.success, a.errors.map((error) => error.message).join("\n")).toBe(true);
    expect(b.success, b.errors.map((error) => error.message).join("\n")).toBe(true);
    expect(a.binary).toEqual(b.binary);
    expect(a.irCompiledFuncs).toEqual(b.irCompiledFuncs);
  });

  it.each([
    [
      "shadowed Promise",
      `const Promise = class LocalPromise<T> { constructor(_executor: (resolve: (value: T) => void) => void) {} };\n${DELAY_BODY}`,
    ],
    [
      "shadowed setTimeout",
      `function setTimeout(callback: () => void, _ms: number): number { callback(); return 0; }\n${DELAY_BODY}`,
    ],
    [
      "aliased resolve",
      `export function delay(ms: number, value: number): Promise<number> {
         return new Promise<number>((resolve) => { const done = resolve; setTimeout(() => done(value), ms); });
       }`,
    ],
    [
      "block timer arrow",
      `export function delay(ms: number, value: number): Promise<number> {
         return new Promise<number>((resolve) => { setTimeout(() => { resolve(value); }, ms); });
       }`,
    ],
    [
      "concise executor",
      `export function delay(ms: number, value: number): Promise<number> {
         return new Promise<number>((resolve) => setTimeout(() => resolve(value), ms));
       }`,
    ],
    [
      "wrong Promise type argument",
      `export function delay(ms: number, value: number): Promise<number> {
         return new Promise<string>((resolve) => { setTimeout(() => resolve(value.toString()), ms); }) as any;
       }`,
    ],
    [
      "executor parameter shadows timeout",
      `export function delay(ms: number, value: number): Promise<number> {
         return new Promise<number>((ms) => { setTimeout(() => ms(value), ms as any); });
       }`,
    ],
    [
      "async executor",
      `export function delay(ms: number, value: number): Promise<number> {
         return new Promise<number>(async (resolve) => { setTimeout(() => resolve(value), ms); });
       }`,
    ],
    [
      "async timer arrow",
      `export function delay(ms: number, value: number): Promise<number> {
         return new Promise<number>((resolve) => { setTimeout(async () => resolve(value), ms); });
       }`,
    ],
    [
      "extra timer argument",
      `export function delay(ms: number, value: number): Promise<number> {
         return new Promise<number>((resolve) => { setTimeout(() => resolve(value), ms, value); });
       }`,
    ],
    [
      "extra Promise argument",
      `export function delay(ms: number, value: number): Promise<number> {
         return new Promise<number>((resolve) => { setTimeout(() => resolve(value), ms); }, value);
       }`,
    ],
    [
      "missing Promise type argument",
      `export function delay(ms: number, value: number): Promise<number> {
         return new Promise((resolve) => { setTimeout(() => resolve(value), ms); });
       }`,
    ],
    [
      "multiple Promise type arguments",
      `export function delay(ms: number, value: number): Promise<number> {
         return new Promise<number, string>((resolve) => { setTimeout(() => resolve(value), ms); });
       }`,
    ],
  ] as const)("rejects %s before IR claim", async (_label, source) => {
    const result = await compileDelay(`${source}\n${INDEPENDENT_LEAF}`);
    expect(result.success, result.errors.map((error) => error.message).join("\n")).toBe(true);
    expect(result.irCompiledFuncs ?? []).not.toContain("delay");
    expect(result.irCompiledFuncs ?? []).toContain("independent");
    if (_label === "shadowed setTimeout") {
      expect(result.irCompiledFuncs ?? []).toContain("setTimeout");
    }
    expect(result.irPostClaimErrors ?? []).toEqual([]);
  });

  it.each([
    ["Promise_new", `function Promise_new(value?: any): any { return value; }`],
    ["__timer_set_timeout", `function __timer_set_timeout(callback: any, _ms?: any): any { return callback; }`],
    ["__box_number", `function __box_number(value?: number): any { return value; }`],
    ["__call_1_f64", `function __call_1_f64(_fn: any, value?: number): number { return value ?? 0; }`],
  ] as const)(
    "demotes runtime-helper collision %s before adding incidental helpers",
    async (_collision, declaration) => {
      const source = `${declaration}\n${DELAY_BODY}\n${INDEPENDENT_LEAF}`;
      const [ir, legacy] = await Promise.all([compileDelay(source), compileDelay(source, { experimentalIR: false })]);
      expect(ir.success, ir.errors.map((error) => error.message).join("\n")).toBe(true);
      expect(ir.irCompiledFuncs ?? []).not.toContain("delay");
      expect(ir.irCompiledFuncs ?? []).toContain("independent");
      expect(ir.irPostClaimErrors ?? []).toEqual([]);
      expect(ir.irFirstSkipped ?? []).not.toContain("delay");
      expect(manifestImportNames(ir)).toEqual(manifestImportNames(legacy));
      if (_collision !== "Promise_new") expect(importNames(ir)).toEqual(importNames(legacy));
    },
  );

  it("keeps a runtime-helper-demotable delay component compile-twice", async () => {
    const result = await compileDelay(`
      function __timer_set_timeout(callback: any, _ms?: any): any { return callback; }
      function delay(ms: number, value: number): Promise<number> {
        return new Promise<number>((resolve) => {
          setTimeout(() => resolve(value), ms);
        });
      }
      export function caller(ms: number, value: number): number {
        delay(ms, value);
        return value;
      }
      ${INDEPENDENT_LEAF}
    `);

    expect(result.success, result.errors.map((error) => error.message).join("\n")).toBe(true);
    expect(WebAssembly.validate(result.binary)).toBe(true);
    expect(result.irCompiledFuncs ?? []).not.toContain("delay");
    expect(result.irCompiledFuncs ?? []).not.toContain("caller");
    expect(result.irCompiledFuncs ?? []).toContain("independent");
    expect(result.irFirstSkipped ?? []).not.toContain("delay");
    expect(result.irFirstSkipped ?? []).not.toContain("caller");
    expect(result.irFirstSkipped ?? []).toContain("independent");
    expect(result.irPostClaimErrors ?? []).toEqual([]);
  });

  it.each([
    ["standalone", { target: "standalone" }],
    ["wasi", { target: "wasi" }],
    ["fast", { fast: true }],
    ["native strings", { nativeStrings: true }],
  ] as const)("keeps the slice preclaim-disabled in %s", async (_label, lane) => {
    const [ir, legacy] = await Promise.all([
      compileDelay(DELAY_BODY, lane),
      compileDelay(DELAY_BODY, { ...lane, experimentalIR: false }),
    ]);
    expect(ir.success).toBe(legacy.success);
    expect(ir.irCompiledFuncs ?? []).not.toContain("delay");
    expect(ir.irPostClaimErrors ?? []).toEqual([]);
    if (ir.success && legacy.success) expect(importNames(ir)).toEqual(importNames(legacy));
  });

  it("does not claim the delay through the disk-backed multi-module overlay", async () => {
    const dir = mkdtempSync(join(tmpdir(), "js2wasm-2856-delay-m0-"));
    const depPath = join(dir, "dep.ts");
    const entryPath = join(dir, "entry.ts");
    writeFileSync(depPath, `${DELAY_BODY}\n${INDEPENDENT_LEAF}`);
    writeFileSync(
      entryPath,
      `
        import { independent } from "./dep.ts";
        export function useIndependent(n: number): number { return independent(n); }
      `,
    );
    try {
      const result = await compileFiles(entryPath, {
        experimentalIR: true,
        trackFallbacks: true,
        skipSemanticDiagnostics: true,
      });
      expect(result.success, result.errors.map((error) => error.message).join("\n")).toBe(true);
      expect(WebAssembly.validate(result.binary)).toBe(true);
      expect(result.irCompiledFuncs ?? []).not.toContain("delay");
      expect(result.irCompiledFuncs ?? []).toEqual(expect.arrayContaining(["independent", "useIndependent"]));
      expect(result.irPostClaimErrors ?? []).toEqual([]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
