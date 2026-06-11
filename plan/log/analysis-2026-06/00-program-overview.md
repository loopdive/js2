# 00 — Program Overview: June-2026 Analysis Program (synthesis)

> Synthesis of reports 01–06 (`plan/log/analysis-2026-06/`), 2026-06-11.
> Companion documents: `07-sprint-62-63-64-proposal.md` (the plan),
> `08-new-issues-to-file.md` (unfiled issue stubs).
> Evidence base: 170 issues filed 2026-06-10/11 (#1916–#2085 ranges), the
> upstream architecture review (`docs/architecture/compiler-quality-review-2026-06.md`),
> and ~600 ad-hoc probes that found bugs the 2,000+-file test corpus could not see.

---

## 1. The five diseases (compressing report 01's 13 families)

Report 01 taxonomizes 170 issues into 13 root-cause families. For program
planning they collapse into **five diseases**, each with one structural cure:

| # | Disease | Families (report 01) | Issues | Cure | Owning spec |
|---|---------|----------------------|--------|------|-------------|
| D1 | **Type-erased value representation** — lowering picks tags/representation from the Wasm ValType, not the JS type; every observer (`String()`, `typeof`, truthiness, `===`, `??`, `?.`) then guesses wrong. Includes the four divergent coercion matrices built on top of those untagged values. | F2 REPR (16) + F3 COERCE (13) | ~29 + the largest standalone bucket share | JsTag/brand discipline (report 02, phases P0–P6) feeding one coercion engine (report 03, steps 0–5) | 02 + 03 |
| D2 | **Fail-soft compilation** — the compiler prefers emitting *something* (null, NaN, 0, dropped args, truncated loops, skipped bindings) over refusing. ~25% of the June corpus traces to seven silent-fallback pattern classes. | F1 SILENT (24) + fallback slices of F7/F11 | ~33 attributed | `reportSilentFallback()` telemetry + per-class ratchet + promotion to hard error at zero — a clone of the proven #1376/#1530 machinery | 04 |
| D3 | **Ad-hoc host boundary** — Wasm↔JS marshaling decided per call site (opaque vecs, inconsistently wrapped closures, fixed-arity imports for variadic builtins, unversioned ~200-name ABI); every ad-hoc bridge is also a future standalone import leak. | F4 HOST (14) + F12's leak half | ~14 + #2073/#2075-class leaks | One declared deep-marshaling contract every bridge routes through; emit-time import-section assert for standalone | 01 Seed C + 04 §h + 06 §5 |
| D4 | **Duplicated & name-keyed structure** — N divergent copies of one concept (7 ToString matrices, 3 ctor-synthesis paths, 2 capture machineries) plus identity decided by name strings/struct shape (funcMap collisions, shape-id collisions) and absolute function indices. Drift is the *breeding mechanism* by which D1/D2 symptoms recur after point fixes. | F8 DUP (9) + F10 SHAPE (4) + F9 IDX (6) | ~19 | Consolidate onto the good twin per pair; instance-carried identity (#2009/#1989); symbolic **collision-free** function IDs (#1916 amended) | 05 |
| D5 | **Missing spec machinery** — runtime checks lower to uncatchable traps instead of catchable JS errors; classes have no ctor-as-value/prototype model; builtins written from memory of the spec. Structurally invisible today because the test262 oracle discards error types (#1945). | F5 ERR (10) + F6 CLASS (11) + F11 SPEC (11) | ~32 | `throwJsError(kind)` shared lowering + class object-model decision + spec-first fixes — all gated on oracle precision so CI can *see* the disease | 01 Seeds D/F + 06 §3 |

Residue: F7 BIND (12, shared binding-info analysis), F13 IR (4, verifier
instruction-type rules #1924) — real but smaller; scheduled behind the five
above. F12 LANE mostly **decomposes into D1/D3/D4** (report 01: standalone is
a lens, not a family); the genuinely lane-local items are the linear backend's
prototype-grade runtime (#1977 heap corruption is the floor).

## 2. Cross-report convergences (the load-bearing agreements)

These independently-derived conclusions agree across reports and define the
program's dependency spine:

1. **Boxing before coercion engine.** Report 01 (F2 ranked above F3), report
   02 (§1: the JS type is unrecoverable at every observing site), report 03
   (scope note), and report 05 (§2a: #1917's spec has *zero mention* of
   TS-type hints) all conclude the same thing: a single coercion engine fed
   untagged values still cannot recover the JS type. **#2072/#2080 type-aware
   boxing (value-rep P0, senior lane) is the program's first mover**, and
   #1917 must be amended to `(fromWasmType, toWasmType, staticJsType?)`
   before its dev dispatch.
2. **#1917 needs the type-hint, which needs a thin TypeOracle slice.** Report
   05 §5: the right sequencing is NOT 9 boxing bugfixes each threading ad-hoc
   `ts.Type` params (growing the 399-site checker leak #1930 exists to kill),
   but one context field with the 3–4 queries boxing needs (`jsTypeTagOf`,
   nullability, primitive-kind) — a #1930 down-payment, not a 190-field
   CodegenContext decomposition (which stays deferred, #1172).
3. **#1916 must mint collision-free FuncIds, not name strings.** Report 05
   §3: the prototype `IrFuncRef { name }` is still a string — it fixes the
   *shift* fragility (F9) but not the *collision* class (F10: #1983/#1989/
   #2009 survive the rewrite unless the handle is declaration-site/
   ts.Symbol-derived). Spec amendment before implementation.
4. **All ratchets reuse the #1376/#1530 machinery and share one dashboard.**
   The fail-loud telemetry gate (report 04 §5), the coercion drift gate
   `check-coercion-sites.mjs` (report 03 §5), and the standalone import-leak
   budget (report 06 §5.4) are all clones of `check-ir-fallbacks.ts`
   (baseline JSON, growth fails, `--update-on-decrease` banks improvements,
   promotion to `STRICT_*` hard error at zero). They report into one ratchet
   dashboard section in `plan/log/ir-adoption.md`.
5. **The oracle (#1945) is the detector for D5.** Reports 01 §3 and 06 §3
   agree: families F5/F11 are invisible *by construction* — the runner passes
   runtime negatives on ANY throw including Wasm traps. Oracle step 1
   (trap ≠ pass) is ~30 runner-only lines and must land (flag-gated) before
   the error-model fix wave, or the fixes are unobservable in CI.
6. **The probe corpus is the program's instrument.** ~600 probes found 170
   bugs the suite missed; report 06 converts them into a permanent
   table-driven spec suite under the already-required `equivalence-gate`
   check, with open-bug probes landing immediately as baselined failures.
   Report 02 §4's eight T-tables are the regression guardrails for every
   value-rep phase — the suite must exist **before/with** sprint-62's
   value-rep work, in all 4 lanes (host/standalone × O0/-O).
7. **Standalone buckets route to parent families.** ~5,400 host-pass tests
   in buckets #2036–#2042 decompose into D1 (boxing: #2072/#2080/#2081),
   D3 (import leaks: #2073/#2075), D4/F9 (#2029/#2079), D5 (#2077/#2078).
   Fixing the disease fixes the bucket; the lane holds the line with the
   refusal layer + leak budget.
8. **Dual-mode drift needs scaffolding, not discipline.** Report 05 §2c:
   join alone bred 4 issues, one per representation variant. The
   per-builtin "element accessor + coercion" scaffold (parameterized by
   representation) is the structural answer the dual-mode principle
   (CLAUDE.md) guarantees we'll need forever.
9. **`-O` is a correctness lane, today broken.** #1973 (`-O` output rejected
   by stock V8/JSC) upgrades #1941 from "largest untested surface" to "the
   lane ships broken binaries" — fix #1973, then gate `-O` differentially
   (report 06 D2), then weekly full `-O` test262 (D3).

## 3. What changes about how we build this compiler (one page)

**From "emit something" to "prove or refuse."** Every dispatcher gets a
default arm that throws; every unresolvable entity becomes a structured
diagnostic, ratcheted to zero, then promoted to a hard compile error
(`STRICT_FALLBACK_CLASSES`, the #1530 lifecycle). A silent wrong value is
treated as strictly worse than a compile error.

**From Wasm-kind guessing to JS-type fidelity.** One canonical `JsTag` enum
(`src/codegen/value-tags.ts`), invariant V1 (tag = ECMAScript type partition),
brands for unboxed carriers (`{kind:"i32", boolean:true}`, `UNDEF_F64`
sentinel), chosen from the **checker type at the producer**, never inferred
from the ValType at the consumer. Backend-independent policy; per-backend
carriers (#1852 seam).

**From N copies to one engine row.** New coercion/marshaling/ctor-synthesis
logic lands as a row in the shared engine/scaffold, never as an (N+1)th copy.
Individual bug fixes are still fixed individually — but *as the engine row*
(report 03 §6). Grep-based drift gates make bypass a CI failure.

**From name-keyed to identity-keyed.** Function references, struct shapes,
and ToPrimitive dispatch key on per-declaration/per-instance IDs; names are
debug metadata.

**From "tests pin the past" to "probes precede fixes."** Every new bugfix
issue carries its repro into `tests/equivalence/spec/` (CI-enforced,
`check-issue-spec-coverage.mjs`), landing red-but-baselined at discovery and
de-baselined at fix. Node is the oracle; values are computed, not
hand-written. Four lanes always: host, standalone, ×`-O`.

**From a blunted oracle to an honest one.** Trap ≠ catchable error; expected
error types checked; `oracle_version` stamped into every JSONL row so
baselines re-seed honestly when the oracle tightens. The headline number may
drop on the flip — that drop *is* the honesty.

**Sprint mix discipline stays.** Each sprint pairs foundation work (specs,
engines, ratchets) with visible conformance wins (the queue's
ready-to-fix issues), so test262 keeps moving while the foundations land.

## 4. Goal-graph delta (proposal — do not apply without PO sign-off)

Proposed edits to `plan/goals/goal-graph.md`, diff-style. Rationale: the
program's three structural tracks (value representation, fail-loud, trust)
have no goal to belong to today, so their issues scatter across
`core-semantics`/`refactoring` and lose sequencing identity.

```diff
   === Parallel tracks (no conformance dependency) ===

+  +----------------------+   +--------------------+   +---------------------+
+  | value-representation |   |  fail-loud-        |   | trust-              |
+  |     -integrity       |   |    compiler        |   |  infrastructure     |
+  | (JsTag fidelity,     |   | (no silent         |   | (spec suite, oracle |
+  |  brands, undefined   |   |  fallbacks; ratchet|   |  precision, -O diff,|
+  |  observability)      |   |  -> hard error)    |   |  baseline trust)    |
+  +----------------------+   +--------------------+   +---------------------+
+  Depends on:                Independent              Independent
+  core-semantics (partial)   (extends #1376/#1530)    (feeds ALL goals'
+  Feeds: standalone-mode,                              measurability)
+  spec-completeness,
+  backend-agnostic-ir
+
+  +----------------------+
+  | host-boundary-       |
+  |    contract          |
+  | (deep marshaling,    |
+  |  versioned ABI,      |
+  |  glue-size #2083)    |
+  +----------------------+
+  Depends on: core-semantics (partial)
+  Feeds: standalone-mode (leak class), platform
```

```diff
 | Goal | Status | Target | Dependencies | Key Issues |
+| **value-representation-integrity** | Active (s62) | V1–V3 invariants hold on all lanes | core-semantics (partial) | #2072/#2080 (P0, senior), #2044 (ratified), P1–P4 phase issues (see 08-new-issues), #1987, #2005, #2004, #2051, #2001 (P5), #1926 (IR seam, last) |
+| **fail-loud-compiler** | Active (s62) | silent-fallback classes -> 0, promoted to STRICT | — (independent) | #1921, #1937, #1939, #1918, fallback-telemetry (new), arity audit (#1955/#2002/#1958/#2013), caps (#2067, REGEX_STEP_CAP) |
+| **trust-infrastructure** | Active (s62) | every PR sees 4-lane spec suite + honest oracle | — (independent) | spec-suite (new), #1945, #1941, #1973, #1862, leak-budget (new), issue→probe rule (new) |
+| **host-boundary-contract** | Activatable | one marshaling layer, versioned ABI | core-semantics (partial) | marshaling spec (new), #1932, #1933, #1935, #1969, #2070, #2015, #2028, #2083 |
~| **error-model** | Active | spec errors, ~50% | compilable (met), **trust-infrastructure (oracle step 1 — detector)** | add: throwJsError lowering (new), #1972, #2061, #2003, #2017, #2012, #1954, #2000 |
~| **class-system** | Active | ~60% | core-semantics (partial) | add: class object-model architect spec (new — gates #2023/#2026), ctor-body family #1965/#2082/#2078, single-ctor-synthesis (new) |
~| **standalone-mode** | **Active** (was Activatable) | WASI works | iterator-protocol, generator-model, **value-representation-integrity (partial)** | add: #2079, #2029, buckets #2036–#2042 routed to parent families |
~| **backend-agnostic-ir** | Active (s57) | IR lowers to 2+ backends | compiler-architecture, **value-representation-integrity P6 (#1852 carrier policy)** | unchanged + #1926 |
-| (no change to remaining rows)
```

Also: park `performance`-goal members #1946–#1950 explicitly (report 01: they
rank below every correctness family) — **except #1973**, which moves under
trust-infrastructure as a correctness bug wearing a perf label.

## 5. Program risks

1. **Merge-queue contention**: phase 0 boxing freezes three file regions
   (`type-coercion.ts:1178-1218`, `native-strings.ts:5417-5586`,
   `any-helpers.ts:384-443`); coercion Step 1 overlaps in-flight PRs 1321/1325.
   The sprint plan sequences around this (07 §dependency notes).
2. **Oracle flip blast radius**: pass-rate headline drops; protocol in report
   06 §3.3 (flag-gate → measure → stamp `oracle_version` → coordinated flip).
3. **Brand erosion** (`{boolean:true}` dropped by ad-hoc ValType copies):
   mitigated by T-table probes + grep ratchet; long-term owned by IR (#1926).
4. **Spec-amendment latency**: #1917/#1916 are dev-blocked until their
   architect amendments land — scheduled first thing in sprint 62.
