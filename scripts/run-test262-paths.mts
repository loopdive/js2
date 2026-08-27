/**
 * Run an explicit list of test262 paths through the runner's own
 * `runTest262File` and print the per-row verdict.
 *
 *   npx tsx scripts/run-test262-paths.mts .tmp/es2016-paths.txt
 *
 * Scoped measurement lane for one slice — an ES edition, a directory, a
 * suspected regression set. Requires the test262 submodule
 * (`git submodule update --init --depth 1 test262`).
 *
 * Why not `pnpm run test:262` with TEST262_PATH_FILTER_FILE: filtering to ~150
 * tests leaves most of its 16 shards empty, and an empty shard aborts as "No
 * test suite found" before any report is written.
 *
 * Why not a hand-written repro: the runner wraps each file with `wrapTest` and
 * judges it by its own rules, so a row can compile fine and still be a
 * compile_error (any error-SEVERITY diagnostic counts). Judging a slice by
 * anything else is how #4764 got two wrong diagnoses and shipped a regression
 * that only a before/after run of the whole slice caught.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { runTest262File } from "../tests/test262-runner.js";

const listFile = process.argv[2];
if (!listFile) {
  console.error("usage: run-test262-paths.mts <file-of-test262-relative-paths>");
  process.exit(2);
}
const paths = readFileSync(listFile, "utf-8")
  .split("\n")
  .map((l) => l.trim())
  .filter(Boolean);

const counts: Record<string, number> = {};
const failures: string[] = [];

for (const rel of paths) {
  const abs = resolve("test262/test", rel);
  const category = rel.split("/").slice(0, 2).join("/");
  let status = "error";
  let reason = "";
  try {
    const r = await runTest262File(abs, category);
    status = r.status;
    reason = (r as { reason?: string; error?: string }).reason ?? (r as { error?: string }).error ?? "";
  } catch (e) {
    reason = String((e as Error)?.message ?? e).split("\n")[0] ?? "";
  }
  counts[status] = (counts[status] ?? 0) + 1;
  if (status !== "pass" && status !== "skip") {
    failures.push(`${status.padEnd(14)} ${rel}\n                 ${reason.split("\n")[0]?.slice(0, 160) ?? ""}`);
  }
}

console.log("\n=== counts ===");
console.log(counts);
console.log(`\n=== ${failures.length} non-pass (excluding skip) ===`);
for (const f of failures) console.log(f);
