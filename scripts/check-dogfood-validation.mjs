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
// THE MODULE SURFACE (#5368). Until 2026-09-12 this gate compiled exactly one
// module per package — `<pkg>/<declared entry>`. A module a dogfood SUITE
// admits through a subpath was never compiled here, so the invariant held
// green over a package whose subpath emitted a module no engine would load.
// #5339 is the measured miss: hono's `dist/helper/dev/index.js` pulls in
// `dist/utils/color.js`, whose `getColorEnabledAsync` emitted `type error in
// return[0] (expected i32, got externref)`. Re-measured on #5676's parent
// (`34720daf53`), that module is INVALID and the other 19 hono suite modules
// are clean — the widened gate is red there and green on main.
//
// The gated surface is `suite`: the declared entry PLUS every published module
// the dogfood upstream suites admit (tests/dogfood/dogfood-surface-modules.mjs
// derives it from the committed suite pins, so no upstream clone and no
// generated tree is needed). A wider `--surface exports` walks the whole
// `exports` map; it is a SURVEY, not a gate — see KNOWN_INVALID_MODULES.
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
//   node scripts/check-dogfood-validation.mjs --surface exports   # survey, wider
//   node scripts/check-dogfood-validation.mjs --list-modules      # print the surface
//
// Exit 0 = every gated module upheld the invariant. Exit 1 = a gated module
// compiled to a binary that does not validate (or blew its compile budget).
// Exit 2 = usage. Exit 3 = infrastructure failure; nothing was measured.

import { spawn } from "node:child_process";
import { availableParallelism } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { performance } from "node:perf_hooks";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const HARNESS = join(REPO_ROOT, "tests", "dogfood", "npm-compat-catalog-harness.mjs");
const SURFACE_PROBE = join(REPO_ROOT, "tests", "dogfood", "dogfood-surface-probe.mjs");
/** Per-module deadline used to size each chunk's wall budget. */
const MODULE_TIMEOUT_MS = 120_000;

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

/**
 * Individual SUBPATH modules that compile but do not validate on main today,
 * all found by this gate's own `--surface exports` survey on 2026-09-12
 * (`cf82f78d6d`). None of them is in the gated `suite` surface, so on the
 * default surface this list waives nothing — it is what stops the wider survey
 * from reading as an undifferentiated pile of red, and it is the list a future
 * widening of the gated surface has to empty first. Fixing one deletes its row.
 *
 * One codegen bug, three modules: #6413 (a closure falling through with
 * externref where i32 is expected). #6412 (`extern.convert_any` expecting anyref
 * where an async resume produced externref) is FIXED — its three hono jwt/jwk
 * rows are gone; #6414's row was retired on main.
 */
const KNOWN_INVALID_MODULES = [
  {
    name: "hono",
    module: "dist/jsx/dom/client.js",
    issue: 6413,
    detail: 'fallthru[0] expected i32, got externref in "__closure_64"',
  },
  { name: "hono", module: "dist/jsx/dom/jsx-runtime.js", issue: 6413, detail: "same __closure_35 fallthru shape" },
  { name: "hono", module: "dist/jsx/dom/jsx-dev-runtime.js", issue: 6413, detail: "same __closure_35 fallthru shape" },
];

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

/**
 * Compile one CHUNK of one package's subpath modules in a single child.
 * One process per chunk, not per module: loading the compiler costs ~1.5 s and
 * the widened surface has ~20x the modules the entry-only gate had.
 */
function probeModuleChunk(name, modules) {
  return new Promise((resolve) => {
    const started = performance.now();
    const child = spawn(
      process.execPath,
      [
        "--max-old-space-size=2048",
        "--import",
        "tsx",
        SURFACE_PROBE,
        "--package",
        name,
        "--modules",
        modules.join(","),
      ],
      { cwd: REPO_ROOT, stdio: ["ignore", "pipe", "pipe"] },
    );
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
    // Sized off the chunk, not off one module: a chunk that hangs must still
    // be killed, but a slow-but-honest chunk must not be.
    const timer = setTimeout(() => child.kill("SIGTERM"), MODULE_TIMEOUT_MS * modules.length);
    const settle = (rows, infrastructure) => {
      clearTimeout(timer);
      resolve({ name, modules, rows, infrastructure, wallMs: Math.round(performance.now() - started) });
    };
    child.on("error", (error) => settle([], `surface probe could not start: ${error.message}`));
    child.on("exit", (code, signal) => {
      const rows = [];
      for (const line of stdout.split(/\r?\n/)) {
        if (!line.trim()) continue;
        try {
          rows.push(JSON.parse(line));
        } catch {
          // A non-JSON line is compiler chatter, not a verdict.
        }
      }
      if (rows.some((row) => row.fatal)) {
        settle([], `surface probe reported fatal: ${rows.find((row) => row.fatal).fatal}`);
        return;
      }
      // A chunk that dies mid-way (OOM, crash) leaves its remaining modules
      // unmeasured. Scoring only what survived would read as "all clear".
      if (rows.length !== modules.length) {
        const detail = stderr.trim() || `exited ${signal ?? `with code ${code}`}`;
        settle(
          rows,
          `surface probe returned ${rows.length}/${modules.length} module verdicts ` +
            `(stopped at ${modules[rows.length] ?? "?"}): ${detail.slice(0, 400)}`,
        );
        return;
      }
      settle(rows, null);
    });
  });
}

/** Split a package's modules into at most `parts` chunks, order preserved. */
function chunk(modules, parts) {
  const size = Math.max(1, Math.ceil(modules.length / Math.max(1, parts)));
  const chunks = [];
  for (let index = 0; index < modules.length; index += size) chunks.push(modules.slice(index, index + size));
  return chunks;
}

const argv = process.argv.slice(2);
const jsonOnly = argv.includes("--json");
const survey = argv.includes("--survey");
const only = readFlag(argv, "--only");
const surface = readFlag(argv, "--surface") ?? "suite";
if (!["suite", "exports"].includes(surface)) usage(`--surface expects one of suite, exports`);
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

// The subpath surface: the declared entry is already covered by the per-package
// harness above, so it is dropped here rather than compiled twice.
const { dogfoodSurfaceModules } = await import("../tests/dogfood/dogfood-surface-modules.mjs");
const moduleJobs = [];
const surfaceByPackage = new Map();
for (const name of names) {
  let enumerated;
  try {
    enumerated = dogfoodSurfaceModules(name, { surface });
  } catch (error) {
    // Enumeration is filesystem work over an extracted tarball; a package that
    // cannot even be enumerated is reported by its entry probe below.
    surfaceByPackage.set(name, { modules: [], error: error instanceof Error ? error.message : String(error) });
    continue;
  }
  const subpaths = enumerated.modules.filter((entry) => entry.origin !== "entry").map((entry) => entry.path);
  surfaceByPackage.set(name, { modules: subpaths, error: null });
  for (const part of chunk(subpaths, concurrency)) moduleJobs.push({ name, modules: part });
}

if (argv.includes("--list-modules")) {
  for (const name of names) {
    const entry = surfaceByPackage.get(name);
    if (entry.error) {
      process.stdout.write(`${name}\t(enumeration failed: ${entry.error})\n`);
      continue;
    }
    for (const modulePath of entry.modules) process.stdout.write(`${name}\t${modulePath}\n`);
  }
  process.exit(0);
}

const log = jsonOnly ? () => {} : (...values) => console.log(...values);
const started = performance.now();
log(
  `[dogfood-validation] ${names.length} package${names.length === 1 ? "" : "s"}, concurrency ${concurrency} — ` +
    `asserting compile.success ⇒ the emitted binary validates`,
);

// ONE pool over both kinds of work. The entry probes are a handful of long
// jobs and the subpath chunks are many short ones; splitting the pool in two
// leaves whichever half finishes first idle while the other is still the
// critical path. Entry probes are queued first because they are the longest.
const queue = [
  ...names.map((name) => ({ kind: "entry", name })),
  ...moduleJobs.map((job) => ({ kind: "chunk", ...job })),
];
const entryResults = new Map();
const chunkResults = [];
await Promise.all(
  Array.from({ length: Math.max(1, Math.min(concurrency, queue.length)) }, async () => {
    for (let job = queue.shift(); job !== undefined; job = queue.shift()) {
      if (job.kind === "entry") entryResults.set(job.name, await probePackage(job.name));
      else chunkResults.push(await probeModuleChunk(job.name, job.modules));
    }
  }),
);
const outcomes = names.map((name) => entryResults.get(name));
const rows = outcomes.map((outcome) => describe(outcome, classify(outcome)));
const moduleRows = chunkResults
  .flatMap((result) => result.rows)
  .sort((a, b) => a.package.localeCompare(b.package) || a.module.localeCompare(b.module));
const moduleInfrastructure = chunkResults.filter((result) => result.infrastructure);
const waived = new Set(KNOWN_INVALID_MODULES.map((entry) => `${entry.name} ${entry.module}`));
const invalidModules = moduleRows.filter(
  (row) => row.verdict === "invalid" && !waived.has(`${row.package} ${row.module}`),
);
const waivedHits = moduleRows.filter((row) => row.verdict === "invalid" && waived.has(`${row.package} ${row.module}`));
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

const moduleCounts = { valid: 0, invalid: 0, "compile-failed": 0 };
for (const row of moduleRows) moduleCounts[row.verdict] = (moduleCounts[row.verdict] ?? 0) + 1;
log(
  `  ${surface === "exports" ? "exports-map" : "suite"} subpath surface: ${moduleRows.length} module(s) — ` +
    `${moduleCounts.valid} valid, ${moduleCounts.invalid} invalid, ${moduleCounts["compile-failed"]} did not codegen ` +
    `(a module that does not codegen makes the implication vacuous; it is counted, never failed on)`,
);
for (const row of moduleRows) {
  if (row.verdict === "valid") continue;
  log(
    `  ${row.verdict === "invalid" ? (waived.has(`${row.package} ${row.module}`) ? "(waived)" : "INVALID ") : "no-build"} ` +
      `${`${row.package}/${row.module}`.padEnd(46)} ${String(row.detail).split("\n")[0].slice(0, 110)}`,
  );
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
    `${JSON.stringify(
      { gated: !survey && !only, surface, concurrency, wallMs, vacuous, packages: rows, modules: moduleRows },
      null,
      2,
    )}\n`,
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

if (infrastructure.length > 0 || moduleInfrastructure.length > 0) {
  for (const row of infrastructure) console.error(`::error::[dogfood-validation] ${row.name}: ${row.detail}`);
  for (const result of moduleInfrastructure) {
    console.error(`::error::[dogfood-validation] ${result.name} subpath chunk: ${result.infrastructure}`);
  }
  console.error(`[dogfood-validation] FAILED — the harness did not produce a verdict; nothing was measured.`);
  process.exit(3);
}

if (invalid.length > 0 || budget.length > 0 || invalidModules.length > 0) {
  for (const row of [...invalid, ...budget]) {
    console.error(
      `::error::[dogfood-validation] ${row.name}@${row.version ?? "?"} (${row.entryModule ?? "?"}) ` +
        `${row.verdict === "budget" ? "blew its compile budget" : `compiled ${row.binaryBytes.toLocaleString("en-US")} bytes that do NOT validate`}: ${row.detail}`,
    );
  }
  // Package, module path, and the engine's own words — a validation failure is
  // only actionable if you can see WHICH function the engine rejected.
  for (const row of invalidModules) {
    console.error(
      `::error::[dogfood-validation] ${row.package} module ${row.module} ` +
        `compiled ${row.binaryBytes.toLocaleString("en-US")} bytes that do NOT validate: ${row.detail}`,
    );
  }
  const total = invalid.length + invalidModules.length;
  console.error(
    `\n[dogfood-validation] FAILED — the compiler emitted ${total} module(s) that WebAssembly refuses to load.\n` +
      `A module that codegens but does not validate is always a compiler bug: fix the codegen, do not\n` +
      `adjust this gate. Reproduce locally with:\n` +
      `  node --import tsx tests/dogfood/npm-compat-catalog-harness.mjs --package <name>          # declared entry\n` +
      `  node --import tsx tests/dogfood/dogfood-surface-probe.mjs --package <name> --modules <p> # one subpath\n`,
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

if (waivedHits.length > 0) {
  for (const row of waivedHits) {
    const waiver = KNOWN_INVALID_MODULES.find((entry) => entry.name === row.package && entry.module === row.module);
    log(`  (waived) ${row.package}/${row.module} — known-invalid, tracked by #${waiver.issue}`);
  }
}

log(
  `[dogfood-validation] ok — ${compiled.length}/${rows.length} gated packages compiled, ${compiled.length}/${compiled.length} validated; ` +
    `${moduleCounts.valid + moduleCounts.invalid}/${moduleRows.length} subpath modules compiled, ${moduleCounts.valid} validated.`,
);
