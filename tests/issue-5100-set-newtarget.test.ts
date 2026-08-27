// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
// #5100 — a flowing Set prototype must not turn the intrinsic constructor adder
// into a refusing first-class closure.
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { compile } from "../src/index.js";
import { buildImports } from "../src/runtime.js";
import { runTest262File } from "./test262-runner.js";

type Lane = "host" | "standalone";

const EXACT = "built-ins/Set/set-newtarget.js";
const CONTROLS = [
  "built-ins/Set/prototype/add/returns-this.js",
  "built-ins/Set/prototype/has/returns-false-when-value-not-present-boolean.js",
  "built-ins/Set/set-get-add-method-failure.js",
] as const;

const PROBE = `
  export function test(): number {
    const empty = new Set();
    const seeded = new Set([1, 2]);
    return Object.getPrototypeOf(empty) === Set.prototype &&
      Object.getPrototypeOf(seeded) === Set.prototype &&
      empty.size === 0 && seeded.size === 2 ? 1 : 0;
  }
`;

async function runProbe(lane: Lane): Promise<number> {
  const options = lane === "standalone" ? { target: "standalone" as const, nativeStrings: true } : {};
  const result = await compile(PROBE, { fileName: "issue-5100-probe.ts", ...options });
  expect(result.success, result.success ? "" : result.errors.map((error) => error.message).join("\n")).toBe(true);
  if (!result.success) return -1;
  if (lane === "standalone") expect(result.imports ?? []).toHaveLength(0);
  const imports = lane === "host" ? buildImports(result.imports, undefined, result.stringPool) : {};
  const { instance } = await WebAssembly.instantiate(result.binary, imports);
  imports.setInstance?.(instance);
  return (instance.exports as { test: () => number }).test();
}

describe("#5100 standalone Set constructor intrinsic add", () => {
  it("passes the exact host Test262 row", async () => {
    const result = await runTest262File(join("test262/test", EXACT), "issue-5100", 120_000);
    expect(result.status, result.error ?? result.reason ?? "").toBe("pass");
  });

  it("passes the exact standalone Test262 row", async () => {
    const result = await runTest262File(join("test262/test", EXACT), "issue-5100", 120_000, "standalone");
    expect(result.status, result.error ?? result.reason ?? "").toBe("pass");
  });

  for (const control of CONTROLS) {
    it(`keeps the host control green: ${control}`, async () => {
      const result = await runTest262File(join("test262/test", control), "issue-5100", 120_000);
      expect(result.status, result.error ?? result.reason ?? "").toBe("pass");
    });

    it(`keeps the standalone control green: ${control}`, async () => {
      const result = await runTest262File(join("test262/test", control), "issue-5100", 120_000, "standalone");
      expect(result.status, result.error ?? result.reason ?? "").toBe("pass");
    });
  }

  it("preserves Set prototype identity and native collection state in standalone", async () => {
    await expect(runProbe("standalone")).resolves.toBe(1);
  });

  it("preserves Set prototype identity and native collection state on host", async () => {
    await expect(runProbe("host")).resolves.toBe(1);
  });
});
