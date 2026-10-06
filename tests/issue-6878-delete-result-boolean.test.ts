// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import { describe, expect, it } from "vitest";
import { compile } from "../src/index.js";

const controls = [
  [
    "successful member delete through externref",
    `
    var obj: any = { p: 17 };
    var actual: any = delete obj.p;
    if (!booleanResult(actual, true)) return 11;
    if ("p" in obj || obj.p !== undefined) return 12;
  `,
  ],
  [
    "refused member delete through externref",
    `
    var obj: any = {};
    Object.defineProperty(obj, "p", { value: 17, configurable: false });
    var actual: any = delete obj.p;
    if (!booleanResult(actual, false)) return 21;
    if (!("p" in obj) || obj.p !== 17) return 22;
  `,
  ],
  [
    "successful computed delete through externref",
    `
    var obj: any = { p: 17 };
    var key: any = "p";
    var actual: any = delete obj[key];
    if (!booleanResult(actual, true)) return 31;
    if ("p" in obj || obj.p !== undefined) return 32;
  `,
  ],
  [
    "refused computed delete through externref",
    `
    var obj: any = {};
    Object.defineProperty(obj, "p", { value: 17, configurable: false });
    var key: any = "p";
    var actual: any = delete obj[key];
    if (!booleanResult(actual, false)) return 41;
    if (!("p" in obj) || obj.p !== 17) return 42;
  `,
  ],
  [
    "missing property delete stays Boolean and preserves siblings",
    `
    var obj: any = { sibling: 17 };
    var actual: any = delete obj.missing;
    if (!booleanResult(actual, true)) return 51;
    if ("missing" in obj || obj.sibling !== 17) return 52;
  `,
  ],
  [
    "side-effecting operand is evaluated exactly once",
    `
    var obj: any = { p: 17 };
    var count = 0;
    function receiver(): any { count++; return obj; }
    var actual: any = delete receiver().p;
    if (!booleanResult(actual, true) || count !== 1) return 61;
    if ("p" in obj) return 62;
  `,
  ],
  [
    "strict nonconfigurable delete retains TypeError identity",
    `
    "use strict";
    var obj: any = {};
    Object.defineProperty(obj, "p", { value: 17, configurable: false });
    var caught = false;
    try { delete obj.p; } catch (error) {
      caught = error instanceof TypeError && error.constructor === TypeError;
    }
    if (caught !== true || obj.p !== 17 || !("p" in obj)) return 71;
  `,
  ],
  [
    "receiver and computed key retain their once-only evaluation order",
    `
    var obj: any = { p: 17 };
    var trace = 0;
    function receiver(): any { trace = trace * 10 + 1; return obj; }
    function key(): string { trace = trace * 10 + 2; return "p"; }
    var actual: any = delete receiver()[key()];
    if (!booleanResult(actual, true) || trace !== 12) return 81;
    if ("p" in obj) return 82;
  `,
  ],
  [
    "bare with-identifier delete retains its existing Boolean brand",
    `
    var env: any = { p: 17 };
    var actual: any;
    with (env) { actual = delete p; }
    if (!booleanResult(actual, true) || "p" in env) return 91;
  `,
  ],
  [
    "pre-RHS reference capture writes Boolean while outer binding stays undefined",
    `
    var obj: any = { test262id: 1 };
    with (obj) { var test262id: any = delete obj.test262id; }
    if (!booleanResult(obj.test262id, true)) return 101;
    if (test262id !== undefined) return 102;
  `,
  ],
  [
    "a property created by the RHS cannot retarget the captured binding",
    `
    var env: any = {};
    with (env) { var actual: any = (env.actual = 17, delete env.missing); }
    if (!booleanResult(actual, true)) return 111;
    if (env.actual !== 17 || "missing" in env) return 112;
  `,
  ],
  [
    "nested with and unscopables preserve binding choice and Boolean result",
    `
    var outer: any = { result: 17 };
    var inner: any = { result: 23, p: 29 };
    inner[Symbol.unscopables] = { result: true };
    with (outer) { with (inner) { result = delete inner.p; } }
    if (!booleanResult(outer.result, true)) return 121;
    if (inner.result !== 23 || "p" in inner) return 122;
  `,
  ],
] as const;

async function run(body: string, target: "host" | "standalone"): Promise<unknown> {
  const result = await compile(
    `
    function booleanResult(value: any, expected: boolean): boolean {
      return value === expected && typeof value === "boolean";
    }
    function test(): number { ${body} return 1; }
    var controlResult = test();
    if (controlResult !== 1) throw new Error("Control result: " + controlResult);
  `,
    {
      fileName: "issue-6878-delete-result-boolean.ts",
      skipSemanticDiagnostics: true,
      inferModuleStrictArguments: false,
      deferTopLevelInit: true,
      ...(target === "standalone" ? { target: "standalone" as const } : {}),
    },
  );
  expect(result.success, JSON.stringify(result.errors)).toBe(true);
  expect(result.binary.length).toBeGreaterThan(0);
  expect(WebAssembly.validate(result.binary)).toBe(true);
  const imports = result.importObject ?? {};
  const { instance } = await WebAssembly.instantiate(result.binary, imports);
  (imports as { __setExports?: (exports: WebAssembly.Exports) => void }).__setExports?.(instance.exports);
  expect(typeof instance.exports.__module_init).toBe("function");
  (instance.exports.__module_init as () => void)();
  return 1;
}

describe.each(["host", "standalone"] as const)("#6878 delete Boolean completion (%s)", (target) => {
  it.each(controls)("%s", async (_name, body) => {
    expect(await run(body, target)).toBe(1);
  });
});
