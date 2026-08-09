// E0 — in-Wasm AST consumer probe (#3308, umbrella #2927 / doc §15-§16).
//
// PURPOSE — arbitration, not conformance. The #1710/#1712 dogfood corpus reads
// compiled-acorn's AST *across the host boundary* via `wrapExports`, so its
// divergence report conflates two failure classes:
//   - true parser/substrate bugs (block the #2928 bytecode interpreter), and
//   - host-marshalling-only losses (irrelevant to the interpreter, which
//     consumes the AST IN-WASM via dynamic `$Object` field reads, never through
//     `wrapExports`).
//
// This probe compiles a small TS walker ALONGSIDE acorn in the SAME js2wasm
// module (`acorn-probe.mts`, `skipSemanticDiagnostics`), so the walker reads AST
// node fields in-Wasm exactly the way the #2928 emitter will. Every probe
// returns a SCALAR (a count / char code), so the MEASUREMENT itself marshals no
// AST across the boundary — only a number comes back.
//
// KEY SUBSTRATE FINDINGS (measured 2026-07-17 while building this — full
// write-up in plan/issues/3308-*.md):
//   1. STATIC named field reads are faithful in-Wasm, INCLUDING element
//      sub-fields of array children (`params[i].type`, `expressions[i].type`,
//      `quasis[0].value.cooked`). So #2841/#2851/#2852 are host-marshalling-only
//      and drop off the interpreter's critical path.
//   2. The walker MUST use TYPE-SWITCHED named reads (the emitter's own pattern),
//      not generic computed access `node[k]` (which does not descend the dynamic
//      $Object faithfully).
//   3. (#3343, RESOLVED) A full recursive walk over a LARGE multi-construct
//      parse (~60+ nodes, e.g. corpus/loops.js) USED TO hit a scale-dependent
//      "runaway". Root cause was NOT a $Object read: reads are faithful. It was
//      a codegen control-flow bug — a `for (let i)` loop counter was compiled to
//      a shared module global (`$__mod_i`, because acorn has a top-level `i`)
//      instead of a per-invocation local, so a recursive walk clobbered the
//      outer loop's counter. Fixed in src/codegen/statements/loops.ts. This
//      probe now expects 13/13 `match` and stays as the regression guard (a
//      re-broken counter would show `runaway` again). Every probe is
//      budget-guarded so the harness NEVER hangs; a runaway is reported, not hung.
//
// Invoke:  npx tsx tests/dogfood/acorn-probe.mjs           (human summary)
//          npx tsx tests/dogfood/acorn-probe.mjs --json    (machine report)
//          pnpm run dogfood:acorn-probe
//
// Pure tooling — fixes no compiler bug.

import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { performance } from "node:perf_hooks";

import { compile } from "../../src/index.ts";
import { setupAcorn } from "./setup-acorn.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const CORPUS_DIR = join(HERE, "corpus");
const REPORT_PATH = join(HERE, "report", "acorn-probe.json");

// Budget cap on total node visits per probe — a defensive ceiling so a
// scale-dependent in-Wasm recursive-read runaway is REPORTED (as -99999 /
// "runaway") rather than hanging the harness. A correct walk of the largest
// corpus AST (~88 nodes) costs only a few hundred visits, so 50k is ~500x
// headroom for a clean walk while tripping a runaway quickly. (It must NOT be
// huge: each node visit does up to ~60 `type === "..."` wasm:js-string
// comparisons — host calls — so a multi-million budget turns a runaway into a
// minutes-long hang instead of a fast, reported trip.)
const BUDGET = 50_000;
const RUNAWAY = -99999; // node-count budget exhausted
const NOT_MEASURED = -99998; // search budget exhausted before a target was found

// ---------------------------------------------------------------------------
// ESTree visitor keys (child-bearing fields per node type). SINGLE SOURCE OF
// TRUTH: generates the in-Wasm type-switched walker's static field reads AND the
// JS "named-field mirror" completeness control. The walker reads ONLY the fields
// valid for each node's `type` — the emitter's own pattern — which both matches
// what #2928 will do and avoids the non-own-field read paths.
// ---------------------------------------------------------------------------
const VISITOR_KEYS = {
  Program: ["body"],
  ExpressionStatement: ["expression"],
  BlockStatement: ["body"],
  StaticBlock: ["body"],
  IfStatement: ["test", "consequent", "alternate"],
  LabeledStatement: ["label", "body"],
  BreakStatement: ["label"],
  ContinueStatement: ["label"],
  WithStatement: ["object", "body"],
  SwitchStatement: ["discriminant", "cases"],
  SwitchCase: ["test", "consequent"],
  ReturnStatement: ["argument"],
  ThrowStatement: ["argument"],
  TryStatement: ["block", "handler", "finalizer"],
  CatchClause: ["param", "body"],
  WhileStatement: ["test", "body"],
  DoWhileStatement: ["body", "test"],
  ForStatement: ["init", "test", "update", "body"],
  ForInStatement: ["left", "right", "body"],
  ForOfStatement: ["left", "right", "body"],
  VariableDeclaration: ["declarations"],
  VariableDeclarator: ["id", "init"],
  FunctionDeclaration: ["id", "params", "body"],
  FunctionExpression: ["id", "params", "body"],
  ArrowFunctionExpression: ["id", "params", "body"],
  ClassDeclaration: ["id", "superClass", "body"],
  ClassExpression: ["id", "superClass", "body"],
  ClassBody: ["body"],
  MethodDefinition: ["key", "value"],
  PropertyDefinition: ["key", "value"],
  Property: ["key", "value"],
  ObjectExpression: ["properties"],
  ObjectPattern: ["properties"],
  ArrayExpression: ["elements"],
  ArrayPattern: ["elements"],
  RestElement: ["argument"],
  SpreadElement: ["argument"],
  AssignmentPattern: ["left", "right"],
  TemplateLiteral: ["quasis", "expressions"],
  TaggedTemplateExpression: ["tag", "quasi"],
  SequenceExpression: ["expressions"],
  UnaryExpression: ["argument"],
  UpdateExpression: ["argument"],
  BinaryExpression: ["left", "right"],
  LogicalExpression: ["left", "right"],
  AssignmentExpression: ["left", "right"],
  ConditionalExpression: ["test", "consequent", "alternate"],
  CallExpression: ["callee", "arguments"],
  NewExpression: ["callee", "arguments"],
  MemberExpression: ["object", "property"],
  YieldExpression: ["argument"],
  AwaitExpression: ["argument"],
  MetaProperty: ["meta", "property"],
  ImportExpression: ["source"],
  ChainExpression: ["expression"],
  ParenthesizedExpression: ["expression"],
  ImportDeclaration: ["specifiers", "source"],
  ImportSpecifier: ["imported", "local"],
  ImportDefaultSpecifier: ["local"],
  ImportNamespaceSpecifier: ["local"],
  ExportNamedDeclaration: ["declaration", "specifiers", "source"],
  ExportDefaultDeclaration: ["declaration"],
  ExportAllDeclaration: ["exported", "source"],
  ExportSpecifier: ["local", "exported"],
};

const FN_TYPES = ["ArrowFunctionExpression", "FunctionExpression", "FunctionDeclaration"];

// ---------------------------------------------------------------------------
// In-Wasm walker (TS), generated from VISITOR_KEYS. Compiled alongside acorn;
// `parse` is the acorn top-level function in scope. All `any`-typed — these ARE
// the dynamic $Object reads. Everything is budget-guarded via a module global.
// ---------------------------------------------------------------------------
function genWalker() {
  const countBranches = Object.entries(VISITOR_KEYS)
    .map(([type, fields]) => {
      const reads = fields.map((f) => `    n = n + e0Count(node.${f});`).join("\n");
      return `  if (t === "${type}") {\n${reads}\n    return n;\n  }`;
    })
    .join("\n");

  const findBranches = Object.entries(VISITOR_KEYS)
    .map(([type, fields]) => {
      const reads = fields
        .map((f) => `    { const r = e0Find(node.${f}, want); if (r !== null) return r; }`)
        .join("\n");
      return `  if (t === "${type}") {\n${reads}\n    return null;\n  }`;
    })
    .join("\n");

  const fnMatch = FN_TYPES.map((t) => `t === "${t}"`).join(" || ");

  return `
// ==== E0 in-Wasm AST walker (#3308) — generated, appended to acorn ====

let e0Budget: number = 0;
let e0Hit: number = 0;

function e0Parse(src: string, isModule: number): any {
  if (isModule) { return parse(src, { ecmaVersion: 2025, sourceType: "module" }); }
  return parse(src, { ecmaVersion: 2025 });
}

// Full recursive node count via TYPE-SWITCHED static field reads (the emitter's
// path). Budget-guarded: a scale-dependent runaway trips e0Hit and stops.
function e0Count(node: any): number {
  if (e0Budget <= 0) { e0Hit = 1; return 0; }
  e0Budget = e0Budget - 1;
  if (node === null || node === undefined) return 0;
  if (typeof node !== "object") return 0;
  if (Array.isArray(node)) {
    let n = 0;
    const len: number = (node as any).length;
    for (let i = 0; i < len; i++) { if (e0Budget <= 0) { e0Hit = 1; return n; } n = n + e0Count(node[i]); }
    return n;
  }
  const t = node.type;
  if (typeof t !== "string" || (t as string).length === 0) return 0;
  let n = 1;
${countBranches}
  return n; // unknown node type: counted, not recursed
}

// First node whose type === want, pre-order via type-switched field reads.
function e0Find(node: any, want: string): any {
  if (e0Budget <= 0) { e0Hit = 1; return null; }
  e0Budget = e0Budget - 1;
  if (node === null || node === undefined) return null;
  if (typeof node !== "object") return null;
  if (Array.isArray(node)) {
    const len: number = (node as any).length;
    for (let i = 0; i < len; i++) { const r = e0Find(node[i], want); if (r !== null) return r; }
    return null;
  }
  const t = node.type;
  if (typeof t !== "string" || (t as string).length === 0) return null;
  if (t === want) return node;
${findBranches}
  return null;
}

// First Function/Arrow node (any of the three function kinds).
function e0FindFn(node: any): any {
  const a = e0Find(node, "ArrowFunctionExpression");
  if (a !== null) return a;
  const f = e0Find(node, "FunctionExpression");
  if (f !== null) return f;
  return e0Find(node, "FunctionDeclaration");
}

// Count array children whose element .type is a non-empty string.
function e0TypedElems(arr: any): number {
  if (arr === null || arr === undefined) return 0;
  const len: number = (arr as any).length;
  let typed = 0;
  for (let i = 0; i < len; i++) {
    const e = arr[i];
    if (e !== null && e !== undefined && typeof e.type === "string" && (e.type as string).length > 0) { typed++; }
  }
  return typed;
}

// ---- probes (all return scalars; ${RUNAWAY}=runaway, ${NOT_MEASURED}=search budget hit) ----

export function probeNodeCount(src: string, isModule: number): number {
  e0Budget = ${BUDGET}; e0Hit = 0;
  const n = e0Count(e0Parse(src, isModule));
  return e0Hit ? ${RUNAWAY} : n;
}

// #2841 — first Function/Arrow params.length (container survival).
export function probeParamCount(src: string, isModule: number): number {
  e0Budget = ${BUDGET}; e0Hit = 0;
  const fn = e0FindFn(e0Parse(src, isModule));
  if (e0Hit) return ${NOT_MEASURED};
  if (fn === null) return -1;
  const ps = fn.params;
  if (ps === null || ps === undefined) return -2;
  return (ps as any).length;
}
// #2841 — params whose element .type survives in-Wasm (element integrity).
export function probeParamTyped(src: string, isModule: number): number {
  e0Budget = ${BUDGET}; e0Hit = 0;
  const fn = e0FindFn(e0Parse(src, isModule));
  if (e0Hit) return ${NOT_MEASURED};
  if (fn === null) return -1;
  return e0TypedElems(fn.params);
}

// #2852 — first SequenceExpression expressions.length (container survival).
export function probeSeqCount(src: string, isModule: number): number {
  e0Budget = ${BUDGET}; e0Hit = 0;
  const se = e0Find(e0Parse(src, isModule), "SequenceExpression");
  if (e0Hit) return ${NOT_MEASURED};
  if (se === null) return -1;
  const ex = se.expressions;
  if (ex === null || ex === undefined) return -2;
  return (ex as any).length;
}
// #2852 — sequence children whose element .type survives (element integrity).
export function probeSeqTyped(src: string, isModule: number): number {
  e0Budget = ${BUDGET}; e0Hit = 0;
  const se = e0Find(e0Parse(src, isModule), "SequenceExpression");
  if (e0Hit) return ${NOT_MEASURED};
  if (se === null) return -1;
  return e0TypedElems(se.expressions);
}

// #2851 — first TemplateLiteral quasis.length (container survival).
export function probeQuasiCount(src: string, isModule: number): number {
  e0Budget = ${BUDGET}; e0Hit = 0;
  const tl = e0Find(e0Parse(src, isModule), "TemplateLiteral");
  if (e0Hit) return ${NOT_MEASURED};
  if (tl === null) return -1;
  const qs = tl.quasis;
  if (qs === null || qs === undefined) return -2;
  return (qs as any).length;
}
// #2851 — first TemplateElement's cooked[0] char code (element integrity).
export function probeQuasiCookedFirst(src: string, isModule: number): number {
  e0Budget = ${BUDGET}; e0Hit = 0;
  const tl = e0Find(e0Parse(src, isModule), "TemplateLiteral");
  if (e0Hit) return ${NOT_MEASURED};
  if (tl === null) return -1;
  const qs = tl.quasis;
  if (qs === null || qs === undefined) return -2;
  if ((qs as any).length === 0) return -3;
  const q0 = qs[0];
  if (q0 === null || q0 === undefined) return -4;
  const val = q0.value;
  if (val === null || val === undefined) return -5;
  const cooked = val.cooked;
  if (typeof cooked !== "string") return -6;
  const cs = cooked as string;
  if (cs.length === 0) return -7;
  return cs.charCodeAt(0);
}
`;
}

// ---------------------------------------------------------------------------
// JS reference walkers (node-acorn ground truth + completeness control).
// ---------------------------------------------------------------------------

// TRUE node count: generic recursion over EVERY own key.
function jsGenericCount(node) {
  if (node === null || typeof node !== "object") return 0;
  if (Array.isArray(node)) {
    let n = 0;
    for (const v of node) n += jsGenericCount(v);
    return n;
  }
  let n = typeof node.type === "string" && node.type.length > 0 ? 1 : 0;
  for (const k of Object.keys(node)) n += jsGenericCount(node[k]);
  return n;
}

function jsFind(node, pred) {
  if (node === null || typeof node !== "object") return null;
  if (Array.isArray(node)) {
    for (const v of node) {
      const r = jsFind(v, pred);
      if (r !== null) return r;
    }
    return null;
  }
  if (pred(node)) return node;
  for (const k of Object.keys(node)) {
    const r = jsFind(node[k], pred);
    if (r !== null) return r;
  }
  return null;
}

function jsTypedElems(arr) {
  if (!Array.isArray(arr)) return 0;
  let typed = 0;
  for (const e of arr) if (e && typeof e.type === "string" && e.type.length > 0) typed++;
  return typed;
}

function isModuleName(name) {
  return /\.module\.js$/.test(name);
}

function loadCorpus(name) {
  const p = join(CORPUS_DIR, name);
  return existsSync(p) ? readFileSync(p, "utf-8") : null;
}

// ---------------------------------------------------------------------------
// Inputs
// ---------------------------------------------------------------------------

// Single-construct inputs where the in-Wasm recursive walk is reliable — spans
// the ESTree breadth relevant to the corpus. Used for the ±0 node-count parity
// demonstration (proves the read path reaches every node faithfully).
const SINGLE_CONSTRUCT_INPUTS = [
  "x;",
  "x + y;",
  "a => a;",
  "(a) => a;",
  "(a, b) => a + b;",
  "(a, b, c) => a + b + c;",
  "(a, b, c = 0) => a + b + c;",
  "async (a, b) => a + b;",
  "(a, b, c);",
  "`hi ${x} bye`;",
  "f(a, b);",
  "a.b.c;",
  "[1, 2, 3];",
  "({ a: 1, b: 2 });",
  "let z = 5;",
  "if (a) b(); else c();",
  "while (x) y();",
  "for (let i = 0; i < n; i++) s(i);",
  "function g(a, b) { return a + b; }",
  "a ? b : c;",
];

// Gap arbitration: crafted minimal inputs (known structure) + the representative
// corpus file (real-world cross-check; may report not-measured on in-Wasm
// runaway, which the finding explains).
const ARBITRATION = [
  {
    gap: "#2841",
    what: "Function/Arrow params[] element .name/.type",
    kind: "params",
    crafted: "const f = (a, b, c) => a + b + c;",
    corpus: "arrow-params.js",
  },
  {
    gap: "#2852",
    what: "SequenceExpression expressions[] child nodes",
    kind: "seq",
    crafted: "x = (a, b, c);",
    corpus: "sequence-misc.js",
  },
  {
    gap: "#2851",
    what: "TemplateLiteral quasis[] TemplateElement value.cooked",
    kind: "quasi",
    crafted: "const s = `hi ${x} bye`;",
    corpus: "templates.js",
  },
];

// Corpus script files, walked with the full recursive counter to characterise
// the scale-dependent runaway (the substrate finding).
const CORPUS_SCALE_FILES = [
  "loops.js",
  "members-calls.js",
  "objects.js",
  "control-flow.js",
  "optional-nullish.js",
  "spread-rest.js",
  "operators.js",
  "sequence-misc.js",
  "arrow-params.js",
  "templates.js",
  "escapes-unicode.js",
  "destructuring.js",
  "classes.js",
];

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
export async function runProbe({ quiet = false } = {}) {
  const log = quiet ? () => {} : (...a) => console.error(...a);

  const { entryModulePath, version } = setupAcorn();
  const acornSource = readFileSync(entryModulePath, "utf-8");
  const combined = acornSource + genWalker();

  log(`[probe] compiling pinned acorn@${version} + in-Wasm walker (~60s)…`);
  const t0 = performance.now();
  const r = await compile(combined, { fileName: "acorn-probe.mts", skipSemanticDiagnostics: true });
  const compileMs = Math.round(performance.now() - t0);
  log(`[probe] compile success=${r.success} in ${compileMs}ms — binary ${r.binary?.length ?? 0} bytes`);
  if (!r.success || !r.binary?.length) {
    throw new Error(
      `[probe] compile failed: ${(r.errors ?? [])
        .slice(0, 4)
        .map((e) => e.message)
        .join(" | ")}`,
    );
  }

  await WebAssembly.compile(r.binary); // validate (throws on invalid)
  const io = r.importObject ?? {};
  const { instance } = await WebAssembly.instantiate(r.binary, io);
  io.__setInstance?.(instance);
  const exp = instance.exports;
  const REQUIRED = [
    "probeNodeCount",
    "probeParamCount",
    "probeParamTyped",
    "probeSeqCount",
    "probeSeqTyped",
    "probeQuasiCount",
    "probeQuasiCookedFirst",
  ];
  for (const name of REQUIRED) {
    if (typeof exp[name] !== "function") {
      throw new Error(`[probe] compiled module missing export ${name} — got ${Object.keys(exp).slice(0, 40)}`);
    }
  }
  const oracle = await import(pathToFileURL(entryModulePath).href);
  log("[probe] instantiated; measuring.");

  const callWasm = (name, src, isModule) => {
    try {
      return { ok: true, value: exp[name](src, isModule ? 1 : 0) };
    } catch (e) {
      let payload;
      if (typeof WebAssembly !== "undefined" && e instanceof WebAssembly.Exception) {
        try {
          const tag = exp.__exn_tag ?? exp.__tag;
          if (tag) payload = e.getArg(tag, 0);
        } catch {}
      }
      const payloadName =
        payload != null && (typeof payload === "object" || typeof payload === "function") ? payload.name : undefined;
      const payloadMessage =
        payload != null && (typeof payload === "object" || typeof payload === "function") ? payload.message : undefined;
      const error =
        typeof payloadName === "string"
          ? `${payloadName}${payloadMessage ? `: ${String(payloadMessage)}` : ""}`
          : (e?.message ?? String(e));
      return { ok: false, error };
    }
  };

  // --- (1) gap arbitration (element-field integrity) ---
  const verdicts = [];
  for (const a of ARBITRATION) {
    const cases = [{ label: "crafted", src: a.crafted, isModule: false }];
    const corpusSrc = a.corpus ? loadCorpus(a.corpus) : null;
    if (corpusSrc != null)
      cases.push({ label: `corpus/${a.corpus}`, src: corpusSrc, isModule: isModuleName(a.corpus) });

    const caseResults = [];
    let craftedIntact = false;
    let anyMeasured = false;
    for (const c of cases) {
      const res = arbitrateCase(a.kind, c, oracle, callWasm);
      caseResults.push(res);
      if (res.measured) {
        anyMeasured = true;
        if (c.label === "crafted" && res.intact) craftedIntact = true;
      }
    }
    // Verdict anchors on the crafted single-construct input (proven-reliable
    // read path); corpus cross-checks are advisory (may be not-measured on runaway).
    const verdict = craftedIntact ? "intact-in-wasm" : anyMeasured ? "lost-in-wasm" : "not-measured";
    verdicts.push({ gap: a.gap, field: a.what, kind: a.kind, verdict, cases: caseResults });
    log(`[probe] ${a.gap} ${a.what}: ${verdict.toUpperCase()}`);
  }

  // --- (2) node-count parity on single-construct inputs (read-path fidelity) ---
  const parity = [];
  for (const src of SINGLE_CONSTRUCT_INPUTS) {
    const truth = jsGenericCount(oracle.parse(src, { ecmaVersion: 2025 }));
    const w = callWasm("probeNodeCount", src, false);
    parity.push({
      input: src,
      nodeAcorn: truth,
      inWasm: w.ok ? w.value : null,
      match: w.ok && w.value === truth,
      ...(w.ok ? {} : { error: w.error }),
    });
  }
  const parityMatches = parity.filter((p) => p.match).length;

  // --- (3) corpus scale characterisation (documents the runaway finding) ---
  const scale = [];
  for (const name of CORPUS_SCALE_FILES) {
    const src = loadCorpus(name);
    if (src == null) continue;
    const isModule = isModuleName(name);
    let truth;
    try {
      truth = jsGenericCount(oracle.parse(src, { ecmaVersion: 2025, sourceType: isModule ? "module" : "script" }));
    } catch {
      truth = null;
    }
    const w = callWasm("probeNodeCount", src, isModule);
    const val = w.ok ? w.value : null;
    const status = !w.ok ? "wasm-threw" : val === RUNAWAY ? "runaway" : val === truth ? "match" : "undercount";
    scale.push({ input: name, bytes: src.length, nodeAcorn: truth, inWasm: val, status });
    log(`[probe] scale ${name.padEnd(20)} node-acorn=${truth} in-Wasm=${val} → ${status}`);
  }

  const summary = {
    acornVersion: version,
    compileMs,
    binaryBytes: r.binary.length,
    verdicts: verdicts.map((v) => ({ gap: v.gap, verdict: v.verdict })),
    singleConstructParity: `${parityMatches}/${parity.length}`,
    singleConstructMeets5: parityMatches >= 5,
    scale: {
      match: scale.filter((s) => s.status === "match").length,
      runaway: scale.filter((s) => s.status === "runaway").length,
      undercount: scale.filter((s) => s.status === "undercount").length,
      total: scale.length,
    },
  };

  const report = {
    issue: 3308,
    umbrella: 2927,
    generatedAt: new Date().toISOString(),
    acornVersion: version,
    compileMs,
    binaryBytes: r.binary.length,
    note: "in-Wasm AST consumer probe — arbitrates host-boundary gaps #2841/#2851/#2852 via in-Wasm named-field reads (scalar-only measurement).",
    finding:
      "In-Wasm static named field reads are faithful (element sub-fields intact). The former scale-dependent recursive-walk 'runaway' (#3343) is RESOLVED — it was NOT a $Object read bug (reads are faithful) but a codegen control-flow bug: a `for (let i)` loop counter was compiled to a shared module global (acorn has a top-level `i`) instead of a per-invocation local, so a recursive walk clobbered the outer counter. Fixed in src/codegen/statements/loops.ts. This probe now expects 13/13 match and guards against regression. See plan/issues/3343-*.md.",
    summary,
    verdicts,
    singleConstructParity: parity,
    scaleCharacterisation: scale,
  };

  mkdirSync(dirname(REPORT_PATH), { recursive: true });
  writeFileSync(REPORT_PATH, JSON.stringify(report, null, 2) + "\n");

  if (!quiet) printHumanSummary(report);
  return report;
}

function arbitrateCase(kind, c, oracle, callWasm) {
  let ast, oracleErr;
  try {
    ast = oracle.parse(c.src, { ecmaVersion: 2025, sourceType: c.isModule ? "module" : "script" });
  } catch (e) {
    oracleErr = e?.message ?? String(e);
  }
  if (oracleErr) return { label: c.label, measured: false, oracleError: oracleErr };

  const notMeasured = (a, b) => (a.ok && a.value === NOT_MEASURED) || (b.ok && b.value === NOT_MEASURED);

  if (kind === "params") {
    const fn = jsFind(ast, (n) => FN_TYPES.includes(n.type));
    if (!fn) return { label: c.label, measured: false, reason: "no function node in oracle AST" };
    const trueLen = fn.params.length;
    const trueTyped = jsTypedElems(fn.params);
    const wLen = callWasm("probeParamCount", c.src, c.isModule);
    const wTyped = callWasm("probeParamTyped", c.src, c.isModule);
    if (notMeasured(wLen, wTyped))
      return { label: c.label, measured: false, reason: "in-Wasm search runaway (scale limit)" };
    const intact =
      wLen.ok && wTyped.ok && wLen.value === trueLen && wTyped.value === trueTyped && trueTyped === trueLen;
    return {
      label: c.label,
      measured: true,
      intact,
      nodeAcorn: { paramsLength: trueLen, typedElems: trueTyped },
      inWasm: { paramsLength: wLen.ok ? wLen.value : null, typedElems: wTyped.ok ? wTyped.value : null },
    };
  }
  if (kind === "seq") {
    const se = jsFind(ast, (n) => n.type === "SequenceExpression");
    if (!se) return { label: c.label, measured: false, reason: "no SequenceExpression in oracle AST" };
    const trueLen = se.expressions.length;
    const trueTyped = jsTypedElems(se.expressions);
    const wLen = callWasm("probeSeqCount", c.src, c.isModule);
    const wTyped = callWasm("probeSeqTyped", c.src, c.isModule);
    if (notMeasured(wLen, wTyped))
      return { label: c.label, measured: false, reason: "in-Wasm search runaway (scale limit)" };
    const intact =
      wLen.ok && wTyped.ok && wLen.value === trueLen && wTyped.value === trueTyped && trueTyped === trueLen;
    return {
      label: c.label,
      measured: true,
      intact,
      nodeAcorn: { expressionsLength: trueLen, typedElems: trueTyped },
      inWasm: { expressionsLength: wLen.ok ? wLen.value : null, typedElems: wTyped.ok ? wTyped.value : null },
    };
  }
  // quasi
  const tl = jsFind(ast, (n) => n.type === "TemplateLiteral");
  if (!tl) return { label: c.label, measured: false, reason: "no TemplateLiteral in oracle AST" };
  const trueLen = tl.quasis.length;
  const trueCooked = tl.quasis[0]?.value?.cooked ?? "";
  const trueCode = trueCooked.length > 0 ? trueCooked.charCodeAt(0) : -7;
  const wLen = callWasm("probeQuasiCount", c.src, c.isModule);
  const wCode = callWasm("probeQuasiCookedFirst", c.src, c.isModule);
  if (notMeasured(wLen, wCode))
    return { label: c.label, measured: false, reason: "in-Wasm search runaway (scale limit)" };
  const intact = wLen.ok && wCode.ok && wLen.value === trueLen && wCode.value === trueCode;
  return {
    label: c.label,
    measured: true,
    intact,
    nodeAcorn: { quasisLength: trueLen, cookedFirstCharCode: trueCode, cookedFirst: trueCooked.slice(0, 1) },
    inWasm: { quasisLength: wLen.ok ? wLen.value : null, cookedFirstCharCode: wCode.ok ? wCode.value : null },
  };
}

function printHumanSummary(report) {
  const s = report.summary;
  const out = (...a) => console.error(...a);
  out("");
  out("=== E0 in-Wasm AST consumer probe (#3308) ===");
  out(
    `acorn@${report.acornVersion}  compiled+walker in ${report.compileMs}ms (${(report.binaryBytes / 1024).toFixed(0)} KB)`,
  );
  out("");
  out("--- gap arbitration (in-Wasm element-field integrity) ---");
  for (const v of report.verdicts) {
    out(`  ${v.gap.padEnd(6)} ${v.verdict.toUpperCase().padEnd(16)} ${v.field}`);
    for (const c of v.cases) {
      if (!c.measured) {
        out(`         [${c.label}] not measured (${c.reason || c.oracleError})`);
        continue;
      }
      out(
        `         [${c.label}] node-acorn=${JSON.stringify(c.nodeAcorn)} in-Wasm=${JSON.stringify(c.inWasm)} ${c.intact ? "INTACT" : "LOST"}`,
      );
    }
  }
  out("");
  out(`--- node-count parity ±0 on single-construct inputs (${s.singleConstructParity}) ---`);
  for (const p of report.singleConstructParity) {
    out(
      `  [${p.match ? "±0" : "  "}] node-acorn=${String(p.nodeAcorn).padStart(3)} in-Wasm=${String(p.inWasm).padStart(3)}  ${JSON.stringify(p.input)}`,
    );
  }
  out("");
  out("--- corpus scale characterisation (documents the in-Wasm recursive-read runaway) ---");
  for (const sc of report.scaleCharacterisation) {
    out(`  [${sc.status.padEnd(10)}] ${sc.input.padEnd(20)} node-acorn=${sc.nodeAcorn} in-Wasm=${sc.inWasm}`);
  }
  out("");
  out(`verdicts: ${s.verdicts.map((v) => v.gap + "=" + v.verdict).join(", ")}`);
  out(`single-construct parity ≥5: ${s.singleConstructMeets5 ? "PASS" : "FAIL"} (${s.singleConstructParity})`);
  out(
    `scale: ${s.scale.match} match / ${s.scale.undercount} undercount / ${s.scale.runaway} runaway (of ${s.scale.total})`,
  );
  out(`finding: ${report.finding}`);
  out("");
  out(`full report → ${REPORT_PATH}`);
}

// CLI entry
if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  const jsonOnly = process.argv.includes("--json");
  runProbe({ quiet: jsonOnly })
    .then((report) => {
      if (jsonOnly) process.stdout.write(JSON.stringify(report, null, 2) + "\n");
      process.exit(0);
    })
    .catch((e) => {
      console.error("[probe] harness crashed:", e);
      process.exit(2);
    });
}
