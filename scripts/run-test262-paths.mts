/**
 * Run an explicit list of test262 paths through the runner's own
 * `runTest262File` and print the per-row verdict.
 *
 *   npx tsx scripts/run-test262-paths.mts .tmp/es2016-paths.txt --standalone
 *
 * Scoped measurement lane for one slice — an ES edition, a directory, a
 * suspected regression set. Requires the test262 submodule
 * (`git submodule update --init --depth 1 test262`).
 *
 * CAVEAT — realm contamination, and the `--isolate` answer. Every row runs
 * IN-PROCESS in one realm by default, so a test that mutates a shared intrinsic
 * leaks into every row after it. The `class/dstr/*-array-prototype.js` family
 * replaces `Array.prototype[Symbol.iterator]`, which breaks `for…of` inside the
 * RUNNER itself — the run then dies with "meta.features is not iterable" after
 * doing all the work, and every row after the first poisoner is meaningless.
 * Pass `--isolate` to run each row in a fresh child process; it is the only
 * correct way to measure such a family, at ~2-4s per row, so use it for
 * bucket-sized slices rather than the whole suite. The sharded
 * `pnpm run test:262` forks per shard and does not have this problem.
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
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { runTest262File } from "../tests/test262-runner.js";

// Child mode for --isolate: measure exactly one row and print a parseable line.
const oneRow = process.env.JS2WASM_ROW_ONE;
const target =
  process.argv.includes("--standalone") || process.env.JS2WASM_ROW_TARGET === "standalone" ? "standalone" : undefined;
if (oneRow) {
  let st = "error";
  let rs = "";
  try {
    const r = await runTest262File(
      resolve("test262/test", oneRow),
      oneRow.split("/").slice(0, 2).join("/"),
      undefined,
      target,
    );
    st = r.status;
    rs = (r as { reason?: string; error?: string }).reason ?? (r as { error?: string }).error ?? "";
  } catch (e) {
    rs = String((e as Error)?.message ?? e).split("\n")[0] ?? "";
  }
  console.log(`ROW ${st} ${rs.split("\n")[0]?.slice(0, 200) ?? ""}`);
  process.exit(0);
}

// `--isolate` runs each row in a FRESH child process. Slower (one node start per
// row, ~2-4s), and the only way to measure a realm-poisoning family correctly —
// see the caveat above. Use it for bucket-sized slices, not the whole suite.
const isolate = process.argv.includes("--isolate");
const listFile = process.argv.find((a, i) => i >= 2 && !a.startsWith("--"));
if (!listFile) {
  console.error("usage: run-test262-paths.mts <file-of-test262-relative-paths>");
  process.exit(2);
}
const paths = readFileSync(listFile, "utf-8")
  .split("\n")
  .map((l) => l.trim())
  .filter(Boolean);

const counts: Record<string, number> = {};
const __nonPass: string[] = [];

// Index loops, not for-of, and no array spread anywhere below. These tests run
// IN-PROCESS in one realm, and whole families deliberately poison it — the
// `class/dstr/*-array-prototype.js` group replaces
// `Array.prototype[Symbol.iterator]`. After one of those, a `for…of` over an
// ordinary array in THIS file throws "not iterable" and the run dies at the end,
// after doing all the work. See the caveat in the header.
for (let pi = 0; pi < paths.length; pi++) {
  const rel = paths[pi]!;
  const abs = resolve("test262/test", rel);
  const category = rel.split("/").slice(0, 2).join("/");
  let status = "error";
  let reason = "";
  if (isolate) {
    try {
      const out = execFileSync(process.execPath, ["--import", "tsx", process.argv[1]!, "-"], {
        input: rel,
        encoding: "utf-8",
        timeout: 120_000,
        env: { ...process.env, JS2WASM_ROW_ONE: rel, ...(target ? { JS2WASM_ROW_TARGET: target } : {}) },
      });
      const m = /^ROW (\S+) (.*)$/m.exec(out);
      status = m?.[1] ?? "error";
      reason = m?.[2] ?? out.slice(-160);
    } catch (e) {
      reason = String((e as Error)?.message ?? e).split("\n")[0] ?? "";
    }
    counts[status] = (counts[status] ?? 0) + 1;
    if (status !== "pass" && status !== "skip")
      __nonPass.push(`${status.padEnd(14)} ${rel}\n                 ${reason.slice(0, 160)}`);
    continue;
  }
  try {
    const r = await runTest262File(abs, category, undefined, target);
    status = r.status;
    reason = (r as { reason?: string; error?: string }).reason ?? (r as { error?: string }).error ?? "";
  } catch (e) {
    reason = String((e as Error)?.message ?? e).split("\n")[0] ?? "";
  }
  counts[status] = (counts[status] ?? 0) + 1;
  if (status !== "pass" && status !== "skip") {
    __nonPass.push(`${status.padEnd(14)} ${rel}\n                 ${reason.split("\n")[0]?.slice(0, 160) ?? ""}`);
  }
}

console.log("\n=== counts ===");
console.log(counts);
console.log(`\n=== ${__nonPass.length} non-pass (excluding skip) ===`);
for (let i = 0; i < __nonPass.length; i++) console.log(__nonPass[i]);
