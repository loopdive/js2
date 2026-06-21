---
id: 1625
title: "#779 and #820 cluster decomposition — sprint 54 dispatch plan"
status: ready
created: 2026-05-21
updated: 2026-06-19
sprint: Backlog
renumbered_from: 779
parents: [779, 820]
baseline: "benchmarks/results/test262-current.jsonl (21.5.2026 00:24)"
---
# #779 and #820 cluster decomposition — 2026-05-21

Baseline: `benchmarks/results/test262-current.jsonl` snapshot from
21.5.2026 00:24. The umbrella targets (~8,674 for #779, ~6,993 for #820)
date from the 2026-04-07 official run; since then, multiple sub-issues
have landed and the live JSONL shows much smaller residuals. This audit
re-decomposes the class/elements and class/dstr concentrations within the
umbrellas.

## Live counts in current baseline

| Path-prefix | non-pass | pass |
|-------------|----------|------|
| `class/elements` | 786 (728 fail + 58 compile_error) | 2,176 |
| `class/dstr`     | 1,098 (1,062 fail + 36 compile_error) | 2,742 |

## #779 cluster — class/elements concentration (and broader)

| Sub-issue | Pattern | FAIL count (today) | Status before audit | Status after |
|-----------|---------|--------------------|---------------------|--------------|
| #779 | parent umbrella (8,674 historical) | — | analysis-only | parent |
| #779a | class/dstr method-tramp residual (gen / async-gen / private / static / dflt) | 727 | not filed | **stub created (ready)** |
| #779b | class/elements multi-definition parsing → re-diagnosed as prototype chain gap (~290) | 290 | in sprint 53; bumped to needs-spec (task #91 / #96) | spec in progress |
| #779c | String.prototype.split result `.constructor` is not Array | 78 | landed (task #89) | done |
| #779d | Object-literal dstr residuals (non-class, non-for-of) | 132 | not filed | **stub created (ready)** |
| #779e | arguments-object mapped / trailing-comma / sloppy-strict residuals | 161 | not filed | **stub created (ready)** |

### #779 routed elsewhere (large, owned by other issues)

| Where | Pattern | FAIL count |
|-------|---------|------------|
| #1461 | Array.prototype.* array-like receiver assertion mismatch | ~948 |
| #1460 | Object.defineProperty/defineProperties descriptor fidelity | ~847 |
| #1518 | annexB eval-code direct/indirect | ~104–128 |
| #1396/#1454/#1468 | for-of/dstr residuals | ~252 |
| #1431 | language/expressions/assignment/dstr | ~138 |
| #1543/#1544 (closed) | async-gen-meth and for-of dstr illegal-cast | (already landed) |
| #1553a–e (in flight) | destructuring residuals waves | various |

## #820 cluster — class/dstr concentration (and broader)

| Sub-issue | Pattern | FAIL count (today) | Status before audit | Status after |
|-----------|---------|--------------------|---------------------|--------------|
| #820 | parent umbrella (6,993 historical → 1,316 live) | — | analysis-only | parent |
| #820a | RegExp Symbol.* / RegExpStringIterator null deref | 148 (residual) | in sprint 53 (task #61 completed; verify on next run) | landed pending re-baseline |
| #820b | Object literal computed-property accessor names | 30 | in sprint 53 (task #66 completed) | landed pending re-baseline |
| #820c | Async-gen object-method yield* iterator-protocol null deref | 39 | in sprint 53 (task #73 completed) | landed pending re-baseline |
| #820d | class/dstr async-gen-meth `unresolvable` illegal cast | 104 | in sprint 53 (task #90 in-progress) | in flight |
| #820e | private-method dstr null deref | 18 | not filed (below stub threshold) | **noted only** — track in next baseline; promote to stub if it grows |
| #820f | dynamic-import usage null deref | 22 | not filed (below stub threshold) | **noted only** |
| #820g | module-namespace internals TypeError | 9 | not filed | **noted only** |
| #820h | (Async)DisposableStack brand check + protocol | 74 | not filed | **stub created (ready)** |
| #820i | Function.prototype.* receiver TypeError | 11 | not filed (below threshold) | **noted only** |
| #820j | (Async)GeneratorPrototype brand check + descriptors | 36 | not filed | **stub created (ready)** |
| #820k | Object.* receiver TypeError (RequireObjectCoercible / ToObject) | 39 | not filed | **stub created (ready)** |

## Total addressable per cluster after decomposition

### #779 family (within umbrella scope, this audit's new stubs)

| Sub-issue | Est. FAIL reduction |
|-----------|--------------------:|
| #779a | up to 727 |
| #779d | up to 132 |
| #779e | up to 161 |
| **Subtotal (new stubs)** | **~1,020** |

Plus existing in-flight: #779b (290 prototype chain), and the routed-elsewhere
buckets (#1461 ~948, #1460 ~847, #1518 ~128, #1396/#1454/#1468 ~252,
#1431 ~138, #1553x ~variable). With those, the umbrella has a clear path to
~3,750+ fails worth of attributable work.

### #820 family (within umbrella scope, this audit's new stubs)

| Sub-issue | Est. FAIL reduction |
|-----------|--------------------:|
| #820h | up to 74 |
| #820j | up to 36 |
| #820k | up to 39 |
| **Subtotal (new stubs)** | **~149** |

Plus in-flight: #820a (148), #820b (30), #820c (39), #820d (104). Sub-50
clusters (#820e ~18, #820f ~22, #820g ~9, #820i ~11 = ~60) are not yet
worth their own stub; they remain in the umbrella and will be revisited
once the in-flight items land and the baseline is refreshed.

## Recommended sprint 54 wave assignment

Wave 1 (parallelizable, all `priority: medium-high`, `feasibility: medium`):

1. **#779a** — class/dstr method-tramp residual (727)
   - Highest single-cluster reduction available. Coordinate with #1553x
     dev to avoid double-work; once #1553d lands, re-measure.
2. **#779d** — object-literal dstr residuals (132)
   - Symmetric with #779a; same dev could take both back-to-back.
3. **#779e** — arguments-object residuals (161)
   - Touches arguments.ts + statement-level strict-mode validation; a
     different surface from the dstr work, so good parallel candidate.

Wave 2 (smaller, cleanup):

4. **#820k** — Object.* RequireObjectCoercible (39)
   - Sequence after #1129 (in-progress) so the ToObject pieces are
     consistent.
5. **#820j** — (Async)GeneratorPrototype brand check (36)
   - Pairs naturally with the generator/async-gen lowering work in #1042
     (impl spec in progress per task #88).
6. **#820h** — (Async)DisposableStack brand + protocol (74)
   - Lower-priority because it's an ES2025 surface; defer unless we want
     ES2025 coverage in sprint 54.

Wave 3 (re-baseline driven):

7. Once #779a / #1553x land, re-snapshot the JSONL and revisit #820e
   (private-method dstr null deref ~18) — it may grow or shrink once the
   shared destructuring path is fixed.
8. #820i (Function.prototype.* receiver TypeError ~11) — small; either
   roll into #820k as part of a broader RequireObjectCoercible sweep, or
   leave in umbrella.

## File index (new artifacts from this audit)

- `plan/issues/779a-class-dstr-method-tramp-residual.md`
- `plan/issues/779d-object-literal-dstr-residual.md`
- `plan/issues/779e-arguments-object-residual.md`
- `plan/issues/820h-disposable-stack-brand-check.md`
- `plan/issues/820j-generator-prototype-brand.md`
- `plan/issues/820k-object-receiver-toobject.md`
- `plan/issues/1625-820-cluster-decomposition.md` (this file)

## Method notes

- Baseline `test262-current.jsonl` records `file`, `status`,
  `error_category`, `scope_official`. Decomposition queried by path-prefix
  intersect filename-token prefix intersect error_category — produces tight
  buckets without needing to read the test source.
- Threshold for stub creation: ≥30 fails (mandatory ≥50). Below 30 are
  tracked in the umbrella table but not given their own issue file yet.
- Counts here are non-pass within the live JSONL; historical umbrella
  targets (8,674 / 6,993) date from 2026-04-07 and are recorded for
  longitudinal tracking, not as today's baseline.
