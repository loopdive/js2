// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// (#7164) Records — or checks — the four origin/main fixtures that
// tests/equivalence/issue-7164-externref-vec-length-growth.test.ts compares
// head against:
//
//   issue-7164-length-update-sweep-base.json  every sweep cell where the base
//       compiler differs from node: "wrong" (a value) or "trap" (a trap or a
//       compile error). A cell not listed matched node on base.
//   issue-7164-callback-sweep-base.json  the same for the callback-array
//       escape sweep (receiver wrapper × callback method × length update).
//   issue-7164-target-sweep-base.json  the same for the assignment-target
//       sweep, with "ce" (compile error) kept apart from "trap".
//   issue-7164-leak-base.json  per leak setup/case/lane, the marker leaks head
//       still SHARES with base (same index, same kind). Recording refuses when
//       head has a leak base lacks: that is a regression to fix, not to record.
//
// Each fixture's first key, "$base", is the base commit it was recorded against.
//
// The base compiler is `git archive <rev> src tests/equivalence/helpers.ts`,
// extracted under the repo's .tmp/7164-base. That location is load-bearing:
// node_modules and the repo's package.json (ESM) resolve from there; extracted
// outside the repo, tsx loads helpers.ts as CommonJS and vitest refuses to load.
// Every sweep and leak module is compiled on its own on gc, standalone and
// wasi. The test compiles a leak setup's 37 cases into one module, so a
// module-wide registration (like #7164's own box-type bug) could differ
// between the two; the test's base-relative rule still holds per case.
//
//   node --import ./scripts/record-7164-bases-loader.mjs --import tsx \
//     scripts/record-7164-bases.mts [--base <rev>] (--write | --check)
//
// --check recomputes both fixtures and exits 1 when either's entries differ from
// the committed file, so a stale entry (one base no longer has) cannot silently
// widen what the test allows; it warns when only the recorded "$base" is older.
// It takes about half an hour on a 4-core box.
import { execSync } from "node:child_process";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const repo = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);
const mode = args.includes("--write") ? "write" : args.includes("--check") ? "check" : undefined;
const baseRev = args.includes("--base") ? args[args.indexOf("--base") + 1]! : "origin/main";
if (!mode) {
  console.error("usage: record-7164-bases.mts [--base <rev>] (--write | --check)");
  process.exit(2);
}

const baseRoot = join(repo, ".tmp", "7164-base");
rmSync(baseRoot, { recursive: true, force: true });
mkdirSync(baseRoot, { recursive: true });
execSync(`git archive ${baseRev} src tests/equivalence/helpers.ts | tar -x -C ${baseRoot}`, { cwd: repo });
const baseSha = execSync(`git rev-parse ${baseRev}`, { cwd: repo }).toString().trim();

const cases = await import(pathToFileURL(join(repo, "tests/equivalence/issue-7164-length-update-sweep-cases.ts")).href);
const { evaluateAsJs } = await import(pathToFileURL(join(repo, "tests/equivalence/helpers.ts")).href);
type Tree = { compile: Function; instantiate: Function };
async function loadTree(root: string): Promise<Tree> {
  const { compile } = await import(pathToFileURL(join(root, "src/index.ts")).href);
  const { instantiateWithRuntime } = await import(pathToFileURL(join(root, "tests/equivalence/helpers.ts")).href);
  return { compile, instantiate: instantiateWithRuntime };
}
const head = await loadTree(repo);
const base = await loadTree(baseRoot);
const LANES: [string, Record<string, string>][] = [
  ["gc", {}],
  ["standalone", { target: "standalone" }],
  ["wasi", { target: "wasi" }],
];
const read = (at: (i: number) => number): string => {
  const n = at(-1);
  let s = "";
  for (let i = 0; i < n; i++) s += String.fromCharCode(at(i));
  return s;
};
/** The exported reader's string, or "CE" / "TRAP". */
async function run(tree: Tree, src: string, options: object, fn: string): Promise<string> {
  try {
    const result = await tree.compile(src, { fileName: "probe.ts", ...options });
    if (!result.success) return "CE";
    return read((await tree.instantiate(result)).exports[fn]);
  } catch {
    return "TRAP";
  }
}
const failed = (v: string): boolean => v === "CE" || v === "TRAP";

// The length-update sweep: base only.
const sweep: Record<string, Record<string, string>> = {};
for (const row of cases.sweepRows()) {
  const src = `${cases.sweepSource(row.form, row.element, row.setup, row.eqElsewhere, row.receiver)}\nexport function at(i: number): number { const s = value(); return i < 0 ? s.length : s.charCodeAt(i); }`;
  const node = read(evaluateAsJs(src).at as (i: number) => number);
  for (const [lane, options] of LANES) {
    const value = await run(base, src, options, "at");
    if (value !== node) (sweep[row.key] ??= {})[lane] = failed(value) ? "trap" : "wrong";
  }
}

// The callback-array escape sweep: base only, same encoding.
const callbacks: Record<string, Record<string, string>> = {};
for (const row of cases.callbackRows()) {
  const src = cases.callbackSource(row.wrapper, row.method, row.form);
  let node: string;
  try {
    node = read(evaluateAsJs(src).at as (i: number) => number);
  } catch {
    node = "JSERR";
  }
  for (const [lane, options] of LANES) {
    const value = await run(base, src, options, "at");
    if (value !== node) (callbacks[row.key] ??= {})[lane] = failed(value) ? "trap" : "wrong";
  }
}

// The assignment-target sweep: base only, keeping a compile error ("ce")
// apart from a trap ("trap"), since head may fail only the way base does.
const targets: Record<string, Record<string, string>> = {};
for (const form of Object.keys(cases.TARGET_FORMS)) {
  const src = cases.targetSource(form);
  let node: string;
  try {
    node = read(evaluateAsJs(src).at as (i: number) => number);
  } catch {
    node = "JSERR";
  }
  for (const [lane, options] of LANES) {
    const value = await run(base, src, options, "at");
    if (value !== node) (targets[form] ??= {})[lane] = value === "CE" ? "ce" : value === "TRAP" ? "trap" : "wrong";
  }
}

// The leak detector: head ∩ base.
const leak: Record<string, Record<string, string[]>> = {};
const refused: string[] = [];
for (const [setupName, setup] of Object.entries(cases.LEAK_SETUPS as Record<string, string>)) {
  for (const name of Object.keys(cases.SWEEP)) {
    const src = `${cases.SWEEP_PRELUDE}${cases.LEAK_SUMMARY}\n${cases.leakFns(setup, [name])}`;
    const node = read(evaluateAsJs(src)[`at_${name}`] as (i: number) => number);
    for (const [lane, options] of LANES) {
      const h = await run(head, src, options, `at_${name}`);
      if (failed(h)) continue; // a head compile error or trap cannot leak
      const b = await run(base, src, options, `at_${name}`);
      const headLeaks: string[] = cases.leaksIn(node, h, lane);
      const baseLeaks: string[] = failed(b) ? [] : cases.leaksIn(node, b, lane);
      for (const l of headLeaks) if (!baseLeaks.includes(l)) refused.push(`${setupName}/${name}/${lane} ${l}`);
      const shared = headLeaks.filter((l) => baseLeaks.includes(l));
      if (shared.length > 0) (leak[`${setupName}/${name}`] ??= {})[lane] = shared;
    }
  }
}

const sweepPath = join(repo, "tests/equivalence/issue-7164-length-update-sweep-base.json");
const leakPath = join(repo, "tests/equivalence/issue-7164-leak-base.json");
const format = (value: object, path: string): string =>
  execSync(`npx prettier --stdin-filepath ${path}`, { cwd: repo, input: JSON.stringify(value) }).toString();
const sweepText = format({ $base: baseSha, ...sweep }, sweepPath);
const callbackPath = join(repo, "tests/equivalence/issue-7164-callback-sweep-base.json");
const callbackText = format({ $base: baseSha, ...callbacks }, callbackPath);
const targetPath = join(repo, "tests/equivalence/issue-7164-target-sweep-base.json");
const targetText = format({ $base: baseSha, ...targets }, targetPath);
const leakText = format({ $base: baseSha, ...leak }, leakPath);
console.log(
  `base ${baseSha}: ${Object.keys(sweep).length} sweep rows differ from node; ${Object.keys(leak).length} leak cases share a leak`,
);
if (refused.length > 0) {
  console.error(`REFUSED: ${refused.length} leak(s) head has and base lacks:\n  ${refused.join("\n  ")}`);
  process.exit(1);
}
if (mode === "write") {
  writeFileSync(sweepPath, sweepText);
  writeFileSync(callbackPath, callbackText);
  writeFileSync(targetPath, targetText);
  writeFileSync(leakPath, leakText);
  console.log("wrote the four fixtures");
} else {
  const entries = (text: string): string => {
    const { $base: _, ...rest } = JSON.parse(text) as Record<string, unknown>;
    return JSON.stringify(rest);
  };
  const stale: string[] = [];
  for (const [path, text] of [
    [sweepPath, sweepText],
    [callbackPath, callbackText],
    [targetPath, targetText],
    [leakPath, leakText],
  ] as const) {
    const committed = readFileSync(path, "utf8");
    if (entries(committed) !== entries(text)) stale.push(path);
    else if ((JSON.parse(committed) as { $base?: string }).$base !== baseSha)
      console.warn(
        `WARNING: ${path} records base ${(JSON.parse(committed) as { $base?: string }).$base ?? "(none)"}; entries still match ${baseSha} — re-run with --write to refresh it`,
      );
  }
  if (stale.length > 0) {
    console.error(`STALE (re-run with --write): ${stale.join(", ")}`);
    process.exit(1);
  }
  console.log("the four fixtures match");
}
