#!/usr/bin/env node
// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #5336 — pre-merge floor on `compile.validated` for the dogfood packages.
//
// WHY. PR #5390 (`82be803ac7`, src/codegen/statements/nested-declarations.ts)
// made the compiler emit, for moment, a module that CODEGENS FINE and then
// fails `WebAssembly.compile`:
//
//     Compiling function #721:"__closure_47" failed:
//       call[25] expected type (ref null 84), found struct.get of type i32
//
// moment went 10/10 → 0/10 upstream tests and `compile.validated` 6/6 → 0/6,
// and it survived FIVE merges with all six required checks green. Nothing in
// CI asserted anything about validation: `tests/dogfood/*-upstream-suite.test.ts`
// runs its heavy arm only behind an opt-in env var, and no `scripts/check-*`
// looked at the field. It was found days later, by hand.
//
// THE INVARIANT (no baseline, no golden number). For a fixed input,
//
//     compile.success  ⇒  the emitted binary validates
//
// is not a target, it is a THEOREM about the compiler: a module that codegens
// but that no engine will load is *always* a compiler bug, never legitimate
// drift. That framing is what makes this safe to gate on. Contrast pass counts
// (they move daily for legitimate reasons) and contrast `compile.success`
// itself, which is NOT stable enough to assert — measured over the 80
// `benchmarks/results/npm-compat.json` revisions on main between 2026-08-29
// and 2026-09-05, ONE refresh revision (`b8fecd5d19`) flipped hono,
// styled-components, moment, lodash-es and prettier to `success: false`
// simultaneously and back. Asserting compile success would have failed five
// packages on measurement noise; the implication above is VACUOUSLY TRUE
// during exactly that outage, so it cannot.
//
// Over those same 80 revisions the implication was violated on main for
// `moment` in 10 of them (two distinct windows, ~3.5 days total) and for `lit`
// in all 80. Zero false positives among the gated packages.
//
// WHAT IT DOES NOT COVER. A package that stops compiling ALTOGETHER — the
// #5332 class (`multi-prepared-module-init-census:terminal-join` took prettier
// 61/151 → 2/151 via a hard codegen error) — makes this implication vacuous,
// so this gate does not catch it and deliberately does not try. Catching that
// needs a per-package compile-status baseline, and the flip data above says
// such a baseline would be noisy. The per-package compile status IS printed on
// every run so the regression is at least visible in the log.
//
// MACHINERY. All reused: `runNpmCompatCatalogHarness` (tests/dogfood/
// npm-compat-catalog-harness.mjs) compiles the pinned tarball's declared entry
// module via `tests/helpers/compile-project-probe.ts` in a child process with
// a hard timeout and reports `{compile:{success,…}, validation:{validates,
// firstError}}`. It never RUNS the package and needs no upstream test clone —
// that is what makes this cheap enough to be a required check. Because the
// gate calls the same harness npm-compat calls, its verdict cannot diverge
// from the dashboard's.
//
// USAGE
//   node scripts/check-dogfood-validation.mjs             # gate (CI)
//   node scripts/check-dogfood-validation.mjs --survey    # re-derive the set
//   node scripts/check-dogfood-validation.mjs --list      # print the set, run nothing
//   node scripts/check-dogfood-validation.mjs --json
//   node scripts/check-dogfood-validation.mjs --only moment,lit
//   node scripts/check-dogfood-validation.mjs --concurrency 1
//
// Exit 0 = every gated package upheld the invariant. Exit 1 = a gated package
// compiled to a binary that does not validate (or blew its compile budget).
// Exit 2 = usage. Exit 3 = infrastructure failure; nothing was measured.

import { spawn } from "node:child_process";
import { availableParallelism } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { performance } from "node:perf_hooks";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const HARNESS = join(REPO_ROOT, "tests", "dogfood", "npm-compat-catalog-harness.mjs");

/**
 * The gated set: pinned npm-compat catalog packages that BOTH compile and
 * validate on main today. Membership is not a hand-audited list — re-derive it
 * with `--survey`, which runs every catalog package and prints which ones
 * qualify.
 *
 * `moment` is the load-bearing member: it is the ONLY package in the catalog
 * whose entry module reproduces #5333. Measured on the reverted tree
 * (2026-09-05), redux/react/jest/hono/styled-components all still validated,
 * so they contribute breadth against future regressions rather than coverage
 * of this one. They are here because they are cheap.
 */
const GATED = [
  { name: "redux", why: "small ESM project; ~4s" },
  { name: "react", why: "CJS project with the classic UMD prologue; ~3s" },
  { name: "jest", why: "ESM re-export surface; ~2s" },
  { name: "hono", why: "ESM project with heavy generic inference; ~7s" },
  { name: "styled-components", why: "ESM bundle, large closure graph; ~11s" },
  {
    name: "moment",
    why: "CJS project with deep nested-declaration capture graphs — the only catalog package that reproduces #5333",
  },
];

/**
 * Compiles but does NOT validate on main today, and has for as long as the
 * committed npm-compat history goes back. Excluded rather than waived so the
 * gate stays a clean invariant; fixing one means moving it into `GATED`.
 */
const KNOWN_INVALID = [{ name: "lit", issue: 3977, detail: 'local.set[0] in "y_createRenderRoot"' }];

function usage(message) {
  process.stderr.write(
    `${message}\nusage: check-dogfood-validation.mjs [--survey] [--list] [--json] [--only <pkg[,pkg]>] [--concurrency <n>]\n`,
  );
  process.exit(2);
}

function readFlag(argv, name) {
  const index = argv.indexOf(name);
  if (index < 0) return null;
  const value = argv[index + 1];
  if (value === undefined || value.startsWith("--")) usage(`${name} expects a value`);
  return value;
}

/** Run one package's entry-compile + validate probe in its own process. */
function probePackage(name) {
  return new Promise((resolve) => {
    const started = performance.now();
    const child = spawn(process.execPath, ["--import", "tsx", HARNESS, "--package", name, "--json"], {
      cwd: REPO_ROOT,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    const settle = (extra) => resolve({ name, wallMs: Math.round(performance.now() - started), ...extra });
    child.on("error", (error) => settle({ infrastructure: `harness could not start: ${error.message}` }));
    child.on("exit", (code, signal) => {
      const line = stdout.trim().split(/\r?\n/).at(-1) ?? "";
      let report;
      try {
        report = JSON.parse(line);
      } catch {
        const detail = stderr.trim() || stdout.trim() || `exited ${signal ?? `with code ${code}`}`;
        settle({ infrastructure: `harness produced no report: ${detail.slice(0, 600)}` });
        return;
      }
      if (report.fatal) {
        settle({ infrastructure: `harness reported fatal: ${report.fatal}` });
        return;
      }
      settle({ report });
    });
  });
}

async function probeAll(names, concurrency) {
  const queue = [...names];
  const results = new Map();
  const workers = Array.from({ length: Math.max(1, Math.min(concurrency, queue.length)) }, async () => {
    for (let next = queue.shift(); next !== undefined; next = queue.shift()) {
      results.set(next, await probePackage(next));
    }
  });
  await Promise.all(workers);
  return names.map((name) => results.get(name));
}

/** Classify one probe outcome. Only `invalid` and `budget` fail the gate. */
function classify(outcome) {
  if (outcome.infrastructure) return { verdict: "infrastructure", detail: outcome.infrastructure };
  const compile = outcome.report.compile ?? {};
  const validation = outcome.report.validation ?? {};
  if (compile.timedOut === true) {
    return { verdict: "budget", detail: `compile exceeded the ${compile.timeoutMs}ms harness budget` };
  }
  if (compile.success !== true) {
    return { verdict: "compile-failed", detail: compile.errors?.[0]?.message ?? validation.firstError ?? "no binary" };
  }
  if (validation.validates !== true) {
    return { verdict: "invalid", detail: validation.firstError ?? "emitted binary failed WebAssembly validation" };
  }
  return { verdict: "valid", detail: null };
}

function describe(outcome, classified) {
  const report = outcome.report;
  const pkg = report ? (report[outcome.name] ?? {}) : {};
  return {
    name: outcome.name,
    version: pkg.version ?? null,
    entryModule: pkg.entryModule ?? null,
    verdict: classified.verdict,
    detail: classified.detail,
    compileMs: report?.compile?.durationMs ?? null,
    binaryBytes: report?.compile?.binaryBytes ?? 0,
    wallMs: outcome.wallMs,
  };
}

const argv = process.argv.slice(2);
const jsonOnly = argv.includes("--json");
const survey = argv.includes("--survey");
const only = readFlag(argv, "--only");
const concurrencyFlag = readFlag(argv, "--concurrency") ?? process.env.DOGFOOD_VALIDATION_CONCURRENCY;
const concurrency = concurrencyFlag ? Number(concurrencyFlag) : Math.max(1, Math.min(4, availableParallelism() - 1));
if (!Number.isInteger(concurrency) || concurrency < 1) usage(`--concurrency expects a positive integer`);

let names;
if (only) {
  names = only
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);
} else if (survey) {
  const { NPM_COMPAT_CATALOG_NAMES } = await import("../tests/dogfood/npm-compat-catalog.mjs");
  names = [...NPM_COMPAT_CATALOG_NAMES];
} else {
  names = GATED.map((entry) => entry.name);
}

// `--list` resolves the package set and exits. `--survey` on the full catalog
// costs tens of minutes (react-dom and typescript alone dominate), so being
// able to see WHAT it would run without running it is worth one branch.
if (argv.includes("--list")) {
  process.stdout.write(`${names.join("\n")}\n`);
  process.exit(0);
}

const log = jsonOnly ? () => {} : (...values) => console.log(...values);
const started = performance.now();
log(
  `[dogfood-validation] ${names.length} package${names.length === 1 ? "" : "s"}, concurrency ${concurrency} — ` +
    `asserting compile.success ⇒ the emitted binary validates`,
);

const outcomes = await probeAll(names, concurrency);
const rows = outcomes.map((outcome) => describe(outcome, classify(outcome)));
const wallMs = Math.round(performance.now() - started);

const MARK = {
  valid: "ok      ",
  invalid: "INVALID ",
  budget: "BUDGET  ",
  "compile-failed": "no-build",
  infrastructure: "INFRA   ",
};
for (const row of rows) {
  log(
    `  ${MARK[row.verdict]} ${row.name.padEnd(20)} ${String(Math.round((row.compileMs ?? row.wallMs) / 100) / 10).padStart(6)}s` +
      `${row.verdict === "valid" ? `  ${row.binaryBytes.toLocaleString("en-US")} bytes` : `  ${String(row.detail).split("\n")[0].slice(0, 120)}`}`,
  );
}
if (!survey && !only) {
  for (const entry of KNOWN_INVALID) {
    log(`  (skipped) ${entry.name.padEnd(18)} known-invalid on main, tracked by #${entry.issue}: ${entry.detail}`);
  }
}

const invalid = rows.filter((row) => row.verdict === "invalid");
const budget = rows.filter((row) => row.verdict === "budget");
const infrastructure = rows.filter((row) => row.verdict === "infrastructure");
const compiled = rows.filter((row) => row.verdict === "valid" || row.verdict === "invalid");
// A vacuity floor, in the spirit of check-harness-compile-budget.ts: if NOTHING
// compiled, the implication held for the same reason "all unicorns are pink"
// does, and the gate has gone blind rather than green.
const vacuous = !survey && !only && compiled.length === 0;

if (jsonOnly) {
  process.stdout.write(
    `${JSON.stringify({ gated: !survey && !only, concurrency, wallMs, vacuous, packages: rows }, null, 2)}\n`,
  );
}

log(`[dogfood-validation] ${wallMs}ms wall`);

if (survey) {
  const qualifying = rows.filter((row) => row.verdict === "valid").map((row) => row.name);
  log(`\n[dogfood-validation] survey only — nothing gated.`);
  log(`  compile+validate today (eligible for GATED): ${qualifying.join(", ") || "(none)"}`);
  log(
    `  compiles but INVALID: ${
      rows
        .filter((r) => r.verdict === "invalid")
        .map((r) => r.name)
        .join(", ") || "(none)"
    }`,
  );
  process.exit(0);
}

if (infrastructure.length > 0) {
  for (const row of infrastructure) console.error(`::error::[dogfood-validation] ${row.name}: ${row.detail}`);
  console.error(`[dogfood-validation] FAILED — the harness did not produce a verdict; nothing was measured.`);
  process.exit(3);
}

if (invalid.length > 0 || budget.length > 0) {
  for (const row of [...invalid, ...budget]) {
    console.error(
      `::error::[dogfood-validation] ${row.name}@${row.version ?? "?"} (${row.entryModule ?? "?"}) ` +
        `${row.verdict === "budget" ? "blew its compile budget" : `compiled ${row.binaryBytes.toLocaleString("en-US")} bytes that do NOT validate`}: ${row.detail}`,
    );
  }
  console.error(
    `\n[dogfood-validation] FAILED — the compiler emitted ${invalid.length} module(s) that WebAssembly refuses to load.\n` +
      `A module that codegens but does not validate is always a compiler bug: fix the codegen, do not\n` +
      `adjust this gate. Reproduce one package locally with:\n` +
      `  node --import tsx tests/dogfood/npm-compat-catalog-harness.mjs --package <name>\n`,
  );
  process.exit(1);
}

if (vacuous) {
  console.error(
    `::error::[dogfood-validation] no gated package produced a binary — the validation invariant was VACUOUS.\n` +
      `This means the compiler or the harness is broken, not that validation is fine.`,
  );
  process.exit(1);
}

log(
  `[dogfood-validation] ok — ${compiled.length}/${rows.length} gated packages compiled, ${compiled.length}/${compiled.length} validated.`,
);
