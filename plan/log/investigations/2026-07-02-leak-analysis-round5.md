# Leak-analysis round 5 — execution-verified sole-import levers (2026-07-02)

**Task:** round-5 measurement (fresh session, dev). **Source artifact:** freshest
successful `merge_group` `test262-merged-report` — run **28605503741**
(2026-07-02T16:26Z, head `cab9680`), both-lane merged jsonl. Recomputed raw per
the round-1..4 method (`host_free_pass` = `status == "pass"` AND zero `env::`
imports), and re-ran inject-throw vacuity probes against **current `origin/main`
(`4c74c87`)** — NOT trusting round-4's verdicts, because a large batch landed
today (#2984/#2985/#2992/#2986-89/#2962/#2938/#2953/#2972 + parallel-session
#1916/#2140/#1930/#2134/#2141/#2934).

## Headline numbers (current)

| scope                           | standalone n | pass   | **host_free_pass** | leaky_pass | js-host pass | honest gap |
| ------------------------------- | ------------ | ------ | ------------------ | ---------- | ------------ | ---------- |
| ALL records                     | 48,118       | 27,647 | 18,937             | 8,710      | 34,824       | 15,887     |
| **OFFICIAL** (`scope_official`) | 43,136       | 26,507 | **18,586**         | 7,921      | 33,333       | **14,747** |

**Movement vs round-4 (official):** `host_free_pass` 18,024 → **18,586 (+562)**;
honest gap 15,259 → **14,747 (−512)**. Real progress from today's batch, but far
smaller than the "substantial move" the batch size suggested — most of today's
PRs shifted multi-import async/gen mass, not the host-free count.

Official gap decomposition: 7,921 leaky passes + 6,826 standalone-fail/CE where
js-host passes. Official **sole-leak** passes (exactly one distinct `env::`
import): **1,440**.

## CRITICAL vacuity caveat — the raw 18,586 is honest ONLY because the vacuous cluster is still LEAKY on main

The `testWith[BigInt]TypedArrayConstructors(function(TA){...})` wrapper-callback
class is **confirmed still VACUOUS on current main** (`4c74c87`) by fresh
inject-throw probes (the callback body is dead code — see verdict table). On main
these tests still carry their host import (`__make_callback` etc.), so they are
**leaky, hence correctly EXCLUDED** from the 18,586. The number is honest today.

**The trap (unchanged from round-4, memory
`project_hostfree_pass_can_be_vacuous_inject_throw_probe`):** the in-flight
BigInt-TA runner shim (shipped inside **PR #2463**, branch
`issue-2940-vacuity-scorer`, **OPEN / CLEAN, NOT merged**) removes those imports,
which would flip ≈**1,433** vacuous tests from leaky → host-free and spuriously
inflate raw `host_free_pass` by ~1,433 (PR #2463's own measurement:
17,802 → 16,369 on its branch). PR #2463 is designed to fire the vacuity
**scorer** in the *same* PR so those 1,433 score `fail`+`vacuous:true` and are
structurally re-excluded — net-neutral. **So the TA-wrapper cluster is a
NET-ZERO honest lever** until PR2 (#2939, the dynamic-dispatch fix) makes the
callbacks actually EXECUTE.

- **Raw host_free_pass (official, current main) = 18,586** — CI-reported, honest today.
- **After #2463 lands (scorer + shim together) ≈ 18,586** (net-neutral by design).
- **Do NOT ship the BigInt-TA shim without the scorer** — that path alone would
  dishonestly report ~20,019.

Root blocker for making these callbacks execute is unchanged today:
`src/codegen/expressions/calls-closures.ts` (~L680–705) exact-arity + kind
closure-match gate — no commits touched this file on 2026-07-02. Routed to the
senior/dispatch lane (#2939).

## Sole-import lever ranking (official, current) + execution verdicts

Probe = inject `throw new Error('VACUITY_RAN')` before the first executing
assert/check, run standalone via `runTest262File(..., "standalone")` on current
main. VACUOUS = injected copy still passes (body dead); GENUINE = injected copy
fails (body runs).

| lever                              | sole   | verdict (this session, main `4c74c87`)         | class                                         |
| ---------------------------------- | ------ | ---------------------------------------------- | --------------------------------------------- |
| `env::__make_callback`             | **663**| **VACUOUS** (probe: TA/reduce/BigInt callback) | TA-wrapper — net-zero until #2939             |
| `env::__extern_eval`               | 316    | — (SKIP-CLASS: eval)                           | excluded                                      |
| `env::__dynamic_import`            | 80     | — (SKIP-CLASS: dynamic import)                 | excluded                                      |
| `env::__get_globalThis`            | **47** | **GENUINE**                                    | globalThis substrate                          |
| `env::WeakMap_set`                 | 34     | **VACUOUS** (TA/set wrapper)                    | TA-wrapper — net-zero                          |
| `env::SharedArrayBuffer_new`       | 27     | **VACUOUS** (TA ctors buffer-arg)              | TA-wrapper — net-zero                          |
| `env::Promise_new`                 | 17     | mixed — 11 are TLA-syntax (skip-adjacent)      | ~5 genuine (Object.seal/Promise)              |
| `env::__instanceof_check`          | **17** | **GENUINE** (mostly; 1 of 2 samples dead)      | legacy S15.x instanceof routing               |
| `env::Object_isPrototypeOf`        | **12** | **GENUINE**                                    | native isPrototypeOf                          |
| `env::Uint8ClampedArray_*` (cluster)| **85** | **VACUOUS** (some/join/fill probed)            | TA-wrapper — net-zero                          |
| `env::__array_from_iter`           | 10     | **GENUINE**                                    | iterator-protocol (dstr-from-iterable)        |
| `env::__iterator`                  | 9      | **GENUINE**                                    | iterator-protocol (entries/values)            |
| `env::Object_get_constructor`      | 9      | **GENUINE**                                    | native `.constructor` access                  |
| `env::CanvasRenderingContext2D_fill`| 8     | **VACUOUS** (TA/fill wrapper; misnamed)        | TA-wrapper — net-zero                          |
| `env::DisposableStack_new`         | 7      | **GENUINE** (but ERM feature, not a lever)     | explicit-resource-mgmt                        |
| `env::__call_1_f64`                | 6      | **GENUINE**                                    | Array predicate-method routing                |
| `env::AsyncDisposableStack_new`    | 5      | (ERM feature)                                  | explicit-resource-mgmt                        |
| `env::__new_Object`                | 5      | **GENUINE**                                    | subclass-of-builtin Object                    |
| `env::Object_set_constructor`      | 5      | GENUINE (paired w/ get_constructor)            | native `.constructor` set                     |

**Confirmed-vacuous TA-wrapper cluster (sole) ≈ 817** (`__make_callback` 663 +
`WeakMap_set` 34 + `SharedArrayBuffer_new` 27 + `Uint8ClampedArray_*` 85 +
`CanvasRenderingContext2D_fill` 8) — the same ≈1,433-test population when counted
across both strict lanes / including multi-import. **These are NOT levers** in the
honest sense; they convert only when #2939 executes the callbacks.

**Honest convertible sole-lever budget:** 1,440 total sole − 396 skip-class
(`__extern_eval` 316 + `__dynamic_import` 80) − ≈817 vacuous TA cluster ≈ **~227
genuine, execution-verified, convertible sole passes.** Modest.

## Top 5 GENUINE (execution-verified, non-vacuous) levers + honest yield

1. **`__get_globalThis` native substrate — ~47 sole (GENUINE).** Clusters:
   annexB `emulates-undefined` (document.all), `global-code`, Array/prototype,
   Proxy/defineProperty. Needs a standalone `globalThis` value/identity object.
   Honest yield ≈ 47 sole + small multi-import tail. **Small-M issue.**
2. **Iterator-protocol tail — ~19 sole (GENUINE):** `__array_from_iter` 10 +
   `__iterator` 9. Destructuring-from-iterable (`ary-init-iter-no-close`,
   class dstr private-meth) + Array `entries`/`values`/`keys` iterator objects.
   Native iterator lowering. Honest yield ≈ 19. **S/M issue.**
3. **Object reflection/constructor tail — ~19 sole (GENUINE):**
   `Object_get_constructor` 9 + `__new_Object` 5 + `Object_set_constructor` 5.
   Native `.constructor` get/set + subclass-of-builtin `Object`. Honest yield
   ≈ 19. **S issue.**
4. **`__instanceof_check` residual — ~12–17 sole (mostly GENUINE):** legacy
   `language/expressions/instanceof/S15.x` shapes still routing to the host
   predicate though native `instanceof` exists → routing/coverage gap (1 of 2
   probed samples was dead, so cap the estimate at ~12). Honest yield ≈ 12.
   **S issue.**
5. **`Object_isPrototypeOf` native — ~12 sole (GENUINE):** native
   `Object.prototype.isPrototypeOf`. Scattered Number/String/Function/Boolean
   S-tests. Honest yield ≈ 12. **S issue.**

Honorable mentions (genuine but not top-5): `__call_1_f64` (~6, Array
find/map/filter predicate routing — native methods exist, routing gap);
DisposableStack/AsyncDisposableStack (~12 combined, but explicit-resource-mgmt
is a whole feature, not a sole-lever fix).

## The real mass is NOT sole levers — it's the multi-import async/gen substrate

Sole levers cap out at ~227 honest passes. The leaky **mass** is multi-import,
by touch-count across all official leaky passes:

| import                        | touch |
| ----------------------------- | ----- |
| `__get_caught_exception`      | 6,158 |
| `__gen_create_buffer`         | 4,910 |
| `__make_callback` (mostly TA) | 4,876 |
| `__gen_next`                  | 3,958 |
| `Promise_reject`              | 3,214 |
| `Promise_resolve`             | 3,200 |
| `Promise_then2`               | 3,146 |
| `__create_async_generator`    | 2,936 |
| `__create_generator`          | 2,215 |
| `Promise_then`                | 2,064 |

Sole counts here ≈ 0 — these ride the in-flight XL lanes (#2938 no-yield
generators, #2922 combinators, async widen). No new issue needed; this is where
the convertible leaky mass lives, and it converts in bulk only as the
generator/async/Promise substrate lands natively.

## Judgment calls flagged to lead

- **PR #2463 (vacuity scorer, −1,433 integrity correction) is OPEN/CLEAN, not
  merged.** Until it lands, raw `host_free_pass` (18,586 official) is honest
  *because the TA cluster is still leaky on main*. If anyone ships the BigInt-TA
  runner shim WITHOUT #2463's scorer, the metric jumps to ~20,019 dishonestly.
  **Recommend prioritising #2463 merge** so the metric is structurally
  self-honest before #2939 (dispatch fix) starts converting the cluster.
- The dispatch blocker (`calls-closures.ts` arity/kind gate) was untouched today;
  the ~817/1,433 TA-wrapper cluster remains a net-zero honest lever pending #2939.

## Method / repro

- Artifact: `gh run download 28605503741 -R loopdive/js2 -n test262-merged-report`
  (→ `test262-standalone-results-merged.jsonl`, `test262-results-merged.jsonl`).
- Recompute + ranking: `/workspace/.tmp/round5/analyze.py`, `levers.py`, `paths.py`
  (worktree-local, gitignored; logic inline in this note's tables).
- Vacuity probes: `.tmp-probe{,2,3}.mts` in the round-5 probe worktree (cleaned
  up) — control + assert-injected copies through the real
  `runTest262File(file, cat, 30000, "standalone")` on `origin/main` `4c74c87`.
  Injection point: `throw new Error('VACUITY_RAN')` before the first executing
  `assert`/`verify`/`$ERROR`/`if(`; VACUOUS iff the injected copy still passes.
