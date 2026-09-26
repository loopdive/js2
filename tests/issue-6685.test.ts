// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { compile } from "../src/index.js";
import { buildCompiledImports } from "../src/runtime.js";

// #6685 (slice S1 of #5385) — console is a platform capability in a JavaScript
// environment, including under the native semantic regime.
//
// With JS2WASM_NATIVE_REGIME_JS=1 a `semanticProviders: "native-first"` gc build
// lowers with the native (standalone) codegen regime. Its console arms used to
// test the REGIME (`ctx.standalone`), so the module minted the host-free
// `__stdout_acc` sink (#3469) and `__stdout_prepare`/`__stdout_char` exports and
// never called the `console_log_*` capability: the test262 async completion
// marker was invisible to the JS-host runner. Those arms now test the
// ENVIRONMENT (`hostFreeEnvironment(ctx)`); host-free targets are unchanged.

type Compiled = Awaited<ReturnType<typeof compile>>;

// test262-shaped async program: `$DONE → print → console.log(marker)` from a
// promise continuation.
const ASYNC_PROGRAM = `
  function print(message: string): void { console.log(message); }
  function $DONE(error?: string): void {
    if (error) print("Test262:AsyncTestFailure:" + error);
    else print("Test262:AsyncTestComplete");
  }
  async function body(): Promise<void> { await Promise.resolve(1); }
  body().then(() => $DONE(), (e: any) => $DONE(String(e)));
`;

async function build(options: Record<string, unknown>): Promise<Compiled> {
  const result = await compile(ASYNC_PROGRAM, {
    fileName: "issue-6685.ts",
    skipSemanticDiagnostics: true,
    ...options,
  });
  expect(result.success, result.errors.map((e) => e.message).join("\n")).toBe(true);
  return result;
}

function importNames(result: Compiled): string[] {
  return WebAssembly.Module.imports(new WebAssembly.Module(result.binary)).map((i) => `${i.module}.${i.name}`);
}

function exportNames(result: Compiled): string[] {
  return WebAssembly.Module.exports(new WebAssembly.Module(result.binary)).map((e) => e.name);
}

function readSink(instance: WebAssembly.Instance): string {
  const exp = instance.exports as Record<string, any>;
  if (typeof exp.__drain_microtasks === "function") exp.__drain_microtasks();
  const len = exp.__stdout_prepare() | 0;
  let out = "";
  for (let i = 0; i < len; i++) out += String.fromCharCode(exp.__stdout_char(i) & 0xffff);
  return out;
}

describe("#6685 console capability under the native regime", () => {
  let savedRegime: string | undefined;
  beforeEach(() => {
    savedRegime = process.env.JS2WASM_NATIVE_REGIME_JS;
  });
  afterEach(() => {
    if (savedRegime === undefined) Reflect.deleteProperty(process.env, "JS2WASM_NATIVE_REGIME_JS");
    else process.env.JS2WASM_NATIVE_REGIME_JS = savedRegime;
    vi.restoreAllMocks();
  });

  it("reports the async marker through the console capability in a JS environment", async () => {
    process.env.JS2WASM_NATIVE_REGIME_JS = "1";
    const result = await build({ semanticProviders: "native-first" });

    expect(importNames(result)).toContain("env.console_log_string");
    expect(exportNames(result).filter((name) => name.startsWith("__stdout_"))).toEqual([]);
    const inventory = result.hostImportInventory ?? [];
    expect(inventory).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: "console_log_string", classification: "platform-capability" }),
      ]),
    );

    const lines: string[] = [];
    vi.spyOn(console, "log").mockImplementation((...args: unknown[]) => {
      lines.push(args.map(String).join(" "));
    });
    const imports = buildCompiledImports(result);
    const { instance } = await WebAssembly.instantiate(result.binary, imports);
    imports.setInstance?.(instance);
    (imports as { runStart?: () => void }).runStart?.();
    const exp = instance.exports as Record<string, any>;
    if (typeof exp.__drain_microtasks === "function") exp.__drain_microtasks();
    for (let turn = 0; turn < 20 && !lines.some((l) => l.includes("Test262:")); turn++) {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    expect(lines).toContain("Test262:AsyncTestComplete");
  });

  it("keeps the host-free sink on --target standalone, with or without the opt-in", async () => {
    // hostBridge "always" matches the test262 runner's standalone lane, which is
    // what keeps the `__stdout_*` inspection exports alive (as in #3469's test).
    const plain = await build({ target: "standalone", hostBridge: "always" });
    process.env.JS2WASM_NATIVE_REGIME_JS = "1";
    const optIn = await build({ target: "standalone", hostBridge: "always" });
    expect(Buffer.from(optIn.binary).equals(Buffer.from(plain.binary))).toBe(true);

    expect(importNames(plain).filter((name) => name.includes("console_"))).toEqual([]);
    expect(exportNames(plain)).toEqual(expect.arrayContaining(["__stdout_prepare", "__stdout_char"]));
    const { instance } = await WebAssembly.instantiate(plain.binary, {});
    expect(readSink(instance)).toContain("Test262:AsyncTestComplete");
  });

  it("keeps WASI on fd_write: no console capability, no __stdout_* exports", async () => {
    const plain = await build({ target: "wasi" });
    process.env.JS2WASM_NATIVE_REGIME_JS = "1";
    const optIn = await build({ target: "wasi" });
    expect(Buffer.from(optIn.binary).equals(Buffer.from(plain.binary))).toBe(true);

    expect(importNames(plain).filter((name) => name.includes("console_"))).toEqual([]);
    expect(importNames(plain).some((name) => name.endsWith(".fd_write"))).toBe(true);
    expect(exportNames(plain).filter((name) => name.startsWith("__stdout_"))).toEqual([]);
  });
});
