// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #5119 — ES2015 §28.1.5 / §28.1.8: Reflect.get/has must reject a Symbol
// target before ToPropertyKey (and before an explicit receiver is consumed).
// ArgumentListEvaluation still evaluates every supplied argument first.
import { existsSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { compile } from "../src/index.js";
import { runTest262File } from "./test262-runner.js";

type Lane = "host" | "standalone";
const CONTROL_TIMEOUT_MS = 150_000;

async function run(source: string, lane: Lane): Promise<number> {
  const result = await compile(source, {
    fileName: "issue-5119.ts",
    skipSemanticDiagnostics: true,
    ...(lane === "standalone" ? { target: "standalone" as const } : {}),
  });
  expect(result.success, result.errors.map((error) => error.message).join("\n")).toBe(true);
  expect(WebAssembly.validate(result.binary), `${lane} module failed validation`).toBe(true);

  const module = new WebAssembly.Module(result.binary);
  const imports = WebAssembly.Module.imports(module).map((entry) => `${entry.module}::${entry.name}`);
  if (lane === "standalone") {
    expect(imports, "standalone Reflect.get/has must not import a host helper").toEqual([]);
    const { instance } = await WebAssembly.instantiate(result.binary, {});
    return (instance.exports as { test: () => number }).test();
  }

  const importObject = result.importObject ?? {};
  const { instance } = await WebAssembly.instantiate(result.binary, importObject);
  (importObject as { __setInstance?: (value: WebAssembly.Instance) => void }).__setInstance?.(instance);
  return (instance.exports as { test: () => number }).test();
}

const GET_SYMBOL_TARGET = `
  export function test(): number {
    try {
      Reflect.get(Symbol(1), "missing");
      return 0;
    } catch (error) {
      return error instanceof TypeError ? 1 : 0;
    }
  }
`;

const HAS_SYMBOL_TARGET = `
  export function test(): number {
    try {
      Reflect.has(Symbol(1), "missing");
      return 0;
    } catch (error) {
      return error instanceof TypeError ? 1 : 0;
    }
  }
`;

const DYNAMIC_SYMBOL_TARGETS = `
  function get(target: any): any {
    return Reflect.get(target, "missing");
  }
  function has(target: any): boolean {
    return Reflect.has(target, "missing");
  }
  export function test(): number {
    let getCaught = 0;
    let hasCaught = 0;
    try {
      get(Symbol(1));
    } catch (error) {
      getCaught = error instanceof TypeError ? 1 : 0;
    }
    try {
      has(Symbol(2));
    } catch (error) {
      hasCaught = error instanceof TypeError ? 1 : 0;
    }
    return getCaught && hasCaught ? 1 : 0;
  }
`;

const GET_SYMBOL_TARGET_NO_KEY_COERCION = `
  let toStringCalls = 0;
  const key: any = {
    toString(): string {
      toStringCalls = toStringCalls + 1;
      return "missing";
    },
  };
  export function test(): number {
    try {
      Reflect.get(Symbol(1), key);
      return 0;
    } catch (error) {
      return error instanceof TypeError && toStringCalls === 0 ? 1 : 0;
    }
  }
`;

const HAS_SYMBOL_TARGET_NO_KEY_COERCION = `
  let toStringCalls = 0;
  const key: any = {
    toString(): string {
      toStringCalls = toStringCalls + 1;
      return "missing";
    },
  };
  export function test(): number {
    try {
      Reflect.has(Symbol(1), key);
      return 0;
    } catch (error) {
      return error instanceof TypeError && toStringCalls === 0 ? 1 : 0;
    }
  }
`;

const GET_LATE_ARGUMENT_ABRUPTION = `
  let order = 0;
  function mark(value: number): any {
    order = order * 10 + value;
    return "missing";
  }
  function abrupt(): any {
    order = order * 10 + 3;
    throw 99;
  }
  export function test(): number {
    try {
      Reflect.get(Symbol(1), mark(2), abrupt());
      return 0;
    } catch (error) {
      return order === 23 && error === 99 ? 1 : 0;
    }
  }
`;

const HAS_LATE_ARGUMENT_ABRUPTION = `
  let order = 0;
  function mark(value: number): any {
    order = order * 10 + value;
    return "missing";
  }
  function abrupt(): any {
    order = order * 10 + 3;
    throw 99;
  }
  export function test(): number {
    try {
      Reflect.has(Symbol(1), mark(2), abrupt());
      return 0;
    } catch (error) {
      return order === 23 && error === 99 ? 1 : 0;
    }
  }
`;

const OBJECT_TARGETS = `
  export function test(): number {
    const target: any = { value: 41 };
    return Reflect.get(target, "value") === 41 && Reflect.has(target, "value") ? 1 : 0;
  }
`;

const OBJECT_TARGET_EXPLICIT_RECEIVER = `
  export function test(): number {
    const target: any = {};
    Object.defineProperty(target, "value", {
      get: function (): number { return (this as any).marker; },
    });
    const receiver: any = { marker: 42 };
    return Reflect.get(target, "value", receiver) === 42 ? 1 : 0;
  }
`;

const NATIVE_SIBLING_OBJECT_TARGETS = `
  export function test(): number {
    const array: any = [41];
    return Reflect.get(array, "0") === 41 &&
      Reflect.has(array, "0") &&
      Reflect.get(function callable(): number { return 42; }, "length") === 0 ? 1 : 0;
  }
`;

describe("#5119 — Reflect.get/has Symbol target validation", () => {
  for (const lane of ["host", "standalone"] as const) {
    it(
      `${lane}: get rejects a Symbol target with the exact TypeError identity`,
      { timeout: CONTROL_TIMEOUT_MS },
      async () => {
        await expect(run(GET_SYMBOL_TARGET, lane)).resolves.toBe(1);
      },
    );

    it(
      `${lane}: has rejects a Symbol target with the exact TypeError identity`,
      { timeout: CONTROL_TIMEOUT_MS },
      async () => {
        await expect(run(HAS_SYMBOL_TARGET, lane)).resolves.toBe(1);
      },
    );

    it(
      `${lane}: callee-before-caller dynamic Symbol targets still reject in get and has`,
      { timeout: CONTROL_TIMEOUT_MS },
      async () => {
        await expect(run(DYNAMIC_SYMBOL_TARGETS, lane)).resolves.toBe(1);
      },
    );

    it(`${lane}: get validates the target before key ToPropertyKey`, { timeout: CONTROL_TIMEOUT_MS }, async () => {
      await expect(run(GET_SYMBOL_TARGET_NO_KEY_COERCION, lane)).resolves.toBe(1);
    });

    it(`${lane}: has validates the target before key ToPropertyKey`, { timeout: CONTROL_TIMEOUT_MS }, async () => {
      await expect(run(HAS_SYMBOL_TARGET_NO_KEY_COERCION, lane)).resolves.toBe(1);
    });

    it(
      `${lane}: get evaluates a later abrupt argument after earlier arguments`,
      { timeout: CONTROL_TIMEOUT_MS },
      async () => {
        await expect(run(GET_LATE_ARGUMENT_ABRUPTION, lane)).resolves.toBe(1);
      },
    );

    it(
      `${lane}: has evaluates a later abrupt argument after earlier arguments`,
      { timeout: CONTROL_TIMEOUT_MS },
      async () => {
        await expect(run(HAS_LATE_ARGUMENT_ABRUPTION, lane)).resolves.toBe(1);
      },
    );

    it(`${lane}: object targets remain positive`, { timeout: CONTROL_TIMEOUT_MS }, async () => {
      await expect(run(OBJECT_TARGETS, lane)).resolves.toBe(1);
    });

    it(
      `${lane}: get still consumes an explicit receiver for object targets`,
      { timeout: CONTROL_TIMEOUT_MS },
      async () => {
        await expect(run(OBJECT_TARGET_EXPLICIT_RECEIVER, lane)).resolves.toBe(1);
      },
    );

    it(
      `${lane}: array and callable sibling carriers remain object targets`,
      { timeout: CONTROL_TIMEOUT_MS },
      async () => {
        await expect(run(NATIVE_SIBLING_OBJECT_TARGETS, lane)).resolves.toBe(1);
      },
    );
  }
});

const TEST262_ROOT = join(__dirname, "..", "test262");
const TARGET_ROWS = [
  "built-ins/Reflect/get/target-is-symbol-throws.js",
  "built-ins/Reflect/has/target-is-symbol-throws.js",
] as const;
const TARGET_ROWS_AVAILABLE = TARGET_ROWS.every((relativePath) => existsSync(join(TEST262_ROOT, "test", relativePath)));

describe.skipIf(!TARGET_ROWS_AVAILABLE)("#5119 exact Test262 rows", () => {
  for (const lane of ["host", "standalone"] as const) {
    for (const relativePath of TARGET_ROWS) {
      it(`${lane}: ${relativePath} passes`, { timeout: 150_000 }, async () => {
        const result = await runTest262File(
          join(TEST262_ROOT, "test", relativePath),
          "issue-5119-reflect-symbol-target",
          130_000,
          lane === "standalone" ? lane : undefined,
        );
        expect(result.status, result.error ?? result.reason ?? "").toBe("pass");
      });
    }
  }
});
