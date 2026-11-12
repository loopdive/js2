// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import { describe, expect, it, vi } from "vitest";
import { compile } from "../src/index.js";
import { buildImports } from "../src/runtime.js";
import { NATIVE_STRING_MEMORY_READER } from "../src/shared/contracts/init-marshal-helpers.js";
import { readNativeStringMemory } from "../src/runtime/native-string-memory.js";

const PROGRAMS = [
  [
    "user helper name stays independent",
    "function __str_mem_read16() { return 0; } var x = 1; x = 'one'; console.log(x);",
    ["one"],
  ],
  [
    "combined issue repro",
    "var x = 1; x = 'one'; console.log(x); var s = 0; s += 'ab'; console.log(s); function f() { let y = 1; y = 'one'; return y; } console.log(f());",
    ["one", "0ab", "one"],
  ],
  ["number to string", "var x = 1; x = 'one'; console.log(x);", ["one"]],
  ["string compound assignment", "var s = 0; s += 'ab'; console.log(s);", ["0ab"]],
  ["inferred local return", "function f() { let y = 1; y = 'one'; return y; } console.log(f());", ["one"]],
  ["boolean tag", "var x = 1; x = true; console.log(x);", ["true"]],
  ["addition after string to number", "var t = 'a'; t = 5; console.log(t + 1);", ["6"]],
  ["parenthesized read", "var x = 1; x = 'one'; console.log((x));", ["one"]],
  ["alias read", "var x = 1; x = 'one'; var y = x; console.log(y);", ["one"]],
  ["local console", "function f() { let x = 1; x = 'one'; console.log(x); } f();", ["one"]],
  [
    "return forwarding",
    "function f() { let x = 1; x = 'one'; return x; } function g() { return f(); } console.log(g());",
    ["one"],
  ],
  [
    "ordered mixed values",
    "console.log(1); var x = 0; x = 'one'; console.log(x); console.log(true); console.log(2);",
    ["1", "one", "true", "2"],
  ],
  ["same type control", "var x = 1; x = 5; console.log(x + 1);", ["6"]],
] as const;

async function output(source: string, deferred: boolean, fileName = "input.js"): Promise<string[]> {
  const result = await compile(source, {
    fileName,
    allowJs: true,
    skipSemanticDiagnostics: true,
    deferTopLevelInit: deferred,
  });
  expect(result.success, result.errors.map((error) => error.message).join("\n")).toBe(true);
  const built = deferred ? buildImports(result.imports, undefined, result.stringPool) : undefined;
  const imports = built ?? result.importObject!;
  const lines: string[] = [];
  const log = vi.spyOn(console, "log").mockImplementation((...args: unknown[]) => {
    lines.push(args.map(String).join(" "));
  });
  try {
    const { instance } = await WebAssembly.instantiate(result.binary, imports as WebAssembly.Imports);
    if (built) built.setInstance?.(instance);
    else (imports as { __setInstance?: (instance: WebAssembly.Instance) => void }).__setInstance?.(instance);
    if (deferred) (instance.exports.__module_init as () => void)();
  } finally {
    log.mockRestore();
  }
  return lines;
}

describe("GitHub #7077 — heterogeneous bindings retain their runtime values", () => {
  for (const deferred of [false, true]) {
    for (const [name, source, expected] of PROGRAMS) {
      it(`${name}, ${deferred ? "deferred" : "immediate"} initialization`, async () => {
        expect(await output(source, deferred)).toEqual(expected);
      });
    }
    it(`explicit TypeScript any, deferred=${deferred}`, async () => {
      expect(await output("var x: any = 1; x = 'one'; console.log(x);", deferred, "input.ts")).toEqual(["one"]);
    });
  }
});

it("uses the shared inferred return ABI in the IR producer", async () => {
  const result = await compile("function f() { let x = 1; x = 'one'; return x; } console.log(f());", {
    fileName: "input.js",
    skipSemanticDiagnostics: true,
    trackIrOutcomes: true,
    deferTopLevelInit: true,
  });
  expect(result.success).toBe(true);
  expect(result.irCompiledFuncs).toContain("f");
  expect(result.irPostClaimErrors ?? []).toEqual([]);
});

it("prints startup values synchronously and keeps instances independent", async () => {
  const result = await compile(
    "var x = 0; x = 'one'; console.log(x); console.log(2); export function later() { console.log(7); }",
    {
      fileName: "input.js",
      skipSemanticDiagnostics: true,
    },
  );
  expect(result.success).toBe(true);
  const first = buildImports(result.imports, undefined, result.stringPool);
  const second = buildImports(result.imports, undefined, result.stringPool);
  const lines: unknown[] = [];
  const log = vi.spyOn(console, "log").mockImplementation((value: unknown) => {
    lines.push(value);
  });
  try {
    const a = await WebAssembly.instantiate(result.binary, first as WebAssembly.Imports);
    expect(lines).toEqual(["one", 2]);
    const b = await WebAssembly.instantiate(result.binary, second as WebAssembly.Imports);
    expect(lines).toEqual(["one", 2, "one", 2]);
    second.setInstance?.(b.instance);
    second.setInstance?.(b.instance);
    first.setInstance?.(a.instance);
    expect(lines).toEqual(["one", 2, "one", 2]);
    (a.instance.exports.later as () => void)();
    expect(lines).toEqual(["one", 2, "one", 2, 7]);
  } finally {
    log.mockRestore();
  }
});

it.each([
  ["native string", "var x = 1; x = 'one'; console.log(x);", "one"],
  ["number", "console.log(1);", 1],
  ["ordinary object", "console.log({ a: 1 });", undefined],
] as const)("keeps %s console effects before a startup throw", async (_name, source, expected) => {
  const result = await compile(`${source} throw 'boom';`, { fileName: "input.js", skipSemanticDiagnostics: true });
  expect(result.success).toBe(true);
  const lines: unknown[] = [];
  const log = vi.spyOn(console, "log").mockImplementation((value: unknown) => {
    lines.push(value);
  });
  try {
    await expect(WebAssembly.instantiate(result.binary, result.importObject!)).rejects.toBeDefined();
    expect(lines).toHaveLength(1);
    if (expected !== undefined) expect(lines[0]).toBe(expected);
    else expect(typeof lines[0]).toBe("object");
  } finally {
    log.mockRestore();
  }
});

it.each(["memory export", "startup reader"] as const)("decodes UTF-16 chunks through the %s", (route) => {
  const expected = "ab𝒳\ud800".repeat(1200);
  const memory = new WebAssembly.Memory({ initial: 1 });
  const offset = 16;
  const units = new Uint16Array(memory.buffer, offset, expected.length);
  for (let index = 0; index < expected.length; index++) units[index] = expected.charCodeAt(index);
  const exports =
    route === "memory export"
      ? { __str_mem: memory }
      : { [NATIVE_STRING_MEMORY_READER]: (address: number) => new DataView(memory.buffer).getUint16(address, true) };
  expect(readNativeStringMemory(exports as unknown as Record<string, Function>, offset, expected.length)).toBe(
    expected,
  );
});
