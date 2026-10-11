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
// themselves are separate slices (first: the ir -> codegen edges, #6808).
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
// THE RATCHETED NUMBERS:
//   largestSccSize  files in the largest SCC (Tarjan).
//   sccCountOver1   SCCs with more than one file.
//   twoWayDirEdges  for every pair of "directories" that import each other,
//                   the edge count in EACH direction, keyed "codegen->ir".
//                   A directory is the first path segment under src/, so a
//                   root-level file is its own group ("compiler.ts"): leaf
//                   modules such as ts-api.ts never pair with anything.
//                   A pair that stops being two-way drops out.
//
// GATE SEMANTICS — change-scoped, like check:loc-budget / check:func-budget.
//   The tree is measured twice: at the change-set's own base (resolved by
//   scripts/lib/change-scope.mjs — HEAD^1 of CI's synthetic merge, else the
//   merge-base with main; only the changed files are re-read from that base)
//   and at HEAD. A number that grows, or a NEW two-way pair, FAILS unless the
//   change-set grants it. The committed baseline is NOT read on this path, so
//   PRs never edit scripts/import-cycles-baseline.json.
//
// INTENDED GROWTH is granted in the YAML frontmatter of an issue file the
// change-set itself adds or modifies (only those are read, so a grant that
// landed on main grants nothing to later PRs). One entry per number: the key
// (`largestSccSize`, `sccCountOver1`, or a two-way pair such as
// `codegen->ir`), the highest value the change-set may reach, and a dated
// rationale after `#` (required — an entry without one grants nothing):
//
//   import-cycles-allow:
//     - largestSccSize: 699 # 2026-10-02 (#NNNN): two new codegen helpers join the SCC
//     - codegen->ir: 297 # 2026-10-02 (#NNNN): new leaf imports from-ast for ...
//
// THE COMMITTED BASELINE (scripts/import-cycles-baseline.json) is a low-water
// mark. The post-merge jobs bank decreases into it with
// `--update-on-decrease` (it never raises a number), and it is the reference
// only when no base can be resolved (a source tarball, a --src tree outside
// any repository). `--update` is a deliberate human re-seed.
//
// Usage:
//   node scripts/check-import-cycles.mjs                      # gate
//   node scripts/check-import-cycles.mjs --update-on-decrease # bank drops (post-merge)
//   node scripts/check-import-cycles.mjs --update             # (re)seed baseline
//   node scripts/check-import-cycles.mjs --verbose            # largest SCC +
//                                                             # every cross-dir edge
//   node scripts/check-import-cycles.mjs --json               # machine-readable
//   node scripts/check-import-cycles.mjs --src <dir> --baseline <file>
//                                                             # alternate tree (tests)

import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, realpathSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { references } from "./check-compiler-boundaries.mjs";
import { baseBlob, changedPaths, changeSetAllowances, resolveChangeBase } from "./lib/change-scope.mjs";

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

/** Module references of one file, reduced to what resolution needs. */
function scanRefs(srcDir, rel, text) {
  const sf = ts.createSourceFile(join(srcDir, rel), text, ts.ScriptTarget.Latest, true);
  return references(sf, {}).map(({ specifier, typeOnly }) => ({ specifier, typeOnly }));
}

/**
 * Value-import graph over `refsByFile` (Map<file relative to srcDir, refs>):
 * Map<file, sorted importees>. `typeOnlySkipped` counts the type-only
 * references that resolved to a node and were left out.
 */
function resolveGraph(srcDir, refsByFile) {
  const toRel = (abs) => relative(srcDir, abs).split(sep).join("/");
  const resolveSpecifier = (fromRel, specifier) => {
    if (!specifier || !specifier.startsWith(".")) return undefined;
    const base = resolve(dirname(join(srcDir, fromRel)), specifier);
    const candidates = [];
    if (base.endsWith(".js")) candidates.push(`${base.slice(0, -3)}.ts`);
    if (base.endsWith(".ts")) candidates.push(base);
    candidates.push(`${base}.ts`, join(base, "index.ts"));
    return candidates.map(toRel).find((rel) => refsByFile.has(rel));
  };
  const adj = new Map();
  let typeOnlySkipped = 0;
  for (const from of [...refsByFile.keys()].sort()) {
    const out = new Set();
    for (const ref of refsByFile.get(from)) {
      const target = resolveSpecifier(from, ref.specifier);
      if (target === undefined) continue;
      if (ref.typeOnly) typeOnlySkipped++;
      else if (target !== from) out.add(target);
    }
    adj.set(from, [...out].sort());
  }
  return { adj, typeOnlySkipped };
}

/** Value-import graph of the working tree under `srcDir` (plus its per-file refs). */
export function buildGraph(srcDir) {
  if (!existsSync(srcDir)) throw new Error(`source directory not found: ${srcDir}`);
  const refs = new Map();
  for (const abs of walk(srcDir)) {
    const rel = relative(srcDir, abs).split(sep).join("/");
    refs.set(rel, scanRefs(srcDir, rel, readFileSync(abs, "utf8")));
  }
  return { ...resolveGraph(srcDir, refs), refs };
}

/** Top level of the work tree containing `dir`, or undefined outside one. */
function workTreeRoot(dir) {
  try {
    // Without GIT_*: inside a hook GIT_DIR would answer for the hook's repo, not `dir`'s.
    const top = execFileSync("git", ["-C", dir, "rev-parse", "--show-toplevel"], {
      encoding: "utf8",
      env: Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("GIT_"))),
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    return top ? realpathSync(top) : undefined;
  } catch {
    return undefined;
  }
}

/**
 * The same graph at the change-set's `base`: HEAD's per-file refs with every
 * changed `.ts` under srcDir replaced by its base blob (or dropped when the
 * change-set added it). Undefined when the diff against `base` fails.
 */
function baseGraph(srcDir, repoRoot, base, headRefs) {
  const prefix = relative(repoRoot, srcDir).split(sep).join("/");
  const changed = changedPaths(repoRoot, base, prefix);
  if (changed === undefined) return undefined;
  const refs = new Map(headRefs);
  for (const path of changed) {
    if (!path.endsWith(".ts") || path.endsWith(".d.ts")) continue;
    const rel = path.slice(prefix.length + 1);
    const text = baseBlob(repoRoot, base, path);
    if (text === undefined) refs.delete(rel);
    else refs.set(rel, scanRefs(srcDir, rel, text));
  }
  return resolveGraph(srcDir, refs);
}

const ALLOWANCE = /^(largestSccSize|sccCountOver1|[^\s:>]+->[^\s:]+)\s*:\s*(\d+)\s*#\s*(\S.*)$/;

/**
 * The change-set's `import-cycles-allow:` grants: Map<flattened key,
 * {value, sources}>, plus the malformed entries, which grant nothing.
 */
function cycleAllowances(repoRoot, base) {
  const grants = new Map();
  const invalid = [];
  for (const [item, sources] of changeSetAllowances(repoRoot, base, "import-cycles-allow")) {
    const m = ALLOWANCE.exec(item.trim());
    if (!m) {
      invalid.push(`${item} (${sources.join(", ")})`);
      continue;
    }
    const key = m[1].includes("->") ? `twoWayDirEdges[${m[1]}]` : m[1];
    const prior = grants.get(key);
    grants.set(key, {
      value: Math.max(Number(m[2]), prior?.value ?? 0),
      sources: [...(prior?.sources ?? []), ...sources],
    });
  }
  return { grants, invalid };
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

/** Numbers of `current` above / below `reference`, as {key, from, to}. */
function compare(reference, current) {
  const ref = flatten(reference);
  const cur = flatten(current);
  const growth = [];
  const drops = [];
  for (const key of [...new Set([...Object.keys(ref), ...Object.keys(cur)])].sort()) {
    const from = ref[key] ?? 0;
    const to = cur[key] ?? 0;
    if (to > from) growth.push({ key, from, to });
    else if (to < from) drops.push({ key, from, to });
  }
  return { growth, drops };
}

const describe = ({ key, from, to }) => `${key}: ${from} → ${to}${from === 0 ? " (NEW two-way directory pair)" : ""}`;

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
  // Under --json stdout carries only the payload; human lines go to stderr.
  const say = (msg) => (json ? console.error(msg) : console.log(msg));
  const srcDir = realpathSync(resolve(REPO_ROOT, flagValue("--src") ?? "src"));
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
  const baseline = existsSync(baselinePath) ? JSON.parse(readFileSync(baselinePath, "utf8")) : undefined;

  // Post-merge banking: lower the low-water mark, never raise it, never fail.
  if (argv.includes("--update-on-decrease")) {
    if (!baseline) {
      console.error(`import-cycles ratchet: no baseline at ${baselinePath} — seed it with --update.`);
      return 2;
    }
    const { growth, drops } = compare(baseline, current);
    if (drops.length > 0) writeBaseline(banked(baseline, current));
    say(`import-cycles ratchet: banked ${drops.length} decrease(s) — ${summary}`);
    for (const d of drops) say(`  ${describe(d)}`);
    for (const g of growth) say(`  above the low-water mark (admitted by its PR, not banked): ${describe(g)}`);
    return 0;
  }

  // Gate: against the change-set's own base when one resolves.
  const repoRoot = workTreeRoot(srcDir);
  const { base, how } = repoRoot ? resolveChangeBase(repoRoot) : { base: undefined, how: "no-git" };
  const atBase = base ? baseGraph(srcDir, repoRoot, base, graph.refs) : undefined;
  let reference;
  let against;
  let grants = new Map();
  if (atBase) {
    reference = measure(atBase.adj).current;
    against = `base: ${how}`;
    const allowances = cycleAllowances(repoRoot, base);
    grants = allowances.grants;
    for (const bad of allowances.invalid)
      console.error(
        `import-cycles ratchet: WARNING — ignoring malformed import-cycles-allow entry: ${bad}\n` +
          "  expected `- <largestSccSize|sccCountOver1|dirA->dirB>: <value> # <date> (#issue): <why>`",
      );
  } else if (baseline) {
    reference = baseline;
    against = `committed baseline (${how})`;
  } else {
    console.error(
      `import-cycles ratchet: no base (${how}) and no baseline at ${baselinePath} — seed it with --update.`,
    );
    return 2;
  }

  const { growth, drops } = compare(reference, current);
  const granted = [];
  const failed = [];
  for (const g of growth) {
    const grant = grants.get(g.key);
    if (grant && g.to <= grant.value)
      granted.push(`${describe(g)} — allowed up to ${grant.value} by ${grant.sources.join(", ")}`);
    else failed.push(describe(g) + (grant ? ` — exceeds the allowed ${grant.value}` : ""));
  }
  if (failed.length > 0) {
    console.error(`import-cycles ratchet: FAIL — the value-import cycles in src/ grew (${against}).`);
    for (const f of failed) console.error(`  - ${f}`);
    console.error(
      "\nFind the new edge with `node scripts/check-import-cycles.mjs --verbose`. Cut it with `import type`,\n" +
        "by moving the shared code below both files (src/shared/, src/backend/wasmgc/), or by injecting\n" +
        "the dependency. If the growth is intended (a new file that must join the SCC, a split), grant it\n" +
        "in the frontmatter of this change-set's own plan/issues/*.md file:\n" +
        "  import-cycles-allow:\n" +
        "    - largestSccSize: <new value> # <date> (#issue): <why>\n" +
        "Do not edit scripts/import-cycles-baseline.json; main's post-merge job is its sole writer.",
    );
    return 1;
  }
  for (const g of granted) say(`import-cycles ratchet: granted ${g}`);
  say(
    `import-cycles ratchet: OK — ${summary} (${against})` +
      (drops.length > 0 ? ` [${drops.length} number(s) dropped — the post-merge job banks them]` : ""),
  );
  return 0;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = main(process.argv.slice(2));
}
