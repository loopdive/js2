// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// (#3613) THE HARNESS TRUTH TABLE — behavioural unit tests for the test262
// machinery itself.
//
// Why this file exists
// --------------------
// The compiler is judged by a harness that, until 2026-07-25, nothing tested.
// Two independent defects landed that day, both of which made the harness
// report `pass` for programs that validated NOTHING:
//
//   • #3592 RC2 — `__apply_closure` dispatched on the *dynamic* argument count
//     alone, so `assert.sameValue(a, b)` (2 args into 3 declared formals)
//     silently never invoked the callee. ~5,000 standalone passes (18.4 % of
//     that lane) were vacuous for months.
//   • #3592 RC1 — a module whose body was a top-level `throw` emitted no
//     `__module_init` at all, so the program exited 0 instead of throwing.
//     This also DEFEATED throw-probe auditing: the very technique used to
//     detect vacuity was broken by it (an audit run on a pre-fix base reported
//     a spurious "43/43 vacuous").
//
// A vacuous pass is worse than a failure: it inflates conformance AND hides a
// real defect. Both defects were invisible because every existing test of the
// machinery was a SOURCE-SHAPE assertion (`expect(worker).toContain(...)`,
// cf. tests/issue-3227-s4.test.ts) — those pin that a line of code exists, not
// that the oracle reaches the right verdict.
//
// What this file does instead
// ---------------------------
// It drives synthetic, test262-shaped files through the REAL oracle
// (`runTest262File`, the same `assembleOriginalHarness` assembly CI scores
// with) and asserts the VERDICT against a hand-derived ground truth. Every
// entry is a claim of the form "this program must be observed as pass/fail" —
// if the machinery stops observing it, this file goes red.
//
// Anti-vacuity discipline applied to this file itself
// ---------------------------------------------------
//   1. POSITIVE CONTROLS. The table contains genuinely-passing programs. A
//      harness that failed everything would score them wrong, so "all green"
//      cannot be reached by a harness that refuses to run.
//   2. NEGATIVE CONTROLS. It contains genuinely-failing programs whose failure
//      is reached only by executing the body. A harness that passed everything
//      goes red.
//   3. NO SILENT SKIP. If the test262 harness inputs are missing, this file
//      HARD-FAILS under CI rather than skipping — a checker that verifies
//      nothing must never look like a checker with nothing to verify.
//   4. KNOWN-VACUOUS entries are `it.fails` — they assert the TRUTH and are
//      expected to fail today. When the underlying defect is fixed the entry
//      starts passing and vitest turns it RED, forcing the debt to be retired
//      here instead of silently rotting.
import { existsSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { restoreHostBuiltins } from "./test262-restore-builtins.js";
import { runTest262File } from "./test262-runner.js";

const HARNESS_ROOT = join(__dirname, "..", "test262", "harness");
const HARNESS_AVAILABLE = existsSync(join(HARNESS_ROOT, "assert.js"));
const IN_CI = !!process.env.CI;

// (3) NO SILENT SKIP. Under CI the harness is always prepared (the `quality`
// job checks out the test262 submodule before running root tests), so a
// missing harness means the job is misconfigured — fail, do not skip.
if (!HARNESS_AVAILABLE && IN_CI) {
  throw new Error(
    "#3613: test262 harness inputs are missing under CI (test262/harness/assert.js). " +
      "This file must never silently skip — a verifier that verifies nothing looks " +
      "exactly like one with nothing to verify. Run `git submodule update --init --checkout test262`.",
  );
}

type Verdict = "pass" | "fail";

interface TruthCase {
  /** Stable id — also the synthetic filename. */
  id: string;
  /** The test262 test body (the harness prefix is assembled around it). */
  body: string;
  /** Extra frontmatter YAML lines (`negative:`, `flags:`, `includes:`). */
  frontmatter?: string;
  /** Ground truth: what a correct oracle MUST report. */
  truth: Verdict;
  /** Why this is the ground truth — the load-bearing part of the entry. */
  why: string;
  /**
   * Set when the machinery currently reports the WRONG verdict. The entry
   * still asserts the TRUTH and runs under `it.fails`, so fixing the defect
   * turns this file red and forces the entry to be retired.
   */
  knownWrong?: string;
  /** Lanes to exercise. Default: host only. */
  lanes?: ("gc" | "standalone")[];
}

// ── The table ──────────────────────────────────────────────────────────────
//
// Grouped by the mechanism each entry defends. Read the `why` before changing
// a `truth`: these are spec/harness claims, not observations of the compiler.
const CASES: TruthCase[] = [
  // ── Group A: an under-applied harness call must NOT silently pass (#3592 RC2)
  //
  // Every `assert.*` in test262 is declared with a trailing `message` formal
  // and virtually always called without it. If under-application silently
  // no-ops, the ENTIRE assert family becomes decorative.
  {
    id: "A1-under-applied-sameValue",
    body: `assert.sameValue(1, 2);`,
    truth: "fail",
    why: "assert.sameValue(actual, expected, message) — 2 args into 3 formals. The values differ, so the harness must throw. #3592 RC2: dispatching on argc alone made this a silent no-op.",
    lanes: ["gc", "standalone"],
  },
  {
    id: "A2-exact-arity-sameValue",
    body: `assert.sameValue(1, 2, "explicit message");`,
    truth: "fail",
    why: "Control for A1: the SAME assertion at exact arity. A1 and A2 must agree — if only A2 fails, the defect is arity dispatch, not the assertion.",
    lanes: ["gc", "standalone"],
  },
  {
    id: "A3-under-applied-notSameValue",
    body: `assert.notSameValue(1, 1);`,
    truth: "fail",
    why: "Same under-application shape on the negated assertion — the values ARE the same, so it must throw.",
    lanes: ["gc", "standalone"],
  },
  {
    id: "A4-under-applied-throws-nothing-thrown",
    body: `assert.throws(TypeError, function () {});`,
    truth: "fail",
    why: "assert.throws(Ctor, func, message) — 2 of 3. The callback throws nothing, so the harness must report 'no exception was thrown'. If under-application no-ops, every assert.throws in the corpus is decorative.",
    lanes: ["gc", "standalone"],
  },
  {
    id: "A5-under-applied-assert-false",
    body: `assert(false);`,
    truth: "fail",
    why: "assert(mustBeTrue, message) — 1 of 2. The 1-formal-called-with-0 shape is the same defect one arity down.",
    lanes: ["gc", "standalone"],
  },
  {
    id: "A6-positive-control-sameValue-holds",
    body: `assert.sameValue(1, 1);`,
    truth: "pass",
    why: "POSITIVE CONTROL. Same under-applied call shape as A1 but the assertion HOLDS. A harness that failed everything would score this wrong, so group A cannot be satisfied by a harness that refuses to run.",
    lanes: ["gc", "standalone"],
  },
  {
    id: "A7-positive-control-throws-does-throw",
    body: `assert.throws(TypeError, function () { throw new TypeError("expected"); });`,
    truth: "pass",
    why: "POSITIVE CONTROL for A4: the callback DOES throw the expected constructor, so the assertion holds.",
    lanes: ["gc", "standalone"],
  },

  // ── Group B: a module that throws at top level must be OBSERVED as throwing (#3592 RC1)
  {
    id: "B1-toplevel-unconditional-throw",
    body: `throw new Test262Error("top-level throw must be observed");`,
    truth: "fail",
    why: "#3592 RC1: a module body that is an unconditional top-level throw emitted no __module_init at all and exited 0. This also broke throw-probe vacuity auditing, so it must stay pinned.",
    lanes: ["gc", "standalone"],
  },
  {
    id: "B2-toplevel-conditional-throw",
    body: `if (typeof Test262Error === "function") { throw new Test262Error("conditional top-level throw"); }`,
    truth: "fail",
    why: "The CONDITIONAL form — structurally immune to the RC1 statement-collector bug and therefore the shape the standing vacuity detector (scripts/detect-vacuity.mjs) injects. Its correctness is a precondition for that detector's verdicts.",
    lanes: ["gc", "standalone"],
  },
  {
    id: "B3-throw-after-statements",
    body: `var x = 1;\nx = x + 1;\nthrow new Test262Error("throw at end of body");`,
    truth: "fail",
    why: "The detector appends its probe at the END of the body. If a trailing top-level throw were dropped, every probed run would look vacuous — the spurious '43/43 vacuous' reading of 2026-07-25.",
    lanes: ["gc", "standalone"],
  },

  // ── Group C: an assertion reached through indirection must still be observed
  //
  // "A test whose assertion never executes must not pass." These entries put a
  // FAILING assertion behind each indirection layer the corpus actually uses;
  // if the layer swallows the throw or never runs the callback, the verdict
  // silently flips to pass.
  {
    id: "C1-assert-inside-callback",
    body: `[1].forEach(function () { assert.sameValue(1, 2); });`,
    truth: "fail",
    why: "Assertion inside a host-iterated callback. A callback that is never invoked, or whose throw is swallowed by the iteration helper, turns the test vacuous.",
    lanes: ["gc", "standalone"],
  },
  {
    id: "C2-assert-inside-finally",
    body: `try { } finally { assert.sameValue(1, 2); }`,
    truth: "fail",
    why: "Assertion in a finally block — the throw must propagate out of the finally, not be absorbed by the try machinery.",
    lanes: ["gc", "standalone"],
  },
  {
    id: "C3-assert-inside-loop-body",
    body: `for (var i = 0; i < 1; i++) { assert.sameValue(i, 99); }`,
    truth: "fail",
    why: "A loop that runs at least once must execute its body. A zero-trip miscompile would make the test vacuous.",
  },
  {
    id: "C4-assert-inside-nested-function-call",
    body: `function outer() { inner(); }\nfunction inner() { assert.sameValue(1, 2); }\nouter();`,
    truth: "fail",
    why: "Two call frames deep — the throw must cross both.",
  },
  {
    id: "C5-assert-inside-valueOf-hook",
    body: `var o = { valueOf: function () { assert.sameValue(1, 2); return 1; } };\n+o;`,
    truth: "fail",
    why: "ToPrimitive hooks are how a large slice of test262 observes abrupt completions. The hook must be invoked and its throw propagated.",
  },
  {
    id: "C6-positive-control-callback-holds",
    body: `[1].forEach(function () { assert.sameValue(1, 1); });`,
    truth: "pass",
    why: "POSITIVE CONTROL for group C.",
  },

  // ── Group D: negative tests pass only when rejected for the EXPECTED reason
  {
    id: "D1-parse-negative-genuine",
    body: `var 1 = 2;`,
    frontmatter: `negative:\n  phase: parse\n  type: SyntaxError\n`,
    truth: "pass",
    why: "A genuine syntax error the compiler rejects statically — the parse-negative happy path.",
    lanes: ["gc", "standalone"],
  },
  {
    id: "D2-runtime-negative-genuine",
    body: `throw new TypeError("expected");`,
    frontmatter: `negative:\n  phase: runtime\n  type: TypeError\n`,
    truth: "pass",
    why: "A runtime negative whose expected error IS thrown. On the standalone lane this ALSO pins the #3613 render-parity fix: `originalNegativeMatches` searches the reported detail for the expected type name, so while the local runner rendered the opaque #2870 label instead of the real text, this scored `fail` locally and `pass` in CI.",
    lanes: ["gc", "standalone"],
  },
  {
    id: "D3-runtime-negative-nothing-thrown",
    body: `var x = 1;`,
    frontmatter: `negative:\n  phase: runtime\n  type: TypeError\n`,
    truth: "fail",
    why: "NEGATIVE CONTROL: nothing is thrown, so the negative test must FAIL. A runner that scored every `negative:` file as pass would score this wrong.",
    lanes: ["gc", "standalone"],
  },
  {
    id: "D4-parse-negative-compiles-clean",
    body: `var validProgram = 1;`,
    frontmatter: `negative:\n  phase: parse\n  type: SyntaxError\n`,
    truth: "fail",
    why: "NEGATIVE CONTROL for the #2920 strict compile-SUCCEEDED arm: the compiler emitted no diagnostic, so it did NOT detect the expected early error. Passing this would be the ~439-test #2898 incidental-pass class.",
    lanes: ["gc", "standalone"],
  },

  // ── Group E: async completion must be observed, not assumed
  {
    id: "E1-async-done-called",
    body: `$DONE();`,
    frontmatter: `flags: [async]\nincludes: [doneprintHandle.js]\n`,
    truth: "pass",
    why: "POSITIVE CONTROL: the async completion marker is emitted.",
  },
  {
    id: "E2-async-done-with-error",
    body: `$DONE("async failure");`,
    frontmatter: `flags: [async]\nincludes: [doneprintHandle.js]\n`,
    truth: "fail",
    why: "$DONE with a truthy argument is an async FAILURE. Scoring it pass would make every async test decorative.",
  },
  {
    id: "E3-async-never-completes",
    body: `var x = 1;`,
    frontmatter: `flags: [async]\nincludes: [doneprintHandle.js]\n`,
    truth: "fail",
    why: "The completion marker is never emitted. An async test that never completes must NOT be scored pass — this is the #3227/#2939 vacuity class (1,679 rows re-scored).",
  },
  {
    id: "E4-async-assertion-in-promise-then",
    body: `Promise.resolve().then(function () { assert.sameValue(1, 2); }).then($DONE, $DONE);`,
    frontmatter: `flags: [async]\nincludes: [doneprintHandle.js]\n`,
    truth: "fail",
    why: "The failing assertion runs in a microtask; the runner must drain the queue and observe the rejection instead of scoring the synchronous return.",
  },

  // ── Group F: the #3615 accessor-drop class — RETIRED from known-wrong.
  //
  // Discovered by this file on its first run (2026-07-25): a bare property read
  // in EXPRESSION-STATEMENT position never invoked the accessor, so its
  // observable effects — including its throw — were dropped, and the test
  // scored a VACUOUS PASS. F1–F3 were `it.fails` entries asserting the truth.
  //
  // FIXED by #3615 in the same PR series, so they are now ordinary `it`s. The
  // root cause was NOT the property-read lowering (this file's original note
  // guessed wrong): `collectDeclarations` builds `ctx.moduleInitStatements`
  // from an ALLOW-LIST of expression-statement shapes, and a bare
  // PropertyAccess/ElementAccess matched no arm, so the whole statement never
  // reached `__module_init`. Identical mechanism to #2992 (`delete`) and #3592
  // RC1 (`throw`) — see #3623 for the generalisation that stops the next one.
  //
  // F4/F5 stay as the controlled pair that proved NOT-INVOKED rather than
  // invoked-but-swallowed: same file shape, only the read form differs.
  {
    id: "F1-objlit-getter-in-statement-position",
    body: `var o = { get p() { throw new Test262Error("accessor must run"); } };\no.p;`,
    truth: "fail",
    why: "#3615: a bare `o.p;` statement must invoke the accessor, so the throw must be observed. Was a vacuous pass until the collector's allow-list gained a property/element-read arm.",
    lanes: ["gc", "standalone"],
  },
  {
    id: "F2-defineProperty-getter-in-statement-position",
    body: `var o = {};\nObject.defineProperty(o, "p", { get: function () { throw new Test262Error("accessor must run"); } });\no.p;`,
    truth: "fail",
    why: "#3615: same class via Object.defineProperty — the accessor kind is irrelevant, the statement SHAPE was the defect.",
  },
  {
    id: "F3-class-getter-in-statement-position",
    body: `class C { get p() { throw new Test262Error("accessor must run"); } }\nvar c = new C();\nc.p;`,
    truth: "fail",
    why: "#3615: same class on a class accessor — confirms the defect was the read form, not the accessor kind.",
  },
  // F4/F5 are a matched pair that observes the accessor through a SIDE EFFECT
  // rather than a throw, so no exception machinery is in the picture. Before
  // #3615 they disagreed (F4 fail / F5 pass) and that disagreement is what
  // proved the accessor was NOT INVOKED rather than invoked-but-swallowed.
  // After #3615 they must AGREE — and they still localize a regression: if the
  // collector arm is ever lost again, F4 flips to fail while F5 stays pass,
  // pinning it to the statement-read form specifically.
  {
    id: "F4-statement-read-side-effect-observed",
    body: `var hit = 0;\nvar o = { get p() { hit = 1; return 1; } };\no.p;\nassert.sameValue(hit, 1, "the accessor must have run");`,
    truth: "pass",
    why: "#3615: a STATEMENT-position read must invoke the accessor, so `hit` must be 1. This entry's ground truth INVERTED when #3615 landed — pre-fix it was the direct evidence of the drop (`hit` stayed 0); post-fix it is the direct evidence the fix holds. If it ever fails again while F5 passes, the collector arm has been lost.",
  },
  {
    id: "F5-consumed-read-side-effect-observed",
    body: `var hit = 0;\nvar o = { get p() { hit = 1; return 1; } };\nvar v = o.p;\nassert.sameValue(hit, 1, "the accessor must have run");`,
    truth: "pass",
    why: "The SAME accessor read in VALUE position — a path that always worked, so it never depended on #3615. Paired with F4 it discriminates 'the collector dropped the statement' from 'the accessor itself broke'.",
  },
];

// ── Meta-guards on the table itself ────────────────────────────────────────
describe("#3613 the truth table is itself non-vacuous", () => {
  it("contains both positive and negative controls in meaningful numbers", () => {
    const passes = CASES.filter((c) => c.truth === "pass" && !c.knownWrong);
    const fails = CASES.filter((c) => c.truth === "fail" && !c.knownWrong);
    // A table of only-fail entries is satisfied by a harness that fails
    // everything; a table of only-pass entries by one that passes everything.
    expect(passes.length, "need positive controls").toBeGreaterThanOrEqual(5);
    expect(fails.length, "need negative controls").toBeGreaterThanOrEqual(10);
  });

  it("every entry justifies its ground truth", () => {
    for (const c of CASES) {
      expect(c.why ?? c.knownWrong, `${c.id} must state WHY its verdict is the ground truth`).toBeTruthy();
    }
  });

  it("ids are unique", () => {
    expect(new Set(CASES.map((c) => c.id)).size).toBe(CASES.length);
  });
});

// ── Execution ──────────────────────────────────────────────────────────────
let dir: string;

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "test262-truth-table-"));
});

afterAll(() => {
  restoreHostBuiltins();
});

function materialize(c: TruthCase): string {
  const source = `/*---\ndescription: "#3613 harness truth table: ${c.id}"\n${c.frontmatter ?? ""}---*/\n${c.body}\n`;
  const file = join(dir, `${c.id}.js`);
  writeFileSync(file, source);
  return file;
}

async function verdictOf(c: TruthCase, lane: "gc" | "standalone"): Promise<{ status: string; error?: string }> {
  const file = materialize(c);
  try {
    const r = await runTest262File(
      file,
      "harness-truth-table",
      30_000,
      lane === "standalone" ? "standalone" : undefined,
    );
    return { status: r.status, error: r.error };
  } finally {
    // The runner executes test code in this realm; undo any builtin pollution
    // before the next entry compiles (#3318).
    restoreHostBuiltins();
  }
}

const runIf = HARNESS_AVAILABLE ? describe : describe.skip;

for (const lane of ["gc", "standalone"] as const) {
  const laneCases = CASES.filter((c) => (c.lanes ?? ["gc"]).includes(lane));
  if (laneCases.length === 0) continue;

  runIf(`#3613 harness truth table — ${lane} lane`, () => {
    for (const c of laneCases) {
      const title = `${c.id}: must be observed as ${c.truth.toUpperCase()}`;
      const run = async () => {
        const got = await verdictOf(c, lane);
        expect(
          got.status,
          `${c.id} [${lane}]\n  ground truth: ${c.truth}\n  why: ${c.why ?? c.knownWrong}\n  runner said: ${got.status}${got.error ? ` — ${got.error}` : ""}`,
        ).toBe(c.truth);
      };
      if (c.knownWrong) {
        // ┌──────────────────────────────────────────────────────────────────┐
        // │ SEEING "expected test to fail" HERE? That is GOOD NEWS, not a    │
        // │ broken test: the defect named in the title has been FIXED. The   │
        // │ action is to DELETE this entry's `knownWrong:` field, which      │
        // │ turns it into an ordinary `it` asserting the same ground truth.  │
        // │ Nothing else changes — the assertion was always the TRUTH.       │
        // └──────────────────────────────────────────────────────────────────┘
        // Asserts the TRUTH; expected to fail today. When the defect is fixed
        // this entry starts passing and vitest reports "expected test to fail"
        // — the debt cannot rot silently.
        it.fails(`${title}  [KNOWN WRONG: ${c.knownWrong}]`, run, 90_000);
      } else {
        it(title, run, 90_000);
      }
    }
  });
}
