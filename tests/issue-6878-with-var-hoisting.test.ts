// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import { describe, expect, it } from "vitest";
import { compile } from "../src/index.js";

const controls = [
  [
    "reads undefined before an unreachable with-body var declaration",
    `
    if (hoisted !== undefined) return 201;
    if (false) { with ({}) { var hoisted: any = 17; } }
    if (hoisted !== undefined) return 202;
  `,
  ],
  [
    "hoisting leaves the with receiver deferred and evaluated exactly once",
    `
    var calls = 0;
    var env: any = { hoisted: 23 };
    function receiver(): any { calls++; return env; }
    if (hoisted !== undefined || calls !== 0) return 211;
    with (receiver()) { var hoisted: any = 17; }
    if (calls !== 1 || env.hoisted !== 17) return 212;
    if (hoisted !== undefined) return 213;
  `,
  ],
  [
    "nested with bodies hoist vars while retaining both object bindings",
    `
    var outer: any = { outerValue: 23 };
    var inner: any = { innerValue: 29 };
    if (outerValue !== undefined || innerValue !== undefined) return 221;
    with (outer) {
      var outerValue: any = 31;
      with (inner) { var innerValue: any = 37; }
    }
    if (outerValue !== undefined || innerValue !== undefined) return 222;
    if (outer.outerValue !== 31 || inner.innerValue !== 37) return 223;
  `,
  ],
  [
    "a nested function's var does not shadow an outer global binding",
    `
    if (outsideWithFunction !== 43) return 231;
    if (false) {
      with ({}) {
        function nested(): any { var outsideWithFunction: any = 17; return outsideWithFunction; }
      }
    }
    if (outsideWithFunction !== 43) return 232;
  `,
  ],
] as const;

async function run(body: string, target: "host" | "standalone"): Promise<void> {
  const result = await compile(
    `
    var outsideWithFunction: any = 43;
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
  const binary = new Uint8Array(result.binary);
  expect(WebAssembly.validate(binary)).toBe(true);
  const imports = result.importObject ?? {};
  const { instance } = await WebAssembly.instantiate(binary, imports);
  // Bind the genuine instance so host struct operations have decoding authority.
  (imports as { __setInstance?: (instance: WebAssembly.Instance) => void }).__setInstance?.(instance);
  expect(typeof instance.exports.__module_init).toBe("function");
  (instance.exports.__module_init as () => void)();
}

describe.each(["host", "standalone"] as const)("#6878 with var hoisting (%s)", (target) => {
  it.each(controls)("%s", async (_name, body) => {
    await run(body, target);
  });
});
