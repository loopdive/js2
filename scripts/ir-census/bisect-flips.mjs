// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * Pin each file whose IR-only state flipped between two mains to the
 * first-parent commit that flipped it.
 *
 *   node scripts/ir-census/bisect-flips.mjs --from <old-sha> --to <new-sha> \
 *        --files <list> [--jobs N] [--work .tmp/ir-census/bisect]
 *
 * Each probed commit is exported with `git archive` (src, tests, scripts,
 * package.json, tsconfig.json) next to links to this checkout's
 * `node_modules` and `test262`, and measured with census.mts `--tree`. The
 * search is a binary search over `git rev-list --first-parent` per file, with
 * every file still unresolved measured together at each probe. A file's state
 * at `--from` is taken as the opposite of its state at `--to`; prints
 * `file<TAB>state-at-to<TAB>first commit with that state<TAB>subject`.
 */
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { readRows } from "./analyze.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, "../..");

function arg(flag, fallback) {
  const index = process.argv.indexOf(flag);
  return index >= 0 ? process.argv[index + 1] : fallback;
}

const git = (...args) => execFileSync("git", args, { cwd: REPO_ROOT, encoding: "utf8" }).trim();

function exportTree(sha, work) {
  const tree = join(work, "trees", sha);
  if (existsSync(join(tree, "src"))) return tree;
  mkdirSync(tree, { recursive: true });
  execFileSync("sh", ["-c", `git archive ${sha} src tests scripts package.json tsconfig.json | tar -x -C ${tree}`], {
    cwd: REPO_ROOT,
  });
  for (const link of ["node_modules", "test262"]) symlinkSync(join(REPO_ROOT, link), join(tree, link));
  return tree;
}

/** IR-only state of each file at `sha`. */
function measure(sha, files, work, jobs) {
  const list = join(work, `probe-${sha}.txt`);
  const out = join(work, `probe-${sha}.jsonl`);
  writeFileSync(list, `${files.join("\n")}\n`);
  execFileSync(
    process.execPath,
    [
      "--import",
      "tsx",
      join(HERE, "census.mts"),
      "--files",
      list,
      "--out",
      out,
      "--jobs",
      String(jobs),
      "--tree",
      exportTree(sha, work),
    ],
    {
      cwd: REPO_ROOT,
      stdio: ["ignore", "ignore", "inherit"],
      env: { ...process.env, JS2WASM_IR_SHAPE_DIAG: "1", JS2WASM_IR_MODULE_INIT_ALL_REJECTS: "1" },
    },
  );
  const state = new Map(readRows(out).map((row) => [row.file, row.status === "compiled" && row.irOnly]));
  return (file) => state.get(file) === true;
}

const from = arg("--from");
const to = arg("--to");
const work = resolve(arg("--work", ".tmp/ir-census/bisect"));
const jobs = Number(arg("--jobs", 4));
const files = readFileSync(arg("--files"), "utf8").split("\n").filter(Boolean);
mkdirSync(work, { recursive: true });

// commits[0] = from, commits[n] = to, first-parent order.
const commits = [from, ...git("rev-list", "--first-parent", "--reverse", `${from}..${to}`).split("\n")];
const target = measure(to, files, work, jobs);
const search = new Map(files.map((file) => [file, { lo: 0, hi: commits.length - 1, want: target(file) }]));
while ([...search.values()].some((s) => s.hi - s.lo > 1)) {
  const byMid = new Map();
  for (const [file, s] of search) {
    if (s.hi - s.lo <= 1) continue;
    const mid = (s.lo + s.hi) >> 1;
    byMid.set(mid, [...(byMid.get(mid) ?? []), file]);
  }
  for (const [mid, group] of byMid) {
    const state = measure(commits[mid], group, work, jobs);
    for (const file of group) {
      const s = search.get(file);
      if (state(file) === s.want) s.hi = mid;
      else s.lo = mid;
    }
  }
}
for (const [file, s] of search) {
  const sha = commits[s.hi];
  console.log(
    [file, s.want ? "ir-only" : "blocked", sha.slice(0, 10), git("log", "-1", "--format=%s", sha)].join("\t"),
  );
}
