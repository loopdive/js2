// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import { afterEach, describe, expect, it } from "vitest";
import { compile, type CompileResult } from "../src/index.js";
import { buildImports } from "../src/runtime.js";

const SAFE_SOURCE = `
function sum(): number {
  let result = arguments.length;
  for (let index = 0; index < arguments.length; index++) {
    result += arguments[index] as number;
  }
  return result;
}

function firstThroughArrow(): number {
  const read = (): number => arguments[0] as number;
  return read();
}

export function test(): number {
  return sum(4, 5) + firstThroughArrow(7);
}
`;

function hasRegistrationImport(result: CompileResult): boolean {
  return result.imports.some((entry) => entry.name === "__register_arguments");
}

async function compileSource(source: string, enabled: boolean): Promise<CompileResult> {
  process.env.JS2WASM_ELIDE_PRIVATE_ARGUMENTS_REGISTRATION = enabled ? "1" : "0";
  const result = await compile(source, {
    fileName: "private-arguments-registration.ts",
    skipSemanticDiagnostics: true,
  });
  expect(result.success, result.errors.map((error) => error.message).join("\n")).toBe(true);
  expect(WebAssembly.validate(result.binary)).toBe(true);
  return result;
}

async function run(result: CompileResult): Promise<number> {
  const imports = buildImports(result.imports, undefined, result.stringPool);
  const { instance } = await WebAssembly.instantiate(result.binary, imports);
  return (instance.exports.test as () => number)();
}

afterEach(() => {
  process.env.JS2WASM_ELIDE_PRIVATE_ARGUMENTS_REGISTRATION = undefined;
});

describe("private read-only arguments host registration", () => {
  it("omits the host import for length and proven numeric indexed reads", async () => {
    const optimized = await compileSource(SAFE_SOURCE, true);
    const control = await compileSource(SAFE_SOURCE, false);
    expect(hasRegistrationImport(optimized)).toBe(false);
    expect(hasRegistrationImport(control)).toBe(true);
    expect(await run(optimized)).toBe(18);
    expect(await run(control)).toBe(18);
    expect(optimized.binary.length).toBeLessThan(control.binary.length);
  });

  const reflectiveOrEscapingBodies = [
    "return arguments as any;",
    "return (arguments as any).constructor;",
    'return (arguments as any)["callee"];',
    'const key: string = "0"; return (arguments as any)[key];',
    "(arguments as any)[0] = 9; return 9;",
    "[(arguments as any)[0]] = [9]; return 9;",
    "(arguments as any).length = 0; return 0;",
    "return (arguments as any)[0]();",
    'return eval("arguments.length");',
  ];

  for (const body of reflectiveOrEscapingBodies) {
    it(`keeps registration for ${body}`, async () => {
      const result = await compileSource(
        `
        export function inspect(): any { ${body} }
        export function test(): number { return 1; }
      `,
        true,
      );
      expect(hasRegistrationImport(result)).toBe(true);
    });
  }
});
