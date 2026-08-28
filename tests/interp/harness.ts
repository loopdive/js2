// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #3101 / E1 — the Node test harness for the bytecode interpreter. It parses
// with **node-acorn** (the pinned dogfood tarball — the SAME parser E2 compiles,
// so there is zero version skew) and differentials the interpreter against the
// host's own `eval`. No Wasm is involved anywhere here — this is the "developed
// and unit-tested in Node against node-acorn" bar (doc §16 E1).

import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { runInNewContext } from "node:vm";
import { setupAcorn } from "../dogfood/setup-acorn.mjs";
import { runScript, type JSValue } from "../../src/interp/index.js";

// ── acorn acquisition (pinned tarball) ────────────────────────────────────────
let acornMod: { parse: (src: string, opts: object) => JSValue } | null = null;

export async function loadAcorn(): Promise<void> {
  if (acornMod) return;
  const s = setupAcorn();
  acornMod = (await import(s.entryModulePath)) as typeof acornMod;
}

/** Parse a source string to an ESTree Program (script goal symbol). Callers
 * exercising source metadata may forward the exact parser options supplied by
 * the runtime-eval entry point. */
export function parse(src: string, options?: object): JSValue {
  if (!acornMod) throw new Error("harness: call loadAcorn() first (beforeAll)");
  return acornMod.parse(src, options ?? { ecmaVersion: 2023, sourceType: "script" });
}

// ── differential result model ─────────────────────────────────────────────────
export interface Outcome {
  ok: boolean;
  value?: JSValue;
  errName?: string;
}

/** Run a body through the host's `eval` in a FRESH global (node:vm), so each
 *  body is isolated exactly like the interpreter's per-run global — no cross-body
 *  `var`/global leakage, matching indirect-eval global-scope semantics. */
export function runEval(body: string): Outcome {
  try {
    return { ok: true, value: runInNewContext(body, {}, { filename: "eval-body.js" }) };
  } catch (e) {
    return { ok: false, errName: e instanceof Error ? e.constructor.name : typeof e };
  }
}

/** Run a body through the interpreter. */
export function runInterp(body: string): Outcome {
  try {
    return { ok: true, value: runScript(parse(body)) };
  } catch (e) {
    return { ok: false, errName: e instanceof Error ? e.constructor.name : typeof e };
  }
}

/** Verdict of one differential comparison. */
export type Verdict = "match" | "mismatch" | "both-throw" | "interp-only-throw" | "eval-only-throw";

export interface DiffResult {
  verdict: Verdict;
  detail: string;
}

/** Compare the interpreter and `eval` on one body. */
export function differential(body: string): DiffResult {
  const e = runEval(body);
  const i = runInterp(body);
  if (!e.ok && !i.ok) {
    return { verdict: "both-throw", detail: `eval:${e.errName} interp:${i.errName}` };
  }
  if (e.ok && !i.ok) return { verdict: "interp-only-throw", detail: `interp threw ${i.errName}` };
  if (!e.ok && i.ok) return { verdict: "eval-only-throw", detail: `eval threw ${e.errName}` };
  return sameValue(e.value, i.value)
    ? { verdict: "match", detail: repr(e.value) }
    : { verdict: "mismatch", detail: `eval=${repr(e.value)} interp=${repr(i.value)}` };
}

// ── value comparison ──────────────────────────────────────────────────────────
export function sameValue(a: JSValue, b: JSValue): boolean {
  if (a === b) return true;
  const ta = typeof a;
  const tb = typeof b;
  if (ta !== tb) return false;
  if (ta === "number") return Number.isNaN(a) && Number.isNaN(b);
  if (ta === "function") return true; // interp closures vs host fns — can't compare
  if (ta !== "object" || a === null || b === null) return false;
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
    for (let k = 0; k < a.length; k += 1) if (!sameValue(a[k], b[k])) return false;
    return true;
  }
  // Plain objects: compare own enumerable keys structurally.
  const ka = Object.keys(a).sort();
  const kb = Object.keys(b).sort();
  if (ka.length !== kb.length) return false;
  for (let k = 0; k < ka.length; k += 1) {
    if (ka[k] !== kb[k]) return false;
    if (!sameValue(a[ka[k]], b[ka[k]])) return false;
  }
  return true;
}

function repr(v: JSValue): string {
  const t = typeof v;
  if (t === "string") return JSON.stringify(v);
  if (t === "function") return "<fn>";
  if (v === null) return "null";
  if (v === undefined) return "undefined";
  if (t === "object") {
    try {
      return JSON.stringify(v);
    } catch {
      return "<object>";
    }
  }
  return String(v);
}

// ── test262 eval-body sampling (real bodies, extracted with acorn) ────────────
// Walk a bounded set of test262 files and, using acorn, pull every
// `eval("<string-literal>")` / `eval('<literal>')` argument out as a real,
// correctly-unescaped constant eval body. Robust (AST-based, not regex).
export function sampleTest262EvalBodies(roots: string[], limit: number): string[] {
  const bodies: string[] = [];
  const seen = new Set<string>();
  for (const root of roots) {
    walkFiles(root, (file) => {
      if (bodies.length >= limit) return;
      let src: string;
      try {
        src = readFileSync(file, "utf-8");
      } catch {
        return;
      }
      if (!src.includes("eval(")) return;
      let ast: JSValue;
      try {
        ast = parse(src);
      } catch {
        return; // module-syntax / unsupported-by-acorn file — skip
      }
      collectEvalStringArgs(ast, (s) => {
        if (bodies.length >= limit) return;
        if (seen.has(s)) return;
        seen.add(s);
        bodies.push(s);
      });
    });
  }
  return bodies;
}

function walkFiles(dir: string, visit: (file: string) => void): void {
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return;
  }
  for (const name of entries) {
    const full = join(dir, name);
    let st: ReturnType<typeof statSync>;
    try {
      st = statSync(full);
    } catch {
      continue;
    }
    if (st.isDirectory()) walkFiles(full, visit);
    else if (name.endsWith(".js") && !name.endsWith("_FIXTURE.js")) visit(full);
  }
}

/** Recursively find `eval("<literal>")` calls and yield the literal string arg. */
function collectEvalStringArgs(node: JSValue, yieldStr: (s: string) => void): void {
  if (node === null || typeof node !== "object") return;
  if (Array.isArray(node)) {
    for (const child of node) collectEvalStringArgs(child, yieldStr);
    return;
  }
  if (
    node.type === "CallExpression" &&
    node.callee &&
    node.callee.type === "Identifier" &&
    node.callee.name === "eval" &&
    node.arguments.length === 1 &&
    node.arguments[0].type === "Literal" &&
    typeof node.arguments[0].value === "string"
  ) {
    yieldStr(node.arguments[0].value);
  }
  for (const key of Object.keys(node)) {
    if (key === "type") continue;
    collectEvalStringArgs(node[key], yieldStr);
  }
}
