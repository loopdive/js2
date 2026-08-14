// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * (#4410) Adjudication probes — hand-built cases where ECMAScript pins the
 * right answer, so "checker vs in-house" can be SCORED instead of assumed.
 *
 * `audit-oracle-differential.mts` measures how often the two backends differ.
 * It cannot say who is right, because it answers from the checker and so
 * treats the checker as ground truth. TypeScript is deliberately unsound in
 * exactly the places a JS compiler cares about — `with`, direct `eval`,
 * annexB hoisting, declared-vs-actual signatures — and in this codebase it is
 * additionally bound to a `ts.Program` that excludes re-entrant eval'd
 * sources.
 *
 * Each probe below states what ECMAScript REQUIRES of a sound oracle and
 * prints both backends' answers next to it, so the verdict is readable rather
 * than inferred. Findings live in #4409 (in-house is wrong) and #4410
 * (TypeScript is wrong or declines).
 *
 * Usage:
 *   npx tsx scripts/audit-oracle-adjudication.mts [--json <out.json>]
 */
import { writeFileSync } from "node:fs";

const { compile } = await import("../src/index.js");
const { globalDivergenceLedger } = await import("../src/checker/oracle-backend.js");

interface Probe {
  name: string;
  /** What ECMAScript requires of a SOUND oracle. */
  truth: string;
  /** Queries worth printing for this probe. */
  focus: RegExp;
  source: string;
}

const probes: Probe[] = [
  {
    name: "with-shadows-outer-var",
    truth: "MUST ABSTAIN on `x` — inside `with (scope)`, `x` resolves to scope.x at runtime, not the outer `var x`.",
    focus: /valueDeclarationOf|declarationsOf|isUnresolvableIdentifier|staticJsTypeOf|typeFactOf/,
    source: `var x = 0;
var scope = { x: 1 };
with (scope) { x = 2; }
globalThis.out = [x, scope.x];`,
  },
  {
    name: "with-unscopables-restores-outer",
    truth:
      "MUST ABSTAIN on `v` — resolution depends on obj[Symbol.unscopables].v, a RUNTIME property read. Answering `var v` is right only by luck.",
    focus: /valueDeclarationOf|declarationsOf|isUnresolvableIdentifier|staticJsTypeOf/,
    source: `var v = 1;
var obj = { v: 99 };
obj[Symbol.unscopables] = { v: true };
function f(y) { var v = y; with (obj) { return v; } }
globalThis.out = f(10);`,
  },
  {
    name: "direct-eval-creates-binding",
    truth:
      "MUST ABSTAIN on `f` — no FunctionDeclaration exists in this source; `f` is created by annexB B.3.3.3 at runtime.",
    focus: /valueDeclarationOf|typeFactOf|declarationsOf|isUnresolvableIdentifier/,
    source: `eval('{ function f() { return "inner"; } }');
globalThis.out = typeof f;`,
  },
  {
    name: "let-without-initializer",
    truth: "MUST RESOLVE `resizeTo` to its `let` declaration — plain lexical binding, nothing dynamic about it.",
    focus: /valueDeclarationOf|variableDeclarationOf|declarationsOf/,
    source: `let resizeTo;
resizeTo = 4;
function use() { return resizeTo; }
globalThis.out = use();`,
  },
  {
    name: "builtin-returns-boolean",
    truth: "`Array.prototype.some.call(...)` IS boolean-producing. Answering `false` is safe-but-lossy, not wrong.",
    focus: /isBooleanProducing|signatureOf|typeFactOf/,
    source: `var sample = [1, 2, 3];
globalThis.out = Array.prototype.some.call(sample, function (e) { return e > 2; });`,
  },
  {
    name: "plain-function-signature",
    truth:
      "`isEven` has one param and a boolean return, both statically evident. Abstaining loses a real specialization.",
    focus: /signatureOf|typeFactOf/,
    source: `function isEven(n) { return n != undefined && Number(n) % 2 == 0; }
globalThis.out = [1, 2, 3].filter(isEven);`,
  },
  {
    name: "getprototypeof-is-any",
    truth: "`Object.getPrototypeOf(x)` is `any` per lib.d.ts. Naming it `ArrayConstructor` is an INVENTION.",
    focus: /declaredNameOf|typeFactOf/,
    source: `var actual = [1, 2, 3];
globalThis.out = Object.getPrototypeOf(actual) === Array.prototype;`,
  },
  {
    name: "array-literal-element-type",
    truth: "`[1,2,3]` has number elements. `array<any>` is safe-but-lossy; `array<number>` is the precise answer.",
    focus: /typeFactOf|elementFactOf/,
    source: `var xs = [1, 2, 3];
xs.pop();
globalThis.out = xs;`,
  },
];

const out: unknown[] = [];
for (const p of probes) {
  globalDivergenceLedger.reset();
  let compileErr = "";
  try {
    await compile(p.source, { oracleBackend: "differential" });
  } catch (e) {
    compileErr = (e as Error).message.slice(0, 100);
  }
  const rows = globalDivergenceLedger.samples
    .concat(globalDivergenceLedger.conflictSamples)
    .filter((s) => p.focus.test(s.query));
  // Dedupe identical (query, node, checker, inhouse) tuples.
  const seen = new Set<string>();
  const uniq = rows.filter((r) => {
    const k = `${r.query}|${r.node}|${r.checker}|${r.inhouse}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
  console.log(`\n${"=".repeat(76)}\n${p.name}\n  ES truth: ${p.truth}`);
  if (compileErr) console.log(`  (compile: ${compileErr})`);
  if (uniq.length === 0) console.log("  (no divergence on focused queries — backends agree)");
  for (const r of uniq) {
    console.log(
      `  ${r.query.padEnd(24)} node=${JSON.stringify(r.node).padEnd(34)} checker=${r.checker}  inhouse=${r.inhouse}`,
    );
  }
  out.push({ probe: p.name, truth: p.truth, rows: uniq });
}
const args = process.argv.slice(2);
const jsonAt = args.indexOf("--json");
if (jsonAt !== -1 && args[jsonAt + 1]) writeFileSync(args[jsonAt + 1], JSON.stringify(out, null, 2));
