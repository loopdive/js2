// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * #6687 (S3-a of #5385) — class async-generator methods with destructured
 * params emitted invalid Wasm under the native regime in a JS environment:
 * `C_method: not enough arguments on the stack for call (need 4, got 1)`.
 *
 * Root cause: the method's param prologue boxes an f64 element with
 * `call $__box_number`. Under the native regime `__box_number` is a DEFINED
 * helper, and while the method's `__async_resume_f*` function compiles, a
 * JS-env-only late import (the eval runtime's) shifts every defined index — but
 * the method body is not reachable by the shifter at that moment, so the baked
 * live index went stale-low and landed on `__num_ryu_to_buf`. Fix: native
 * `__box_number` is minted as a stable (#1916 S3) handle, resolved at emit.
 *
 * The defect only reproduces through the real assembled harness (a bare class
 * compiles valid). A regime compile of that harness exceeds the 512 MB Vitest
 * fork, so the compile runs out of process (same pattern as #1712).
 */
import { execFile } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";

const HERE = dirname(fileURLToPath(import.meta.url));
const execFileAsync = promisify(execFile);

const REPROS = [
  "language/statements/class/dstr/async-gen-meth-static-ary-init-iter-close.js",
  "language/statements/class/dstr/async-gen-meth-ary-name-iter-val.js",
  "language/statements/class/dstr/async-gen-meth-static-dflt-ary-ptrn-rest-ary-elem.js",
];

type Row = { file: string; profile: string; error: string | null };

async function probe(files: string[], profiles: string): Promise<Row[]> {
  const { stdout } = await execFileAsync(
    process.execPath,
    [
      "--max-old-space-size=2048",
      "--import",
      "tsx",
      join(HERE, "fixtures", "issue-6687-regime-probe.mts"),
      files.join(","),
      profiles,
    ],
    { cwd: join(HERE, ".."), encoding: "utf-8", maxBuffer: 16 * 1024 * 1024 },
  );
  return JSON.parse(stdout) as Row[];
}

describe("#6687 native regime (JS env) — class async-gen method dstr validates", () => {
  it("regime builds of the three repros validate", { timeout: 300_000 }, async () => {
    const rows = await probe(REPROS, "regime");
    expect(rows.map((r) => [r.file.split("/").pop(), r.error])).toEqual(REPROS.map((f) => [f.split("/").pop(), null]));
  });

  it("standalone and default builds of the repro still validate", { timeout: 300_000 }, async () => {
    const rows = await probe([REPROS[0]!], "standalone,default");
    expect(rows.map((r) => [r.profile, r.error])).toEqual([
      ["standalone", null],
      ["default", null],
    ]);
  });
});
