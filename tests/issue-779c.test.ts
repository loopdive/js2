import { describe, it, expect } from "vitest";
import { runTest262File } from "./test262-runner.js";
import { writeFileSync, mkdtempSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";

/**
 * #779c — String.prototype.split result `.constructor` must be `Array`.
 *
 * The test262 runner supplies a `globalSandbox` (vm.createContext) for
 * per-test built-in isolation. The test's `Array` identifier resolves to
 * `sandbox.Array` via `declared_global`, but the runtime's `extern_get`
 * for `vec.constructor` previously returned `globalThis.Array` — identity
 * mismatch failed ~78 split/array constructor assertions.
 *
 * The fix in src/runtime.ts substitutes `sandbox.Array` when a sandbox is
 * active, restoring identity. src/codegen/index.ts is also updated to emit
 * `__vec_len` whenever `__extern_get` is imported so the runtime can
 * positively identify vec wrappers when this code path runs.
 */

function writeTest262Style(body: string): string {
  const dir = mkdtempSync(join(tmpdir(), "issue-779c-"));
  const file = join(dir, "test.js");
  writeFileSync(
    file,
    `// Copyright test262
/*---
description: synthetic regression test for #779c
---*/

${body}
`,
  );
  return file;
}

describe("#779c — String.prototype.split / Array literal constructor identity under sandbox", () => {
  it("'a,b,c'.split(',') result has constructor === Array", async () => {
    const file = writeTest262Style(`
      var __split = "a,b,c".split(",");
      assert.sameValue(__split.constructor, Array);
      assert.sameValue(__split.length, 3);
    `);
    const r = await runTest262File(file, "test", 30000);
    expect(r.status).toBe("pass");
  });

  it("array literal has constructor === Array", async () => {
    const file = writeTest262Style(`
      var __arr = [1, 2, 3];
      assert.sameValue(__arr.constructor, Array);
    `);
    const r = await runTest262File(file, "test", 30000);
    expect(r.status).toBe("pass");
  });

  it("Array.prototype.constructor === Array", async () => {
    const file = writeTest262Style(`
      assert.sameValue(Array.prototype.constructor, Array);
    `);
    const r = await runTest262File(file, "test", 30000);
    expect(r.status).toBe("pass");
  });

  it("new Array() has constructor === Array", async () => {
    const file = writeTest262Style(`
      var __arr = new Array(3);
      assert.sameValue(__arr.constructor, Array);
    `);
    const r = await runTest262File(file, "test", 30000);
    expect(r.status).toBe("pass");
  });

  it("real test262 split test passes", async () => {
    const r = await runTest262File(
      "/workspace/test262/test/built-ins/String/prototype/split/instance-is-string.js",
      "built-ins/String",
      30000,
    );
    expect(r.status).toBe("pass");
  });
});
