# 08 — New issues to file (consolidated from reports 01–06)

> Everything the analysis program identified that is **not yet filed** as of
> 2026-06-11 (verified against `plan/issues/` — highest existing ID is #2085).
> Each stub is ready for `/create-issue`: title, 3-line problem, root-cause
> pointer, suggested priority/feasibility. Numbering is indicative (next free
> IDs); the PO assigns final IDs at filing.
>
> **Already filed — do NOT re-file** (checked): `buildTruthyCheck` NaN-truthy /
> boxed-falsy divergence = **#2085** (report 03 §2.4 B2 flagged it; it's on
> disk at `plan/issues/2085-buildtruthycheck-nan-boxed-falsy-truthy.md`,
> status backlog). #2044 (BigInt i64 brand) is filed and **ratified** (PR 1337).
> #2048 (merged-PR ⇒ done automation) is filed. #2083 (glue exports) is filed.
>
> **Spec AMENDMENTS to existing issues** (edits, not new files — listed here
> so they aren't lost): (a) **#1917** — add `staticJsType?` to the engine
> signature + the concat/template/any-to-string sites missing from its
> inventory (reports 03 + 05 §2a); (b) **#1916** — symbolic handles must be
> collision-free FuncIds (declaration-site/ts.Symbol-derived), names as debug
> metadata (report 05 §3); (c) **#1930** — define the thin first slice (one
> ctx field, 3–4 queries) as the boxing prerequisite (report 05 §5);
> (d) **#1945** — fold in the step-1/step-2 plan from report 06 §3.2;
> (e) status reconciliation: #1992/#1991 → done (PR 1352 merged), #1897 →
> done (merged, stale `in-review`).

---

## A. Structural consolidations (report 05's three NEW issues)

### 1. #2086 — single implicit-derived-ctor synthesis shared by all three representation paths
- **Problem**: the rule "implicit derived ctor forwards all args to super" is
  implemented three times (externref `class-bodies.ts:1263-1289`, WasmGC
  struct `:1292-1356`, standalone). #1833 fixed one twin; the struct twin
  still synthesizes **zero params** (`new Dog("rex")` → name=null, #2082) and
  the standalone variant zeroes base fields (#2078).
- **Root cause**: `src/codegen/class-bodies.ts:1263-1356` — per-representation
  re-implementation with no shared `synthesizeImplicitDerivedCtor(repr)`.
- **Priority/feasibility**: high / medium (S–M). Unblocks #2082, #2078;
  hardens #2020/#2021. Sprint 63 (N1).

### 2. #2087 — capture-machinery unification: object-literal accessors must use the boxedCaptures ref-cell path
- **Problem**: object-literal accessors build a parallel closure path that
  captures **copies** — writes through accessors never reach outer scope,
  getter/setter pairs don't share state (#2011); compound assignment on
  captured strings diverged the same way (#1999, fixed point-wise).
- **Root cause**: `literals.ts:299-528` parallel path vs the canonical
  `ctx.boxedCaptures` machinery owned by `closures.ts` (threaded through 13
  files).
- **Priority/feasibility**: high / hard (M). Subsumes the structural half of
  #2011. Sprint 63 (N2, senior).

### 3. #2088 — per-builtin representation scaffold (element accessor + coercion), starting with fromCharCode + join
- **Problem**: each builtin re-derives element-load + ToString + null handling
  per representation (host vec / native string / standalone any). join alone
  bred 4 issues (#1968, #1998, #2074, #2075); fromCharCode bred #1955 with
  the single-arg bug copied independently into each of its 4 paths.
- **Root cause**: no shared scaffold parameterized by representation;
  registration scattered across 3 scanner sites (`declarations.ts:545/1164`,
  `index.ts:1035/7258`); `registry/imports.ts` underused.
- **Priority/feasibility**: high / medium (M, repeatable). Sprint 63 (N3).

## B. Fail-loud machinery (report 04)

### 4. #2089 — silent-fallback telemetry + check-codegen-fallbacks ratchet (Phase 0)
- **Problem**: ~33 of the ~135 June wrong-answer bugs trace to seven
  silent-fallback classes (null fallback, lookup-miss skip, NaN/0/false
  constants, arity truncation, allowlist miss, caps, compiler catch); none
  are counted, so the classes keep breeding.
- **Root cause**: no codegen-internal equivalent of the #1376/#1530 IR
  ratchet. Plan: `src/codegen/fallback-telemetry.ts`
  (`reportSilentFallback()`), `scripts/check-codegen-fallbacks.ts` + baseline
  + CI `quality` wiring + `STRICT_FALLBACK_CLASSES` promotion at zero;
  Phase 0 instruments only the ~16 verified sites (8 unary-updates NaN, 7
  `fieldIdx===-1`, identifiers.ts:812).
- **Priority/feasibility**: critical / easy (Phase 0 ~1 day, counts only).
  Sprint 62 (D2). Phases 1–4 ride this issue or split per phase.

### 5. #2090 — stack-balance self-repair must not invent values (hard error)
- **Problem**: the stack-repair pass patches unknown types with a "safe
  default" null — masking the producing bug *twice* (the repair pass exists
  to catch exactly these).
- **Root cause**: `src/codegen/stack-balance.ts:812`. Report 04 §2a marks it
  an uncovered **gap**; §5 Phase 1 says convert to hard error immediately
  (no legitimate trigger).
- **Priority/feasibility**: high / easy (S). Sprint 63 (F1) or fold into
  #2089 Phase 1.

### 6. #2091 — REGEX_STEP_CAP overflow silently reports no-match
- **Problem**: regexes exceeding 1M VM steps return `null` (no match) with no
  diagnostic — a silent wrong answer indistinguishable from a true no-match;
  empty-quantifier loops (#1959) burn the cap and hit this today.
- **Root cause**: `src/codegen/regex/vm.ts:24` + `:107 return null`, and
  `native-regex.ts:68` (duplicated cap). Report 04 §2f gap.
- **Priority/feasibility**: medium / easy (S). Convert to `RangeError` throw
  per report 04 §3f. Sprint 63 (F3, with #2067's loop caps).

## C. Trust / test infrastructure (report 06)

### 7. #2092 — spec-conformance suite: tests/equivalence/spec/ harness + probe corpus
- **Problem**: ~600 ad-hoc June probes found 170 bugs the 2,000+-file corpus
  could not see (hand-picked happy paths; issue tests pin the past). The
  probes live only in issue markdown and will rot.
- **Root cause**: no table-driven value×operator sweeps; no standalone/-O
  execution lanes at PR time. Plan per report 06 §2: harness composed from
  `tests/equivalence/helpers.ts` + `issue-1901.test.ts`'s runStandalone,
  Node as oracle, 4 lanes, open bugs land as baselined failures under the
  required `equivalence-gate`.
- **Priority/feasibility**: critical / medium (M for skeleton + F2/F1/F5
  tables ≈150 probes; long tail in 63). Sprint 62 (D3) + 63 (T2).

### 8. #2093 — issue→probe coverage CI rule
- **Problem**: nothing forces a bugfix issue's repro into the permanent
  suite; the next sweep's bugs will again have no armor.
- **Root cause**: no gate. Plan: `scripts/check-issue-spec-coverage.mjs` in
  the `quality` job — warning at `status: ready`, hard fail when a PR flips
  `status: done` with no probe/test reference; cutoff `created >= 2026-06-15`.
- **Priority/feasibility**: high / easy (S). Sprint 62 (D5).

### 9. #2094 — standalone import-leak budget + emit-time import-section assert
- **Problem**: host imports leak past the strict `addImport` gate into
  standalone binaries (instantiation failures #2073/#2075) via bypasses and
  stale funcMap indices; nothing scans the finished binary.
- **Root cause**: `registry/imports.ts:34-46` gate is bypassable (its own
  comment documents the stale-index hazard). Plan: post-link import-section
  scan under `--target standalone` (structured CE on any non-allowlisted
  `env` import) + playground-corpus leak-budget test cloned from
  `tests/host-import-allowlist-budget.test.ts`.
- **Priority/feasibility**: high / easy (S). Sprint 62 (D6). Counts feed the
  #2089 dashboard (class h).

### 10. #2095 — baseline validator: standalone sample + fail-row sample
- **Problem**: `test262-baseline-validate.yml` spot-checks 50 host `pass`
  rows only. A rotted standalone baseline silently weakens the #1897 floor;
  a stale `fail` row that now passes inflates `improvements` and masks one
  real regression per PR diff.
- **Root cause**: validator samples one lane, one row class. Report 06 §5.1 +
  §6.2.
- **Priority/feasibility**: medium / easy (S). Sprint 62 (D7). Include the
  #1897 status flip.

### 11. #2096 — oracle_version stamping + cross-version diff guard
- **Problem**: tightening the test262 oracle (#1945) flips pass rows to fail;
  without a version stamp, every PR after the flip diffs apples to oranges
  and the regression gate fires on oracle skew.
- **Root cause**: JSONL rows and merged reports carry no oracle identity.
  Plan: stamp `oracle_version`, teach `scripts/diff-test262.ts` to refuse
  cross-version diffs unless `ORACLE_REBASE=1`; `promote-baseline` re-seeds
  at the new version on merge.
- **Priority/feasibility**: high / easy (S). Sprint 63 (T1, lands with the
  flip). Could be folded into #1945 — file separately so the protocol has an
  owner even if #1945's steps split.

### 12. #2097 — absolute standalone pass-count floor (high-water-mark backstop)
- **Problem**: the #1897 floor is *moving* (re-seeded every push to main), so
  a sequence of small-net-negative PRs compounds ratchet-free.
- **Root cause**: tolerance-vs-rolling-baseline design. Plan: weekly job (or
  D3 step) asserting standalone pass ≥ high-water-mark − 50, mark committed
  like `benchmarks/results/test262-current.json`.
- **Priority/feasibility**: medium / easy (S). Sprint 63 (T3).

### 13. #2098 — flake-classification rules encoded in diff-test262
- **Problem**: triage rules live in tribal memory ("pass→compile_timeout is
  runner-load flake unless baseline compile >5s"; "identical clusters across
  unrelated PRs are drift") and are re-derived by every agent.
- **Root cause**: `scripts/diff-test262.ts` doesn't read `timing.compileMs`
  or emit a bucket-signature hash. Plan: `ct_flake`/`ct_suspect` split +
  stable signature hash in the summary (output-only, no gate change).
- **Priority/feasibility**: low / easy (S). Sprint 63 (T4).

### 14. #2099 — promote-baseline must re-run (not carry forward) poison-classified rows
- **Problem**: phantom `Binary emit error` rows from poisoned workers can
  persist across baseline promotions (the #1080 drift class); #1862's
  acceptance boxes 2–3 are unchecked.
- **Root cause**: `promote-baseline` carries rows matching
  `POISON_ERROR_RE` forward instead of re-running them
  (#1862 investigation item 3, unimplemented).
- **Priority/feasibility**: medium / easy (S). Sprint 63 (T4). Alternatively
  reopen/extend #1862 (in-review) rather than file new.

## D. Architecture decisions / family parents (report 01 gaps)

### 15. #2100 — architect spec: deep-marshaling contract at the host boundary
- **Problem**: Wasm↔host value conversion is decided ad hoc per call site —
  vecs cross opaque in some bridges and converted in others (#1996/#1969/
  #1998), closures are sometimes wrapped as host callbacks and sometimes not
  (#2070), `this` routing diverges (#2015/#2025). ~14 issues; F4 is unowned
  as a family.
- **Root cause**: no declared conversion contract (vec ⇄ array, closure ⇄
  callback, struct ⇄ object) with one layer every bridge routes through;
  `HOST_CALLBACK_METHODS` is dead code.
- **Priority/feasibility**: high / spec-only (architect). Sprint 62 (A3);
  consumers in 64.

### 16. #2101 — architect spec: class object model (constructor-as-value + prototype chain)
- **Problem**: classes lower to flat structs + static dispatch with no
  ctor-function object and no prototype object — `new.target` is constant 1
  (#2023), classes aren't first-class values (#2026), inherited statics
  unreachable (#2020), `in` can't walk a chain (#1991 fixed point-wise).
- **Root cause**: no representation decision for "class as value / chain";
  the upstream review grades WasmGC codegen C− but proposes no class-model
  work.
- **Priority/feasibility**: high / spec-only (architect). Sprint 62 (A4);
  decides #2023/#2026 feasibility; #1965/#2082 findings feed it.

### 17. #2102 — shared throwJsError(kind, msg) lowering + trap-site audit
- **Problem**: runtime checks lower to uncatchable Wasm traps (or nothing)
  where the spec requires catchable TypeError/RangeError/ReferenceError —
  10+ issues (#2003 charCodeAt OOB, #2017 getter-only assignment, #2012
  freeze, #1954 TDZ, #2000 Array RangeError).
- **Root cause**: no shared "throw a JS error" helper that bounds/integrity/
  callable checks route through (standalone: exn tag; host:
  `__throw_*` imports).
- **Priority/feasibility**: high / medium. Sprint 63 (E1, after #1972/#2061
  make handlers reachable). F5's structural fix; oracle step 1 is its
  detector.

### 18. #2103 — shared binding-info analysis (assigned? captured? declaration order?)
- **Problem**: each lowering keeps its own binding snapshot and forgets to
  invalidate it — localMap shadows leak (#2064), for-of/for-in iterate stale
  snapshots (#2065/#2066), isStaticNaN ignores reassignment (#2057), rethrow
  ignores catch-param reassignment (#2062), conversion buffers go stale
  (#1970).
- **Root cause**: no single mutation/capture/order oracle consulted by
  closure capture, const-folding, snapshot caching, and scope save/restore.
- **Priority/feasibility**: medium / hard (M; F7 parent). Sprint 64+ —
  members remain individually fixable meanwhile.

## E. Value representation phase issues (report 02 — file as the P1–P4 work splits)

### 19. #2104 — value-rep P1: canonical JsTag module + boxToAny consolidation
- **Problem**: tag policy lives in scattered `__any_box_*` call sites; the
  enum, `jsStaticType` classifier, `UNDEF_F64` constant, and tag 7
  (function) have no single home, so phase-0's fix can erode.
- **Root cause**: no `src/codegen/value-tags.ts`; `coerceType` carries no
  TS-type param (351 call sites get an optional `jsType?`).
- **Priority/feasibility**: high / medium. Sprint 63 (V1). Depends on
  #2072/#2080 (P0) merging.

### 20. #2105 — value-rep P2: boolean brand producers + consumers
- **Problem**: bare-i32 booleans stringify as "1"/"0" wherever the checker
  consult can't see (any receivers, synthesized results): #2016
  hasOwnProperty, #2030 `.done`, #2005 residue.
- **Root cause**: brand `{kind:"i32", boolean:true}` exists (#1788) with ~1
  producer and 4 consumers; ≈20 producer + ≈12 consumer sites need it.
- **Priority/feasibility**: high / medium. Sprint 63 (V2).

### 21. #2106 — value-rep P3: undefined observability (UNDEF_F64 + union-collapse reversal + standalone $undefined singleton)
- **Problem**: `T | undefined` collapses to bare T, so undefined becomes
  NaN/0 in numeric carriers and is unobservable to `===`/`??`/`?.`/typeof/
  ToString (#2004, #2051, #2030, #2001-addendum); standalone `undefined`
  and `null` are the same bit pattern (`ref.null extern`).
- **Root cause**: union collapse at `index.ts:9108-9117`/
  `type-mapper.ts:79-99`; observers don't check the existing sNaN sentinel;
  `late-imports.ts:535-543` null-extern fallback. The `$undefined`
  singleton global (tag-1 `ref $AnyValue`) is the standalone half.
- **Priority/feasibility**: high / hard (union-collapse arm is
  feature-flagged + measured). Sprint 63 (V3); singleton lands with P4 if
  sequencing prefers.

### 22. #2107 — value-rep P4: standalone any-helper conformance on canonical tags
- **Problem**: helpers dispatch on stale tag assumptions — `__any_strict_eq`
  bails on tagA≠tagB so `0 === -0` fails across tags 2/3 (#1987 residue),
  `__any_unbox_bool` has no tag-5 length arm, `$__any_to_string` lacks the
  refval string branch, `__any_typeof` lacks tag-5/6/7 arms.
- **Root cause**: `any-helpers.ts:384-443/887-1000/1076-1163`,
  `native-strings.ts:5480-5586` — consumer-side fixes deferred from P0.
- **Priority/feasibility**: high / medium. Sprint 64 (item 1); coordinates
  with coercion Step 3 (C3 owns the operator entry points, P4 owns the
  helper bodies).

## F. Coercion engine support (report 03)

### 23. #2108 — coercion drift gate: scripts/check-coercion-sites.mjs
- **Problem**: nothing stops a 9th ToString copy; #2073's in-flight PR
  already adds a fresh inline ToNumber matrix — drift continues during
  normal sprint work.
- **Root cause**: the sealed vocabulary (`__extern_toString`,
  `__any_to_f64`, `__host_loose_eq`, …) is callable from anywhere. Plan per
  report 03 §5: grep-count baseline outside `coercion-engine.ts`, growth
  fails, `--update-on-decrease` ratchets, non-exported internals.
- **Priority/feasibility**: high / easy (S). Sprint 63 (C4, after Step 1
  seals the vocabulary).

### 24. #2109 — BigInt mixed loose-equality uses parseFloat instead of StringToNumber
- **Problem**: `10n == "10"`-class comparisons route through JS `parseFloat`
  semantics, not §7.1.4.1 StringToNumber — the same drift disease #1134
  fixed elsewhere (accepts trailing garbage, rejects "0x" forms).
- **Root cause**: `binary-ops.ts:960-1010` (E8 in report 03 §2.3).
- **Priority/feasibility**: low / easy (S). Absorb into coercion Step 3 (C3)
  or fix standalone with a spec citation.

---

## Filing checklist for the PO

1. File A1–A4 + B + C items before sprint-62 dispatch (they're 62 tasks);
   D/E/F items before their consuming sprint.
2. Apply the five spec amendments listed in the header (edits to #1917,
   #1916, #1930, #1945 + status reconciliation #1992/#1991/#1897).
3. Set `goal:` per the goal-graph delta in `00-program-overview.md` §4
   (value-representation-integrity / fail-loud-compiler /
   trust-infrastructure / host-boundary-contract) once those goals are
   ratified — otherwise use the nearest existing goal.
4. Update `plan/issues/backlog/backlog.md` and the dependency graph with the
   edges from `07-sprint-62-63-64-proposal.md`'s dependency spine.
