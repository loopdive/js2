// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * The stand-in harness for the Prepared-path census ("behind the prelude").
 *
 * The real prelude (`test262-fyi-runtime.js` + `assert.js` + `sta.js`) stops
 * every file at its first gap, so a test body is never measured. The stand-in
 * replaces those three files with plain functions of untyped (dynamic)
 * parameters, and rewrites each use of the harness API to a call of one:
 * `assert.sameValue(` → `__assert_sameValue(`, `assert(` → `__assert(`,
 * `$ERROR(` → `__error(`. Metadata includes (`propertyHelper.js`, …) are kept,
 * rewritten the same way. A rewrite never adds or removes a line, so a gap's
 * line still says whether it lies in an include, the stand-in or the body.
 *
 * Only the stand-in functions the program names are emitted, so a mechanism
 * one of them needs (`__assert_throws` calls a function value) is charged
 * only to the files that use it. A file that names a harness function the
 * stand-in lacks (`assert.deepEqual`, `$DONE`, …) is marked `unmodelled`.
 */

const STAND_IN = {
  Test262Error: "function Test262Error(message) {}",
  __assert: "function __assert(value, message) { if (value !== true) throw 1; }",
  __assert_sameValue:
    "function __assert_sameValue(actual, expected, message) { if (actual === expected) { if (actual !== 0 || 1 / actual === 1 / expected) return; throw 1; } if (actual !== actual && expected !== expected) return; throw 1; }",
  __assert_notSameValue:
    "function __assert_notSameValue(actual, unexpected, message) { if (actual === unexpected) { if (actual !== 0 || 1 / actual === 1 / unexpected) throw 1; return; } if (actual !== actual && unexpected !== unexpected) throw 1; }",
  __assert_throws:
    "function __assert_throws(expectedErrorConstructor, func, message) { try { func(); } catch (error) { return; } throw 1; }",
  __assert_compareArray:
    "function __assert_compareArray(actual, expected, message) { if (actual.length !== expected.length) throw 1; for (var i = 0; i < actual.length; i++) { if (actual[i] !== expected[i]) throw 1; } }",
  __error: "function __error(message) { throw 1; }",
};

const REWRITES = [
  [/\bassert\.(sameValue|notSameValue|throws|compareArray)\s*\(/g, "__assert_$1("],
  [/\bassert\s*\(/g, "__assert("],
  [/\$ERROR\s*\(/g, "__error("],
];

/** Harness API a test may name that the stand-in does not model. */
const UNMODELLED = /\bassert\.\w+|\$DONE\b|\$DONOTEVALUATE\b|\$262\b|\bprint\s*\(/;

const REAL_PRELUDE = new Set(["__js2wasm_test262_runtime__.js", "assert.js", "sta.js", "doneprintHandle.js"]);

const rewrite = (text) => REWRITES.reduce((out, [pattern, to]) => out.replace(pattern, to), text);

/**
 * Assemble `body` behind the stand-in. `parts` are the real harness parts in
 * order (`harnessSourceParts`); `strict` adds the directive. Returns the
 * source, `[firstLine, name]` per part and the first body line.
 */
export function assembleStandIn(body, parts, strict) {
  const includes = parts
    .filter((part) => !REAL_PRELUDE.has(part.name))
    .map((part) => ({ ...part, source: rewrite(part.source) }));
  const testBody = rewrite(body);
  const named = [testBody, ...includes.map((part) => part.source)].join("\n");
  const standIn = Object.entries(STAND_IN)
    .filter(([name]) => new RegExp(`\\b${name.replace("$", "\\$")}\\b`).test(named))
    .map(([, source]) => source);
  const pieces = [
    ...(strict ? [{ name: "directive", source: '"use strict";\n' }] : []),
    ...includes.map((part) => ({
      name: part.name,
      source: part.source.endsWith("\n") ? part.source : `${part.source}\n`,
    })),
    { name: "stand-in", source: standIn.map((line) => `${line}\n`).join("") },
  ];
  const starts = [];
  let line = 1;
  for (const piece of pieces) {
    starts.push([line, piece.name]);
    line += piece.source.split("\n").length - 1;
  }
  return {
    source: pieces.map((piece) => piece.source).join("") + testBody,
    starts,
    bodyLine: line,
    unmodelled: UNMODELLED.test(testBody),
  };
}
