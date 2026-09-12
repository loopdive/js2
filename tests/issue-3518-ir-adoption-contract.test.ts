// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.

import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const repository = resolve(import.meta.dirname, "..");
const contract = "src/shared/contracts/ir-preparation-failure.ts";
const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function fixture(transform: (source: string) => string | undefined) {
  const root = mkdtempSync(resolve(tmpdir(), "js2-adoption-contract-"));
  roots.push(root);
  const put = (path: string, text: string) => {
    mkdirSync(dirname(resolve(root, path)), { recursive: true });
    writeFileSync(resolve(root, path), text);
  };
  for (const path of ["scripts/gen-ir-adoption.mjs", "plan/log/ir-adoption.md", "src/codegen/index.ts", ".prettierrc"])
    put(path, readFileSync(resolve(repository, path), "utf8"));
  const original = readFileSync(resolve(repository, contract), "utf8");
  // Even a valid old-location union must not mask a broken canonical owner.
  put("src/ir/select.ts", original);
  const source = transform(original);
  if (source !== undefined) put(contract, source);
  symlinkSync(resolve(repository, "node_modules"), resolve(root, "node_modules"));
  const result = spawnSync(process.execPath, [resolve(root, "scripts/gen-ir-adoption.mjs"), "--check"], {
    encoding: "utf8",
    timeout: 30_000,
  });
  expect(result.error).toBeUndefined();
  expect(result.signal).toBeNull();
  return result;
}

describe("IR adoption reads the canonical fallback contract", () => {
  it("checks the complete unchanged report using the canonical owner", () => {
    const result = fixture((source) => source);
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain("ir-adoption.md is up to date.");
  });
  it("rejects an absent canonical owner despite the old union", () => {
    const result = fixture(() => undefined);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("ENOENT");
    expect(result.stderr).toContain(contract);
  });
  it("rejects an empty union", () => {
    const result = fixture(() => "export type IrFallbackReason = never;");
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("parsed to zero members");
  });
  it("rejects a new undocumented reason", () => {
    const result = fixture((source) => source.replace('| "unnamed"', '| "new-undocumented-reason"\n  | "unnamed"'));
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("missing from BUCKETS: new-undocumented-reason");
  });
  it("rejects a removed reason still documented in the report", () => {
    const result = fixture((source) => source.replace('| "unnamed"', ""));
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain(`in BUCKETS but not in ${contract}: unnamed`);
  });
});
