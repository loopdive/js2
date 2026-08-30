// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.

import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { compile } from "../src/index.js";
import { buildImports } from "../src/runtime.js";
import { runTest262File } from "./test262-runner.js";

type Lane = "host" | "standalone";

const EXACT_FILES = [
  "built-ins/MapIteratorPrototype/Symbol.toStringTag.js",
  "built-ins/SetIteratorPrototype/Symbol.toStringTag.js",
] as const;

const CONTROL_SOURCE = `
  export function test(): number {
    const mapFromIterator: any = Object.getPrototypeOf(new Map()[Symbol.iterator]());
    const mapFromEntries: any = Object.getPrototypeOf(new Map().entries());
    const setFromIterator: any = Object.getPrototypeOf(new Set()[Symbol.iterator]());
    const setFromValues: any = Object.getPrototypeOf(new Set().values());
    if (mapFromIterator !== mapFromEntries || setFromIterator !== setFromValues) return 1;
    if (mapFromIterator === setFromIterator) return 2;

    const mapDescriptor: any = Object.getOwnPropertyDescriptor(mapFromIterator, Symbol.toStringTag);
    const setDescriptor: any = Object.getOwnPropertyDescriptor(setFromIterator, Symbol.toStringTag);
    if (mapFromIterator[Symbol.toStringTag] !== "Map Iterator") return 3;
    if (setFromIterator[Symbol.toStringTag] !== "Set Iterator") return 4;
    if (
      mapDescriptor === undefined ||
      mapDescriptor.value !== "Map Iterator" ||
      mapDescriptor.writable !== false ||
      mapDescriptor.enumerable !== false ||
      mapDescriptor.configurable !== true
    ) return 5;
    if (
      setDescriptor === undefined ||
      setDescriptor.value !== "Set Iterator" ||
      setDescriptor.writable !== false ||
      setDescriptor.enumerable !== false ||
      setDescriptor.configurable !== true
    ) return 6;
    return 0;
  }
`;

async function runControl(lane: Lane): Promise<number> {
  const options = lane === "standalone" ? { target: "standalone" as const, nativeStrings: true } : {};
  const result = await compile(CONTROL_SOURCE, { fileName: "issue-4777-control.ts", ...options });
  expect(result.success, result.success ? "" : result.errors.map((error) => error.message).join("\n")).toBe(true);
  if (!result.success) return -1;

  const imports = lane === "host" ? buildImports(result.imports, undefined, result.stringPool) : {};
  const { instance } = await WebAssembly.instantiate(result.binary, imports);
  imports.setInstance?.(instance);
  return (instance.exports as { test: () => number }).test();
}

describe("#4777 Map/Set iterator prototype Symbol.toStringTag", () => {
  it.each(EXACT_FILES)("passes the exact host Test262 row %s", async (file) => {
    const result = await runTest262File(join("test262/test", file), "issue-4777", 120_000);
    expect(result.status, `${file}: ${result.error ?? result.reason ?? ""}`).toBe("pass");
  });

  it.each(EXACT_FILES)("passes the exact standalone Test262 row %s", async (file) => {
    const result = await runTest262File(join("test262/test", file), "issue-4777", 120_000, "standalone");
    expect(result.status, `${file}: ${result.error ?? result.reason ?? ""}`).toBe("pass");
  });

  it("keeps Map and Set iterator prototypes identity-stable and separately tagged in host mode", async () => {
    await expect(runControl("host")).resolves.toBe(0);
  });

  it("keeps Map and Set iterator prototypes identity-stable and separately tagged in standalone mode", async () => {
    await expect(runControl("standalone")).resolves.toBe(0);
  });
});
