// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.

import { existsSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { compile } from "../src/index.js";
import { buildImports } from "../src/runtime.js";
import { runTest262File } from "./test262-runner.js";

type Lane = "host" | "standalone";

const EXACT_FILES = [
  "built-ins/StringIteratorPrototype/next/length.js",
  "built-ins/StringIteratorPrototype/next/name.js",
] as const;

const TEST262_AVAILABLE = existsSync(join("test262", "harness", "assert.js"));
const test262It = TEST262_AVAILABLE ? it : it.skip;

const CONTROL_SOURCE = `
  export function test(): number {
    const proto: any = Object.getPrototypeOf(new String()[Symbol.iterator]());
    const next: any = proto.next;
    const descriptor: any = Object.getOwnPropertyDescriptor(proto, "next");
    if (typeof next !== "function") return 1;
    if (next.name !== "next" || next.length !== 0) return 2;
    if (
      descriptor === undefined ||
      descriptor.value !== next ||
      descriptor.writable !== true ||
      descriptor.enumerable !== false ||
      descriptor.configurable !== true
    ) return 3;
    return 0;
  }
`;

async function runControl(lane: Lane): Promise<number> {
  const options = lane === "standalone" ? { target: "standalone" as const, nativeStrings: true } : {};
  const result = await compile(CONTROL_SOURCE, { fileName: "issue-5099-control.ts", ...options });
  expect(result.success, result.success ? "" : result.errors.map((error) => error.message).join("\n")).toBe(true);
  if (!result.success) return -1;

  const imports = lane === "host" ? buildImports(result.imports, undefined, result.stringPool) : {};
  const { instance } = await WebAssembly.instantiate(result.binary, imports);
  imports.setInstance?.(instance);
  return (instance.exports as { test: () => number }).test();
}

describe("#5099 StringIteratorPrototype.next metadata", () => {
  test262It.each(EXACT_FILES)("passes the exact host Test262 row %s", async (file) => {
    const result = await runTest262File(join("test262/test", file), "issue-5099", 120_000);
    expect(result.status, `${file}: ${result.error ?? result.reason ?? ""}`).toBe("pass");
  });

  test262It.each(EXACT_FILES)("passes the exact standalone Test262 row %s", async (file) => {
    const result = await runTest262File(join("test262/test", file), "issue-5099", 120_000, "standalone");
    expect(result.status, `${file}: ${result.error ?? result.reason ?? ""}`).toBe("pass");
  });

  it("preserves the descriptor and function metadata in host mode", async () => {
    await expect(runControl("host")).resolves.toBe(0);
  });

  it("preserves the descriptor and function metadata in standalone mode", async () => {
    await expect(runControl("standalone")).resolves.toBe(0);
  });
});
