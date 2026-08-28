// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.

import { existsSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { compile } from "../src/index.js";
import { buildImports } from "../src/runtime.js";
import { runTest262File } from "./test262-runner.js";

type Lane = "host" | "standalone";

const EXACT_FILES = [
  "built-ins/Map/prototype/Symbol.toStringTag.js",
  "built-ins/Set/prototype/Symbol.toStringTag.js",
  "built-ins/Set/prototype/Symbol.toStringTag/property-descriptor.js",
] as const;

const TEST262_ROOT = join(process.cwd(), "test262");
const TEST262_AVAILABLE = existsSync(join(TEST262_ROOT, "harness", "assert.js"));

const CONTROL_SOURCE = `
  export function test(): number {
    const mapProto: any = Map.prototype;
    const setProto: any = Set.prototype;
    if (mapProto === setProto) return 1;
    if (mapProto[Symbol.toStringTag] !== "Map") return 2;
    if (setProto[Symbol.toStringTag] !== "Set") return 3;

    const mapDescriptor: any = Object.getOwnPropertyDescriptor(mapProto, Symbol.toStringTag);
    const setDescriptor: any = Object.getOwnPropertyDescriptor(setProto, Symbol.toStringTag);
    if (
      mapDescriptor === undefined ||
      mapDescriptor.value !== "Map" ||
      mapDescriptor.writable !== false ||
      mapDescriptor.enumerable !== false ||
      mapDescriptor.configurable !== true
    ) return 4;
    if (
      setDescriptor === undefined ||
      setDescriptor.value !== "Set" ||
      setDescriptor.writable !== false ||
      setDescriptor.enumerable !== false ||
      setDescriptor.configurable !== true
    ) return 5;
    if (mapProto[Symbol("toStringTag")] !== undefined) return 6;
    return 0;
  }
`;

async function runControl(lane: Lane): Promise<number> {
  const options = lane === "standalone" ? { target: "standalone" as const, nativeStrings: true } : {};
  const result = await compile(CONTROL_SOURCE, { fileName: "issue-5116-control.ts", ...options });
  expect(result.success, result.success ? "" : result.errors.map((error) => error.message).join("\n")).toBe(true);
  if (!result.success) return -1;

  if (lane === "standalone") expect(result.imports?.length ?? 0, "standalone control must remain host-free").toBe(0);
  const imports = lane === "host" ? buildImports(result.imports, undefined, result.stringPool) : {};
  const { instance } = await WebAssembly.instantiate(result.binary, imports);
  imports.setInstance?.(instance);
  return (instance.exports as { test: () => number }).test();
}

describe("#5116 standalone Map/Set prototype Symbol.toStringTag", () => {
  it.skipIf(!TEST262_AVAILABLE).each(EXACT_FILES)(
    "passes the exact host Test262 row %s",
    async (file) => {
      const result = await runTest262File(join(TEST262_ROOT, "test", file), "issue-5116", 120_000);
      expect(result.status, `${file}: ${result.error ?? result.reason ?? ""}`).toBe("pass");
    },
    180_000,
  );

  it.skipIf(!TEST262_AVAILABLE).each(EXACT_FILES)(
    "passes the exact standalone Test262 row %s",
    async (file) => {
      const result = await runTest262File(join(TEST262_ROOT, "test", file), "issue-5116", 120_000, "standalone");
      expect(result.status, `${file}: ${result.error ?? result.reason ?? ""}`).toBe("pass");
    },
    180_000,
  );

  it("keeps Map/Set tag values and descriptors isolated in host mode", async () => {
    await expect(runControl("host")).resolves.toBe(0);
  });

  it("keeps Map/Set tag values and descriptors isolated in standalone mode", async () => {
    await expect(runControl("standalone")).resolves.toBe(0);
  });
});
