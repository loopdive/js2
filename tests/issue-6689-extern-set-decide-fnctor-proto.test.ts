// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * #6689 (S3-c of #5385) — `f.length = o` trapped with an uncatchable
 * `illegal cast` inside `__extern_set_decide` when `f` is an instance of a
 * function constructor whose `prototype` is a native array:
 *
 *   foo.prototype = new Array(1, 2, 3); function foo() {}
 *   var f = new foo(); f.length = o;
 *
 * The #4504 inherited-[[Set]] decision started its walk at the fnctor's
 * registered prototype and `ref.cast` it to `$Object` unconditionally; a vec
 * prototype is not one. The cast is now guarded by `ref.test` (the #4639 rule
 * the `__extern_get` arm already follows).
 *
 * Why it surfaced under the native regime in a JS environment: the decision
 * runtime is active only when a descriptor trigger is present, and the
 * harness's `$262.evalScript` carries an `eval(...)` call. Host-free targets
 * elide that dead binding before parsing (#3418), the JS environment does not,
 * so only the regime build activated the runtime. The defect is the cast, not
 * the environment: a standalone build with a LIVE `Function(...)` call traps
 * identically, which the `standalone-dyn` profile pins.
 *
 * A regime compile of the assembled harness exceeds the 512 MB Vitest fork, so
 * the compile runs out of process (same pattern as #6687).
 */
import { execFile } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";

const HERE = dirname(fileURLToPath(import.meta.url));
const execFileAsync = promisify(execFile);

const REPRO = "built-ins/Array/prototype/reduceRight/15.4.4.22-5-6.js";

type Row = { file: string; profile: string; error: string | null; run?: string | null; sha256?: string };

async function probe(profiles: string): Promise<Row[]> {
  const { stdout } = await execFileAsync(
    process.execPath,
    [
      "--max-old-space-size=2048",
      "--import",
      "tsx",
      join(HERE, "fixtures", "issue-6689-regime-probe.mts"),
      REPRO,
      profiles,
    ],
    { cwd: join(HERE, ".."), encoding: "utf-8", maxBuffer: 16 * 1024 * 1024 },
  );
  return JSON.parse(stdout) as Row[];
}

describe("#6689 __extern_set_decide tests a fnctor prototype before casting it", () => {
  it("regime build validates and runs the assembled repro", { timeout: 300_000 }, async () => {
    const [row] = await probe("regime");
    expect(row?.error).toBeNull();
    expect(row?.run).toBeNull();
  });

  it("standalone with live dynamic code runs the repro without a trap", { timeout: 300_000 }, async () => {
    const [row] = await probe("standalone-dyn");
    expect(row?.error).toBeNull();
    expect(row?.run).toBeNull();
  });

  // Byte identity of these two against the pre-fix compiler is a PR-time
  // measurement (recorded in the #6689 issue file); pinning a hash here would
  // break on every unrelated main change, so the test asserts validity only.
  it("standalone and default builds of the repro still validate", { timeout: 300_000 }, async () => {
    const rows = await probe("standalone,default");
    expect(rows.map((r) => [r.profile, r.error])).toEqual([
      ["standalone", null],
      ["default", null],
    ]);
  });
});
