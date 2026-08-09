---
id: 3197
title: "default lane: drive the for-await-of / async-dstr callback chain to completion (383 vacuous fails)"
status: ready
blocked: scope-decision
created: 2026-07-12
updated: 2026-07-12
priority: high
feasibility: hard
model: fable
task_type: bug
area: codegen
es_edition: ES2018
language_feature: for-await-of
goal: core-semantics
sprint: current
horizon: xl
umbrella: 3184
related: [3184, 2940, 3086, 2669, 3021]
origin: "2026-07-12 Fable codebase audit §F1; slice of #3184"
---

# #3197 — for-await-of / async-dstr drive slice (383 vacuous)

Sub-slice of **#3184**. This slice owns the **for-await-of** half; the
Promise-combinator half is **#3198**.

## Problem

On the default (JS-host) lane, `language/statements/for-await-of` has **489
non-pass** tests, of which **383** carry `vacuous: harness-wrapper callback
never executed (#2940)`: the compiled test returns "success" while the async
callback chain — and every assertion — **never runs**. Sampled files are
dominated by destructuring-in-async shapes:

```
language/statements/for-await-of/async-func-decl-dstr-array-elem-nested-array-null.js
language/statements/for-await-of/async-func-dstr-var-ary-ptrn-elem-id-iter-val-err.js
language/statements/for-await-of/async-func-dstr-var-obj-ptrn-prop-id-init-unresolvable.js
language/statements/for-await-of/async-gen-decl-dstr-obj-id-put-unresolvable-no-strict.js
```

**CORRECTION (root-cause diagnosis, dev-number-resid 2026-07-12):** the
original claim "the runner is NOT the gap … the failure is compiler-side" is
**wrong**. This is a **runner-timing** issue, proven by repro below. The runner
DOES implement the harness shims (`$DONE` `:1890`, `asyncTest` `:1899`,
detection `:2568-2569`), but it reads `test()`'s return value
**synchronously** (`const ret = testFn()` `:4001`, vacuity check `:4035`),
while the host/default-lane async continuation chain runs on the **host
microtask queue**, which does not drain until AFTER `test()` has already
returned. The callbacks are not dropped — they run too late for the runner to
observe. See `## Root-cause diagnosis` and `## Scope Decision Needed` below.

## Reproduction path (verified anchors)

For-of/for-await statement dispatch enters at `src/codegen/statements.ts:180-181`
(`ts.isForOfStatement` → `compileForOfStatement`, imported at `:39`); the
await-modifier lowering and its host-Promise drive live inside that path.
First diagnostic step: compile one sampled vacuous test on the default lane
and trace whether (a) the wrapped `asyncTest` callback is ever invoked, (b) the
for-await loop's first `IteratorNext` promise is ever awaited, or (c) an early
silent rejection is swallowed by the host bridge (`Promise_then` /
`__make_callback` family in `src/runtime.ts`).

## Acceptance criteria

1. Root-cause note in this file: which link of the chain drops the callback
   (asyncTest wrapper → async fn body → for-await drive → $DONE).
2. The 383 vacuous for-await-of records: ≥ 250 flip to genuine pass OR to
   honest assertion failures (no longer vacuous) on the default lane.
3. `language/statements/for-await-of` non-pass drops below 250 (from 489).
4. No standalone-lane regressions (the standalone carriers #2865/#3132 own
   that lane; do not touch their emit paths).
5. If the same root cause explains the async-function/async-generator vacuous
   slice (~91), note the measured overlap; do not scope-creep into the
   Promise-combinator slice (that is #3198).

## Root-cause diagnosis (dev-number-resid, 2026-07-12) — satisfies AC#1

**The chain is NOT broken; it completes too late.** Reproduced with a minimal
host-lane repro (`.tmp/repro-realshape.mjs`) mirroring the sampled test shape
(`async fn() { for await (…) { throw ReferenceError } }` →
`fn().then(onRes,onRej).then($DONE,$DONE)`):

- `test()` returns **0 synchronously** — the exact value the runner reads at
  `tests/test262-runner.ts:4001` (`const ret = testFn()`), which then hits the
  `-262` vacuity sentinel path at `:4035` → scored `vacuous`.
- After I manually drain the **host** microtask queue, the chain **completes**
  (`getDone === 1`). So the continuation ran — just after the runner already
  recorded the result.

**Why:** on the default/JS-host lane, async functions compile to **host Promise
imports** — `Promise_resolve` / `Promise_then2` / `Promise_reject` /
`__make_callback` (`src/codegen/declarations.ts:1748-1765`; two-lane split
noted at `src/codegen/async-frame.ts:96`). Host `.then` callbacks are always
scheduled on the host microtask queue and cannot be drained synchronously from
inside a synchronous `test()` call. The **standalone/WASI** lane does NOT have
this bug because it drives on the in-wasm microtask scheduler (#1326/#2906),
which `test()` drains synchronously (WASI `_start` auto-drain) before returning.

**Chain-link answer (AC#1):** `asyncTest`/`.then` wrapper ✅ invoked · async fn
body ✅ runs · for-await drive ✅ completes · `$DONE` ✅ **eventually** called —
but on the host microtask tick that fires *after* the runner's synchronous read.
The "dropped callback" framing is a measurement artifact of the synchronous read.

**AC#5 overlap:** this same host-microtask-timing root cause explains the
async-function / async-generator vacuous slice (~91) and every host-lane test
that routes assertions through `Promise.prototype.then` — it is NOT specific to
for-await-of or destructuring. (The destructuring shapes merely dominate the
*sample*; the mechanism is lane-wide.)

## Scope Decision Needed — BLOCKED (needs stakeholder sign-off)

The fix is **not** an M implementation; it is a scope/policy choice. Re-sized
`horizon: xl`, `blocked: scope-decision`. Two mutually-exclusive paths:

### (a) Architectural — host-lane async on the wasm scheduler — XL / senior
Route the JS-host async continuation chain off host Promises and onto the
synchronously-drainable in-wasm microtask scheduler (extend the #2906 drive
lane to `target` = default/host), so `test()` completes the chain before it
returns. Large, deep async-codegen change; touches the host Promise bridge and
the CPS driver. **Owner: senior-dev.** Risk: host-mode Promise semantics /
interop with real host Promises handed across the boundary.

### (b) Runner-side microtask drain — 1 line, but needs sign-off + baseline refresh
Have the runner `await` a microtask/macrotask tick (or drain) before reading
`ret` for `flags:[async]` tests. Mechanically trivial (drain host microtasks
after `testFn()`), but it **flips ~250–383 currently-`vacuous`/`fail` records
to pass/honest-fail in one commit** — a large baseline movement that, like
#3056, requires **human sign-off + a coordinated baseline refresh** (and a
re-check that no *currently-counted* host pass silently depended on the
vacuity). It also revises the "runner is not the gap" premise the umbrella
#3184 was scoped under.

**Recommendation:** pursue (a) as the durable fix under a senior-dev owner;
consider (b) only if the stakeholder accepts the baseline movement + premise
revision. Diagnosis (AC#1) is delivered; AC#2–#4 await the scope decision.
**Do not implement either without sign-off.**

## Audit cross-link

`plan/log/2026-07-12-fable-codebase-audit.md` §F1.
