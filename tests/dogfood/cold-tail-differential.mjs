// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
// (#3927) Standalone per-field differential for the hot/cold fnctor split.
//
// Compiles acorn to a STANDALONE module (no host imports), parses acorn's own
// dist bundle INSIDE wasm, walks the resulting AST INSIDE wasm and returns one
// rolling hash per ESTree property name. Two builds' hashes are compared with
// `cold-tail-diff.mjs`; a single differing name localises a wrong answer to one
// property out of 64.
//
// WHY IT HAS TO BE IN-WASM. A closed fnctor struct serialises as `null` through
// the standalone boundary, so `JSON.stringify` sees nothing, and
// `acorn-corpus.mjs` runs in JS-HOST mode where flow-grown fields are never
// reserved as native slots at all — it is structurally blind to this feature.
//
// FOUR READ MODES, and the distinction is what found the #3927 §4 defect:
//   PROBE_READ=computed  `node[key]`     → the computed `__extern_get` path
//   PROBE_READ=named     `node.<key>`    → the per-name `__get_member_<n>`
//                                          dispatcher and its typed twins
//   PROBE_READ=reflect   `for…in` + `hasOwnProperty` + `node[k]` → the
//                                          ENUMERATION arms
//   PROBE_READ=copy      copy every node via `for (k in n) copy[k] = n[k]`
//                        into a fresh `new Node(...)`, then read the COPY →
//                        the computed-WRITE arms (#4194) composed with
//                        enumeration — acorn's copyNode shape. On one build,
//                        copy-mode hashes must EQUAL computed-mode hashes
//                        field-for-field; a dropped write reads as the ctor
//                        default and diverges.
//
// EXPECTED copy-mode divergences vs computed mode (measured 2026-08-08,
// 58/64 exact; do not re-diagnose these as write defects):
//   - type/start/end presence 32487 -> 32506: the copy SHELL is a Node, whose
//     ctor writes those three unconditionally, so the 19 walked non-Node
//     objects gain them. Instrument shape, not a defect.
//   - pattern/flags 15 -> 0, source 5 -> 1: acorn's `node.regex` descriptor is
//     a plain `{pattern, flags}` object natively (enumerable — the ORACLE
//     copies it), but the wasm lane's for…in over that carrier class yields
//     nothing, so the copy loses what the direct computed READ still sees
//     (computed-mode seen: 15). That is a PRE-EXISTING #3920-family
//     enumeration residual on that receiver class — measurable at all only
//     now that the write half works.
// The defect was invisible in `computed` and uniform in `named`.
//
// ⚠ `reflect` IS CURRENTLY VACUOUS ON THIS CORPUS, AND SAYS SO. Measured
// 2026-08-07: `for…in` over a standalone closed fnctor struct enumerates ZERO
// own properties — only 15 of 32,506 walked objects yield any key at all, and
// those 15 are the plain RegExp-ish objects, not AST nodes. The reference
// implementation yields keys on all 32,487. So a `reflect` differential
// compares `undefined` against `undefined` and passes no matter what. The
// report therefore always carries `enumeratingNodes`; **if it is ~0 the run
// proved nothing** and the harness warns on stderr. Keep the mode: it becomes
// real the day standalone enumeration over these receivers does, and until
// then it is the measurement of that gap.
//
// This also bears on a record in the issue: the split's first cut was said to
// have been broken via acorn's `copyNode` (`for (var prop in node) …`). That
// routine cannot copy anything if `for…in` yields nothing, and the per-type
// layouts slice separately measured `copyNode` executing zero times on this
// corpus. Two independent lines of evidence against that attribution — the fix
// worked, but the named mechanism is unsupported. Do not build on it.
//
// ONE MUTABLE SCALAR, NOT AN ARRAY. Each field gets its own full walk and the
// accumulator is a scalar module global. An earlier cut accumulated into a
// module-level ARRAY and produced results that changed when unrelated exports
// were added — i.e. the instrument was less trustworthy than the thing it
// measures. Do not "optimise" this back into one walk with an array.
//
// ORACLE. The same walk runs in plain Node over the real acorn AST, so "the
// probe agrees with itself across builds" is backed against a reference. Read
// the `oracleSeen` (presence) columns, NOT `oracleMismatch`: on current main
// the reference walk descends into 11 more objects than the standalone lane
// does (RegExp-literal value objects), and 11 extra visits shift every rolling
// hash, so `oracleMismatch` lists all 64 names and is not a finding. The
// PRESENCE counts agree on 60 of 64; the four that do not — `raw`, `test`,
// `source`, `flags` — are that same pre-existing RegExp gap and are unrelated
// to this feature.
//
// Usage:
//   node tests/dogfood/cold-tail-differential.mjs --json .tmp/off.json
//   JS2WASM_FNCTOR_HOT_FIELDS=24 PROBE_READ=named \
//     node tests/dogfood/cold-tail-differential.mjs --json .tmp/k24.json
//   node tests/dogfood/cold-tail-diff.mjs .tmp/off.json .tmp/k24.json
//
// Env: JS2WASM_FNCTOR_HOT_FIELDS=<K>  (unset = OFF/baseline)
//      PROBE_READ=computed|named      (default computed)
//      PROBE_SRC=<path>               (parse this instead of acorn's dist)
//      JS2WASM_FNCTOR_COLD_DIAG=1     (prints the hot/cold split to stderr)
//
// Budget: ~90 s per data point. This is deliberately NOT a vitest test.

import { readFileSync, writeFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

import { compile } from "../../src/index.ts";
import { setupAcorn } from "./setup-acorn.mjs";

const args = process.argv.slice(2);
const optIdx = args.indexOf("--opt");
const optimize = optIdx >= 0 ? Number(args[optIdx + 1]) : 0;
const jsonIdx = args.indexOf("--json");
const jsonOut = jsonIdx >= 0 ? args[jsonIdx + 1] : undefined;

// The ESTree surface acorn can put on a Node, plus the positional fields.
const ALL_FIELDS = [
  "type",
  "start",
  "end",
  "name",
  "value",
  "raw",
  "operator",
  "prefix",
  "argument",
  "left",
  "right",
  "callee",
  "arguments",
  "object",
  "property",
  "computed",
  "body",
  "params",
  "id",
  "init",
  "test",
  "update",
  "consequent",
  "alternate",
  "declarations",
  "kind",
  "properties",
  "key",
  "shorthand",
  "method",
  "elements",
  "expression",
  "expressions",
  "label",
  "block",
  "handler",
  "finalizer",
  "param",
  "cases",
  "discriminant",
  "quasis",
  "quasi",
  "tag",
  "source",
  "specifiers",
  "local",
  "imported",
  "exported",
  "declaration",
  "sourceType",
  "generator",
  "async",
  "delegate",
  "static",
  "superClass",
  "optional",
  "tail",
  "cooked",
  "pattern",
  "flags",
  "regex",
  "attributes",
  "directive",
  "meta",
];
const fieldsIdx = args.indexOf("--fields");
const FIELDS = fieldsIdx >= 0 ? args[fieldsIdx + 1].split(",") : ALL_FIELDS;

const MOD = 50000017; // 33*MOD + MOD < 2^31 so i32 and f64 lowerings agree
// `computed` reads `node[key]` (reflective / `__extern_get`); `named` reads a
// literal `node.<key>` behind an if-chain (the per-name `__get_member_<n>`
// dispatcher and its typed twins). Running both separates "the stored value is
// wrong" from "this particular read path is wrong".
const readMode =
  process.env.PROBE_READ === "named"
    ? "named"
    : process.env.PROBE_READ === "reflect"
      ? "reflect"
      : process.env.PROBE_READ === "copy"
        ? "copy"
        : "computed";

/** The reference implementation of the in-wasm walk, for the oracle. */
function oracleHash(root, key, childKeys) {
  let acc = 7;
  let seen = 0;
  let nodes = 0;
  const walk = (node) => {
    if (node === null) return;
    if (typeof node !== "object") return;
    if (Array.isArray(node)) {
      for (let i = 0; i < node.length; i++) walk(node[i]);
      return;
    }
    nodes += 1;
    let v;
    if (readMode === "copy") {
      // (#4194) Mirror the in-wasm copy probe: enumerate + computed-write into
      // a fresh object, then read the copy. The reference uses a plain object
      // where the wasm lane uses `new Node(...)` — both start property-less
      // for every ESTree name (Node's ctor fields are then overwritten by the
      // copy loop, same as in wasm).
      const copy = {};
      for (const k in node) copy[k] = node[k];
      v = copy[key];
    } else {
      v = node[key];
    }
    acc = (acc * 33 + code(v)) % MOD;
    if (v !== undefined) seen += 1;
    for (let i = 0; i < childKeys.length; i++) {
      const c = node[childKeys[i]];
      if (c !== null && typeof c === "object") walk(c);
    }
  };
  const code = (v) => {
    if (v === undefined) return 1;
    if (v === null) return 2;
    const t = typeof v;
    if (t === "boolean") return v ? 3 : 4;
    if (t === "number") return (5 + Math.abs(v) * 7) % MOD;
    if (t === "string") {
      let h = 17;
      for (let i = 0; i < v.length; i++) h = (h * 33 + v.charCodeAt(i)) % MOD;
      return h;
    }
    if (t === "object") return 9;
    return 13;
  };
  walk(root);
  return { hash: acc, seen, nodes };
}

function chunked(source) {
  const CHUNK = 4096;
  const out = [];
  for (let i = 0; i < source.length; i += CHUNK) out.push(JSON.stringify(source.slice(i, i + CHUNK)));
  return `[${out.join(",")}]`;
}

async function main() {
  const { entryModulePath } = setupAcorn();
  const source = readFileSync(entryModulePath, "utf-8");
  const corpus = process.env.PROBE_SRC ? readFileSync(process.env.PROBE_SRC, "utf-8") : source;

  const driver = `
var __probeChunks = ${chunked(corpus)};
var __probeInput = "";
for (var __pi = 0; __pi < __probeChunks.length; __pi++) { __probeInput += __probeChunks[__pi]; }
var __probeChildKeys = ${JSON.stringify(ALL_FIELDS)};
var __probeFields = ${JSON.stringify(FIELDS)};
var __probeFieldIdx = ${JSON.stringify(FIELDS.map((f) => ALL_FIELDS.indexOf(f)))};
var __probeAcc = 0;
var __probeSeen = 0;
var __probeNodes = 0;
var __probeKey = "type";
var __probeKeyIdx = 0;
var __probeAst = null;

/** Identity that erases static typing (the copy-mode receiver spelling). @param {*} x @returns {*} */
function __probeLaunder(x) { return x ? x : x; }

/** @param {*} node @returns {*} */
function __probeRead(node) {
${
  readMode === "named"
    ? `  var v = undefined;\n${ALL_FIELDS.map((f, i) => `  if (__probeKeyIdx === ${i}) { v = node.${f}; }`).join("\n")}\n  return v;`
    : readMode === "reflect"
      ? `  // Reach the value ONLY through the reflective surface: the key has to
  // come out of \`for…in\` enumeration, and \`hasOwnProperty\` has to agree.
  // A field the enumeration arms forgot answers \`undefined\` here even when
  // the value arms are perfect.
  var v = undefined;
  for (var k in node) {
    if (k === __probeKey) {
      if (node.hasOwnProperty(k)) { v = node[k]; }
      else { v = "HASOWN-DISAGREES"; }
    }
  }
  return v;`
      : readMode === "copy"
        ? `  // (#4194) The copyNode-shaped probe: enumerate + computed-WRITE into a
  // fresh Node, then read the COPY. Exercises the closed-struct arms of
  // __extern_set (the write half) composed with the #3920 enumeration arms —
  // the exact acorn copyNode composition that measured ZERO effect before
  // the extern-set fill (every computed write dropped, so the copy was
  // blank and every hash was the ctor default).
  //
  // The copy is LAUNDERED to an any-typed binding first — acorn's copyNode
  // receiver is an untyped parameter, and a struct-typed binding takes a
  // DIFFERENT lowering for both n[k] reads and writes (receiver-spelling
  // trap, #3920: the first cut of this mode measured a statically-typed
  // copy and answered non-undefined for all 64 fields on all 32,506 nodes).
  var copy = __probeLaunder(new Node({ options: {} }, 0, null));
  for (var k in node) { copy[k] = node[k]; }
  return copy[__probeKey];`
        : `  return node[__probeKey];`
}
}

/** @param {*} v @returns {number} */
function __probeCode(v) {
  if (v === undefined) { return 1; }
  if (v === null) { return 2; }
  var t = typeof v;
  if (t === "boolean") { if (v) { return 3; } return 4; }
  if (t === "number") { var n = v; if (n < 0) { n = 0 - n; } return (5 + n * 7) % ${MOD}; }
  if (t === "string") {
    var h = 17;
    for (var si = 0; si < v.length; si++) { h = (h * 33 + v.charCodeAt(si)) % ${MOD}; }
    return h;
  }
  if (t === "object") { return 9; }
  return 13;
}

/** @param {*} node @returns {void} */
function __probeWalk(node) {
  if (node === null) { return; }
  if (typeof node !== "object") { return; }
  if (Array.isArray(node)) {
    for (var ai = 0; ai < node.length; ai++) { __probeWalk(node[ai]); }
    return;
  }
  __probeNodes = __probeNodes + 1;
  var v = __probeRead(node);
  __probeAcc = (__probeAcc * 33 + __probeCode(v)) % ${MOD};
  if (v !== undefined) { __probeSeen = __probeSeen + 1; }
  for (var ci = 0; ci < __probeChildKeys.length; ci++) {
    var c = node[__probeChildKeys[ci]];
    if (c !== null && typeof c === "object") { __probeWalk(c); }
  }
}

/** @returns {number} */
export function __probe_parse() {
  __probeAst = parse(__probeInput, { ecmaVersion: 2022, sourceType: "module" });
  return __probeAst.body.length;
}

/** @param {number} i @returns {number} */
export function __probe_field(i) {
  __probeKey = __probeFields[i];
  __probeKeyIdx = __probeFieldIdx[i];
  __probeAcc = 7;
  __probeSeen = 0;
  __probeNodes = 0;
  __probeWalk(__probeAst);
  return __probeAcc;
}

/** @returns {number} */
export function __probe_seen() { return __probeSeen; }

/**
 * Walked objects on which \`for…in\` yields at least one key. This is the
 * VALIDITY number for \`PROBE_READ=reflect\`: near zero means that mode's
 * differential compared undefined against undefined and proved nothing.
 * @returns {number}
 */
export function __probe_enumerating_nodes() {
  var count = 0;
  __probeEnumCount(__probeAst);
  count = __probeEnum;
  return count;
}

var __probeEnum = 0;

/** @param {*} node @returns {void} */
function __probeEnumCount(node) {
  if (node === null) { return; }
  if (typeof node !== "object") { return; }
  if (Array.isArray(node)) {
    for (var ei = 0; ei < node.length; ei++) { __probeEnumCount(node[ei]); }
    return;
  }
  var n = 0;
  for (var k in node) { n = n + 1; }
  if (n > 0) { __probeEnum = __probeEnum + 1; }
  for (var eci = 0; eci < __probeChildKeys.length; eci++) {
    var ec = node[__probeChildKeys[eci]];
    if (ec !== null && typeof ec === "object") { __probeEnumCount(ec); }
  }
}

/** @returns {number} */
export function __probe_nodes() { return __probeNodes; }
`;

  const started = Date.now();
  const result = await compile(`${source}\n${driver}`, {
    fileName: "acorn.mjs",
    skipSemanticDiagnostics: true,
    target: "standalone",
    optimize,
  });
  const compileMs = Date.now() - started;
  if (!result.binary?.length) {
    process.stderr.write(`[cold-tail] compile FAILED\n${(result.errors ?? []).slice(0, 5).join("\n")}\n`);
    process.exit(1);
  }
  const module = await WebAssembly.compile(result.binary);
  const imports = WebAssembly.Module.imports(module).filter((e) => e.kind === "function");
  if (imports.length > 0) {
    process.stderr.write(`[cold-tail] NOT standalone — imports: ${imports.map((i) => i.name).join(",")}\n`);
    process.exit(1);
  }
  const { exports } = await WebAssembly.instantiate(module, {});
  const bodyLength = exports.__probe_parse();
  const enumeratingNodes = exports.__probe_enumerating_nodes();

  const hashes = {};
  const seen = {};
  const nodes = {};
  for (let i = 0; i < FIELDS.length; i++) {
    hashes[FIELDS[i]] = exports.__probe_field(i);
    seen[FIELDS[i]] = exports.__probe_seen();
    nodes[FIELDS[i]] = exports.__probe_nodes();
  }

  // Oracle: the same walk in plain Node over the real acorn AST.
  const oracleMod = await import(pathToFileURL(entryModulePath).href);
  const ast = oracleMod.parse(corpus, { ecmaVersion: 2022, sourceType: "module" });
  const oracle = {};
  const oracleSeen = {};
  for (const f of FIELDS) {
    const r = oracleHash(ast, f, ALL_FIELDS);
    oracle[f] = r.hash;
    oracleSeen[f] = r.seen;
  }
  const oracleMismatch = FIELDS.filter((f) => hashes[f] !== oracle[f]);

  const report = {
    k: process.env.JS2WASM_FNCTOR_HOT_FIELDS ?? "OFF",
    readMode,
    optimize,
    compileMs,
    binaryBytes: result.binary.length,
    bodyLength,
    nodes: nodes[FIELDS[0]],
    enumeratingNodes,
    oracleMismatch,
    hashes,
    seen,
    oracle,
    oracleSeen,
  };
  if (jsonOut) writeFileSync(jsonOut, `${JSON.stringify(report, null, 2)}\n`);
  // A `reflect` run whose receivers enumerate nothing compares undefined
  // against undefined. Say so loudly rather than let it read as coverage.
  if (readMode === "reflect" && enumeratingNodes * 20 < report.nodes) {
    process.stderr.write(
      `[cold-tail] ⚠ VACUOUS reflect run — for…in yielded keys on only ${enumeratingNodes} of ` +
        `${report.nodes} walked objects. This differential proves NOTHING about the enumeration ` +
        `arms; see this file's header.\n`,
    );
  }
  process.stdout.write(
    `[cold-tail] K=${report.k} nodes=${report.nodes} enumerating=${enumeratingNodes} ` +
      `body=${bodyLength} bin=${result.binary.length} ` +
      `oracleMismatch=${oracleMismatch.length === 0 ? "(none)" : oracleMismatch.join(",")}\n`,
  );
  if (!jsonOut) process.stdout.write(`${JSON.stringify(report)}\n`);
}

main().catch((error) => {
  process.stderr.write(`[cold-tail] ${error?.stack ?? error}\n`);
  process.exit(1);
});
