// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { ts } from "../src/ts-api.js";
import { describe, expect, it } from "vitest";
import { compile } from "../src/index.js";
import type { CodegenContext } from "../src/codegen/context/types.js";
import {
  ensureIrNativeConsoleProvider,
  nativeConsoleOutputAvailable,
} from "../src/codegen/helpers/ir-native-console.js";
import { IR_CONSOLE_FORMAT_VALUE_FN, IR_CONSOLE_SINK_APPEND_FN } from "../src/shared/contracts/console-output.js";

async function execute(
  source: string,
  target: "standalone" | "wasi",
  experimentalIR: boolean,
  entry: "out" | "main" = "out",
) {
  const result = await compile(source, {
    target,
    hostBridge: "always",
    fileName: "console.ts",
    experimentalIR,
    trackIrOutcomes: true,
    skipSemanticDiagnostics: true,
  });
  expect(result.success, result.errors.map((e) => e.message).join("\n")).toBe(true);
  const module = new WebAssembly.Module(result.binary);
  const imports = WebAssembly.Module.imports(module);
  expect(imports.filter((i) => i.module === "env")).toEqual([]);
  if (target === "standalone") expect(imports).toEqual([]);
  else expect(imports.every((i) => i.module === "wasi_snapshot_preview1")).toBe(true);
  const output: Record<number, number[]> = { 1: [], 2: [] };
  let instance: WebAssembly.Instance;
  const wasi = {
    fd_write(fd: number, iovs: number, count: number, written: number) {
      const memory = instance.exports.memory as WebAssembly.Memory;
      const view = new DataView(memory.buffer);
      expect(fd === 1 || fd === 2).toBe(true);
      let total = 0;
      for (let i = 0; i < count; i++) {
        const offset = view.getUint32(iovs + i * 8, true);
        const length = view.getUint32(iovs + i * 8 + 4, true);
        output[fd]!.push(...new Uint8Array(memory.buffer, offset, length));
        total += length;
      }
      view.setUint32(written, total, true);
      return 0;
    },
  };
  instance = new WebAssembly.Instance(module, target === "wasi" ? { wasi_snapshot_preview1: wasi } : {});
  (instance.exports.__module_init as (() => void) | undefined)?.();
  if (entry === "main") (instance.exports.main as () => void)();
  else {
    const value = (instance.exports.make as () => unknown)();
    (instance.exports.out as (value: unknown) => void)(value);
  }
  let stdout = new TextDecoder().decode(Uint8Array.from(output[1]!));
  if (target === "standalone") {
    const length = (instance.exports.__stdout_prepare as () => number)();
    stdout = Array.from({ length }, (_, i) =>
      String.fromCharCode((instance.exports.__stdout_char as (i: number) => number)(i)),
    ).join("");
  }
  return {
    result,
    stdout,
    stderr: new TextDecoder().decode(Uint8Array.from(output[2]!)),
    calls: instance.exports.calls as (() => number) | undefined,
  };
}

/** Only the provider boundary's input facts; materialization must not run for absent providers. */
function providerContext(overrides: Record<string, unknown> = {}): CodegenContext {
  return {
    targetProfile: { environment: "standalone" },
    standalone: true,
    wasi: false,
    nativeStrings: true,
    fast: false,
    funcMap: new Map([["__stdout_append", 0]]),
    wasiFdWriteIdx: -1,
    ...overrides,
  } as unknown as CodegenContext;
}

describe("#7136 native provider availability", () => {
  for (const [name, overrides] of [
    ["missing standalone sink", { funcMap: new Map() }],
    ["missing WASI syscall", { standalone: false, wasi: true }],
    ["non-native strings", { nativeStrings: false }],
    ["JavaScript environment", { targetProfile: { environment: "javascript" } }],
  ] as const) {
    it(`fails closed for ${name}`, () => {
      const ctx = providerContext(overrides);
      expect(nativeConsoleOutputAvailable(ctx)).toBe(false);
      expect(ensureIrNativeConsoleProvider(ctx, IR_CONSOLE_SINK_APPEND_FN)).toBeNull();
      expect(ensureIrNativeConsoleProvider(ctx, IR_CONSOLE_FORMAT_VALUE_FN)).toBeNull();
    });
  }
  it("accepts a standalone sink at function index zero", () => {
    const ctx = providerContext({ funcMap: new Map([["__stdout_append", 0]]) });
    expect(nativeConsoleOutputAvailable(ctx)).toBe(true);
    expect(ensureIrNativeConsoleProvider(ctx, IR_CONSOLE_SINK_APPEND_FN)).toBe(0);
  });
  it("accepts WASI fd_write at import index zero", () => {
    expect(nativeConsoleOutputAvailable(providerContext({ standalone: false, wasi: true, wasiFdWriteIdx: 0 }))).toBe(
      true,
    );
  });
  it("refuses fast dynamic formatting even with an available sink", () => {
    const ctx = providerContext({ fast: true, funcMap: new Map([["__stdout_append", 0]]) });
    expect(nativeConsoleOutputAvailable(ctx)).toBe(true);
    expect(ensureIrNativeConsoleProvider(ctx, IR_CONSOLE_FORMAT_VALUE_FN)).toBeNull();
  });
  it("refuses an unknown provider binding", () => {
    expect(ensureIrNativeConsoleProvider(providerContext(), "unknown")).toBeNull();
  });
});

for (const target of ["standalone", "wasi"] as const) {
  describe(`#7136 dynamic console (${target})`, () => {
    for (const [name, value, expected] of [
      ["string", '"ready"', "ready"],
      ["number", "42", "42"],
      ["fraction", "-7.5", "-7.5"],
      ["NaN", "NaN", "NaN"],
      ["negative zero", "-0", "0"],
      ["empty string", '""', ""],
      ["Unicode", '"λ😀"', "λ😀"],
      ["rope", '(function () { var s = "hello"; return s + "世界"; })()', "hello世界"],
      ["boolean", "true", "true"],
      ["null", "null", "null"],
      ["undefined", "undefined", "undefined"],
      ["object", "{}", "[object Object]"],
      ["symbol", 'Symbol("token")', "Symbol(token)"],
    ] as const) {
      it(`renders ${name} from a real dynamic carrier in an IR body`, async () => {
        const source = `export function make(): any { return ${value}; }
          export function out(value: any): void { console.log(value); }`;
        const { result, stdout, stderr } = await execute(source, target, true);
        expect(stdout).toBe(expected + "\n");
        expect(stderr).toBe("");
        expect(
          result.irOutcomes?.find((o) => o.displayName === "out"),
          JSON.stringify(result.irOutcomes),
        ).toMatchObject({ irBodyEmitted: true });
        expect(result.irPostClaimErrors ?? []).toEqual([]);
      });
    }
    for (const [name, prefix, declarations, expression, expected] of [
      ["scalar number", "", "", "42", "42"],
      ["scalar boolean", "", "", "true", "true"],
      ["signed bitwise expression", "", "const value = -7;", "value | 0", "-7"],
      ["unsigned bitwise expression", "", "const value = -1;", "value >>> 0", "4294967295"],
    ] as const) {
      it(`preserves the ${name} brand`, async () => {
        const source = `${prefix} export function main(): void { ${declarations} console.log(${expression}); }`;
        const { result, stdout, stderr } = await execute(source, target, true, "main");
        expect(stdout).toBe(expected + "\n");
        expect(stderr).toBe("");
        expect(
          result.irOutcomes?.find((o) => o.displayName === "main"),
          JSON.stringify(result.irOutcomes),
        ).toMatchObject({ irBodyEmitted: true });
        expect(result.irPostClaimErrors ?? []).toEqual([]);
      });
    }

    // #7137 preserves the unsigned source domain through the native field slot.
    it("renders an unsigned native field above INT32_MAX without fallback", async () => {
      const source = `type u32 = number; class C { value: u32 = 4294967295; }
        export function main(): void { console.log((new C()).value); }`;
      const { result, stdout } = await execute(source, target, true, "main");
      expect(result.irOutcomes?.find((o) => o.displayName === "main")).toMatchObject({ irBodyEmitted: true });
      expect(result.irPostClaimErrors ?? []).toEqual([]);
      expect(result.irOutcomes?.find((o) => o.displayName === "C_new")).toMatchObject({
        irBodyEmitted: true,
        legacyBodyEmitted: false,
      });
      expect(stdout).toBe("4294967295\n");
    });

    it("evaluates the dynamic source expression once", async () => {
      const source = `var count = 0;
        function take(value: any): any { count = count + 1; return value; }
        export function calls(): number { return count; }
        export function make(): any { return "once"; }
        export function out(value: any): void { console.log(take(value)); }`;
      const { result, stdout, calls } = await execute(source, target, true);
      expect(stdout).toBe("once\n");
      expect(calls!()).toBe(1);
      expect(
        result.irOutcomes?.find((o) => o.displayName === "out"),
        JSON.stringify(result.irOutcomes),
      ).toMatchObject({ irBodyEmitted: true });
      expect(result.irPostClaimErrors ?? []).toEqual([]);
    });

    for (const [name, body, parameters] of [
      ["multiple arguments", 'console.log(value, "tail");', "value: any"],
      ["zero arguments", "console.log();", "value: any"],
      ["unknown method", "console.table(value);", "value: any"],
      ["optional call", "console.log?.(value);", "value: any"],
      ["shadowed console", "console.log(value);", "value: any, console: any"],
    ] as const) {
      it(`keeps ${name} outside the native console claim`, async () => {
        const result = await compile(`export function out(${parameters}): void { ${body} }`, {
          target,
          experimentalIR: true,
          trackIrOutcomes: true,
          skipSemanticDiagnostics: true,
        });
        expect(result.success, result.errors.map((e) => e.message).join("\n")).toBe(true);
        expect(result.irOutcomes?.find((o) => o.displayName === "out")?.irBodyEmitted).toBe(false);
        expect(result.irPostClaimErrors ?? []).toEqual([]);
      });
    }

    it("keeps an unsupported fast dynamic carrier out before claim", async () => {
      const result = await compile("export function out(value: any): void { console.log(value); }", {
        target,
        fast: true,
        experimentalIR: true,
        trackIrOutcomes: true,
      });
      expect(result.success, result.errors.map((e) => e.message).join("\n")).toBe(true);
      expect(result.irOutcomes?.find((o) => o.displayName === "out")?.irBodyEmitted).toBe(false);
      expect(result.irPostClaimErrors ?? []).toEqual([]);
    });

    for (const method of ["log", "warn", "error", "info", "debug"] as const) {
      it(`routes console.${method} to its native output channel`, async () => {
        const source = `export function make(): any { return "line"; }
          export function out(value: any): void { console.${method}(value); }`;
        const { result, stdout, stderr } = await execute(source, target, true);
        const stderrMethod = target === "wasi" && (method === "warn" || method === "error");
        expect(stdout).toBe(stderrMethod ? "" : "line\n");
        expect(stderr).toBe(stderrMethod ? "line\n" : "");
        expect(
          result.irOutcomes?.find((o) => o.displayName === "out"),
          JSON.stringify(result.irOutcomes),
        ).toMatchObject({ irBodyEmitted: true });
        expect(result.irPostClaimErrors ?? []).toEqual([]);
      });
    }
  });
}

/** These reference examples only log strings, so their JS oracle needs no inspection formatter. */
function javascriptStdout(source: string): string {
  let output = "";
  const context = {
    exports: {} as { main?: () => void },
    console: {
      log: (value: string) => {
        output += value + "\n";
      },
    },
  };
  const compiled = ts.transpileModule(source, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
  });
  runInNewContext(compiled.outputText, context, { timeout: 1000 });
  expect(context.exports.main).toBeTypeOf("function");
  context.exports.main!();
  return output;
}

describe("#7136 WASI reference emit changes", () => {
  for (const [file, witness] of [
    ["classes", "Rex makes a sound — woof!"],
    ["algorithms", "after  = [0,1,2,3,4,5,6,7,8,9]"],
  ] as const) {
    it(`executes ${file}.ts against JavaScript with an executed legacy control`, async () => {
      const source = readFileSync(new URL(`../website/playground/examples/js/${file}.ts`, import.meta.url), "utf8");
      const legacy = await execute(source, "wasi", false, "main");
      const ir = await execute(source, "wasi", true, "main");
      expect(ir.stdout).toContain(witness);
      expect(legacy.stdout.length).toBeGreaterThan(0);
      expect(ir.stdout, `legacy output was ${legacy.stdout}`).toBe(javascriptStdout(source));
      expect(ir.stderr).toBe("");
      expect(
        ir.result.irOutcomes?.find((o) => o.displayName === "main"),
        JSON.stringify(ir.result.irOutcomes),
      ).toMatchObject({ irBodyEmitted: true });
      expect(ir.result.irPostClaimErrors ?? []).toEqual([]);
    });
  }
});
