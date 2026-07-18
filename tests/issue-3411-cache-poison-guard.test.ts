// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #3411 — the standalone CACHE-SUSPECT guard. A stale-base merge_group
// collapse (>90% of non-skip standalone records are the #2961 host-import
// verdict) must fail as CACHE-SUSPECT (exit 3), distinctly from a real
// standalone regression; a healthy run passes (exit 0).
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const SCRIPT = join(import.meta.dirname ?? ".", "..", "scripts", "check-standalone-cache-poison.mjs");
const HOST_IMPORT_ERR =
  "standalone target emitted host imports: env::console_log_externref, env::structuredClone (#2961)";

let dir: string;
beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "cache-poison-"));
});
afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

function writeJsonl(name: string, records: object[]): string {
  const p = join(dir, name);
  writeFileSync(p, records.map((r) => JSON.stringify(r)).join("\n"));
  return p;
}

// Run the guard, returning its exit code (execFileSync throws on non-zero).
function runGuard(jsonl: string): number {
  try {
    execFileSync("node", [SCRIPT, "--jsonl", jsonl], { stdio: "pipe" });
    return 0;
  } catch (e) {
    return (e as { status?: number }).status ?? -1;
  }
}

describe("#3411 standalone cache-poison guard", () => {
  it("fails as CACHE-SUSPECT (exit 3) on the >90% host-import collapse", () => {
    const records: object[] = [];
    for (let i = 0; i < 1100; i++) records.push({ path: `t${i}`, status: "compile_error", error: HOST_IMPORT_ERR });
    for (let i = 0; i < 100; i++) records.push({ path: `p${i}`, status: "pass" });
    for (let i = 0; i < 50; i++) records.push({ path: `s${i}`, status: "skip", error: "unsupported" });
    expect(runGuard(writeJsonl("poison.jsonl", records))).toBe(3);
  });

  it("passes (exit 0) on a healthy lane with a minority of host-import verdicts", () => {
    const records: object[] = [];
    for (let i = 0; i < 200; i++) records.push({ path: `t${i}`, status: "compile_error", error: HOST_IMPORT_ERR });
    for (let i = 0; i < 900; i++) records.push({ path: `p${i}`, status: "pass" });
    for (let i = 0; i < 100; i++) records.push({ path: `f${i}`, status: "fail", error: "assertion" });
    expect(runGuard(writeJsonl("healthy.jsonl", records))).toBe(0);
  });

  it("passes (exit 0) on a corpus below min-records even at 100% host-import", () => {
    const records: object[] = [];
    for (let i = 0; i < 50; i++) records.push({ path: `t${i}`, status: "compile_error", error: HOST_IMPORT_ERR });
    expect(runGuard(writeJsonl("small.jsonl", records))).toBe(0);
  });

  it("does not fire on unrelated compile_error clusters (a real regression is not CACHE-SUSPECT)", () => {
    // A genuine mass CE from a different cause must NOT be swallowed as infra —
    // it should pass this guard so the real regression gates evaluate it.
    const records: object[] = [];
    for (let i = 0; i < 1100; i++)
      records.push({ path: `t${i}`, status: "compile_error", error: "Codegen error: something unrelated broke" });
    for (let i = 0; i < 100; i++) records.push({ path: `p${i}`, status: "pass" });
    expect(runGuard(writeJsonl("real-regression.jsonl", records))).toBe(0);
  });
});
