---
id: 4784
title: "triage: 12 failing rows in four issue-* unit suites that are red on main and gate nothing"
status: in-progress
sprint: current
created: 2026-08-27
priority: high
horizon: m
feasibility: medium
task_type: chore
area: testing
related: [745, 3688, 4564, 4621, 4774]
# (2026-08-27) Id reserved via `claim-issue.mjs --allocate --allow-unscanned`
# because this container has no `gh`, so the tool's open-PR id scan degrades
# unconditionally. The scan was NOT skipped — it was run directly against the
# REST API with curl: 11 open PRs on loopdive/js2 touch issue ids {1691, 3481,
# 3525, 4774, 4775, 4777, 4778, 4779, 4780, 4781, 4782}. 4784 is not among them.
---

# #4784 — four `issue-*` unit suites are red on `main`, gate nothing, and nobody owns them

## Problem

While validating [#4774](https://js2wasm.loopdive.com/dashboard/issue.html?slug=4774-invalid-module-mixed-return-prototype-concat)
I ran four neighbouring suites purely to attribute my own change, and found
**12 failing rows that were already failing on unmodified `main`**. My change
was not responsible for any of them — but nothing else was watching them
either.

This is the same class as the red suite that hid the 28.5x regression a sibling
lane has just fixed: **red on main, ungated, unowned** is now a known-dangerous
state, because a suite that is already red cannot report the next regression
that lands in it. That is what this issue exists to close.

**Scope of this issue is triage, not repair.** Each row below carries an open
question. Answering the question — stale pin vs. real regression vs.
environment prerequisite — is the work. Do not assume the classification
sketched here; it is only what the failure *message* says.

## How this was measured

- Run: `vitest run <file> --pool=forks --poolOptions.forks.singleFork=true --no-file-parallelism`
- **A/B confirmed pre-existing.** Every row was observed with the working tree's
  only modified file (`src/codegen/binary-ops.ts`) reverted to `origin/main`'s
  copy, verified byte-identical to `git show origin/main:src/codegen/binary-ops.ts`.
  The failing set is identical with and without #4774's change: same 12 rows,
  same messages.
- Container: 4-core dev container, no `gh`, no prebuilt QuickJS eval provider.
  **This last fact matters — see group C.**

## The 12 rows

### Group A — `tests/issue-745.test.ts` (4 rows)

Genuine assertion/runtime failures. No missing-artifact message; the module
built and then misbehaved.

| # | row | expected | actual |
| --- | --- | --- | --- |
| A1 | S2 › `number\|string` local: typeof-narrowed arithmetic after cross-kind write | test runs and returns its value | `RuntimeError: illegal cast` |
| A2 | S2 › explicit `unionAnyRep:true` still honored (option overrides lane default) | test runs and returns its value | `RuntimeError: illegal cast` |
| A3 | S4 › union PARAM: typeof-dispatch + as-cast string member read across two call sites | test runs and returns its value | `RuntimeError: dereferencing a null pointer` |
| A4 | S4 › `boolean\|string` union param round-trip (tag-4 brand preserved) | `1` | `0` |

Note A1/A2 both trap with `illegal cast`, and A3 with a null deref, *after*
`expect(r.success).toBe(true)` passed — i.e. `compile()` reported success and
the module then failed at runtime. That is the same success-is-not-validity
shape #4774 documented, so these four may or may not share a cause with it.

**Open question per row:** is this a stale expectation from when the
`unionAnyRep` carrier landed (#745 S2/S4), or a live regression in the union
carrier that arrived later and was never noticed because this file does not
gate?

### Group B — `tests/issue-3688-static-number-equality.test.ts` (1 row)

| # | row | expected | actual |
| --- | --- | --- | --- |
| B1 | shape › **POSITIVE CONTROL** — a dynamic operand still reaches the generic ladder | `true` | `false` (message: "dynamic `===` must still use the generic path") |

**This one deserves attention out of proportion to its count.** It is a
*positive control* — a row whose whole job is to prove the test's negative
assertions are meaningful. A failing positive control means the rest of the
file's green rows are of unknown value: they may be passing vacuously. So B1 is
not one failing row, it is a question mark over the entire suite.

**Open question:** did the narrowing in #3688 widen far enough to swallow the
control case (making the control stale and needing a new dynamic operand), or
does the generic ladder genuinely no longer get reached — in which case the
optimisation is firing where it should not?

### Group C — `tests/issue-4621.test.ts` (5 rows)

**Four of these name a missing local build artifact, not a wrong answer.** The
error is verbatim:

```
JS2WASM_EVAL_ENGINE=quickjs but the quickjs provider is not built
(missing .test262-cache/quickjs-artifact-2e2d7736713beeda/libquickjs.wasm).
Run: node scripts/build-quickjs-eval-provider.mjs
```

| # | row | expected | actual |
| --- | --- | --- | --- |
| C1 | C › `built-ins/global/S10.2.3_A1.1_T3.js` — global code — Date !== null | `"pass: "` | `"fail: …quickjs provider is not built…"` |
| C2 | C › `built-ins/global/S10.2.3_A1.2_T3.js` — function code — Date !== null | `"pass: "` | `"fail: …quickjs provider is not built…"` |
| C3 | C › `built-ins/global/S10.2.3_A1.3_T3.js` — control (eval-code variant, tier-tolerant) | `true` | `false`, via the same provider-not-built error |
| C4 | residuals › `language/literals/regexp/S7.8.5_A1.1_T2.js` — 65k eval loop now completes | `"pass: "` | `"fail: …quickjs provider is not built…"` |
| C5 | residuals › `language/statements/try/S12.14_A18_T6.js` (valueOf-object loses identity across throw) | `not.toBe("pass")` — pinned to STILL FAIL | `"pass"` — the row now passes |

C1–C4 are almost certainly an **environment prerequisite of this container**,
not a defect: they demand a QuickJS provider this box never built. I did not
build it, so I cannot say whether they are green in CI.

C5 is different and is the interesting one: it is an **inverted pin** ("must
still fail") that now fails *because the row started passing*. It ran fine
without the provider, so it is not artifact-blocked.

**Open questions:** (a) does CI build the QuickJS provider, so C1–C4 are green
there and this is purely a local-dev papercut — or are they red in CI too? If
they are local-only, the real defect is that the suite gives no actionable
skip and instead reports four confusing failures. (b) For C5: the compiler
improved and the pin was never refreshed — confirm the improvement is genuine
(not an accidental pass) and retire the pin.

### Group D — `tests/issue-4564-carrier-addition.test.ts` (2 rows)

| # | row | expected | actual |
| --- | --- | --- | --- |
| D1 | closure/Date ToPrimitive › honors an inherited `Function.prototype` valueOf override | test runs | `TypeError: WebAssembly.instantiate(): Import #0 module="js2wasm:runtime-eval": module is not an object or function` |
| D2 | closure/Date ToPrimitive › honors an inherited `Function.prototype` toString override | test runs | same |

The other ~18 rows in this file pass, including the neighbouring
"throws when both inherited Function conversion methods return objects" — so
whatever pulls in the `js2wasm:runtime-eval` import is specific to these two.

**Open question:** is this the same environment-prerequisite family as group C
(the harness not supplying a runtime-eval provider), or did an inherited-
override path start emitting a `js2wasm:runtime-eval` import it should not need
in the standalone lane? The second reading would be a real defect — standalone
is supposed to be host-free.

## Why it matters

None of these four files is a required check. That is the actual finding: the
rows have been failing silently, so the suites cannot do the one job they exist
for. A regression landing in `issue-745`'s union-carrier coverage today would be
indistinguishable from the four failures already there.

The secondary cost is the one this issue was born from: an agent validating an
unrelated change has to spend a full A/B cycle proving each red row is not its
own. I ran these four files twice — once with my change, once with `main`'s
codegen — purely to establish that. That tax is paid by every lane that touches
this area.

## Acceptance criteria

- Every one of the 12 rows has a verdict: **stale pin** (refresh or retire it),
  **real defect** (file it, with the row as the repro), or **environment
  prerequisite** (make the suite skip with an actionable message instead of
  failing).
- No row is left in the "fails and nobody knows why" state that made this issue
  necessary.
- B1 specifically: state whether `issue-3688`'s remaining green rows are
  meaningful, since a dead positive control cannot vouch for them.
- Once the rows are green or honestly skipped, say whether these suites should
  join a gating lane — an ungated suite that nobody runs will silently rot back
  to this state, which is the root cause here rather than any individual row.

## Pointers

- A/B method used: copy `src/codegen/binary-ops.ts` aside, `git show
  origin/main:<path>` over it, re-run, restore. See #4774's Resolution section
  for the same technique applied to digests.
- The QuickJS provider builds with `node scripts/build-quickjs-eval-provider.mjs`
  or is supplied via `JS2WASM_QUICKJS_ARTIFACT_DIR`; check what CI does before
  concluding C1–C4 are red on main rather than red in this container.

---

# Triage result (2026-08-28, `claude/issue-4784-red-rows-triage`)

Base for every measurement below: `origin/main` @ `117c678e71`. All 12 rows
were **re-confirmed red on that base** before anything was touched — nothing
had healed since filing.

## Verdict table

| # | Row | Verdict | Evidence |
| --- | --- | --- | --- |
| A1 | `#745` S2 typeof-narrowed arithmetic after cross-kind write | **real defect — NOT fixed here, claimed territory** | Root cause isolated (below). Belongs to [#745](https://js2wasm.loopdive.com/dashboard/issue.html?slug=745-tagged-union-representation-to-replace), `status: in-progress`, claimed by `ttraenkler/sr-745-s45` on `issue-745-s45-flip` (read from `origin/issue-assignments:745.json`). |
| A2 | `#745` S2 explicit `unionAnyRep:true` still honored | **same defect as A1** | Same trap, same site; the explicit flag reaches the same lowering. |
| A3 | `#745` S4 union PARAM typeof-dispatch across two call sites | **same family — NOT fixed** | Needs *two call sites of different runtime kinds*; single-kind version returns `3` correctly. |
| A4 | `#745` S4 `boolean\|string` param round-trip (tag-4 brand) | **same family — NOT fixed** | Same two-call-site trigger; `h(true)`→`1` and `h("b")`→`2` each pass alone, together `0`. |
| B1 | `#3688` POSITIVE CONTROL — dynamic operand reaches generic ladder | **stale control — FIXED** | The ladder *is* reached; the detection was blind to tail calls. |
| C1 | `#4621` `S10.2.3_A1.1_T3.js` global code | **real ABI defect — FIXED** | Green after the provider-namespace fix. |
| C2 | `#4621` `S10.2.3_A1.2_T3.js` function code | **real ABI defect — FIXED** | Green after the same fix. |
| C3 | `#4621` `S10.2.3_A1.3_T3.js` tier-tolerant control | **real ABI defect — FIXED** | Green; its designed tier-tolerance could never engage while the module failed to *link*. |
| C4 | `#4621` `S7.8.5_A1.1_T2.js` 65k eval loop | **real ABI defect — FIXED** | Green after the same fix. |
| C5 | `#4621` `S12.14_A18_T6.js` inverted pin ("must still fail") | **stale pin — FIXED (retired)** | Row passes; verified tier-independent, flipped to a positive pin. |
| D1 | `#4564` inherited `Function.prototype` valueOf override | **real REGRESSION — NOT fixed, needs design** | Bisected to `372f6b6aae` (2026-08-25). |
| D2 | `#4564` inherited `Function.prototype` toString override | **same regression as D1** | Same commit, same predicate. |

Net: **6 of 12 rows fixed** in this branch (B1, C1–C5), **6 dispositioned**
with a root cause and an owner (A1–A4, D1–D2).

## The finding that mattered most: one ABI gap explained 6 of the 12 rows

C1–C4 were filed as a suspected local-environment papercut ("the QuickJS
provider is not built"). That message was a **red herring** — it is just what
this container prints when `JS2WASM_EVAL_ENGINE` is unset (the default is
`quickjs`). Running the suite the way CI runs it — `JS2WASM_EVAL_ENGINE=
interpreter`, which is what both `ci.yml`'s changed-root-test gate and
`issue-tests.yml` set — replaced it with the *real* error, and that error was
**the same one group D reports**:

```
LinkError: Import #2 module="js2wasm:runtime-eval"
           function="__runtime_script_eval": function import requires a callable
```

Root cause: `__runtime_script_eval` (the global-SCRIPT route) joined the
`js2wasm:runtime-eval` ABI on 2026-08-26 in `7d8021e8` (annex-B global lexical
bindings). That commit taught the **real** provider source and the **QuickJS**
adapter to export it — but not:

1. `instantiateRuntimeEvalNamespace()` in `scripts/runtime-eval-provider.mjs`,
   which builds the namespace **every import object is made from**, from a
   hardcoded four-entry object literal; and
2. `REFUSAL_PROVIDER_SOURCE` in the same file, which declares four of the five
   entry points despite its own doc comment promising "the same ABI as the real
   provider … every entry point returns `[false, TypeError]`".

Because (1) drops the entry for *every native provider*, no refusal- or
interpreter-tier provider could supply it, and any module importing it failed
to **link** — instead of getting the designed catchable `TypeError`. That is
precisely the failure the refusal provider exists to prevent, so the mechanism
was silently inverted for two days.

Measured, before → after (this container, `JS2WASM_EVAL_ENGINE=interpreter`,
refusal provider prebuilt both times):

| suite | base | with fix |
| --- | --- | --- |
| `tests/issue-4621.test.ts` | 5 failed / 22 passed | **1 failed / 26 passed** (only C5, the stale pin) |
| `tests/issue-2928-refusal-provider.test.ts` | new pin **fails**: `namespace entry __runtime_script_eval: expected 'undefined' to be 'function'` | **3 passed** |

**The second half of C1–C4 is a genuine environment prerequisite, and it is now
an actionable SKIP rather than four confusing failures.** Even with the ABI
fixed, an unprovisioned box still fails these rows, because `JS2WASM_EVAL_ENGINE`
defaults to `quickjs` and no dev container builds that artifact. So the suite now
asks the honest question — *is a linkable provider available for the engine this
process selected?* — via `selectCachedRuntimeEvalProvider()`, and skips the four
eval-provider-dependent rows with a message naming the exact prebuild command
when the answer is no. Measured both ways:

| environment | result |
| --- | --- |
| unprovisioned (default `quickjs`, no artifact) — what the pre-commit hook sees | **23 passed / 4 skipped, exit 0**, with the actionable warning |
| CI's shape (`JS2WASM_EVAL_ENGINE=interpreter` + refusal provider prebuilt) | **27 passed / 0 skipped** — the rows still gate |

That second row is the load-bearing one: the guard is FALSE only on an
unprovisioned local box, so it cannot silently disarm the rows in the lanes
where they are meant to catch regressions.

Side effect worth stating: **`node scripts/build-runtime-eval-provider.mjs`
(the full interpreter provider) cannot verify on base.** Its own
`verifyProvider()` asserts all five names on the namespace, and the namespace
could not produce `__runtime_script_eval` — so the build fails its canary. That
affects `eval-interpreter-lane.yml` and `refresh-baseline.yml`. I could not run
the full build here to completion (it OOM-killed twice under container
contention), so this is derived from reading `verifyProvider` against the
measured namespace, not from a completed build — flagged rather than claimed.

## Group A root cause (isolated, not fixed — #745 is claimed)

Minimisation: the failure needs a **loop**. Straight-line narrowing is fine.

```ts
let x: number | string = 5, sum = 0;
for (let i = 0; i < 2; i++) { if (i === 1) x = "done"; if (typeof x === "number") sum += x; }
```

The emitted `typeof` guard reads the carrier's tag with an **unconditional**
cast:

```wat
local.get 0            ;; x
any.convert_extern
ref.cast null (ref null 55)   ;; ← traps when x holds a raw string
struct.get 55 0               ;; read the tag
```

but the string assignment stores an interned string externref **unboxed**
(`global.get 25` → `local.set 0`), never wrapped in the `$AnyValue` carrier the
read requires. So the read path assumes a carrier the write path did not build:
a **carrier-representation inconsistency**, not a stale expectation.

A3/A4 are the same invariant at the parameter boundary — both need two call
sites of *different* runtime kinds; each kind alone is correct.

Do not treat these as four separate bugs. Precedent:
[#3543](https://js2wasm.loopdive.com/dashboard/issue.html?slug=3543-standalone-heterogeneous-anytuple-nested-read-traps)
bisected a sibling family of traps to `570c816b`, the **same** `#745` S4.5
`unionAnyRep` native-lane default flip. Related, both open: `#2141` (retire the
tag-5 box-the-externref ABI — "honest boxing") and `#3053`.

## Group D root cause (bisected, not fixed — needs design)

D1/D2 are a **genuine regression**, not a stale expectation. Probing the exact
D1 source at three revisions (`Function.prototype.valueOf = …`, standalone):

| revision | date | imports emitted |
| --- | --- | --- |
| `725e33c3e2` (the commit that ADDED `tests/issue-4564-*`) | 2026-08-22 | `[]` |
| `372f6b6aae~1` | 2026-08-25 | `[]` |
| **`372f6b6aae`** | 2026-08-25 | **`["js2wasm:runtime-eval"]` (2 imports)** |
| `7d8021e811` | 2026-08-26 | `["js2wasm:runtime-eval"]` |

Culprit: **`372f6b6aae`** — *"fix(standalone): reify ES5 function descriptor
properties"*, whose own message says it shares the realm-owned `Function`
intrinsic between `Function.prototype.constructor` reads and synthesized own
descriptors. After it, a standalone module that merely *mutates*
`Function.prototype.valueOf` demands the provider-backed `%Function%` and so
carries a `js2wasm:runtime-eval` import it did not need before. Ironically that
commit added "a provider-demand regression guard"; it does not cover this shape.

**A second, independent defect surfaced here and is worth its own attention:**
`compile()` **under-reports** this import. `result.imports` is `[]` while the
binary carries 2 real imports. `tests/issue-4564-*`'s own helper asserts
`result.imports === []` as its host-freedom check — that assertion **passes**,
and then `WebAssembly.instantiate(binary, {})` throws. A host-freedom guard that
cannot see a real import is the same "success is not validity" shape #4774
documented. Whether `js2wasm:runtime-eval` *should* appear in `result.imports`
is a genuine design call (`src/host-import-policy.ts` classifies it as a
`host-accelerator` / "replaceable linked Wasm provider", i.e. deliberately not a
JS host import), and flipping it would change the meaning of every
`imports === []` assertion in the repo — so it is recorded, not changed.

Why I did not narrow the predicate: the classifier in
`src/ir/runtime-eval-boundary-plan.ts` (~L270) and
`moduleReadsBareFunctionValue` in `src/codegen/function-intrinsic-carrier.ts`
are explicitly *measured* work with documented carve-outs (a
`Function.prototype.call.bind(…)` chain is deliberately NOT a site;
`Function.prototype.constructor` deliberately IS, because it must equal a bare
`Function` read). Widening the carve-out to cover `Function.prototype.<any
non-constructor member>` is a real design decision for the runtime-eval lane
(#4440/#4442/#4621-family-H), not a drive-by edit.

## B1: are `issue-3688`'s other green rows meaningful?

**Yes.** B1 died because strict equality is now **outlined** into a shared
`$__extern_strict_eq` routine that `dyn` reaches by `return_call`, and the
test's `funcBody()` resolved only `\bcall (\d+)\b` — which cannot match inside
`return_call` (the preceding `_` is a word character, so there is no boundary).
The body therefore listed no helper name and read as "generic ladder never
reached". Dumped WAT confirms `dyn` is exactly `local.get 0; local.get 1;
return_call $__extern_strict_eq` — the generic path, not `f64.eq`. The
optimisation is **not** firing where it should not.

Independently, the suite never relied on B1 alone: the neighbouring
**DIFFERENTIAL** row (same source with `JS2WASM_STATIC_NUMBER_EQ=0` vs on,
asserting `__box_number`/`__str_equals` present-then-absent *and* an identical
observable answer) is a strictly stronger meaningfulness guarantee, and it was
green throughout. Fix: teach `funcBody` to resolve `return_call`, and name
`__extern_strict_eq` as a generic-path marker. After the fix the suite is
**18/18**, and the strengthened helper — which now *can* see through tail calls
— did **not** trip `expectNoLadder` on the narrowed sites, confirming those
pins were honest rather than vacuously green.

## Should these suites join a gating lane?

This is the root cause the issue asked about, and the answer is specific:

- All four files DO run post-merge in `issue-tests.yml` (12 shards) — but that
  workflow does `pnpm install --frozen-lockfile` with **no submodules**, so
  `tests/issue-4621.test.ts` sees `existsSync(test262/harness/assert.js) ===
  false` and **`describe.skipIf(!TEST262)` skips the entire file**. It is not
  red there; it is *absent*. Its gate is also a tolerant auto-ratchet against a
  baseline, not a hard pass/fail.
- At PR time, `ci.yml`'s "Changed root test files must pass (#3008)" gate runs a
  file **only when the PR touches it** — the fix-on-touch ratchet. So a row that
  rots after its file's last edit is invisible until someone edits that file
  again.

Concrete recommendation for the orchestrator: the cheap, high-value change is
to make `issue-tests.yml`'s shard job check out the `test262` submodule and
prebuild the refusal provider (`node --import tsx
scripts/build-runtime-eval-provider.mjs --refusal-only`, ~2.4 s), so
test262-backed `issue-*` suites stop silently skipping in the one lane that runs
them all. Without that, the C group would have gone back to skipping-not-failing
and this class of ABI drift would stay invisible.

## Findings for the orchestrator (no new issue ids allocated, per instruction)

1. **`instantiateRuntimeEvalNamespace` ABI drift — FIXED here**, with a pin
   (`tests/issue-2928-refusal-provider.test.ts`) that now states the ABI width
   in one place so the next entry cannot land in only some providers.
2. **Full interpreter-provider build likely broken on base** (its own
   `verifyProvider` canary) — fixed by the same change; affects
   `eval-interpreter-lane.yml` / `refresh-baseline.yml`. Not confirmed by a
   completed build (OOM here).
3. **`372f6b6aae` provider-demand regression** (D1/D2) — needs a design call in
   the runtime-eval lane.
4. **`result.imports` under-reports `js2wasm:runtime-eval`** — a host-freedom
   guard that cannot see a real import; repo-wide blast radius, needs a decision.
5. **`issue-tests.yml` skips every test262-backed `issue-*` suite** (no
   submodule) — the structural reason these rows rotted unseen.
6. Group A (A1–A4) → fold into **#745**; do not re-file.
