import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

function writeJsonl(path: string, records: Record<string, unknown>[]) {
  writeFileSync(path, records.map((record) => JSON.stringify(record)).join("\n") + "\n");
}

function runDiff(baseline: string, candidate: string): { code: number; out: string } {
  try {
    const out = execFileSync("npx", ["tsx", "scripts/diff-test262.ts", baseline, candidate], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
    return { code: 0, out };
  } catch (err: any) {
    return { code: err.status ?? 1, out: `${err.stdout ?? ""}${err.stderr ?? ""}` };
  }
}

describe("#2098 flake classification + bucket signature in diff-test262", () => {
  let tmpDir: string | undefined;

  afterEach(() => {
    if (tmpDir) rmSync(tmpDir, { recursive: true, force: true });
    tmpDir = undefined;
  });

  function paths() {
    tmpDir = mkdtempSync(join(tmpdir(), "issue-2098-"));
    return { base: join(tmpDir, "base.jsonl"), cand: join(tmpDir, "cand.jsonl"), cand2: join(tmpDir, "cand2.jsonl") };
  }

  it("splits compile_timeout regressions into ct_flake (≤5s baseline) and ct_suspect (>5s/unknown)", () => {
    const p = paths();
    writeJsonl(p.base, [
      { oracle_version: 1, file: "fast.js", status: "pass", compile_ms: 1200 },
      { oracle_version: 1, file: "slow.js", status: "pass", compile_ms: 8000 },
      { oracle_version: 1, file: "unk.js", status: "pass" },
    ]);
    writeJsonl(p.cand, [
      { oracle_version: 1, file: "fast.js", status: "compile_timeout" },
      { oracle_version: 1, file: "slow.js", status: "compile_timeout" },
      { oracle_version: 1, file: "unk.js", status: "compile_timeout" },
    ]);
    const { out } = runDiff(p.base, p.cand);
    expect(out).toMatch(/ct_flake.*: 1 ===/);
    expect(out).toMatch(/ct_suspect.*: 2 ===/);
    expect(out).toMatch(/ct_suspect slow\.js \(baseline compile 8000ms\)/);
    expect(out).toMatch(/ct_suspect unk\.js \(baseline compile unknown\)/);
  });

  it("emits a bucket signature stable across row order and wasm_sha (cluster identity)", () => {
    const p = paths();
    writeJsonl(p.base, [
      { oracle_version: 1, file: "a.js", status: "pass", wasm_sha: "x1" },
      { oracle_version: 1, file: "b.js", status: "pass", wasm_sha: "y1" },
      { oracle_version: 1, file: "ct.js", status: "pass", compile_ms: 100 },
    ]);
    writeJsonl(p.cand, [
      { oracle_version: 1, file: "a.js", status: "fail", wasm_sha: "x2" },
      { oracle_version: 1, file: "b.js", status: "fail", wasm_sha: "y2" },
      { oracle_version: 1, file: "ct.js", status: "compile_timeout" },
    ]);
    // Same cluster, rows reordered + different wasm_sha + the CT row dropped.
    writeJsonl(p.cand2, [
      { oracle_version: 1, file: "b.js", status: "fail", wasm_sha: "z9" },
      { oracle_version: 1, file: "ct.js", status: "compile_timeout" },
      { oracle_version: 1, file: "a.js", status: "fail", wasm_sha: "w0" },
    ]);

    const sig = (out: string) => out.match(/Regression bucket signature: ([0-9a-f]{16})/)?.[1];
    const s1 = sig(runDiff(p.base, p.cand).out);
    const s2 = sig(runDiff(p.base, p.cand2).out);
    expect(s1).toBeDefined();
    expect(s1).toBe(s2);
  });

  it("changes the bucket signature when the regressing cluster differs", () => {
    const p = paths();
    writeJsonl(p.base, [
      { oracle_version: 1, file: "a.js", status: "pass", wasm_sha: "x1" },
      { oracle_version: 1, file: "b.js", status: "pass", wasm_sha: "y1" },
    ]);
    writeJsonl(p.cand, [
      { oracle_version: 1, file: "a.js", status: "fail", wasm_sha: "x2" },
      { oracle_version: 1, file: "b.js", status: "pass", wasm_sha: "y1" },
    ]);
    writeJsonl(p.cand2, [
      { oracle_version: 1, file: "a.js", status: "pass", wasm_sha: "x1" },
      { oracle_version: 1, file: "b.js", status: "fail", wasm_sha: "y2" },
    ]);
    const sig = (out: string) => out.match(/Regression bucket signature: ([0-9a-f]{16})/)?.[1];
    const s1 = sig(runDiff(p.base, p.cand).out);
    const s2 = sig(runDiff(p.base, p.cand2).out);
    expect(s1).toBeDefined();
    expect(s2).toBeDefined();
    expect(s1).not.toBe(s2);
  });
});
