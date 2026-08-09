#!/usr/bin/env node

import { createReadStream, existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

// (#2871 follow-up) Per-file ES-edition index written by
// scripts/generate-editions.ts. Read here so every standalone root-cause bucket
// carries a per-edition count breakdown — without it the report page's edition
// slider has nothing to filter the standalone view by (it ships no per-file
// JSONL, so the page cannot classify those failures itself).
// Resolved against the repo, not the cwd: CI runs this from several working
// directories, and a silently-missing index would just drop the breakdown.
const DEFAULT_FILE_EDITIONS = join(
  REPO_ROOT,
  "website",
  "public",
  "benchmarks",
  "results",
  "test262-file-editions.json",
);

function parseArgs(argv) {
  const args = {
    input: "",
    output: "",
    includeProposals: false,
    baselineSha: "",
    baselineGeneratedAt: "",
    target: "",
    maxUnclassifiedRootCauses: undefined,
    fileEditions: DEFAULT_FILE_EDITIONS,
  };

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--input") {
      args.input = argv[++i] || "";
    } else if (arg === "--output") {
      args.output = argv[++i] || "";
    } else if (arg === "--include-proposals") {
      args.includeProposals = true;
    } else if (arg === "--baseline-sha") {
      args.baselineSha = argv[++i] || "";
    } else if (arg === "--baseline-generated-at") {
      args.baselineGeneratedAt = argv[++i] || "";
    } else if (arg === "--target") {
      args.target = argv[++i] || "";
    } else if (arg === "--file-editions") {
      args.fileEditions = argv[++i] || "";
    } else if (arg === "--max-unclassified-root-causes") {
      const raw = argv[++i] || "";
      const parsed = Number.parseInt(raw, 10);
      if (!Number.isFinite(parsed) || parsed < 0) {
        console.error(`Invalid --max-unclassified-root-causes value: ${raw}`);
        process.exit(1);
      }
      args.maxUnclassifiedRootCauses = parsed;
    }
  }

  if (!args.input || !args.output) {
    console.error(
      "Usage: node scripts/build-test262-report.mjs --input <results.jsonl> --output <report.json> [--include-proposals] [--target standalone] [--file-editions <file-editions.json>] [--max-unclassified-root-causes N]",
    );
    process.exit(1);
  }

  return args;
}

function createCounts() {
  return {
    pass: 0,
    fail: 0,
    compile_error: 0,
    compile_timeout: 0,
    skip: 0,
    total: 0,
    // Kept for the standalone high-water compatibility contract. Under the
    // v4 oracle every standalone `pass` is host-free, so this equals `pass`.
    // The gc/js-host lane still computes it as informational metadata.
    host_free_pass: 0,
  };
}

function buildSummary(counter, target) {
  const hostFreePass = counter.host_free_pass ?? 0;
  return {
    total: counter.total,
    pass: counter.pass,
    fail: counter.fail,
    compile_error: counter.compile_error,
    compile_timeout: counter.compile_timeout,
    skip: counter.skip,
    compilable: counter.pass + counter.fail,
    host_free_pass: hostFreePass,
    // Raw host-satisfied passes have no standalone meaning and are omitted.
    ...(target === "standalone" ? {} : { leaky_pass: (counter.pass ?? 0) - hostFreePass }),
    stale: 0,
  };
}

function inferTarget(args) {
  if (args.target) return args.target;
  return `${args.input} ${args.output}`.includes("standalone") ? "standalone" : "gc";
}

function normalizeStandaloneVerdict(record, target) {
  if (target !== "standalone" || record.status !== "pass") return record;
  const imports = Array.isArray(record.imports) ? record.imports : [];
  if (imports.length === 0 && !record.host_import_leak_class) return record;

  const leaked = imports.length > 0 ? imports.join(", ") : record.host_import_leak_class;
  const error = `standalone target emitted host imports: ${leaked} (#2961)`;
  return {
    ...record,
    status: "compile_error",
    error,
    error_category: "host_import_leak",
    error_signature: `host_import_leak:${error}`,
  };
}

function textOf(record) {
  return [
    record.file,
    record.category,
    record.status,
    record.error,
    record.error_category,
    record.error_signature,
    record.host_import_leak_class,
    Array.isArray(record.imports) ? record.imports.join(" ") : "",
  ]
    .filter(Boolean)
    .join(" ")
    .toLowerCase();
}

function hasAny(text, patterns) {
  return patterns.some((pattern) => {
    if (typeof pattern === "string") return text.includes(pattern);
    return pattern.test(text);
  });
}

function pathHas(record, patterns) {
  const path = `${record.file ?? ""} ${record.category ?? ""}`.toLowerCase();
  return hasAny(path, patterns);
}

function isSameValueValidatorFailure(record, text) {
  const isWasmValidatorFailure =
    record.error_category === "wasm_compile" || hasAny(text, ["invalid wasm binary", "compiling function"]);
  if (!isWasmValidatorFailure) return false;

  return hasAny(text, [
    /compiling function [^"\n]*"issamevalue" failed/,
    /(^|[^a-z0-9_])issamevalue([^a-z0-9_]|$).*expected type/,
    /(^|[^a-z0-9_])issamevalue([^a-z0-9_]|$).*type mismatch/,
  ]);
}

function isStandaloneRegExpRecord(record, text) {
  return (
    record.host_import_leak_class === "regexp" ||
    pathHas(record, ["built-ins/regexp", "regexpstringiteratorprototype"]) ||
    hasAny(text, ["regexp", "regular expression"])
  );
}

function isObjectToPrimitiveResidual(record, text) {
  if (!hasAny(text, ["toprimitive", "to primitive", "valueof", "tostring", "symbol.toprimitive"])) {
    return false;
  }

  return !pathHas(record, [
    "built-ins/array/",
    "built-ins/arraybuffer",
    "built-ins/bigint",
    "built-ins/dataview",
    "built-ins/date",
    "built-ins/decodeuri",
    "built-ins/decodeuricomponent",
    "built-ins/encodeuri",
    "built-ins/encodeuricomponent",
    "built-ins/function",
    "built-ins/math",
    "built-ins/number",
    "built-ins/object",
    "built-ins/regexp",
    "built-ins/string",
    "built-ins/symbol",
    "built-ins/typedarray",
    "language/expressions/arrow-function",
    "language/expressions/tagged-template",
    "language/function",
    "language/literals/string",
    "parsefloat",
    "parseint",
    "regexpstringiteratorprototype",
    "stringiteratorprototype",
    "tagged-template",
    "template",
    "typedarrayconstructors",
  ]);
}

const STANDALONE_ROOT_CAUSE_BUCKETS = [
  {
    // #3086 — honest-vacuity reclassification. A would-be pass whose harness
    // wrapper or nested callback never executed (so no assertion ran) is scored
    // `fail` + `vacuous: true` by the runner's vacuity gate (#2940/#3086,
    // implemented by PR #2463 — a PR number, so it is deliberately NOT in the
    // `issues` list below: those render as links to plan/issues/<id>.md).
    // These are a KNOWN, deliberate honest-metric reclassification, not a
    // codegen root cause — so they get their own bucket rather than falling into
    // `unclassified` (which the strict threshold-0 gate would then trip). Placed
    // FIRST because `vacuous: true` is unambiguous: a vacuity-fail's root cause
    // IS the dropped callback, never the feature the dead assertion targeted, so
    // no feature-path bucket should poach it.
    id: "honest-vacuity-reclassification",
    issues: ["#3086", "#2940"],
    label:
      "Honest-vacuity reclassification (harness/nested callback never executed → no assertion ran; scored vacuous fail, excluded from host_free_pass)",
    match: (record, text) => record.vacuous === true || hasAny(text, ["vacuous:", "no assertion ran"]),
  },
  {
    id: "binary-emit-u32-out-of-range",
    issues: ["#1858", "#1862"],
    label: "Binary emit u32 out of range (negative index/count emitted as u32) — instanceof / Error.isError fail-loud",
    match: (_record, text) => hasAny(text, ["u32 out of range", "binary emit error: u32"]),
  },
  {
    id: "late-import-index-shift",
    issues: ["#2079", "#2043"],
    label:
      "Late-import index-shift fail-loud CE (stale captured index across flushLateImportShifts) — standalone generators, class globals",
    match: (_record, text) => hasAny(text, ["late-import index-shift class"]),
  },
  {
    id: "leaked-host-import",
    issues: ["#2094", "#2073", "#2075"],
    label:
      "Leaked host import in standalone binary — emit-time scan CE (#2094): a host import bypassed the addImport gate (stale funcMap index / direct push). Was a silent instantiation failure (#2073/#2075); now a structured CE.",
    match: (_record, text) => hasAny(text, ["leaked host import"]),
  },
  {
    id: "numeric-separator-literal-values",
    issues: ["#1782", "#53"],
    label: "Numeric and BigInt separator literals evaluate to wrong values",
    match: (record, text) =>
      hasAny(text, ["numericseparator", "numeric-separator", "numeric separator", "bigint separator"]),
  },
  {
    id: "import-proposal-syntax",
    issues: ["#1315", "#1435"],
    label: "import.defer / import.source proposal syntax and early errors",
    match: (record, text) =>
      pathHas(record, ["import-defer", "import-source", "source-phase", "defer-import"]) ||
      hasAny(text, ["import.defer", "import.source", "source phase"]),
  },
  {
    id: "temporal-proposal",
    issues: ["#661"],
    label: "Temporal proposal/polyfill gap",
    match: (record) => pathHas(record, ["built-ins/temporal"]),
  },
  {
    id: "disposable-stack",
    issues: ["#1036", "#990"],
    label: "DisposableStack / explicit resource management",
    match: (record) => pathHas(record, ["disposablestack", "asyncdisposablestack", "explicit-resource-management"]),
  },
  {
    id: "dynamic-import",
    issues: ["#1089", "#1512"],
    label: "Dynamic import unsupported / early errors",
    match: (record, text) =>
      pathHas(record, ["dynamic-import"]) || hasAny(text, ["__dynamic_import", "dynamic import"]),
  },
  {
    id: "with-statement",
    issues: ["#1387"],
    label: "`with` statement dynamic-scope lowering residuals",
    match: (record, text) =>
      pathHas(record, ["language/statements/with"]) || hasAny(text, ["with statement", "with-scope"]),
  },
  {
    id: "standalone-json-codec",
    issues: ["#1599"],
    label: "Standalone JSON parser/stringifier",
    match: (record, text) =>
      record.host_import_leak_class === "json" ||
      pathHas(record, ["built-ins/json"]) ||
      hasAny(text, ["json_parse", "json_stringify"]),
  },
  {
    id: "standalone-regexp-phase-2d",
    issues: ["#1911", "#1909", "#1539"],
    label: "Standalone RegExp Phase 2d: u/v/d flags, Unicode escapes, lookaround, modifiers",
    match: (record, text) =>
      isStandaloneRegExpRecord(record, text) &&
      (pathHas(record, [
        "built-ins/regexp/lookbehind",
        "built-ins/regexp/property-escapes",
        "built-ins/regexp/unicodesets",
        "built-ins/regexp/regexp-modifiers",
      ]) ||
        hasAny(text, [
          /flags "[uvd]"/,
          "u/v/d are",
          "phase 2d",
          "lookahead",
          "lookbehind",
          "unicode property escape",
          "code-point escape",
          "unicode sets",
          "unsupported group form '(?-",
          "unsupported group form '(?i",
          "unsupported group form '(?m",
          "unsupported group form '(?s",
        ])),
  },
  {
    id: "standalone-regexp-phase-2b",
    issues: ["#1912", "#1909", "#1539"],
    label: "Standalone RegExp Phase 2b: word boundaries, backrefs, and character-class compatibility",
    match: (record, text) =>
      isStandaloneRegExpRecord(record, text) &&
      hasAny(text, [
        "word-boundary",
        "backreference",
        "named backreference",
        "negated shorthand",
        "class range out of order",
        "class shorthand as range endpoint",
      ]),
  },
  {
    id: "standalone-regexp-string-protocol",
    issues: ["#1913", "#1909", "#1539"],
    label: "Standalone RegExp string protocol, global/sticky lastIndex, split, replace, and matchAll",
    match: (record, text) =>
      isStandaloneRegExpRecord(record, text) &&
      (pathHas(record, [
        "built-ins/regexp/prototype/symbol.",
        "built-ins/regexpstringiteratorprototype",
        "built-ins/string/prototype/match",
        "built-ins/string/prototype/matchall",
        "built-ins/string/prototype/replace",
        "built-ins/string/prototype/split",
      ]) ||
        hasAny(text, [
          "@@match",
          "@@matchall",
          "@@replace",
          "@@search",
          "@@split",
          "symbol protocol",
          "matchall",
          "regexpstringiterator",
          "lastindex",
          "all-match",
          "split(regexp, limit)",
          "split with capturing",
          "split with empty-match",
          "$-substitution",
          "function replacer",
        ])),
  },
  {
    id: "standalone-regexp-native-engine",
    issues: ["#1914", "#1909", "#682"],
    label: "Standalone RegExp native-engine/runtime gaps: source, constructors, prototype access, result shape",
    match: (record, text) =>
      isStandaloneRegExpRecord(record, text) &&
      (["assertion_fail", "runtime_error", "null_deref", "wasm_compile", "illegal_cast", "oob"].includes(
        record.error_category,
      ) ||
        hasAny(text, [
          "__get_builtin",
          "dynamic constructor patterns",
          "pattern.source",
          "__executed.input",
          "__executed.index",
          "source",
          "flags accessor",
          "regexp.prototype",
        ])),
  },
  {
    id: "standalone-regexp",
    issues: ["#1909", "#1911", "#1912", "#1913", "#1914"],
    label: "Residual standalone RegExp failures not matched by the narrower RegExp sub-buckets",
    match: isStandaloneRegExpRecord,
  },
  {
    id: "issamevalue-invalid-wasm",
    issues: ["#1908", "#1776", "#1807"],
    label: "Residual standalone isSameValue invalid-Wasm validator failures",
    match: (record, text) => isSameValueValidatorFailure(record, text),
  },
  {
    id: "standalone-dynamic-object-property",
    issues: ["#1472"],
    label: "Standalone dynamic object/property operation gate",
    match: (record, text) =>
      record.host_import_leak_class === "dynamic_object_property" ||
      pathHas(record, ["built-ins/proxy"]) ||
      hasAny(text, [
        "__extern_",
        "__object_",
        "__defineproperty",
        "__get_builtin",
        "__new_plain_object",
        "__proxy_",
        "__register_",
        "__proto_method_call",
        "proxy not supported in standalone mode",
        "dynamic object",
        "no dependency provided for imported function",
      ]),
  },
  {
    id: "standalone-reflect-refusal",
    issues: ["#1472"],
    label: "Reflect.* refused in standalone mode (#1472 Phase C)",
    match: (record, text) =>
      pathHas(record, ["built-ins/reflect"]) ||
      hasAny(text, ["not supported in standalone mode (#1472 phase c)", "reflect."]),
  },
  {
    id: "standalone-iterator-protocol",
    issues: ["#1665", "#681", "#1718"],
    label: "Generic iterator protocol still needs a pure-Wasm standalone path",
    match: (record, text) =>
      record.host_import_leak_class === "iterator_protocol" ||
      pathHas(record, [
        "built-ins/iterator",
        "iteratorprototype",
        "arrayiteratorprototype",
        "stringiteratorprototype",
        "mapiteratorprototype",
        "setiteratorprototype",
        "language/statements/for-of",
      ]) ||
      hasAny(text, ["iterator", "__iterator", "__array_from_iter"]),
  },
  {
    id: "generator-async-iteration",
    issues: ["#680", "#1665"],
    label: "Generators and async iteration",
    match: (record, text) =>
      pathHas(record, ["generator", "asyncgenerator", "for-await"]) || hasAny(text, ["generator", "async iterator"]),
  },
  {
    id: "class-element-private-descriptor",
    issues: ["#1591", "#1365", "#1364"],
    label: "Class element, private-name, and descriptor reconciliation gaps",
    // (2026-08-04) The free-text arm used to carry a bare "prototype" token.
    // `textOf(record)` INCLUDES `record.file`, so that token matched every
    // `built-ins/*/prototype/*` path and this bucket swallowed the entire
    // builtin-prototype corpus. Measured on the ES5+untagged standalone scope
    // before the fix: 1,662 files matched, of which only 66 came from the
    // intended path arm — 1,589 matched on the "prototype" token alone, and
    // 1,130 of those had NO such token anywhere in the error text at all. It
    // was a path match wearing a free-text disguise, and it sits at position 22
    // of ~59, so it stole from every later bucket (`object-property-semantics`,
    // `array-typedarray-buffer`, `function-object-semantics`, …).
    //
    // Keep free-text tokens that name a MECHANISM ("private", "class element").
    // Never add a token that also occurs in a file path — put those in the path
    // arm, where the intent is explicit and reviewable.
    match: (record, text) =>
      pathHas(record, [
        "language/classes",
        "language/statements/class",
        "language/expressions/class",
        "/class/",
        "private",
        "computed-property-names",
        "built-ins/object/getownpropertydescriptor",
      ]) || hasAny(text, ["private", "class element", "getownpropertydescriptor"]),
  },
  {
    id: "object-to-primitive",
    issues: ["#1910", "#1525b", "#1900", "#1472"],
    label: "ToPrimitive / object-to-string dispatch residuals",
    match: isObjectToPrimitiveResidual,
  },
  {
    id: "array-typedarray-buffer",
    issues: ["#1358", "#1461", "#1654"],
    label: "Array, TypedArray, DataView, and buffer semantics",
    match: (record) =>
      pathHas(record, [
        "built-ins/array/",
        "built-ins/arraybuffer",
        "built-ins/dataview",
        "built-ins/typedarray",
        "typedarrayconstructors",
        "uint8array",
        "int8array",
        "float32array",
        "float64array",
      ]),
  },
  {
    id: "template-literals",
    issues: ["#1759", "#836"],
    label: "Template literal and tagged-template semantics",
    match: (record) => pathHas(record, ["template", "tagged-template"]),
  },
  {
    id: "object-property-semantics",
    issues: ["#1472", "#176", "#281", "#1466"],
    label: "Object/property/destructuring semantic mismatches behind the object model",
    match: (record, text) =>
      pathHas(record, ["built-ins/object", "language/destructuring", "language/expressions/object/dstr", "object-"]) ||
      hasAny(text, ["object.", "destructuring", "property"]),
  },
  {
    id: "string-methods-coercion",
    issues: ["#1470", "#1105", "#1442", "#1381"],
    label: "String and URI methods/coercion residuals in standalone",
    match: (record) =>
      pathHas(record, [
        "built-ins/decodeuri",
        "built-ins/decodeuricomponent",
        "built-ins/encodeuri",
        "built-ins/encodeuricomponent",
        "built-ins/string",
        "language/literals/string",
        "stringiteratorprototype",
      ]),
  },
  {
    id: "annex-b-function-eval",
    issues: ["#1594", "#1050"],
    label: "Annex B function/eval semantics",
    match: (record) => pathHas(record, ["annexb"]),
  },
  {
    id: "date-formatting-coercion",
    issues: ["#1343"],
    label: "Date prototype formatting/coercion",
    match: (record) => pathHas(record, ["built-ins/date"]),
  },
  {
    id: "number-parsing-formatting",
    issues: ["#1335", "#1663", "#1689"],
    label: "Number parsing, formatting, and coercion",
    match: (record, text) =>
      pathHas(record, ["built-ins/number", "parseint", "parsefloat"]) ||
      hasAny(text, ["parseint", "parsefloat", "number."]),
  },
  {
    id: "math-descriptors-coercion",
    issues: ["#1732", "#562", "#160"],
    label: "Math method descriptors and coercion edge cases",
    match: (record) => pathHas(record, ["built-ins/math"]),
  },
  {
    id: "function-object-semantics",
    issues: ["#731", "#1732", "#1596"],
    label: "Function object name/length/prototype/call semantics",
    match: (record) =>
      pathHas(record, ["built-ins/function", "language/function", "language/expressions/arrow-function"]),
  },
  {
    id: "symbol-builtin-semantics",
    issues: ["#483", "#487", "#1564"],
    label: "Symbol built-in semantics (keyFor/for arg validation, well-known symbols, registry)",
    // Standalone Symbol built-ins lower their argument-type checks to internal
    // traps (e.g. `Symbol.keyFor(null)` traps with "null is not a symbol")
    // instead of throwing a proper TypeError, so test262's `assert.throws`
    // assertion fails. The path-based match keeps this scoped to genuine
    // built-ins/Symbol tests and does not poach the `bigint`/`toprimitive`
    // text-matched buckets that run earlier in this list.
    match: (record) => pathHas(record, ["built-ins/symbol"]),
  },
  {
    id: "assignment-private-short-circuit",
    issues: ["#334", "#1456", "#540"],
    label: "Assignment targets, private refs, and short-circuit semantics",
    match: (record) =>
      pathHas(record, ["language/expressions/assignment", "language/expressions/logical", "short-circuit"]),
  },
  {
    id: "map-set-weak-collections",
    issues: ["#1103"],
    label: "Wasm-native Map/Set/Weak collection semantics",
    match: (record) => pathHas(record, ["built-ins/map", "built-ins/set", "built-ins/weakmap", "built-ins/weakset"]),
  },
  {
    id: "eval-new-function",
    issues: ["#1066", "#1073", "#990"],
    label: "Eval and `new Function` semantics",
    match: (record, text) =>
      pathHas(record, ["eval-code", "built-ins/eval", "function-constructor"]) ||
      hasAny(text, ["__extern_eval", "new function", "eval"]),
  },
  {
    id: "arguments-object",
    issues: ["#1511", "#1726"],
    label: "Arguments object fidelity",
    match: (record) => pathHas(record, ["arguments-object", "mapped-arguments", "unmapped-arguments"]),
  },
  {
    id: "bigint-typed-path",
    issues: ["#1644", "#1535"],
    label: "Standalone BigInt host/typed-path residual",
    match: (record, text) => pathHas(record, ["built-ins/bigint", "bigint"]) || hasAny(text, ["bigint"]),
  },
  {
    id: "lexical-scope-tdz-declarations",
    issues: ["#1128", "#990", "#1726"],
    label: "Lexical scope, TDZ, and declaration semantics",
    match: (record, text) =>
      pathHas(record, [
        "block-scope",
        "identifier-resolution",
        "scope",
        "let",
        "const",
        "built-ins/global",
        "language/global-code",
      ]) || hasAny(text, ["tdz", "referenceerror"]),
  },
  {
    id: "promise-async",
    issues: ["#1326c", "#1116", "#1694"],
    label: "Promise and async standalone semantics",
    match: (record, text) =>
      pathHas(record, ["built-ins/promise", "asyncfunction", "async-function"]) || hasAny(text, ["promise", "async"]),
  },
  {
    id: "module-semantics",
    issues: ["#1046", "#1527"],
    label: "Module semantics and harness export shape",
    match: (record) => pathHas(record, ["module-code", "language/import", "language/export"]),
  },
  {
    id: "tail-call-control-flow",
    issues: ["#602", "#787"],
    label: "Tail-call/control-flow loop semantics, including compile timeouts",
    match: (record, text) =>
      record.status === "compile_timeout" ||
      pathHas(record, ["tail-call", "language/statements", "control-flow"]) ||
      hasAny(text, ["completion value"]),
  },
  {
    id: "syntax-reference-errors",
    issues: ["#927", "#1435", "#990"],
    label: "Missing parse/early/runtime SyntaxError or ReferenceError",
    match: (record, text) =>
      record.error_category === "syntax_error" ||
      pathHas(record, [
        "language/asi",
        "language/directive-prologue",
        "language/comments",
        "line-terminators",
        "reserved-words",
      ]) ||
      hasAny(text, [
        "syntaxerror",
        "referenceerror",
        "early error",
        "hashbang",
        "duplicate identifier",
        "a class may only have one constructor",
        "class constructor may not",
      ]),
  },
  {
    id: "unicode-identifiers",
    issues: ["#832", "#270"],
    label: "Unicode/reserved-word identifier handling",
    match: (record, text) =>
      pathHas(record, ["unicode", "identifier", "reserved"]) || hasAny(text, ["unicode", "reserved word"]),
  },
  {
    id: "completion-control-flow",
    issues: ["#787", "#1378"],
    label: "Completion values and control-flow semantics",
    match: (record) => pathHas(record, ["break", "continue", "return", "switch", "try", "throw"]),
  },
  {
    id: "extern-class-metadata",
    issues: ["#812", "#1559"],
    label: "Extern class dependency metadata",
    match: (record, text) => hasAny(text, ["extern class", "dependency metadata", "extern_class"]),
  },
  {
    id: "super-spread-receiver",
    issues: ["#843", "#1551"],
    label: "`super`, spread, and receiver-evaluation semantics",
    match: (record) => pathHas(record, ["super", "spread", "optional-chaining", "new-target"]),
  },
  {
    id: "sharedarraybuffer-atomics",
    issues: ["#674", "#1354"],
    label: "SharedArrayBuffer / Atomics backlog",
    match: (record) => pathHas(record, ["sharedarraybuffer", "atomics"]),
  },
  {
    id: "new-spread-optional-chain",
    issues: ["#1519", "#1609", "#1603"],
    label: "`new`, spread, and optional-chaining semantics",
    match: (record) => pathHas(record, ["language/expressions/new", "optional-chaining", "spread"]),
  },
  {
    id: "function-bind-descriptors",
    issues: ["#1038", "#1732"],
    label: "Function.prototype.bind / function-object descriptors",
    match: (record) => pathHas(record, ["function/prototype/bind", "bind/"]),
  },
  {
    id: "illegal-cast-boundary",
    issues: ["#826", "#1623"],
    label: "Illegal-cast/type-boundary residual",
    match: (record, text) => hasAny(text, ["illegal cast", "ref.cast", "cast failure"]),
  },
  {
    id: "null-undefined-typeerror",
    issues: ["#820"],
    label: "Null/undefined TypeError lowering residual",
    match: (record, text) => hasAny(text, ["null/undefined", "dereferencing a null", "undefined access"]),
  },
  {
    id: "invalid-wasm-boundaries",
    issues: ["#1623", "#1666", "#1525b"],
    label: "Invalid Wasm at type/coercion boundaries, late globals, and trampolines",
    match: (record, text) =>
      record.error_category === "wasm_compile" ||
      hasAny(text, [
        "invalid wasm",
        "compiling function",
        "type mismatch",
        "not a subtype",
        "trampoline",
        "late global",
        "wasm_compile",
      ]),
  },
  {
    id: "standalone-getter-callback-bridge",
    issues: ["#929", "#1027", "#1239"],
    label:
      "Standalone object-literal / defineProperty accessor needs the `__make_getter_callback` JS-host bridge (this-bound getter/setter); no pure-Wasm path yet, so the strict gate fails the build. Surfaced as a structured CE by #1921 (was a dropped-import / leaked-import failure).",
    match: (_record, text) => hasAny(text, ["__make_getter_callback", "make_getter_callback import"]),
  },
  {
    // #2962 — the standalone exception renderer (`__exn_render_prepare`/
    // `__exn_render_char` + native §20.5.3.4 Error toString) de-masked real
    // assertion texts that previously collapsed into the #2870 opaque label.
    // A "Test262Error: …" signature is a REAL assertion mismatch whose root
    // cause lives in whatever feature the assert exercised — path-based
    // buckets above claim the recognizable ones; this bucket owns the
    // de-masked residual so the strict unclassified gate stays at 0 while the
    // per-feature re-triage (#2962 follow-up harvest) splits it further.
    id: "demasked-native-assertion",
    issues: ["#2962"],
    label:
      "De-masked native assertion failure (Test262Error rendered by the #2962 standalone exception renderer) — real assertion mismatch, re-triage by feature path",
    match: (_record, text) => hasAny(text, ["test262error"]),
  },
  {
    // The runner's retry paths (poison retry, #1589 compile_timeout retry —
    // tests/test262-shared.ts) record the fixed string "fail after retry"
    // when the retried attempt ends in `fail` but the worker returned NO
    // error text. The original attempt's message is lost, so the signature
    // carries zero feature signal and no path/text bucket above can claim
    // it (e.g. built-ins/Error/isError/non-error-objects-other-realm.js,
    // the single unclassified record that parked PR #2846's merge_group).
    // Root cause is runner-side message loss on retry, not a new codegen
    // failure class — the same test fails with a classifiable assertion
    // signature when it doesn't go through the retry path.
    id: "retry-lost-error-text",
    issues: ["#1589"],
    label:
      'Runner retry lost the failure message ("fail after retry": retried attempt failed with empty worker error text) — no feature signal to classify; fix is runner-side message preservation',
    match: (_record, text) => hasAny(text, ["fail after retry"]),
  },
  {
    id: "misc-spec-tail",
    issues: ["#1577", "#779"],
    label: "Miscellaneous low-volume spec-completeness tail",
    match: (record, text) =>
      hasAny(text, [
        "assertion_fail",
        "exception_in_test",
        "returned #",
        "runtime_error",
        "range_error",
        "rangeerror",
        "maximum call stack",
        "typeerror",
      ]),
  },
  {
    // #2870 — the de-masked exception formatter falls back to this stable label
    // when a standalone test throws a Wasm-GC error struct whose payload has no
    // host-reachable `toString` (so `String(payload)` would itself throw). Most
    // such failures are classified by their feature path in an earlier bucket
    // (Temporal, DataView, Object, destructuring, …); this LAST bucket is the
    // honest residual catch for the ones no feature-path bucket matches. It MUST
    // stay at the end of the list so `find`'s first-match never poaches a record
    // that a path-based bucket already owns. The underlying failures are
    // heterogeneous real in-Wasm throws/traps whose only common property is a
    // non-stringifiable payload — re-triaged into actual fixable sub-clusters by
    // the #2862 follow-up.
    id: "nonstringifiable-wasmgc-exception",
    issues: ["#2870", "#2862"],
    label:
      "Standalone failure threw a non-stringifiable Wasm-GC exception payload (de-masked formatter fallback) — residual not matched by a feature-path bucket",
    match: (_record, text) =>
      hasAny(text, ["uncaught wasm-gc exception (non-stringifiable payload)", "non-stringifiable payload"]),
  },
  {
    // #2961 — standalone host-import honesty reclassification. A legacy
    // "leaky pass" (the compiled binary emits `env::__*` host imports, but the
    // JS test262 harness satisfied them so the row read `pass`) is now scored
    // `compile_error` at both the worker (scripts/test262-worker.mjs) and the
    // report builder (`normalizeStandaloneVerdict`, defense-in-depth for
    // legacy JSONL). The overwhelming majority of these rows are ALREADY
    // classified by an earlier feature-path bucket above (e.g. a leaked
    // `env::__temporal_*` import on a Temporal test still lands in
    // `temporal-proposal` via its file path) — that's intentional and this
    // bucket must stay LAST so `find`'s first-match never poaches those. This
    // is the honest residual catch for imports with no dedicated feature
    // bucket (`instanceof`, `AggregateError`, `SuppressedError`,
    // `Error.isError`, …): the root cause of the FAILURE is the reclassification
    // policy itself, not a per-feature codegen gap, so — unlike the other
    // residual buckets above — a match here is not evidence of unclassified
    // compiler behavior; it correctly satisfies the merge_group
    // `--max-unclassified-root-causes 0` gate for the #2961 policy change.
    id: "standalone-host-import-leak-reclassification",
    issues: ["#2961"],
    label:
      "Standalone host-import honesty reclassification (#2961): legacy leaky-pass row (host-satisfied `env::` import) now scored compile_error — residual not matched by a feature-path bucket",
    match: (record, text) =>
      record.error_category === "host_import_leak" || hasAny(text, ["standalone target emitted host imports"]),
  },
];

function emptyRootCauseBucket(bucket) {
  return {
    id: bucket.id,
    issues: bucket.issues,
    label: bucket.label,
    count: 0,
    statuses: createCounts(),
    error_categories: {},
    // (#2871 follow-up) failures in this bucket per ES edition, e.g.
    // { ES5: 12, ES2015: 40 }. Empty when no per-file edition index was
    // readable; the report page then falls back to showing bucket totals.
    by_edition: {},
    sample_files: [],
    sample_signatures: [],
  };
}

// (#2871 follow-up) Load the per-file edition index as a Map of
// "language/…/x.js" → "ES5". Returns null (and warns) when it isn't present:
// the map is committed by the edition-bucket refresh, so a fresh checkout that
// has not promoted yet simply gets no edition breakdown rather than a failure.
function loadFileEditions(path) {
  if (!path || !existsSync(path)) {
    console.warn(`No per-file edition index at ${path || "(unset)"} — standalone buckets get no edition breakdown.`);
    return null;
  }
  try {
    const raw = JSON.parse(readFileSync(path, "utf8"));
    if (!raw || !Array.isArray(raw.editions) || !raw.files) return null;
    const map = new Map();
    for (const [file, idx] of Object.entries(raw.files)) {
      const label = raw.editions[idx];
      if (label) map.set(file, label);
    }
    return map;
  } catch (err) {
    console.warn(`Could not read per-file edition index at ${path}: ${err.message}`);
    return null;
  }
}

function addSample(samples, value, limit = 5) {
  if (!value || samples.includes(value) || samples.length >= limit) return;
  samples.push(value);
}

function recordRootCauseHit(target, record, fileEditions) {
  target.count++;
  target.statuses.total++;
  target.statuses[record.status] = (target.statuses[record.status] ?? 0) + 1;
  if (record.error_category) {
    target.error_categories[record.error_category] = (target.error_categories[record.error_category] ?? 0) + 1;
  }
  if (fileEditions) {
    const edition = fileEditions.get(String(record.file || "").replace(/^test\//, ""));
    if (edition) target.by_edition[edition] = (target.by_edition[edition] ?? 0) + 1;
  }
  addSample(target.sample_files, record.file);
  addSample(target.sample_signatures, record.error_signature ?? record.error);
}

function buildStandaloneRootCauseMap(records, maxUnclassified, fileEditions) {
  const buckets = STANDALONE_ROOT_CAUSE_BUCKETS.map(emptyRootCauseBucket);
  const byId = new Map(buckets.map((bucket) => [bucket.id, bucket]));
  const unclassified = {
    id: "unclassified",
    issues: [],
    label: "Unclassified standalone failures",
    count: 0,
    statuses: createCounts(),
    error_categories: {},
    by_edition: {},
    sample_files: [],
    sample_signatures: [],
  };

  for (const record of records) {
    const text = textOf(record);
    const bucketDef = STANDALONE_ROOT_CAUSE_BUCKETS.find((bucket) => bucket.match(record, text));
    if (bucketDef) {
      recordRootCauseHit(byId.get(bucketDef.id), record, fileEditions);
    } else {
      recordRootCauseHit(unclassified, record, fileEditions);
    }
  }

  const classifiedByEdition = fileEditions !== null;
  return {
    target: "standalone",
    total_non_pass_non_skip: records.length,
    classified: records.length - unclassified.count,
    unclassified_threshold: maxUnclassified ?? null,
    // Tells the report page whether `by_edition` is trustworthy — an empty
    // breakdown on a bucket means "no failures in that edition", but only if
    // the index was actually read.
    has_edition_breakdown: classifiedByEdition,
    buckets: buckets.filter((bucket) => bucket.count > 0),
    unclassified,
  };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const target = inferTarget(args);

  const statuses = createCounts();
  const officialStatuses = createCounts();
  const strictCounts = createCounts();
  const categories = new Map();
  const errorCategories = new Map();
  const skipReasons = new Map();
  // #1853 — hard-error stability bucket (malformed_wasm / missing_test_export),
  // aggregated separately from coverage so it can be gated as a regression.
  const hardErrors = new Map();
  const scopeCounts = new Map([
    ["standard", createCounts()],
    ["annex_b", createCounts()],
    ["proposal", createCounts()],
  ]);
  const rootCauseRecords = [];
  // #2096: capture the oracle_version stamped on the result rows so the
  // merged report carries the same identity. If rows disagree (a merge of
  // shards produced under different oracles) we keep the LOWEST seen and flag
  // it as mixed — a mixed report should never be promoted to a baseline.
  let oracleVersion;
  let oracleVersionMixed = false;

  // (#2913) Dedup duplicate result rows by `file` BEFORE counting. The merged
  // JSONL can carry >1 row per test (the poison/flake retry path recording both
  // the original and the retry, or a shard artifact concatenated twice), and the
  // counters below run per-record — so a duplicated file double-counts into both
  // numerator and denominator and, when the two rows disagree (e.g.
  // compile_error vs fail), makes the headline pass rate non-deterministic.
  // Keep exactly one row per file using a deterministic WORST-status precedence
  // (compile_error > fail > timeout/crash > pass > skip), so the report is stable
  // regardless of retry timing / row order.
  const STATUS_PRECEDENCE = {
    compile_error: 6,
    fail: 5,
    timeout: 4,
    crash: 4,
    pass: 3,
    skip: 2,
  };
  const statusRank = (s) => STATUS_PRECEDENCE[s] ?? 1;
  const recordsByFile = new Map();
  let dedupDropped = 0;

  const rl = createInterface({
    input: createReadStream(args.input),
    crlfDelay: Infinity,
  });

  for await (const line of rl) {
    if (!line.trim()) continue;
    const record = JSON.parse(line);
    if (typeof record.oracle_version === "number") {
      if (oracleVersion === undefined) {
        oracleVersion = record.oracle_version;
      } else if (oracleVersion !== record.oracle_version) {
        oracleVersionMixed = true;
        oracleVersion = Math.min(oracleVersion, record.oracle_version);
      }
    }
    // Dedup rows that carry a `file` key (every test row does). A row without a
    // file is unexpected here but is passed through uncounted-dedup as its own
    // key so nothing is silently dropped.
    const dedupKey = record.file ?? `__nofile_${recordsByFile.size}`;
    const prior = recordsByFile.get(dedupKey);
    if (prior === undefined) {
      recordsByFile.set(dedupKey, record);
    } else {
      dedupDropped++;
      // Worst-status wins; on a tie keep the later row (last-write-wins) for
      // determinism against a fixed input ordering.
      if (statusRank(record.status) >= statusRank(prior.status)) {
        recordsByFile.set(dedupKey, record);
      }
    }
  }

  if (dedupDropped > 0) {
    console.warn(
      `[build-test262-report] #2913: dropped ${dedupDropped} duplicate result row(s); counting ${recordsByFile.size} distinct file(s).`,
    );
  }

  for (const rawRecord of recordsByFile.values()) {
    // Defense in depth for old JSONL or alternate runners: a host-satisfied
    // result can never contribute a standalone pass, even if it arrived with
    // the legacy `status: "pass"` verdict.
    const record = normalizeStandaloneVerdict(rawRecord, target);
    const status = record.status;
    const scope = record.scope ?? "standard";
    const scopeOfficial = record.scope_official ?? scope !== "proposal";
    const strict = record.strict ?? "both";
    const category = record.category ?? "unknown";

    // (#2879) A pass is HOST-FREE iff it emitted no host runtime import. The
    // worker records `host_import_leak_class` exactly when an `env::__*` import
    // leaked (verified equivalent to "no env:: import"); its absence on a pass
    // means the module ran without the JS host. Counted in parallel to status
    // so the honest standalone metric is available per scope/category.
    const hostFreePass = status === "pass" && !record.host_import_leak_class;
    // (#2939/#2940) Vacuity correction: `fail` rows whose harness-wrapper
    // callback never executed (previously-counted-as-pass before the in-runner
    // vacuity gate). Tallied separately so the report surfaces the integrity
    // correction ("N previously-counted passes are vacuous") without inflating
    // the genuine-fail bucket's interpretation.
    const isVacuous = record.vacuous === true;

    statuses.total++;
    statuses[status] = (statuses[status] ?? 0) + 1;
    if (hostFreePass) statuses.host_free_pass = (statuses.host_free_pass ?? 0) + 1;
    if (isVacuous) statuses.vacuous = (statuses.vacuous ?? 0) + 1;

    if (!scopeCounts.has(scope)) scopeCounts.set(scope, createCounts());
    const scopeCounter = scopeCounts.get(scope);
    scopeCounter.total++;
    scopeCounter[status] = (scopeCounter[status] ?? 0) + 1;
    if (hostFreePass) scopeCounter.host_free_pass = (scopeCounter.host_free_pass ?? 0) + 1;

    if (scopeOfficial) {
      officialStatuses.total++;
      officialStatuses[status] = (officialStatuses[status] ?? 0) + 1;
      if (hostFreePass) officialStatuses.host_free_pass = (officialStatuses.host_free_pass ?? 0) + 1;
      if (strict !== "no") {
        strictCounts.total++;
        strictCounts[status] = (strictCounts[status] ?? 0) + 1;
        if (hostFreePass) strictCounts.host_free_pass = (strictCounts.host_free_pass ?? 0) + 1;
      }
    }

    if (!categories.has(category)) categories.set(category, createCounts());
    const categoryCounter = categories.get(category);
    categoryCounter.total++;
    categoryCounter[status] = (categoryCounter[status] ?? 0) + 1;
    if (hostFreePass) categoryCounter.host_free_pass = (categoryCounter.host_free_pass ?? 0) + 1;

    if (record.error_category) {
      errorCategories.set(record.error_category, (errorCategories.get(record.error_category) ?? 0) + 1);
    }
    // #1853 — count hard errors (malformed Wasm / missing test export) into the
    // stability bucket. `hard_error_kind` is set by the runner only where the
    // outcome is unambiguously a compiler bug, never for unsupported-feature.
    if (record.hard_error_kind) {
      hardErrors.set(record.hard_error_kind, (hardErrors.get(record.hard_error_kind) ?? 0) + 1);
    }
    if (status === "skip" && record.error) {
      skipReasons.set(record.error, (skipReasons.get(record.error) ?? 0) + 1);
    }
    if (target === "standalone" && status !== "pass" && status !== "skip") {
      rootCauseRecords.push(record);
    }
  }

  // #106 — split totals by ECMAScript-current-standard vs proposals.
  // The headline `summary` already tracks current-standard tests only
  // (~43k = standard + annex_b); proposals (~5k) are excluded and
  // surfaced separately via `full_summary` and `scope_summaries.proposal`.
  // Add a `summary.by_category` map so clients (statusline, landing-page
  // toggle) can read both numbers from a single field without reaching
  // into multiple top-level objects.
  const standardSummary = buildSummary(scopeCounts.get("standard") ?? createCounts(), target);
  const annexBSummary = buildSummary(scopeCounts.get("annex_b") ?? createCounts(), target);
  const proposalSummary = buildSummary(scopeCounts.get("proposal") ?? createCounts(), target);
  const officialSummaryBuilt = buildSummary(officialStatuses, target);
  const fullSummaryBuilt = buildSummary(statuses, target);

  const report = {
    timestamp: new Date().toISOString(),
    baseline_generated_at: args.baselineGeneratedAt || new Date().toISOString(),
    baseline_sha: args.baselineSha || "",
    // #2096: oracle identity for the merged report. Carried so diff-test262
    // can refuse cross-version comparisons. `oracle_version_mixed` flags a
    // report assembled from shards run under different oracles — never promote
    // such a report to a baseline.
    oracle_version: oracleVersion ?? null,
    ...(oracleVersionMixed ? { oracle_version_mixed: true } : {}),
    mode: {
      target,
      include_proposals: args.includeProposals ? 1 : 0,
      label: args.includeProposals ? "official test262 + proposals" : "official test262 (default scope)",
    },
    summary: {
      ...officialSummaryBuilt,
      by_category: {
        standard: { ...standardSummary, label: "ECMAScript current standard" },
        annex_b: { ...annexBSummary, label: "Annex B (legacy web compat)" },
        proposal: { ...proposalSummary, label: "TC39 proposals" },
        official: { ...officialSummaryBuilt, label: "standard + annex_b (default)" },
        full: { ...fullSummaryBuilt, label: "standard + annex_b + proposals" },
      },
    },
    official_summary: officialSummaryBuilt,
    full_summary: fullSummaryBuilt,
    strict_summary: buildSummary(strictCounts, target),
    scope_summaries: Object.fromEntries(
      [...scopeCounts.entries()]
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([name, counter]) => [name, buildSummary(counter, target)]),
    ),
    categories: [...categories.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([name, counter]) => ({
        // `name` retained for backward compatibility with existing
        // landing-page reader (`report.categories[i].name`); `path`
        // is the canonical field per the #1201 spec.
        name,
        path: name,
        ...counter,
      })),
    error_categories: Object.fromEntries([...errorCategories.entries()].sort(([a], [b]) => a.localeCompare(b))),
    // #1853 — hard-error stability bucket, surfaced separately from coverage and
    // gated by scripts/check-test262-hard-errors.mjs against a committed baseline.
    hard_errors: Object.fromEntries([...hardErrors.entries()].sort(([a], [b]) => a.localeCompare(b))),
    skip_reasons: Object.fromEntries([...skipReasons.entries()].sort(([a], [b]) => a.localeCompare(b))),
  };

  if (target === "standalone") {
    report.root_cause_map = buildStandaloneRootCauseMap(
      rootCauseRecords,
      args.maxUnclassifiedRootCauses,
      loadFileEditions(args.fileEditions),
    );
  }

  writeFileSync(args.output, JSON.stringify(report, null, 2));

  if (
    target === "standalone" &&
    args.maxUnclassifiedRootCauses !== undefined &&
    report.root_cause_map.unclassified.count > args.maxUnclassifiedRootCauses
  ) {
    console.error(
      `Standalone root-cause map has ${report.root_cause_map.unclassified.count} unclassified failures; threshold is ${args.maxUnclassifiedRootCauses}.`,
    );
    process.exitCode = 1;
  }

  // #1201 — also write a standalone categories file at
  // `<output-dir>/test262-categories.json` for clients that only need
  // the per-path breakdown (e.g. landing-page feature-row hydration,
  // the categorical table in report.html). Smaller than the full
  // report and avoids the indirection of "fetch report.json then read
  // .categories". Same schema as `report.categories`.
  const outputDir = args.output.replace(/[^/\\]+$/, "");
  const categoriesFile = target === "standalone" ? "test262-standalone-categories.json" : "test262-categories.json";
  const categoriesPath = outputDir + categoriesFile;
  const categoriesPayload = {
    timestamp: report.timestamp,
    baseline_generated_at: report.baseline_generated_at,
    baseline_sha: report.baseline_sha,
    mode: report.mode,
    categories: report.categories,
  };
  writeFileSync(categoriesPath, JSON.stringify(categoriesPayload, null, 2));
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
