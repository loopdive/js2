import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { test } from "node:test";

const script = fileURLToPath(new URL("./issue-5807-linux-replay.mjs", import.meta.url));
for (const mode of ["invalid", "pre", "post"]) {
  test(`${mode}: invalid admission never launches a compiler; post preserves terminal`, () => {
    const cwd = mkdtempSync(join(tmpdir(), "js2-5807-guard-"));
    const args = mode === "post" ? [script, mode, "1"] : [script, mode];
    const result = spawnSync(process.execPath, args, {
      cwd,
      encoding: "utf8",
      env: { ...process.env, COMPILER_POOL_SIZE: "invalid" },
    });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /AssertionError/);
    assert.deepEqual(readdirSync(cwd), mode === "post" ? ["replay5807-terminal.json"] : []);
    if (mode === "post") assert.equal(JSON.parse(readFileSync(join(cwd, "replay5807-terminal.json"))).code, 1);
    // Retain test receipts; never erase test history during agent work.
  });
}

test("post preserves the original exit before rejecting an unknown tracing mode", () => {
  const cwd = mkdtempSync(join(tmpdir(), "js2-5807-trace-guard-"));
  const result = spawnSync(process.execPath, [script, "post", "1"], {
    cwd,
    encoding: "utf8",
    env: { ...process.env, REPLAY_OBSERVATION_TRACE: "unexpected" },
  });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /unexpected trace mode/);
  assert.deepEqual(readdirSync(cwd), ["replay5807-terminal.json"]);
  assert.equal(JSON.parse(readFileSync(join(cwd, "replay5807-terminal.json"))).code, 1);
});
