---
id: 4468
title: "PR #4507 regressed 7 test262 tests + 2 uncatchable null_deref traps on main — object-shape trampolines / spread-source materialization"
status: in-progress
sprint: current
created: 2026-08-15
updated: 2026-08-15
priority: high
horizon: m
feasibility: medium
reasoning_effort: max
task_type: bug
area: codegen
goal: correctness
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

- [ ] Each of the three families root-caused, documented, and fixed (or a
      documented STOP with findings).
- [ ] Minimized repros A/B-verified: fail on main, pass with fix, pass at
      `c3ff8a1f`.
- [ ] Marked upstream compile+validate still green.
- [ ] Typecheck + gates green; merge queue's regression diff (the authority)
      confirms the 7 return to pass and `null_deref` returns to ≤140.
