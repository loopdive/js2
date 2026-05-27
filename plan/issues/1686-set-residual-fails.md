---
id: 1686
title: "built-ins/Set residual fails — 63 non-passing after set-like fix (split from #1646)"
status: done
created: 2026-05-27
updated: 2026-05-27
completed: 2026-05-27
priority: low
feasibility: medium
reasoning_effort: medium
task_type: investigation+bugfix
area: runtime, codegen
language_feature: set
goal: spec-completeness
sprint: Backlog
parent: 1646
---
# #1659 — built-ins/Set residual fails (post set-like fix)

Split from #1646. The set-like-argument feature (#1352 / #1646) landed and
lifted `built-ins/Set` from 73.6% → **83.6% (320/383)** as of the committed
test262 report (baseline `1f5208c8`, 2026-05-22). #1646 is `done` for its
original scope.

This issue tracks the **remaining 63 non-passing tests** that are *not* the
set-like-argument gap:
- **56 fail**
- **7 compile_error** (likely codegen gaps unrelated to `GetSetRecord` — these
  should be investigated first; a compile error is a harder failure than an
  assertion mismatch).

## First step (investigation)

Run the `built-ins/Set` category against current main and bucket the 63
non-passing tests by root cause. Use the test262 runner (`pnpm run test:262`
scoped to the Set category) or the `tests/map-set.test.ts`-style equivalence
harness — **not** an ad-hoc manual `WebAssembly.instantiate` harness, which
produces return-coercion artifacts (e.g. `new Set([1,2,3]).size` reads back as
`undefined`) that look like failures but are harness bugs.

Once bucketed, either fix the small clusters inline or file per-cluster
sub-issues. Do **not** touch the set-like bridge in `src/runtime.ts`
(`intent.className === "Set"` block) — it is correct.

## Acceptance

- 63 non-passing `built-ins/Set` tests bucketed by root cause.
- The 7 compile_errors diagnosed (each either fixed or filed as a codegen issue).
- `built-ins/Set` pass-rate moves toward ≥90% (345/383).

## Investigation results (2026-05-27, current main 383ec0c6e)

Re-ran the full `built-ins/Set` category through the runner harness
(`runTest262File`, the same path `pnpm run test:262` uses — not an ad-hoc
`WebAssembly.instantiate` harness). Current state:

**310 pass / 53 fail / 7 compile_error** (= 383 total; pass-rate **80.9%**).

The 8 `harness_throw` / 5 extra "compile_error" seen in a naive loop
(`declaredVars.add is not a function` / `definedNames.add is not a function`)
are **probe artifacts** — `runTest262File` carries module-level sandbox state
that collides when many files run in one process. They are NOT compiler
failures; the committed baseline JSONL lists those same files as ordinary
`fail`/`compile_error` with real Set messages. Run those files one-per-process
to see their true status.

### Compile-error bucket (7) — DIAGNOSED → sub-issue #1670

All 7 are identical: `Cannot find method 'size' on parent class 'Set'` from
`prototype/{union,intersection,difference,symmetricDifference,isSubsetOf,
isSupersetOf,isDisjointFrom}/subclass-receiver-methods.js`.

Root cause: `class MySet extends Set { size(...){ return super.size(...) } }`.
`compileSuperMethodCall` (`src/codegen/expressions/new-super.ts:108-120`)
resolves `super.<m>` by walking `ctx.funcMap` for `${ancestor}_${m}`. When the
ancestor is a **built-in** (`Set`), there is no `Set_size` funcMap entry, so it
hits the hard `reportError` at new-super.ts:118. The compiler has no path to
dispatch `super.<method>` to a built-in parent's prototype method. This is a
clean codegen gap, **independent of the set-like bridge** — filed as **#1670**.
Not a "small cluster" inline fix: needs a host-side super→builtin-prototype
bridge.

### Fail buckets (53) — set-like-consumption semantics → sub-issue #1671

The dominant fail clusters all concern **set-like argument consumption** by the
new Set methods (`GetSetRecord`, ES2025 §24.2.5.x). Per this issue's standing
instruction, the `intent.className === "Set"` bridge in `src/runtime.ts:2952`
was NOT touched. Clusters:

| Cluster | ~count | Symptom | Likely cause |
|---------|--------|---------|--------------|
| `.size property is NaN` | ~17 | `set-like-array` / `set-like-class` / `allows-set-like-class` | `GetSetRecord` reads the host object's `.size` as NaN — the user-supplied `size` data prop / getter isn't coerced (`ToNumber`) before use |
| `GetSetRecord coercionCalls !== 1` (`size-is-a-number`) | ~6 | `returned 5 @ L54` | `.size` getter invoked a wrong number of times — spec requires exactly one `Get(obj,"size")` + one `ToNumber` |
| `has`/`keys` not-callable should throw (`has-is-callable`, `keys-is-callable`) | ~9 | `returned 3 @ assert#2 assert.throws` | when `.has`/`.keys` is not callable, GetSetRecord must throw TypeError; we don't |
| `string "has" is not a function` (`set-like-class-mutation`) | ~4 | runtime | method lookup returns a string instead of the function on set-like class instances |
| plain `Set.size` wrong (`returns-count-of-present-values`, `bigint-number-same-value`) | ~4 | `s.size` returns wrong count after mixed inserts | size accounting / bigint-vs-number SameValueZero keying |
| singletons | ~5 | `$262 is not defined` (realm — unsupported), `is-a-constructor`, `prototype-of-set`, `forEach this-arg`, null-deref in `set-like-iter-return` | misc |

All set-like-consumption clusters share one root area (`GetSetRecord` host
shim), so they are filed together as **#1671** rather than split per-method.
The `$262 is not defined` realm test is genuinely out of scope (no `$262` host).

### Disposition

This investigation task is complete: 63 (now measured as 60 real:
7 CE + 53 fail) bucketed, the compile_errors diagnosed, and two scoped
sub-issues filed (#1670 super→builtin-method dispatch; #1671 GetSetRecord
set-like consumption). Neither fix is a "small inline cluster"; both are
deferred to their own issues. No code change made under #1659.

status moved to `done` (investigation deliverable met).
