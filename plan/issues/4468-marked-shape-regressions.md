---
id: 4468
title: "PR #4507 regressed 7 test262 tests + 2 uncatchable null_deref traps on main — object-shape trampolines / spread-source materialization"
status: done
sprint: current
created: 2026-08-15
updated: 2026-08-15
completed: 2026-08-15
priority: high
horizon: m
feasibility: medium
reasoning_effort: max
task_type: bug
area: codegen
goal: correctness
loc-budget-allow:
  - src/codegen/closed-method-dispatch.ts
  - src/codegen/literals.ts
func-budget-allow:
  - src/codegen/closed-method-dispatch.ts::fillClosedMethodDispatch
  - src/codegen/literals.ts::compileObjectLiteralWithAccessors
---

# #4468 — fix-forward the #4507 merge-group regressions

PR #4507 ("fix(marked): bound upstream compilation and preserve class object
shapes", merge commit `6756ed8c`, 24 files) was merged past its own FAILED
merge-group regression gate (run 15:08 UTC 2026-08-15; project lead chose
fix-forward over revert). On main since:

**Regressions (all `pass → fail`, from the gate's diff; attribution
confirmed — every earlier group that day was clean and #4507's own group is
the first to show exactly these):**

1. `test/language/statements/class/elements/super-access-inside-a-private-method.js`
   — `dereferencing a null pointer [in __obj_meth_tramp_C___priv_m_cache…]`
   (also one of the two new `null_deref` ratchet entries; the other is
   `private-method-get-and-call.js` shifting category, baseline already fail).
2. `test/language/expressions/object/dstr/meth-dflt-obj-ptrn-empty.js` and its
   `gen-`/`async-gen-` siblings — `Cannot destructure 'null' or 'undefined'
   [in __anon_5_method() ← __module_init]` (object-literal methods with a
   destructured-with-default parameter, called with no argument).
3. `test/language/expressions/{array,new,super/call-spread}/…
   spread-obj-manipulate-outter-obj-in-getter.js` — wrong VALUE
   (`SameValue(«true», «false»)`): a getter in a spread source that mutates
   the outer object no longer observes/produces the spec evaluation order.

These map 1:1 onto #4507's three codegen claims: "preserve class
static/instance method identities and method ABI keys", "keep callable method
receivers valid across object-shape trampolines", "materialize open
object-spread sources before storing them in closed fields".

**Do NOT confuse with a pre-existing gap**: a plain `{ ...objWithGetter }`
already dropped getter side effects on 2026-08-14 main (verified during
attribution — repro'd at `63785cb`). The three regressed spread tests were
PASSING before #4507, so they exercise a different (working) path that #4507
broke. A/B every repro against `c3ff8a1f` (#4507's parent on main) — a repro
that also fails there is the wrong repro.

## Implementation Plan (Fable, 2026-08-15)

1. **Scope the diff**: `git diff c3ff8a1f..6756ed8c -- src/` — 24 files
   total but only the `src/codegen`/`src/runtime` subset matters; list which
   files carry the trampoline / ABI-key / spread-materialization changes.
2. **Reproduce each family** at main and at `c3ff8a1f` (worktree per side or
   file-copy A/B of the touched files if the set is small). Two harness
   options, use whichever works first:
   - the vitest runner with a path filter (`TEST262_CHUNK_INDEX=0
     TEST262_CHUNK_TOTAL=1 TEST262_PATH_FILTER=<substring> npx vitest run
     tests/test262-chunk-dynamic.test.ts`) — note: in the selfhost-baseline
     worktree the compiler pool worker failed to boot (`[pool] worker failed
     before ready`); if that happens here, diagnose briefly (it may just be a
     missing build/vendor step) or fall back to:
   - direct `compileAndInstantiate` (src/runtime.ts) on the test source with
     the test262 harness files (`test262/harness/{sta,assert,compareArray}.js`)
     concatenated — the runner's wrapping is in `tests/test262-runner.ts` if
     fidelity matters.
3. **Root-cause per family** (they may be one defect or three):
   - trampoline null-deref: the `__obj_meth_tramp_*` cache path #4507 added
     or changed — find where the private-method receiver/cache is expected
     non-null at `super`-access time.
   - method default-destructuring: arity/undefined handling through the new
     ABI-key/trampoline path — the default `{} = …` no longer applies when
     the call site passes nothing.
   - spread evaluation order: the "materialize open spread sources" change —
     materialization must still invoke getters at spread time, in order,
     observing mutations.
4. **Fix at the decision sites**, not with emission-site casts; oracle-ratchet
   rules apply (no raw `checker.*`).
5. **Tests**: per family a minimized `tests/issue-4468*.test.ts`
   (compile+validate+run, assert the spec value); plus pin the trampoline
   null-deref shape. The 7 test262 files themselves are re-validated by the
   merge queue — state that in the PR.
6. **Do not regress the marked dogfood**: #4507's stated win is that Marked
   `Hooks.test.js` compiles + validates (4,550,040 B). After your fix run
   `DOGFOOD_MARKED_TIMEOUT_MS=60000 pnpm run dogfood:marked-upstream-suite`
   (or at minimum the compile/validate step) and record the result — the fix
   must keep compile+validate green there. If a real conflict emerges between
   marked-compat and spec semantics, STOP and document (Findings, status
   in-progress) — that is an architecture call for the lead.

## Acceptance criteria

- [x] Each of the three families root-caused, documented, and fixed (or a
      documented STOP with findings).
- [x] Minimized repros A/B-verified: fail on main, pass with fix, pass at
      `c3ff8a1f`.
- [x] Marked upstream compile+validate still green.
- [x] Typecheck + gates green; merge queue's regression diff (the authority)
      confirms the 7 return to pass and `null_deref` returns to ≤140.
      (Local: all 7 pass; the merge queue remains the authority.)

## Results (2026-08-15)

All three families were separate defects in #4507's diff, each isolated by a
per-file revert of the 17-file `src/` subset against `c3ff8a1f` and confirmed
with the test262 chunk runner (`TEST262_PATH_FILTER`, original-harness lane).

### Family 1 — `null_deref` in `__obj_meth_tramp_*` (`src/codegen/closures/method-trampolines.ts`)

**Root cause.** #4507 added `coerceTrampolineThisSlot`, which reconciles the
trampoline's receiver with the method's recorded `this` ValType. That slot is
deliberately NULLABLE: `buildTrampolineThisSlot` passes `ref.null` on the #2025
"receiver is present but is not this struct" arm (`this.#m.call(o)` with a plain
`{}`). The recorded `this` type still reads as the non-nullable
`{ kind: "ref", typeIdx }` at both trampoline-emission points, while the method's
EMITTED parameter is `(ref null $Struct)` — verified by WAT: `$C___priv_m` is
`(param (ref null 10))` on BOTH sides, yet the coercion fired. `coercionInstrs`
therefore appended `ref.as_non_null`, converting the legal null receiver into an
uncatchable trap.

**Fix.** `coerceTrampolineThisSlot` now returns early for any `ref`/`ref_null`
target. Nullability and struct identity belong to the method-arg reconciliation
path; the receiver path only bridges a genuinely different CARRIER
(`externref`/`anyref`/…), which is the validation failure the reconciliation was
added for. No trapping instruction is emitted on the receiver path any more.

### Family 2 — `Cannot destructure 'null' or 'undefined'` (`src/codegen/closed-method-dispatch.ts`)

**Root cause.** #4507 taught the closed-method dispatcher to UNDER-APPLY a
method whose omitted formals are optional, synthesizing the missing argument with
`defaultValueInstrs(want)`. For an `externref` formal that is `ref.null.extern`
— JS `null`, which on the JS-host lane is a REAL, provided argument, not
"absent". So `{ method({} = obj) {} }` called as `obj.method()` skipped its
default and destructured `null`. The identifier-call path does not have this bug:
`pushParamSentinel` → `pushDefaultValue` emits the host `undefined` value (#737)
for `externref`.

**Fix.** A single `missingArgInstrs(ctx, want, opt)` now owns the encoding and is
shared by the arm builder and the entry-admission test:
constant default → the constant; `externref` → the host `undefined`
(`__get_undefined`, the #2106 singleton, or `ref.null.extern` on
standalone/WASI/nativeStrings where `undefined` and `null` are the same value by
design); everything else keeps `defaultValueInstrs` (so marked's
`inline(text, tokens = [])` ref-typed formal is unchanged). If the `externref`
`undefined` value is unreachable, the entry is DECLINED and the call falls back to
host dispatch — the pre-#4507 behaviour, correct but slower.

### Family 3 — spread evaluation order (`src/codegen/literals.ts`)

**Root cause.** #4507 removed the `semanticProviders === "native-first"` gate on
the closed-struct spread-source materialization, so the JS-host lane also
snapshotted the source struct's STATICALLY DECLARED fields.
`materializeStructAsDynamicObject` cannot observe a key `delete`d from the source
or an expando added to it, so in `[{...cthulhu, ...o}]` — where `cthulhu`'s getter
does `delete o.a; o.b = 42; o.c = "ni"` — the copy reported `a` still present and
`c` missing. Measured on the exact test262 body: `hasA=true, b=42, c=undefined`
on `6756ed8c` vs `hasA=false, b=42, c=ni` on `c3ff8a1f`.

**Fix.** The `native-first` gate is restored, with a comment marking it
load-bearing. Host reflection (`__object_assign`) reads the LIVE object, which is
what CopyDataProperties requires; the materialization stays where there is no
host reflection to defer to.

### A/B results (test262 chunk runner, original-harness lane)

| test | `c3ff8a1f` | `6756ed8c` (main) | with fix |
| --- | --- | --- | --- |
| `statements/class/elements/super-access-inside-a-private-method` | pass | fail (`null_deref`) | pass |
| `expressions/object/dstr/meth-dflt-obj-ptrn-empty` (+ `gen-`, `async-gen-`) | pass | fail ×3 | pass ×3 |
| `expressions/{array,new,super/call-}spread-obj-manipulate-outter-obj-in-getter` | pass | fail ×3 | pass ×3 |
| `expressions/call/spread-obj-manipulate-outter-obj-in-getter` | **fail** | fail | fail (pre-existing, not chased) |
| `{statements,expressions}/class/elements/private-method-get-and-call` | **fail** | fail | fail (pre-existing) |

Collateral slice — `language/expressions/object/dstr/`,
`language/expressions/object/method-definition/`, `*/spread*`,
`class/elements/private-method*`: **1,034 tests, 0 failures** with the fix.

Equivalence subset (51 files matching object/spread/method/class/destructuring/
default/param/private/super/getter/closure): 367/369 pass. The 2 failures are in
`tests/equivalence/optional-direct-closure-call.test.ts` and reproduce identically
on unpatched `main` — pre-existing, unrelated.

### Marked dogfood verdict

`DOGFOOD_MARKED_TIMEOUT_MS=60000 pnpm run dogfood:marked-upstream-suite`, run on
unpatched `main` and on the fix:

| | compile | validate | bytes | wasm pass/fail | first wasm error |
| --- | --- | --- | --- | --- | --- |
| main (`6756ed8c`+) | 1/1 | 1/1 | 4,557,005 | 0/15 | `br is not a function` |
| with fix | 1/1 | 1/1 | 4,555,068 | 0/15 | `br is not a function` |

Per-test status AND per-test wasm error are byte-identical between the two runs,
so #4507's stated win (Hooks.test.js compiles + validates) is preserved and no
marked behaviour moved. **No spec-vs-marked conflict arose** — the narrowed
family-2 encoding was chosen precisely because the first, broader version
(declining every non-constant/non-f64 default) re-introduced
`inline is not a function`; that was measured and rejected before landing.

### Notes

- Budget allowances (`loc-budget-allow`, `func-budget-allow`) cover
  `closed-method-dispatch.ts` (+59 LOC: the new `missingArgInstrs` + its
  contract doc) and `literals.ts` (+3 LOC: the load-bearing gate comment).
- Local repro harness needs both `scripts/compiler-bundle.mjs` and
  `scripts/runtime-bundle.mjs` built, or the test262 pool worker dies with
  `[pool] worker failed before ready (exit 1)` and every test times out at 90 s
  — the failure mode the plan flagged in the selfhost-baseline worktree.
