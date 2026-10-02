#!/usr/bin/env node
// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #6797 — the IMPORT-CYCLE RATCHET over src/.
//
// WHY THIS GATE EXISTS. The documented retirement path (IR replaces the legacy
// AST->Wasm hacks, docs/architecture/codegen-axes.md) assumes the layers can
// be peeled apart one at a time. They cannot while codegen, ir and frontend
// sit in ONE strongly-connected component of the value-import graph: every
// file in an SCC transitively imports every other, so nothing inside it can
// be deleted, moved or tested in isolation. #912 removed cycles once and
// nothing stopped them from returning. This gate stops the growth; the cuts
// themselves are separate slices (first: the ir -> codegen edges).
//
// WHAT IS MEASURED. Nodes are the `.ts` files under `src/` (no `.d.ts`). An
// edge A -> B exists when A has a VALUE reference to B — a static import or
// re-export, a bare side-effect import, a dynamic `import()` (it still loads
// B at run time) or a `require`. Type-only references are skipped:
// `import type`, an import whose every specifier is an inline `type`,
// `export type ... from`, `import("x").T` type queries and `/// <reference>`.
// They are erased at compile time, so they cannot make a load-order cycle.
// The value/type split is `references()` from check-compiler-boundaries.mjs,
// so both gates agree on what an edge is. Only relative specifiers that
// resolve to a file in the node set count (`./x.js` -> `x.ts`, `./dir` ->
// `dir/index.ts`); packages and JSON are outside the graph. Several imports
// of the same file from one file are ONE edge.
//
// THE RATCHETED NUMBERS (scripts/import-cycles-baseline.json):
//   largestSccSize  files in the largest SCC (Tarjan).
//   sccCountOver1   SCCs with more than one file.
//   twoWayDirEdges  for every pair of "directories" that import each other,
//                   the edge count in EACH direction, keyed "codegen->ir".
//                   A directory is the first path segment under src/, so a
//                   root-level file is its own group ("compiler.ts"): leaf
//                   modules such as ts-api.ts never pair with anything.
//                   A pair that stops being two-way drops out.
//
// GATE SEMANTICS (same model as check:ir-fallbacks / check:ir-layering):
//   - any number above the committed baseline, or a NEW two-way pair -> FAIL
//   - decreases -> PASS, with a hint; `--update-on-decrease` banks them
//     (the post-merge baseline jobs call it, so PRs do not have to)
//   - growth that is genuinely intended (a file split inside the SCC adds a
//     file; splitting the SCC in two adds an SCC) -> run `--update` in the PR
//     and commit the baseline, so the increase is visible in review.
//
// Usage:
//   node scripts/check-import-cycles.mjs                      # gate
//   node scripts/check-import-cycles.mjs --update-on-decrease # gate + bank drops
//   node scripts/check-import-cycles.mjs --update             # (re)seed baseline
//   node scripts/check-import-cycles.mjs --verbose            # largest SCC +
//                                                             # every cross-dir edge
//   node scripts/check-import-cycles.mjs --json               # machine-readable
//   node scripts/check-import-cycles.mjs --src <dir> --baseline <file>
//                                                             # alternate tree (tests)

import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { references } from "./check-compiler-boundaries.mjs";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/** Every `.ts` file under `dir`, recursively, excluding declaration files. */
function walk(dir) {
  const out = [];
  for (const entry of readdirSync(dir).sort()) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...walk(full));
    else if (full.endsWith(".ts") && !full.endsWith(".d.ts")) out.push(full);
  }
  return out;
}

/** First path segment under src/ — a directory, or a root-level file itself. */
const segment = (rel) => rel.split("/")[0];

/**
 * Value-import graph of `srcDir`: Map<file, sorted importees>, files relative
 * to `srcDir` with forward slashes. `typeOnlySkipped` counts the type-only
 * references that resolved to a node and were left out.
 */
export function buildGraph(srcDir) {
  if (!existsSync(srcDir)) throw new Error(`source directory not found: ${srcDir}`);
  const toRel = (abs) => relative(srcDir, abs).split(sep).join("/");
  const absFiles = walk(srcDir);
  const nodes = new Set(absFiles.map(toRel));
  const resolveSpecifier = (fromAbs, specifier) => {
    if (!specifier || !specifier.startsWith(".")) return undefined;
    const base = resolve(dirname(fromAbs), specifier);
    const candidates = [];
    if (base.endsWith(".js")) candidates.push(`${base.slice(0, -3)}.ts`);
    if (base.endsWith(".ts")) candidates.push(base);
    candidates.push(`${base}.ts`, join(base, "index.ts"));
    return candidates.map(toRel).find((rel) => nodes.has(rel));
  };
  const adj = new Map();
  let typeOnlySkipped = 0;
  for (const abs of absFiles) {
    const from = toRel(abs);
    const sf = ts.createSourceFile(abs, readFileSync(abs, "utf8"), ts.ScriptTarget.Latest, true);
    const out = new Set();
    for (const ref of references(sf, {})) {
      const target = resolveSpecifier(abs, ref.specifier);
      if (target === undefined) continue;
      if (ref.typeOnly) typeOnlySkipped++;
      else if (target !== from) out.add(target);
    }
    adj.set(from, [...out].sort());
  }
  return { adj, typeOnlySkipped };
}

/** Tarjan's SCC algorithm, iterative (the big cycle is ~700 files deep). */
function stronglyConnectedComponents(adj) {
  let next = 0;
  const index = new Map();
  const low = new Map();
  const onStack = new Set();
  const stack = [];
  const sccs = [];
  const enter = (v) => {
    index.set(v, next);
    low.set(v, next);
    next++;
    stack.push(v);
    onStack.add(v);
  };
  for (const root of adj.keys()) {
    if (index.has(root)) continue;
    enter(root);
    const work = [{ v: root, i: 0 }];
    while (work.length > 0) {
      const frame = work[work.length - 1];
      const succ = adj.get(frame.v);
      if (frame.i < succ.length) {
        const w = succ[frame.i++];
        if (!index.has(w)) {
          enter(w);
          work.push({ v: w, i: 0 });
        } else if (onStack.has(w)) {
          low.set(frame.v, Math.min(low.get(frame.v), index.get(w)));
        }
        continue;
      }
      work.pop();
      if (work.length > 0) {
        const parent = work[work.length - 1].v;
        low.set(parent, Math.min(low.get(parent), low.get(frame.v)));
      }
      if (low.get(frame.v) === index.get(frame.v)) {
        const component = [];
        let w;
        do {
          w = stack.pop();
          onStack.delete(w);
          component.push(w);
        } while (w !== frame.v);
        sccs.push(component.sort());
      }
    }
  }
  return sccs;
}

/** The ratcheted numbers (`current`) plus the evidence behind them (`detail`). */
export function measure(adj) {
  const sccs = stronglyConnectedComponents(adj).sort((a, b) => b.length - a.length || a[0].localeCompare(b[0]));
  const largest = sccs[0] ?? [];
  /** @type {Record<string, string[]>} "dirA->dirB" -> ["a.ts -> b.ts", ...] */
  const crossDirEdges = {};
  for (const [from, targets] of adj) {
    for (const to of targets) {
      if (segment(from) === segment(to)) continue;
      (crossDirEdges[`${segment(from)}->${segment(to)}`] ??= []).push(`${from} -> ${to}`);
    }
  }
  const twoWayDirEdges = {};
  for (const key of Object.keys(crossDirEdges).sort()) {
    const [a, b] = key.split("->");
    if (crossDirEdges[`${b}->${a}`]) twoWayDirEdges[key] = crossDirEdges[key].length;
  }
  return {
    current: {
      largestSccSize: largest.length,
      sccCountOver1: sccs.filter((c) => c.length > 1).length,
      twoWayDirEdges,
    },
    detail: {
      files: adj.size,
      valueEdges: [...adj.values()].reduce((n, t) => n + t.length, 0),
      largestScc: largest,
      crossDirEdges,
    },
  };
}

/** Flatten to {metric: number}, with two-way pairs as `twoWayDirEdges[a->b]`. */
function flatten(m) {
  const out = { largestSccSize: m.largestSccSize ?? 0, sccCountOver1: m.sccCountOver1 ?? 0 };
  for (const [k, v] of Object.entries(m.twoWayDirEdges ?? {})) out[`twoWayDirEdges[${k}]`] = v;
  return out;
}

/** Growth and drops of `current` against `baseline`, one line per number. */
function compare(baseline, current) {
  const base = flatten(baseline);
  const cur = flatten(current);
  const growth = [];
  const drops = [];
  for (const key of [...new Set([...Object.keys(base), ...Object.keys(cur)])].sort()) {
    const b = base[key] ?? 0;
    const c = cur[key] ?? 0;
    if (c > b) growth.push(`${key}: ${b} → ${c}${b === 0 ? " (NEW two-way directory pair)" : ""}`);
    else if (c < b) drops.push(`${key}: ${b} → ${c}`);
  }
  return { growth, drops };
}

/** Per-number minimum of baseline and current; two-way pairs at 0 drop out. */
function banked(baseline, current) {
  const twoWay = {};
  for (const [k, v] of Object.entries(baseline.twoWayDirEdges ?? {})) {
    const lowest = Math.min(v, current.twoWayDirEdges[k] ?? 0);
    if (lowest > 0) twoWay[k] = lowest;
  }
  return {
    largestSccSize: Math.min(baseline.largestSccSize, current.largestSccSize),
    sccCountOver1: Math.min(baseline.sccCountOver1, current.sccCountOver1),
    twoWayDirEdges: twoWay,
  };
}

function main(argv) {
  const flagValue = (name) => {
    const i = argv.indexOf(name);
    return i !== -1 && i + 1 < argv.length ? argv[i + 1] : undefined;
  };
  const json = argv.includes("--json");
  const updateOnDecrease = argv.includes("--update-on-decrease");
  // Under --json stdout carries only the payload; human lines go to stderr.
  const say = (msg) => (json ? console.error(msg) : console.log(msg));
  const srcDir = resolve(REPO_ROOT, flagValue("--src") ?? "src");
  const baselinePath = resolve(REPO_ROOT, flagValue("--baseline") ?? "scripts/import-cycles-baseline.json");
  const writeBaseline = (b) => writeFileSync(baselinePath, `${JSON.stringify(b, null, 2)}\n`);

  const graph = buildGraph(srcDir);
  const { current, detail } = measure(graph.adj);

  if (json) console.log(JSON.stringify({ current, detail, typeOnlySkipped: graph.typeOnlySkipped }, null, 2));
  if (argv.includes("--verbose")) {
    say(`largest SCC (${detail.largestScc.length} files):`);
    for (const f of detail.largestScc) say(`  ${f}`);
    say("cross-directory value-import edges:");
    for (const key of Object.keys(detail.crossDirEdges).sort()) {
      const edges = detail.crossDirEdges[key];
      say(`  [${key}] ${edges.length}${key in current.twoWayDirEdges ? " (two-way)" : ""}`);
      for (const e of edges) say(`    ${e}`);
    }
  }
  const summary =
    `largest SCC ${current.largestSccSize} files, ${current.sccCountOver1} SCCs > 1 file, ` +
    `${Object.keys(current.twoWayDirEdges).length / 2} two-way directory pairs ` +
    `(${detail.files} files, ${detail.valueEdges} value edges, ${graph.typeOnlySkipped} type-only refs skipped)`;

  if (argv.includes("--update")) {
    writeBaseline(current);
    say(`import-cycles ratchet: baseline written — ${summary}`);
    return 0;
  }
  if (!existsSync(baselinePath)) {
    console.error(`import-cycles ratchet: no baseline at ${baselinePath} — seed it with --update.`);
    return 2;
  }

  const baseline = JSON.parse(readFileSync(baselinePath, "utf8"));
  const { growth, drops } = compare(baseline, current);
  if (updateOnDecrease && drops.length > 0) {
    writeBaseline(banked(baseline, current));
    say(`import-cycles ratchet: banked ${drops.length} decrease(s):`);
    for (const d of drops) say(`  ${d}`);
  }
  if (growth.length > 0) {
    console.error("import-cycles ratchet: FAIL — the value-import cycles in src/ grew.");
    for (const g of growth) console.error(`  - ${g}`);
    console.error(
      "\nFind the new edge with `node scripts/check-import-cycles.mjs --verbose`. Cut it with `import type`,\n" +
        "by moving the shared code below both files (src/shared/, src/backend/wasmgc/), or by injecting\n" +
        "the dependency. If the growth is intended (a file split inside the SCC adds a file; splitting the\n" +
        "SCC adds an SCC), run `node scripts/check-import-cycles.mjs --update` and commit the baseline.",
    );
    return 1;
  }
  say(
    `import-cycles ratchet: OK — ${summary}` +
      (drops.length > 0 && !updateOnDecrease ? " [improved — --update-on-decrease banks it]" : ""),
  );
  return 0;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = main(process.argv.slice(2));
}
