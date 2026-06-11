# 07 — Sprint 62/63/64 Proposal (analysis-program execution plan)

> Synthesis deliverable, 2026-06-11. Inputs: reports 00–06, sprint-61 state,
> the goal DAG, on-disk issue frontmatter (every scheduled issue cross-checked
> `status: ready` unless noted), and the open-PR queue on `loopdive/js2`.
>
> **Scheduling ground rules** (carried from sprint 61): small PRs, merge-queue
> serial, devs self-merge via CI; each sprint mixes foundation work with
> visible test262 wins; standalone is first-class (dual-mode principle).
>
> **In-flight work this plan does NOT reschedule** (open PRs as of 2026-06-11,
> they land via the existing queue): PR 1340 (#1986/#1987), 1339 (#2031/#2032),
> 1333 (#2019/#2020/#2027), 1330 (#2043 hardening), 1329 (#2002/#2003/#2004),
> 1326 (#2018), 1325 (#1998/#1997), 1321 (#2005/#2006), 1351 (#1993/#2000),
> 1320 (#1913), plus the plan PRs 1348/1338/1337/1315/1309/1304. PR 1352
> (#1992/#1991) is MERGED — flip both issue files to `done` (frontmatter is
> stale at `ready`).
>
> **TaskList numbering caveat**: the surviving on-disk team store predates the
> #1916→#2036 renumber and the team-store wipe; queue-task numbers in recent
> briefings don't all match it. Tasks below are identified by **issue ID**;
> where the lead's queue numbers were given (#19, #23, #24, #34, #35–#37) the
> content mapping is stated so the lead can reconcile at dispatch.

---

## Sprint 62 (next) — "P0 + mechanisms": value-rep phase 0, fail-loud phase 0, trust mechanisms, queue wins

Sizing: **~20 PRs** (4 senior, ~14 dev, 1 PO) **+ 4 architect specs** — in
line with what sprint 61 absorbed (~17 PRs in the June fix wave). Nothing in
the trust/fail-loud track moves the headline number, so it cannot collide
with the conformance work.

### Senior lane (4)

| # | Task | Issues | Rationale | Depends on / blocks |
|---|------|--------|-----------|---------------------|
| S1 | **Resume suspended worktree `issue-2009-shape-id`** — review uncommitted 257/92 diff, finish PR-1 ($shape i32 field + shapeNames table + export rewrite), commit, PR | #2009 (ready, hard, max) | Suspended mid-PR-1 by the team-store wipe; `## Suspended Work` in the issue file has resume steps. D4/F10 keystone — wrong keys for ALL same-shape objects | blocks D5 (#1989 eqref half); independent of boxing |
| S2 | **Type-aware AnyValue boxing** (value-rep **Phase 0**) — thread TS-type hint into `coerceType(→AnyValue)`; booleans→tag 4, null/undefined→0/1, native strings→recoverable string tag; teach `$__any_to_string`/`__any_unbox_bool` | #2072 + #2080 (ready, hard, senior-routed per 1bb8be691; the lead's queue calls this task **#19**) | The program's first mover (overview §2.1): D1's producer-side fix; everything in value-rep P1–P4 and coercion steps 1–3 rebases on its API choice | **Freezes** `type-coercion.ts:1178-1218`, `native-strings.ts:5417-5586`, `any-helpers.ts:384-443` for everyone else until merged; blocks 63's P1 |
| S3 | **Standalone generators funcindex CE** | #2079 (ready, sprint 61, unstarted) | F9 blast radius: standalone generators regressed to "function index out of range" CEs; pairs with the landed #2043 validation (which made it loud) | independent; informs #1916 amendment (A2) with fresh index-shift reality |
| S4 | **Base-ctor body execution** — derived construction runs the base constructor *body*; `super(args)` stops being a positional field copy | #1965 (ready, critical, max; queue **#37**) | Highest-severity class bug; empirically informs the class object-model spec (A4) before it's written | coordinate with merged #1833/#2018 (PR 1326); feeds 63's single-ctor-synthesis |

### Dev lane (~14)

| # | Task | Issues | Rationale | Depends on |
|---|------|--------|-----------|------------|
| D1 | **Resume suspended worktree `issue-2084-global-guard`** — review 38-line uncommitted diff, run tests/issue-2084.test.ts, finish read-guard half, PR | #2084 (ready) | Near-done work stranded by the wipe; cheapest PR in the sprint | — |
| D2 | **Fail-loud Phase 0**: `fallback-telemetry.ts` + `scripts/check-codegen-fallbacks.ts` + baseline + CI wiring, instrumenting the ~16 highest-leverage verified sites (8 unary-updates NaN sites, 7 `fieldIdx===-1` skips, identifiers.ts:812) — counts only, zero behavior change | new issue (08 §1, "fallback telemetry") | Lands the *mechanism* for D2; clones #1376/#1530 exactly; can't regress anything | — |
| D3 | **Spec-conformance suite skeleton**: `tests/equivalence/spec/harness.ts` (host + standalone + `-O` lanes, Node oracle, baselined-failure integration) + report 02's eight F2 T-tables + top F1/F5 probes (~150 probes) | new issue (08 §2) | The instrument that found the 170 bugs becomes permanent; **guards S2 and every 63 value-rep phase**; standalone lane doubles as leak check | rides the existing required `equivalence-gate` — zero new CI plumbing |
| D4 | **Oracle step 1** (flag-gated): Wasm trap fails runtime negatives; constructor-name prefix match via existing `extractWasmExceptionMessage`; one measured `workflow_dispatch` sharded run + `/harvest-errors` bucket triage | #1945 (backlog → pull into 62, first slice) | ~30 runner-only lines; makes D5/F5 visible to CI for the first time; default-off so zero baseline impact | — |
| D5 | **Issue→probe CI rule**: `scripts/check-issue-spec-coverage.mjs` in the `quality` job (warning at `ready`, hard-fail at `status: done` without a probe reference; cutoff 2026-06-15) | new issue (08 §3) | Closes the loop: no future sweep-class bug lands without permanent armor | D3 (needs the suite to point at) |
| D6 | **Standalone leak gate**: emit-time import-section assert under `--target standalone` + playground-corpus leak-budget test (clone of host-import-allowlist budget) | new issue (08 §4) | Kills the #2073/#2075 class structurally (D3-disease); "cheap and absolute" per report 04 §3h | counts feed the same ratchet dashboard as D2 |
| D7 | **Baseline-trust validator upgrades**: standalone sample + fail-row sample in `test262-baseline-validate.yml`; flip #1897 to `done` (merged, stale frontmatter) | new issue (08 §5) | Stale fail rows currently inflate `improvements` and mask regressions in every PR diff | — |
| D8 | **Fix `-O` instantiation**: exact-heap-types residual; optimized binaries must instantiate on stock V8/JSC | #1973 (ready, sprint 61) | Correctness bug wearing a perf label; gate for D9 | blocks D9 |
| D9 | **Differential `-O` gate**: 9th equivalence-matrix entry `{optimize:true}` + `diff-test.ts` optimize lane (#1941 steps 1–3) | #1941 (ready, critical) | Three reviewers converged on `-O` as the largest untested correctness surface | D8 |
| D10 | **Structured compile-failure gate**: replace the `"Codegen error:"` string-prefix gate (compiler.ts:731/:1033) with structured severities | #1921 (backlog → pull into 62) | Report 05 §6: "cheap, do first — makes every later consolidation fail loud"; F1's gate-of-gates | — |
| D11 | **Coercion-engine Step 0** (the dependency-safe slice): `coercionPlan` ValType table unifying `coercionInstrs`/`callArgCoercionInstrs`/`fixBranchType` + `guardedRefCast` dedup; table-driven unit test | #1917 (ready; Step 0 only) | Original #1917 acceptance; touches none of S2's frozen regions and none of the in-flight PR sites — safe now. Steps 1+ wait for A1 + S2 (see "explicitly deferred") | A1 amendment should land first (same sprint, doc-only) |
| D12 | **valueOf per-instance dispatch (typed-ref/eqref halves per #1989's plan)** | #1989 (ready; queue **#23** "valueOf typed-ref after $shape") | F10's second half; spec already written; ref-path independent of #2009, eqref-path sequenced after S1's $shape PR-1 merges | S1 (eqref half only) |
| D13 | **Module-strict `arguments` unmapping** | #1952 (ready; queue **#24**) | Easy win; mapped `arguments` in always-strict module code | — |
| D14 | **Native-string spread** `[..."ab"]` → empty array | #1962 (ready; queue **#34** — lead noted "after PR 1352"; reconcile at dispatch, no code dependency found on #1992/#1991) | Standalone-visible win; shares surrogate walk with D15 | — |
| D15 | **Native trim whitespace table** + **string for-of code points** (two small PRs or one paired) | #1963 + #1964 (ready; queue **#35/#36**) | Easy spec-cited wins (F11); #1964 shares the pair-aware walk with D14 | — |

### Architect lane (specs, not PRs — subagent spawns)

| # | Spec | Issues | Why now |
|---|------|--------|---------|
| A1 | **#1917 amendment**: signature becomes `(fromWasmType, toWasmType, staticJsType?)`; add the concat/template/any-to-string sites missing from its inventory; define the **thin TypeOracle slice** (one ctx field, 3–4 queries: `jsTypeTagOf`, nullability, primitive-kind) as #1930's first increment | #1917 + #1930 | Overview §2.1–2.2: dev dispatch of coercion Steps 1+ is blocked on this; cheap doc work |
| A2 | **#1916 amendment**: the symbolic handle must be a collision-free FuncId (declaration-site/ts.Symbol-derived), name as debug metadata only | #1916 | Otherwise #1983/#1989/#2009 survive the rewrite (report 05 §3); implementation itself is sprint 64 |
| A3 | **Host-boundary deep-marshaling contract** (new issue, 08 §6): vec ⇄ array, closure ⇄ callback, struct ⇄ object conversion rules; one layer every bridge import routes through | new | Gates the sprint-64 host-boundary family (D3 disease); unowned today — report 01's biggest ownership gap |
| A4 | **Class object-model spec** (new issue, 08 §7): constructor-as-value + prototype-chain representation; decides #2023/#2026 feasibility | new | F6 has no parent decision; S4's findings feed it; consumed by 63's ctor work |

PO task: reconcile statuses (PR-1352 issues #1992/#1991 → done; #1897 → done),
file the 08 stubs with real IDs, populate the TaskList from this table.

### Sprint 62 — do NOT do (and why)

- **#1927 (multi-file pipeline driver), #1925 (IR interpreter), #1926 (IrType
  ValType removal)** — block nothing in the June corpus (report 05 §6 "can
  wait"); #1926 waits for value-rep P1 + the IR adoption wave.
- **#1946–#1950 (perf items)** — rank below every correctness family
  (report 01 §2); #1973 is the one exception and IS scheduled (D8).
- **#1931 (detectEarlyErrors), #1934 (runtime resolveImport tables)** —
  runtime.ts's June citations are semantic gaps, not structure drift.
- **Coercion Steps 1–4** — blocked on A1 + S2's frozen regions + in-flight
  PRs 1321/1325 (templates/join are exactly Step 1's migration sites).
- **#1916 implementation** — spec amendment (A2) first; impl is sprint 64.
- **Oracle default flip** — needs a sprint of flag-gated soak + measured run
  (63).
- **npm/node builtins #1791–#1795, #1387 `with`** — sprint-61 leftovers;
  park unless the user re-prioritizes the npm front.
- **#1855 grammar fuzzer** — fuzz findings would drown in known-broken
  territory until the 4-lane corpus is green.

---

## Sprint 63 — "engine + brands + honest oracle": coercion steps 1–3, value-rep P1–P3, ratchet promotions, structural consolidations

Sizing: **~18 PRs**. Foundation:visible-win mix ≈ 60:40.

### Coercion engine (dev unless noted; sequenced after S2/P0 merged + A1 amendment)

| # | Task | Issues fixed/absorbed | Depends on |
|---|------|----------------------|------------|
| C1 | **Step 1 — `coercion-engine.ts` skeleton + `emitToString`**: migrate template spans (S4/S5) and join elemToStr (S7); S1/S2/S3/S6 mechanically diff-checked | residue of #2005/#2006 (PR 1321) and #1998/#1997 (PR 1325) land *as engine rows*; #2074 standalone join null-deref; regression guard for #2007/#2008 | 62-D11 (Step 0), 62-A1, S2 merged, PRs 1321/1325 landed |
| C2 | **Step 2 — `emitToPrimitive`**: `+` default-hint pre-pass (binary-ops:941); `host_loose_eq` → `_toPrimitiveSync` routing; `__any_add` ref-tag arm through ToPrimitive; absorb #1900's native helper as SA tail | #2022, #1990, #1988 (+#1989 residue if any) | C1; #1900 (in-review) landed |
| C3 | **Step 3 — `emitStrictEq`/`emitLooseEq`**: single-side-any boxing; tag-2/3 numeric-class unification; standalone `$__any_loose_eq` (string-content + ToNumber arms reusing `__str_to_number`); fix E8 parseFloat→StringToNumber drift | #2081, #2058, #2059 entry points; regression-guards #1986/#1987 (PR 1340) and #2073 | C1; value-rep P1 enum |
| C4 | **Drift gate**: `scripts/check-coercion-sites.mjs` + baseline, wired into `quality` (report 03 §5) | new issue (08 §8) | C1 (vocabulary sealed) |

### Value representation (per report 02 phases; P2/P3 parallelizable after P1)

| # | Task | Issues fixed | Depends on |
|---|------|--------------|------------|
| V1 | **P1 — canonical tag module**: `value-tags.ts` (`JsTag`, `jsStaticType`, `UNDEF_F64`, `boxToAny`); migrate 11 direct `__any_box_*` sites + P0's hint plumbing; tag 7 (function) + `__any_typeof` arm | residue of #2072 | S2 (P0) merged; new issue 08 §9 |
| V2 | **P2 — boolean brand**: producers (≈6 binary-ops returns, 4 object-ops predicates, `.done`) + consumers (8 `emitBoolToString` sites, template spans, `boxToAny`) | #2016, #2030 (done-half), #2005 residue | V1 |
| V3 | **P3 — undefined observability**: producers emit `UNDEF_F64` (#2004 codePointAt, #2030 `.value`, #2001-addendum OOB f64 destructuring, #2051 short-circuit arms); observers check it (`===undefined`, `??`/`?.` gate, typeof, ToString); union-collapse reversal **feature-flagged + measured** | #2004 (PR 1329 covers the NaN half — coordinate), #2051, #2030, #2001-addendum | V1; senior review on the union-collapse flag |

### Fail-loud (per report 04 phases 1–3)

| # | Task | Issues | Depends on |
|---|------|--------|------------|
| F1 | **Phase 1 — null/const sweep**: route the ~30 curated (a)/(c) sites through `reportSilentFallback`; `stack-balance.ts:812` → hard error | class members; #2010 adjacent | 62-D2 |
| F2 | **Phase 2 — arity audit + allowlists**: `compileBoundedCallArgs()` over the 18 `Math.min` loops; unify duplicated Sets (`NATIVE_STR_METHODS`, `mathConstants`) with budget tests; instrument else-branches | #1955, #1958, #2013, #2076, #1957 (visible wins); #1966/#1967 MUTATING/write-back audit | 62-D2 |
| F3 | **Phase 3 — runtime-loudness**: 1M loop caps and `REGEX_STEP_CAP` overflow → `RangeError` throw (standalone exn tag / host `__throw_range_error`) | #2067 (queue-19-old), new REGEX_STEP_CAP issue (08 §10) | 62-D2; throwJsError helper (E1 below) |

### Error model + structural consolidations (report 01 Seed D, report 05's three NEW issues)

| # | Task | Issues | Lane |
|---|------|--------|------|
| E1 | **Handler reachability first** + shared `throwJsError(kind,msg)` lowering | #1972, #2061, new throwJsError issue (08 §11) | senior (#1972 is critical control flow) |
| N1 | **Single-ctor-synthesis**: one `synthesizeImplicitDerivedCtor(repr)` for externref/struct/standalone paths | #2082, #2078; hardens #2020/#2021 | dev; after 62-S4 |
| N2 | **Capture-machinery unification**: object-literal accessors through the `boxedCaptures` ref-cell path | #2011 (hard) | senior |
| N3 | **Per-builtin representation scaffold** (fromCharCode + join families first) | #1955 (with F2), #1968 residue, #2074/#2075 | dev |

### Trust (report 06 sprint-63 items)

| # | Task | Issues |
|---|------|--------|
| T1 | **Oracle step 2 + default flip**: typed `assert_throws`; `oracle_version` stamp in JSONL + cross-version diff guard; coordinated flip PR + re-baseline (protocol 06 §3.3); PO messaging for the headline drop | #1945 completion + 08 §12 |
| T2 | **Probe-migration long tail**: families F3/F4/F6/F7/F11/F12, ~3 bundled PRs | 08 §2 follow-on |
| T3 | **Weekly `-O` test262 lane (D3) + absolute standalone floor backstop** | #1941 step 4 + 08 §13 |
| T4 | **Flake rules in diff-test262** (`ct_suspect`, bucket signature hash) + promote-baseline poison re-run | #1862 residual + 08 §14 |

### Sprint 63 — do NOT do

- **#1927 / #1925 / #1926** — still parked; #1926 unlocks only when IR
  adoption needs brands (post-P1, earliest 64).
- **#1946–#1950 perf** — parked.
- **Value-rep P4–P6, holes (#2001 main body)** — sprint 64; P3's
  union-collapse flag needs measurement soak first.
- **#1916 implementation** — 64 (after A2 amendment + S3's evidence).
- **Linear-backend feature work beyond the correctness floor** — #1974/#1975/
  #1976 wait for the P6 seam; **exception**: #1977 (heap corruption) may be
  pulled in if a dev frees up — memory-unsafety outranks lane priority.
- **#1855 fuzzer** — still premature.
- **CodegenContext decomposition (#1098/#1172)** — the thin TypeOracle slice
  (62-A1) is the only context change any June family needs.

---

## Sprint 64 (sketch) — "standalone conformance + identity + boundary"

Sizing target ~15 PRs; refine at 63 wrap-up.

1. **Value-rep P4** — standalone helper conformance on canonical tags:
   `__any_strict_eq`/`__any_loose_eq` numeric-class {2,3} (#1987 residue),
   `__any_unbox_bool` tag-5 length arm, `$__any_to_string` refval branch,
   **`$undefined` singleton global** (undefined ≠ null in standalone refs),
   `__any_typeof` arms. (senior/dev pair)
2. **Value-rep P5 — holes**: null-ref-as-hole for `any[]`, HOF `HasProperty`
   skips, sparse-literal/write promotion to boxed form; documented
   `number[]` divergence. Fixes #2001. (dev)
3. **Value-rep P6 — linear seam**: `BackendEmitter` union/boxed lowering per
   #1851/#1852; linear f64+i32-tag pair on the shared `JsTag`; cross-backend
   T-backend differential tests (#1854). Linear correctness floor rides
   along: #1977 (push heap corruption), #1974 (`%`), #1975 (truthiness),
   #1976 (string compare). (senior + dev)
4. **#1916 implementation + identity-keyed registries**: symbolic
   collision-free FuncIds per A2; retire the three shift regimes; #1984
   (freeze-point) / #1985 (stale-proof `{idx}` cells) land first as
   incremental hardening if not already pulled forward; #1983 funcMap
   mangling falls out. (senior, multi-PR train)
5. **Host-boundary marshaling family** (per A3 spec): #1969 (concat vec
   spread), #2070 (closure-wrapping unification / HOST_CALLBACK_METHODS),
   #2015/#2025 (`this` routing), #2028 (Promise executor), #1932 (versioned
   ABI), #1935 (undefined sentinel protocol). (dev wave)
6. **#2083 glue-export escape analysis** — emit `__call_fn_*`/`__sget_*`/
   `__vec_*` suites only when a value escapes to the host; pairs naturally
   with the marshaling layer (same seam). (dev)
7. **Differential weekly lane matured**: `-O` test262 baseline trends
   reviewed weekly; consider #1855 fuzzer entry **only if** the 4-lane
   corpus is green. (PO/lead ritual + S task)
8. **Error-model continuation**: trap→catchable conversions through
   `throwJsError` (#2003 residue, #2017, #2024, #2012, #1954, #2000
   residue) — now visible in CI thanks to the 63 oracle flip. (dev wave)
9. **Standalone buckets re-measured** (#2036–#2042): after P0–P4 + leak gate
   + #2079/#2029, re-run the buckets and re-triage what's left to parent
   families. (PO)

### Sprint 64 — do NOT do

- **#1925 (IR interpreter), #1927 (pipeline driver)** — still block nothing;
  revisit only when multi-file compilation or IR-only mode becomes a goal.
- **#1946/#1948–#1950 perf** — parked until value-rep P6 settles the
  representation they'd optimize.
- **Full CodegenContext decomposition** — still deferred (#1172).
- **platform goals (#639+)** — wait for standalone-mode goal progress.

---

## Dependency spine (cross-sprint, one picture)

```
62: S2 #2072/#2080 (P0 boxing) ──► 63: V1 (P1 tags) ──► V2 (P2 brand) ─┐
        │                                  │                            ├─► 64: P4 standalone helpers ─► P5 holes ─► P6 linear seam
62: A1 #1917+hint (+#1930 slice) ──► 63: C1 Step1 ─► C2 Step2 ─► C3 Step3 ─► C4 gate
62: D11 Step0 ────────────────────────┘
62: S1 #2009 $shape ──► 62: D12 #1989 (eqref half)
62: A2 #1916 FuncId amendment ──► 64: #1916 impl + identity registries (#1983)
62: D2 fail-loud Phase0 ──► 63: F1/F2/F3 ──► 64+: STRICT promotions at zero
62: D3 spec suite + D4 oracle step1 ──► 63: T1 flip ──► 64: error-model wave visible
62: D8 #1973 ──► D9 #1941 ──► 63: T3 weekly -O lane
62: A3 marshaling spec ──► 64: host-boundary wave + #2083
62: S4 #1965 ──► 62: A4 class-model spec ──► 63: N1 ctor synthesis ──► 64+: #2023/#2026
```

## Acceptance / exit criteria per sprint

- **62**: P0 merged with T-string/T-typeof probes green in both lanes; ratchet
  dashboards exist (fallbacks, leaks) with baselines committed; oracle step 1
  measured (dashboard run + minted issues); both suspended worktrees landed;
  ≥6 conformance-visible fixes merged; #1917/#1916 amendments ratified.
- **63**: coercion sites baseline strictly lower than its day-1 count; V1–V3
  probe tables green; oracle flipped with `oracle_version` stamped and both
  baselines re-seeded; ≥2 fail-loud classes trending to zero; headline-drop
  comms done.
- **64**: standalone buckets re-measured post-P4; zero non-allowlisted env
  imports in any standalone binary (hard gate); #1916 train merged or
  consciously re-scoped.
