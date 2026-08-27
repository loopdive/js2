// #4767 — a worker's terminal report must survive a pipe, whatever its size.
//
// The upstream-suite parent captures worker stdout through a pipe (`spawn`
// with stdio "pipe"). A pipe accepts only its buffer — 64 KB on Linux — before
// the remainder has to be drained asynchronously by the reader, so writing the
// report and then calling `process.exit()` immediately truncates anything
// larger at exactly that boundary. That left the parent a half-written JSON
// document: `JSON.parse` threw, the parent fell back to stderr (which held only
// the `__JS2WASM_COMPILE_COMPLETE__` sentinel), and every test in the affected
// file was scored as a failure — cookie's stringify-cookie suite emits ~508 KB
// and went from 63528/63528 to 0/63528.
//
// Guard the transport itself rather than any one package: spawn a child that
// emits an over-buffer payload through the real `emitWorkerResult`, read it
// through a real pipe, and require it back byte-for-byte.

import { spawn } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";

const PROTOCOL_PATH = fileURLToPath(new URL("./dogfood/upstream-suite-worker-protocol.mjs", import.meta.url));
const PIPE_BUFFER_BYTES = 64 * 1024;

const scratch = mkdtempSync(join(tmpdir(), "issue-4767-"));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

/**
 * Emit `value` from a child process through `emitWorkerResult` and read the
 * result back over a pipe, exactly as the upstream-suite parent does.
 */
function emitThroughPipe(value: unknown, name: string): Promise<{ stdout: string; code: number | null }> {
  const scriptPath = join(scratch, `${name}.mjs`);
  writeFileSync(
    scriptPath,
    `import { emitWorkerResult } from ${JSON.stringify(PROTOCOL_PATH)};\n` +
      `emitWorkerResult(${JSON.stringify(value)});\n`,
  );

  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [scriptPath], { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.on("error", reject);
    child.on("close", (code) => resolve({ stdout, code }));
  });
}

describe("#4767 — worker reports survive the stdout pipe", () => {
  it("delivers a report far larger than the pipe buffer intact", async () => {
    // 256 KB of filler puts the payload well past the 64 KB boundary, in the
    // same size class as the real cookie report that exposed this.
    const report = { marker: "start", filler: "x".repeat(256 * 1024), marker2: "end" };
    const { stdout, code } = await emitThroughPipe(report, "large");

    expect(stdout.length).toBeGreaterThan(PIPE_BUFFER_BYTES);
    // The precise failure was a truncated document, so assert the parse rather
    // than just the length: a cut-off payload throws here.
    expect(() => JSON.parse(stdout.trim())).not.toThrow();
    expect(JSON.parse(stdout.trim())).toEqual(report);
    expect(code).toBe(0);
  });

  it("still delivers a small report and honours the exit code", async () => {
    const report = { ok: true };
    const { stdout, code } = await emitThroughPipe(report, "small");

    expect(JSON.parse(stdout.trim())).toEqual(report);
    expect(code).toBe(0);
  });
});
