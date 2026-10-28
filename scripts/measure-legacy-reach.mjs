#!/usr/bin/env node
// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * #7143 slice B0 — which syntax kinds still reach a legacy (direct AST→Wasm) body?
 *
 * Compiles every corpus source (scripts/legacy-reach-corpus.mjs) with
 * `experimentalIR: true, trackIrOutcomes: true` for each target (`standalone`,
 * and `gc`, whose default is native-first), then joins every IR outcome row to
 * its unit's AST — the declaration at the row's line:column, or for
 * `<module-init>` the top-level statements that are not function or class
 * declarations — and counts the SyntaxKinds that unit lexically contains.
 *
 * Per target and per kind X:
 *   units    — outcome rows whose unit contains X
 *   demoted  — those with `legacyBodyEmitted` (the legacy twin of X ran)
 *   reasons  — demoted units by IrFallbackReason / unsupported code
 * `demoted(X) = 0` on the full corpus is the §3.1 precondition for retiring the
 * twin of X. The totals count every outcome row (the §1.3 "73 units").
 *
 * Usage (needs the tsx loader: `node --import tsx …`, or `pnpm run measure:legacy-reach --`):
 *   --kind <SyntaxKind>     report one kind, listing its demoted units
 *   --corpus <a,b,…>        families (playground,cutover,equivalence,test262) or paths
 *   --target <t,…>          standalone,gc (default both)
 *   --workers <n>           compile processes (default min(3, cores-1))
 *   --json                  print the aggregate as JSON
 *   --update                write scripts/legacy-reach-baseline.json (full corpus only)
 *   --check                 fail when any kind's `demoted` grew vs. the baseline
 */
import { fork } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { availableParallelism } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { compile } from "../src/index.ts";
import { ts } from "../src/ts-api.js";
import { CORPUS_FAMILIES, REPO_ROOT, loadCorpus } from "./legacy-reach-corpus.mjs";

export const BASELINE_PATH = join(REPO_ROOT, "scripts/legacy-reach-baseline.json");
export const TARGETS = ["standalone", "gc"];
const SCHEMA = "js2-legacy-reach-v1";
const SCRIPT_PATH = fileURLToPath(import.meta.url);
const ENTRY_TIMEOUT_MS = 120_000;
const RECYCLE_AFTER = 150; // jobs per worker before a fresh process (bounds compiler-cache growth)

/** SyntaxKind value → canonical name (skips the `First*`/`Last*` range markers). */
export const KIND_NAMES = new Map();
for (const [name, value] of Object.entries(ts.SyntaxKind)) {
  if (typeof value === "number" && !/^(First|Last)/.test(name) && !KIND_NAMES.has(value)) KIND_NAMES.set(value, name);
}

const lineOf = (sf, node) => sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1;

/** `line:column` (1-based, as on outcome rows) → outermost function- or class-like node starting there. */
function unitDeclarations(sf) {
  const byPos = new Map();
  const visit = (node) => {
    if (ts.isFunctionLike(node) || ts.isClassLike(node)) {
      const { line, character } = sf.getLineAndCharacterOfPosition(node.getStart(sf));
      const key = `${line + 1}:${character + 1}`;
      if (!byPos.has(key)) byPos.set(key, node);
    }
    ts.forEachChild(node, visit);
  };
  ts.forEachChild(sf, visit);
  return byPos;
}

/** AST roots of an outcome's unit; `null` = harness unit (excluded), `undefined` = unmatched. */
function unitRoots(sf, declarations, outcome, bodyLine) {
  if (outcome.unitKind === "module-init") {
    return sf.statements.filter(
      (s) => !ts.isFunctionDeclaration(s) && !ts.isClassDeclaration(s) && lineOf(sf, s) > bodyLine,
    );
  }
  if (outcome.line <= bodyLine) return null;
  const node = declarations.get(`${outcome.line}:${outcome.column}`);
  return node && [node];
}

function countKinds(roots) {
  const counts = {};
  const visit = (node) => {
    const name = KIND_NAMES.get(node.kind);
    counts[name] = (counts[name] ?? 0) + 1;
    ts.forEachChild(node, visit);
  };
  roots.forEach(visit);
  return counts;
}

/** Compiler-injected units (e.g. the standalone `setTimeout` shim) have no source AST. */
const isCompilerUnit = (o) => decodeURIComponent(o.unitId ?? "").includes(":compiler-unit:");

/** Demote reason: the unsupported code, `invariant:<code>`, or `ir-patched-over-legacy` (both bodies emitted). */
const reasonOf = (o) =>
  o.kind === "unsupported" ? o.code : o.kind === "invariant" ? `invariant:${o.code}` : "ir-patched-over-legacy";

/** Compile one corpus entry per target; one row per IR outcome, plus compile failures. */
export async function measureEntry(entry, targets = TARGETS) {
  const sf = ts.createSourceFile(entry.fileName, entry.source, ts.ScriptTarget.Latest, true);
  const declarations = unitDeclarations(sf);
  const bodyLine = entry.bodyLine ?? 0;
  const rows = [];
  const failures = [];
  for (const target of targets) {
    let result;
    try {
      result = await compile(entry.source, {
        ...entry.options,
        fileName: entry.fileName,
        target,
        experimentalIR: true,
        trackIrOutcomes: true,
        emitWat: false,
        validate: false,
      });
    } catch (error) {
      failures.push({ target, id: entry.id, error: String(error?.message ?? error).slice(0, 200) });
      continue;
    }
    if (!result.success || !result.irOutcomes) {
      failures.push({ target, id: entry.id, error: (result.errors?.[0]?.message ?? "no irOutcomes").slice(0, 200) });
    }
    for (const o of result.irOutcomes ?? []) {
      const roots = o.file === entry.fileName ? unitRoots(sf, declarations, o, bodyLine) : undefined;
      if (roots === null) continue;
      rows.push({
        target,
        id: entry.id,
        unit: `${o.unitKind}:${o.displayName}@${o.line}`,
        demoted: o.legacyBodyEmitted,
        ...(o.legacyBodyEmitted ? { reason: reasonOf(o) } : {}),
        ...(roots ? { kinds: countKinds(roots) } : isCompilerUnit(o) ? { synthetic: true } : {}),
      });
    }
  }
  return { rows, failures };
}

const bump = (map, key) => (map[key] = (map[key] ?? 0) + 1);
const sortKeys = (obj) => Object.fromEntries(Object.entries(obj).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));

/** Aggregate rows into the baseline shape: per target totals + per kind `{units, demoted, reasons}`. */
export function aggregate(rows, failures, targets = TARGETS) {
  const out = {};
  for (const target of targets) {
    const t = { units: 0, demoted: 0, synthetic: 0, unmatched: 0, compileFailures: 0, reasons: {}, kinds: {} };
    for (const row of rows.filter((r) => r.target === target)) {
      t.units++;
      if (row.demoted) (t.demoted++, bump(t.reasons, row.reason));
      if (row.synthetic) t.synthetic++;
      else if (!row.kinds) t.unmatched++;
      for (const kind of Object.keys(row.kinds ?? {})) {
        const k = (t.kinds[kind] ??= { units: 0, demoted: 0, reasons: {} });
        k.units++;
        if (row.demoted) (k.demoted++, bump(k.reasons, row.reason));
      }
    }
    t.compileFailures = failures.filter((f) => f.target === target).length;
    t.reasons = sortKeys(t.reasons);
    t.kinds = sortKeys(
      Object.fromEntries(Object.entries(t.kinds).map(([k, v]) => [k, { ...v, reasons: sortKeys(v.reasons) }])),
    );
    out[target] = t;
  }
  return out;
}

/** Run `measureEntry` over the corpus in `workers` child processes (in-process when ≤ 1). */
async function measureAll(entries, targets, workers) {
  const rows = [];
  const failures = [];
  let done = 0;
  const take = (r) => {
    rows.push(...r.rows);
    failures.push(...r.failures);
    if (++done % 250 === 0) process.stderr.write(`measured ${done}/${entries.length}\n`);
  };
  if (workers <= 1) {
    for (const entry of entries) take(await measureEntry(entry, targets));
    return { rows, failures };
  }
  let next = 0;
  const spawn = () =>
    new Promise((done) => {
      const child = fork(SCRIPT_PATH, ["--worker"], {
        execArgv: [...process.execArgv, "--max-old-space-size=3072"],
        stdio: ["ignore", "ignore", "inherit", "ipc"],
      });
      let current;
      let timer;
      let jobs = 0;
      const dispatch = () => {
        clearTimeout(timer);
        if (next >= entries.length || jobs++ >= RECYCLE_AFTER) return void child.kill(); // `exit` respawns or finishes
        current = entries[next++];
        timer = setTimeout(() => child.kill("SIGKILL"), ENTRY_TIMEOUT_MS);
        child.send({ entry: current, targets });
      };
      child.on("message", (msg) => (msg.ready ? dispatch() : (take(msg), (current = undefined), dispatch())));
      child.on("exit", () => {
        clearTimeout(timer);
        if (current)
          failures.push(...targets.map((target) => ({ target, id: current.id, error: "worker died or timed out" })));
        if (current || next < entries.length) spawn().then(done);
        else done();
      });
    });
  const pool = Array.from({ length: Math.min(workers, entries.length) }, () => spawn());
  await Promise.all(pool);
  return { rows, failures };
}

function parseArgs(argv) {
  const opts = {
    corpus: CORPUS_FAMILIES,
    targets: TARGETS,
    workers: Math.max(1, Math.min(3, availableParallelism() - 1)),
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const value = () => argv[++i] ?? "";
    if (arg === "--kind") opts.kind = value();
    else if (arg === "--corpus") opts.corpus = value().split(",").filter(Boolean);
    else if (arg === "--target") opts.targets = value().split(",").filter(Boolean);
    else if (arg === "--workers") opts.workers = Number(value());
    else if (arg === "--json" || arg === "--update" || arg === "--check") opts[arg.slice(2)] = true;
    else throw new Error(`unknown argument ${arg}`);
  }
  if (opts.kind && ![...KIND_NAMES.values()].includes(opts.kind)) throw new Error(`unknown SyntaxKind ${opts.kind}`);
  if (opts.targets.some((t) => !TARGETS.includes(t))) throw new Error(`--target must be from ${TARGETS.join(",")}`);
  return opts;
}

const fullRun = (opts) => opts.targets.join() === TARGETS.join() && opts.corpus.join() === CORPUS_FAMILIES.join();

function corpusSummary(entries, items) {
  const families = Object.fromEntries(items.filter((i) => CORPUS_FAMILIES.includes(i)).map((f) => [f, 0]));
  for (const e of entries) bump(families, e.family);
  const digest = createHash("sha256")
    .update(entries.map((e) => e.sha256).join("\n"))
    .digest("hex");
  return { entries: entries.length, families, digest: `sha256:${digest}` };
}

/** Kinds (and totals) whose `demoted` count grew vs. the baseline — the ratchet. */
export function ratchetGrowth(baseline, current) {
  const grown = [];
  for (const [target, now] of Object.entries(current)) {
    const before = baseline.targets?.[target];
    if (!before) continue;
    if (now.demoted > before.demoted) grown.push(`${target}: total demoted ${before.demoted} → ${now.demoted}`);
    for (const [kind, k] of Object.entries(now.kinds)) {
      const was = before.kinds[kind]?.demoted ?? 0;
      if (k.demoted > was) grown.push(`${target}: ${kind} demoted ${was} → ${k.demoted}`);
    }
  }
  return grown;
}

function report(opts, summary, result, rows, failures, seconds) {
  const fam = Object.entries(summary.families)
    .map(([f, n]) => `${f} ${n}`)
    .join(", ");
  console.log(`legacy reach — ${summary.entries} sources (${fam}), ${seconds.toFixed(1)}s`);
  for (const [target, t] of Object.entries(result)) {
    const reasons = Object.entries(t.reasons)
      .map(([r, n]) => `${r} ${n}`)
      .join(", ");
    console.log(
      `${target}: ${t.units} units, ${t.demoted} demoted (${reasons || "none"}); ` +
        `${t.compileFailures} compile failures, ${t.synthetic} compiler-injected, ${t.unmatched} unmatched units`,
    );
    for (const f of failures.filter((f) => f.target === target).slice(0, 5))
      console.log(`  compile failure: ${f.id} — ${f.error}`);
    if (opts.kind) {
      const k = t.kinds[opts.kind] ?? { units: 0, demoted: 0, reasons: {} };
      console.log(`  ${opts.kind}: ${k.units} units, ${k.demoted} demoted ${JSON.stringify(k.reasons)}`);
      for (const r of rows.filter((r) => r.target === target && r.demoted && r.kinds?.[opts.kind])) {
        console.log(`    ${r.id} ${r.unit} — ${r.reason} (×${r.kinds[opts.kind]})`);
      }
    } else {
      const top = Object.entries(t.kinds)
        .filter(([, k]) => k.demoted > 0)
        .sort((a, b) => b[1].demoted - a[1].demoted);
      console.log(
        `  kinds with demotes: ${top.length}; top: ${top
          .slice(0, 12)
          .map(([n, k]) => `${n} ${k.demoted}/${k.units}`)
          .join(", ")}`,
      );
    }
  }
}

async function main(argv) {
  const opts = parseArgs(argv);
  if ((opts.update || opts.check) && !fullRun(opts))
    throw new Error("--update/--check need the full default corpus and both targets");
  const started = performance.now();
  const entries = await loadCorpus(opts.corpus);
  const { rows, failures } = await measureAll(entries, opts.targets, opts.workers);
  const summary = corpusSummary(entries, opts.corpus);
  const result = aggregate(rows, failures, opts.targets);
  const seconds = (performance.now() - started) / 1000;
  if (opts.json) console.log(JSON.stringify({ corpus: summary, targets: result }, null, 2));
  else report(opts, summary, result, rows, failures, seconds);
  if (opts.update) {
    const baseline = {
      schema: SCHEMA,
      command: "pnpm run measure:legacy-reach -- --update",
      corpus: summary,
      targets: result,
    };
    writeFileSync(BASELINE_PATH, `${JSON.stringify(baseline, null, 2)}\n`);
    console.log(`wrote ${BASELINE_PATH}`);
  }
  if (opts.check) {
    const baseline = JSON.parse(readFileSync(BASELINE_PATH, "utf8"));
    if (baseline.corpus?.digest !== summary.digest) console.log("note: corpus differs from the baseline's");
    const grown = ratchetGrowth(baseline, result);
    for (const line of grown) console.log(`GREW ${line}`);
    console.log(grown.length ? "legacy reach: FAIL" : "legacy reach: OK");
    return grown.length ? 1 : 0;
  }
  return 0;
}

if (process.argv.includes("--worker")) {
  process.on("message", async ({ entry, targets }) => process.send(await measureEntry(entry, targets)));
  process.send({ ready: true });
} else if (process.argv[1] && resolve(process.argv[1]) === SCRIPT_PATH) {
  main(process.argv.slice(2)).then(
    (code) => (process.exitCode = code),
    (error) => {
      console.error(`measure-legacy-reach: ${error.message}`);
      process.exitCode = 2;
    },
  );
}
