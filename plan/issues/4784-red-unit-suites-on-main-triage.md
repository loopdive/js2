---
id: 4784
title: "triage: 12 failing rows in four issue-* unit suites that are red on main and gate nothing"
status: ready
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
