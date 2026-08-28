// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #4786 — standalone WeakMap/WeakSet prototypes own their ES2015
// Symbol.toStringTag data properties.

import { existsSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { compile } from "../src/index.js";
import { buildImports } from "../src/runtime.js";
import { runTest262File } from "./test262-runner.js";

type Lane = "host" | "standalone";

const EXACT_FILES = [
  "built-ins/WeakMap/prototype/Symbol.toStringTag.js",
  "built-ins/WeakSet/prototype/Symbol.toStringTag.js",
] as const;

const TEST262_ROOT = join(__dirname, "..", "test262");
const TEST262_AVAILABLE = existsSync(join(TEST262_ROOT, "harness", "assert.js"));

const CONTROL_SOURCE = `
  export function test(): number {
    const weakMapPrototype: any = WeakMap.prototype;
    const weakSetPrototype: any = WeakSet.prototype;
    if (weakMapPrototype === weakSetPrototype) return 1;
    if (weakMapPrototype[Symbol.toStringTag] !== "WeakMap") return 2;
    if (weakSetPrototype[Symbol.toStringTag] !== "WeakSet") return 3;

    const weakMapDescriptor: any = Object.getOwnPropertyDescriptor(weakMapPrototype, Symbol.toStringTag);
    const weakSetDescriptor: any = Object.getOwnPropertyDescriptor(weakSetPrototype, Symbol.toStringTag);
    if (
      weakMapDescriptor === undefined ||
      weakMapDescriptor.value !== "WeakMap" ||
      weakMapDescriptor.writable !== false ||
      weakMapDescriptor.enumerable !== false ||
      weakMapDescriptor.configurable !== true
    ) return 4;
    if (
      weakSetDescriptor === undefined ||
      weakSetDescriptor.value !== "WeakSet" ||
      weakSetDescriptor.writable !== false ||
      weakSetDescriptor.enumerable !== false ||
      weakSetDescriptor.configurable !== true
    ) return 5;
    if (!Object.prototype.hasOwnProperty.call(weakMapPrototype, Symbol.toStringTag)) return 6;
    if (Object.prototype.propertyIsEnumerable.call(weakSetPrototype, Symbol.toStringTag)) return 7;
    if (weakMapPrototype[Symbol("unrelated")] !== undefined) return 8;
    return 0;
  }
`;

async function runControl(lane: Lane): Promise<number> {
  const options = lane === "standalone" ? { target: "standalone" as const } : {};
  const result = await compile(CONTROL_SOURCE, {
    fileName: "issue-4786-control.ts",
    ...options,
  });
  expect(result.success, result.success ? "" : result.errors.map((error) => error.message).join("\n")).toBe(true);
  if (!result.success) return -1;

  const imports = lane === "host" ? buildImports(result.imports, undefined, result.stringPool) : {};
  const { instance } = await WebAssembly.instantiate(result.binary, imports);
  imports.setInstance?.(instance);
  return (instance.exports as { test: () => number }).test();
}

describe("#4786 — WeakMap/WeakSet prototype Symbol.toStringTag", () => {
  it.skipIf(!TEST262_AVAILABLE).each(EXACT_FILES)(
    "passes the exact host Test262 row %s",
    async (file) => {
      const result = await runTest262File(join(TEST262_ROOT, "test", file), "issue-4786", 120_000);
      expect(result.status, `${file}: ${result.error ?? result.reason ?? ""}`).toBe("pass");
    },
    120_000,
  );

  it.skipIf(!TEST262_AVAILABLE).each(EXACT_FILES)(
    "passes the exact standalone Test262 row %s",
    async (file) => {
      const result = await runTest262File(join(TEST262_ROOT, "test", file), "issue-4786", 120_000, "standalone");
      expect(result.status, `${file}: ${result.error ?? result.reason ?? ""}`).toBe("pass");
    },
    120_000,
  );

  it("keeps WeakMap and WeakSet tags identity-stable with exact descriptors in host mode", async () => {
    await expect(runControl("host")).resolves.toBe(0);
  });

  it("keeps WeakMap and WeakSet tags identity-stable with exact descriptors in standalone mode", async () => {
    const result = await compile(CONTROL_SOURCE, {
      fileName: "issue-4786-control.ts",
      target: "standalone",
    });
    expect(result.success, result.success ? "" : result.errors.map((error) => error.message).join("\n")).toBe(true);
    if (!result.success) return;
    const module = await WebAssembly.compile(result.binary);
    expect(WebAssembly.Module.imports(module), "Weak collection tags stay host-free").toEqual([]);
    await expect(runControl("standalone")).resolves.toBe(0);
  });
});
