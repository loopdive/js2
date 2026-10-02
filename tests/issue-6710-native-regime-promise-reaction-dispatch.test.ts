// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * #6710 (S3-f of #5385) — Promise reaction rows trapped with
 * `illegal cast [in __call_fn_method_N]` under the native regime in a JS
 * environment.
 *
 * The callee was never the problem: the reaction handler calls `$DONE()` with
 * no argument, the harness global resolves through the runtime-eval dynamic
 * scope, and `__runtime_eval_call_aot` → `__apply_closure` widens the
 * under-applied call to `__call_fn_method_1`. `$DONE`'s funcref matched the
 * `__consolePrintHandle__` arm first — both lift to `(self, string)` and are one
 * canonical type after `widenNonDefaultableTypes` — but that arm had been built
 * from the pre-widening `(ref $AnyString)` formal, so the padded JS `undefined`
 * met a non-null `ref.cast` instead of the omitted-argument `ref.null` arm.
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

const REPROS = [
  "built-ins/Promise/prototype/then/rxn-handler-fulfilled-next.js",
  "built-ins/Promise/prototype/then/rxn-handler-rejected-next.js",
  "built-ins/Promise/all/reject-deferred.js",
];

type Row = { file: string; profile: string; sha256?: string; complete: boolean; error: string | null };

async function probe(files: string[], profiles: string): Promise<Row[]> {
  const { stdout } = await execFileAsync(
    process.execPath,
    [
      "--max-old-space-size=4096",
      "--import",
      "tsx",
      join(HERE, "fixtures", "issue-6710-regime-probe.mts"),
      files.join(","),
      profiles,
    ],
    { cwd: join(HERE, ".."), encoding: "utf-8", maxBuffer: 16 * 1024 * 1024 },
  );
  return JSON.parse(stdout) as Row[];
}

describe("#6710 native regime (JS env) — Promise reaction handlers dispatch without a cast trap", () => {
  it("regime builds of the repros reach Test262:AsyncTestComplete", { timeout: 600_000 }, async () => {
    const rows = await probe(REPROS, "regime");
    expect(rows.map((r) => [r.file.split("/").pop(), r.error, r.complete])).toEqual(
      REPROS.map((f) => [f.split("/").pop(), null, true]),
    );
  });

  it("standalone and default builds of the repro still run clean", { timeout: 600_000 }, async () => {
    // The host-free build exports no stdout sink for this harness, so its
    // completion marker is not observable here; it must run without a trap.
    const rows = await probe([REPROS[0]!], "standalone,default");
    expect(rows.map((r) => [r.profile, r.error])).toEqual([
      ["standalone", null],
      ["default", null],
    ]);
    expect(rows.find((r) => r.profile === "default")?.complete).toBe(true);
  });
});
