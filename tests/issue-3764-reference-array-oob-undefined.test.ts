// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { compile } from "../src/index.js";
import { runTest262File } from "./test262-runner.js";

const EXACT_CASE = "built-ins/String/prototype/split/call-split-l-na-n-instance-is-string-hello.js";

async function runReferenceArrayProbe(target?: "standalone"): Promise<number> {
  const result: any = await compile(
    `
export function test(): number {
  var values = ["present"];
  if (values[0] !== "present") return 10;
  if (values[1] !== undefined) return 11;

  var empty = new String("hello").split("l", NaN);
  if (empty.length !== 0) return 12;
  return empty[0] === undefined ? 1 : 13;
}
`,
    {
      fileName: "issue-3764-reference-array-oob-undefined.ts",
      target,
      skipSemanticDiagnostics: true,
    },
  );
  expect(result.success, result.errors?.map((error: any) => error.message).join("\n")).toBe(true);
  if (target === "standalone") expect(result.importObject).toEqual({});
  const { instance } = await WebAssembly.instantiate(result.binary, result.importObject);
  return (instance.exports as { test(): number }).test();
}

describe("#3764 reference-array OOB reads", () => {
  it("returns undefined in host mode", async () => {
    expect(await runReferenceArrayProbe()).toBe(1);
  });

  it("returns the standalone undefined singleton", async () => {
    expect(await runReferenceArrayProbe("standalone")).toBe(1);
  });

  it("passes the authoritative standalone ES5 split case", async () => {
    const result = await runTest262File(resolve("test262/test", EXACT_CASE), "issue-3764", 30_000, "standalone");
    expect(result.status, result.error).toBe("pass");
  });
});
