---
id: 5367
title: "`await Promise.all(...)` inline yields the wrong value (a default-initialised tuple / empty array)"
status: done
assignee: ttraenkler/sendev-5372
completed: 2026-09-12
sprint: current
created: 2026-09-06
updated: 2026-09-12
priority: high
horizon: m
feasibility: hard
reasoning_effort: max
task_type: bug
area: compiler
goal: correctness
language_feature: async, Promise.all
related: [5372, 6409, 6410, 5340, 5338, 1042, 1373b, 4110, 1727, 1796, 2028]
---

## Problem

Awaiting a `Promise.all(…)` **call expression directly** produces a value that
is not the resolved array. Binding the promise to a local first and awaiting
the local is correct. Measured on a clean detached worktree at upstream/main
`cbd2f11dff` (and on `a1469a5454`), JS-host GC lane (`target: "gc"`, `platform: "web"`), with and
without `experimentalIR` — both reproduce.

Four-line repro (`compileProject`, untyped `.js`):

```js
export async function run() {
  const r = await Promise.all([Promise.resolve(1), Promise.resolve(2)])
  return 'INLINE len=' + String(r.length) + ' i0=' + String(r[0]) + ' json=' + JSON.stringify(r)
}

export async function probe() {
  const p = Promise.all([Promise.resolve(1), Promise.resolve(2)])
  const r = await p
  return 'VIA-LOCAL len=' + String(r.length) + ' i0=' + String(r[0]) + ' json=' + JSON.stringify(r)
}
```

```
RUN   => INLINE    len=NaN i0=NaN json={"_0":null,"_1":null}   ← wrong
PROBE => VIA-LOCAL len=2   i0=1   json=[1,2]                   ← correct
```

`{"_0":null,"_1":null}` is a **default-initialised wasm tuple struct** — the
static awaited type of `Promise.all([Promise<number>, Promise<number>])` is the
tuple `[number, number]`, and the resume binding appears to materialise that
type instead of carrying the host array through. When the argument is a
**variable** rather than an array literal (so the awaited type is `number[]`)
the same shape produces an **empty array** instead:

```
const ps = [7, 8].map((i) => fn(i))
const r  = await Promise.all(ps)     // len=0, json=[]
```

An explicit `const r: any = await Promise.all([…])` does **not** fix it (it
yields `{}`), so this is not purely a tuple-type materialisation.

Worse, in the array-of-pending-promises form the awaited continuations never
run at all: with `fn = async (i) => { seen.push('s'+i); await gate; seen.push('e'+i); return i }`,
`await Promise.all([fn(0), fn(1)])` returns `[]` and `seen` is `s0|s1` — the
`e0|e1` half never executes. So `Promise.all` is not merely returning the wrong
value, it is not waiting.

`await Promise.resolve(1)` is correct, and sequential `await a; await b` on the
same promises is correct — the defect is specific to the aggregator call in
await position.

## Impact

This is the sole remaining blocker for hono `src/utils/concurrent.test.ts`
(0/6 on main `cbd2f11dff`). All six of its tests end in
`const results = await Promise.all(resultPromises)`, and four of them then assert
on state the un-awaited continuations were meant to mutate. It surfaced while
investigating #5340, whose own root cause — tagged-template substitutions
dropped — #5338 fixed: with the `RangeError: Invalid array length` gone, every
one of the six now fails here instead.

Anything that fans out with `Promise.all` is affected, so the blast radius is
much wider than one hono file.

## Reproduction ladder (all measured, JS-host GC lane)

| shape | result | native |
| --- | --- | --- |
| `await Promise.resolve(1)` | `1` ✅ | `1` |
| `const p = Promise.all([…]); await p` | `[1,2]` ✅ | `[1,2]` |
| `await Promise.all([Promise.resolve(1), Promise.resolve(2)])` | `{_0:null,_1:null}` ❌ | `[1,2]` |
| `await Promise.all(psVariable)` | `[]` ❌ | `[1,2]` |
| `await Promise.all([7,8].map(fn))` | `[]`, continuations skipped ❌ | `[7,8]` |
| `const a = fn(7); const b = fn(8); await a; await b` | `7`, `8` ✅ | `7`, `8` |

## Where to look

- `src/codegen/expressions/call-namespace-static.ts` — the aggregator arm is
  reached (verified by instrumentation); it emits the `Promise_all(thisArg,
  iterable, directCall)` host import and returns `externref`. The host import
  itself (`src/runtime.ts` ~15638 `Promise.all.call(C, _toIterable(arr))`) is a
  faithful delegation, so the loss is on the consumer side.
- `src/codegen/async-cps.ts` / `src/codegen/async-ir-planning.ts` — the resume
  binding's wasm type and the coercion applied to the resumed externref.
  `isAmbientPromiseAll` (async-ir-planning ~490) is a *specialised* path for
  `await Promise.all(<identifier>)`; the array-literal form does not take it,
  and both forms are wrong, so the defect is likely in the shared resume-binding
  typing rather than in that specialisation.

## Acceptance criteria

1. The four-line repro above prints the same string for `run()` and `probe()`.
2. hono `src/utils/concurrent.test.ts` ≥ 5/6 (its `RangeError` blocker is
   already fixed on main by #5338).
3. Regression test under `tests/`, untyped `.js` two-file fixtures, failing on
   the parent and passing with the fix, pinning the resolved VALUES (not just
   `length`), with an anti-vacuity control on the via-local form that already
   works.
4. A/B at one HEAD over all 17 dogfood suites, per test file.

## Implementation Plan

(The plan as executed — one PR with #5372, branch
`issue-5367-5372-await-in-initializer`; the first agent's session was
interrupted after the fix and resumed on 2026-09-12 at upstream/main
`225f400089`.)

1. **Capture the base before any edit**: `.tmp/async-cps.orig.ts`,
   `.tmp/async-frame.orig.ts`, `.tmp/helpers.orig.ts` at `cbd2f11dff`;
   re-captured from `upstream/main` (`225f400089`) into `.tmp/ab2/base-src/`
   after the merge so every A/B leg below runs at ONE head by file copies.
2. **Probe through the dogfood harness** (`compileAndRunUpstreamModule`,
   untyped `.js` two-file project, a deliberately failing control that fails
   in both lanes): the six ladder rows, the continuations log (`seen` must
   read `s0|s1|e0|e1`) and the hono `createPool` shape.
3. **Instrument the engine claim per row** (`planLinearAwaits`,
   `analyzeTryCatchAsync`, `asyncFnNeedsHostDrive`) on the base — the
   verdicts below located the defect in the activation gate, not in the
   resume-binding typing the "Where to look" section suspected.
4. **Fix**: delete the `Promise.<combinator>` carve-out from
   `asyncFnNeedsHostDrive` (host lane only). Compare the WAT of the inline
   and via-local forms: the resume binding is an `externref` in both, so no
   coercion change; `isAmbientPromiseAll` keeps its contract.
5. **Regression test** `tests/issue-5367-await-promise-all-inline.test.ts`
   (values, not lengths; via-local anti-vacuity control; one fresh instance
   per row), counted on the parent and on the fix.
6. **hono**: re-run `src/utils/concurrent.test.ts`; reduce whatever still
   fails to a two-file fixture and file it if it is a further defect
   (→ #6409).
7. **Scoped test262** (`language/expressions/await`,
   `language/statements/async-function`, `built-ins/Promise/all`) parent vs
   fix on both lanes, then the 17-suite A/B per test file.

## Resolution

**Root cause.** Not the resume-binding typing and not the collector: the
JS-host activation gate `asyncFnNeedsHostDrive` (`src/codegen/async-frame.ts`)
carried a #1796-era carve-out — "a lone `await Promise.<combinator>(...)`
already yields a real Promise the legacy identity path resolves correctly" —
that returned `false` for exactly one canonical await whose operand is
`Promise.all/race/any/allSettled(...)`. The function then fell to the legacy
synchronous pass-through: `await` is an identity there, so the resume
"binding" received the un-awaited Promise object coerced into the STATIC
awaited type — the default-initialised tuple struct for
`Promise<[number, number]>`, an empty vec for `Promise<number[]>`, `{}` for
`any` — and, because the body never suspended, the pending promises'
continuations had not run when the function returned. The via-local form
(`const p = Promise.all(…); await p`) awaits an identifier, never hit the
carve-out, and was driven correctly all along. Instrumented verdicts on the
base: `p3/p4/p5/p7/p8: linear=true hostDrive=false`, `p2` (via-local) and
`p6` (sequential): `hostDrive=true`. The carve-out's second rationale — the
#2028 host-method argument-marshaling gap — is fixed (#2028 done 2026-06-16).

**Fix.** Remove the combinator carve-out from `asyncFnNeedsHostDrive` (host
lane only; `asyncFnNeedsDrive` on the wasi carrier keeps its own gate, and
`asyncFnNeedsCps` is untouched). A driven `const r = await Promise.all(…)`
delivers the settled host array as an `externref` resume binding (no
`decl.type`, no target ⇒ externref), exactly as the via-local form does, so
no coercion change was needed. `isAmbientPromiseAll` (the IR lane's
`promise-all-continuation` shape) keeps its contract — its `canPrepare` proof
is independent of the engine claim and stayed `false` for every probe row on
both base and fix.

**Measured (probe, JS-host lane):**

| row | base | fix |
| --- | --- | --- |
| `await Promise.resolve(1)` | `1` | `1` |
| `const p = Promise.all([…]); await p` | `[1,2]\|2\|1` | `[1,2]\|2\|1` |
| `await Promise.all([Promise.resolve(1), Promise.resolve(2)])` | `{"_0":null,"_1":null}\|NaN\|NaN` | `[1,2]\|2\|1` |
| `await Promise.all(psVariable)` | `[]\|0\|undefined` | `[1,2]\|2\|1` |
| `await Promise.all([7,8].map(fn))` + log | `[]\|s7\|s8` | `[7,8]\|s7\|s8\|e7\|e8` |
| `const a = fn(7); const b = fn(8); await a; await b` + log | `7,8\|s7\|s8\|e7\|e8\|e7\|e8` (the previous row's un-driven frames leaking into this row's log) | `7,8\|s7\|s8\|e7\|e8` |
| `await Promise.all([fn(0), fn(1)])` + log | `{}\|s0\|s1` | `[0,1]\|s0\|s1\|e0\|e1` |
| hono `createPool` shape | `3\|3\|[]\|[0,1,2]` | `3\|0\|[0,1,2]\|[0,1,2]` |

**Regression test** `tests/issue-5367-await-promise-all-inline.test.ts`
(untyped `.js` two-file project, one fresh instance per row so an un-driven
row's dangling frames cannot leak into the next row's log): 8 rows — 5 fail
on the parent, 3 controls (`Promise.resolve`, via-local, sequential) pass;
8/8 with the fix.

**hono `src/utils/concurrent.test.ts` (AC 2) — still 0/6, for a different
reason.** All six tests get past the `await Promise.all(resultPromises)` (on
the original parent `cbd2f11dff` `results` read `[]` and the pool never
drained; at the merged head `225f400089` the typed upstream test already
reaches the next assertion on the base too, while the untyped mimic still
reads `[]` there) and fail one step later: `expect(running.size).toBe(0)`
reads `1 | 10 | 10 | 2000` and the two `with interval` tests mismatch on
`toEqual(expectedResults)`. Every job
that hits `createPool`'s pool-full branch is retried through
`setTimeout(() => run(fn, promise, resolve))` — a nested async arrow calling
itself through its own captured `const` while its body awaits a call — and
that recursive activation never enters the body. Reduced to a two-file
fixture and measured identical with the base sources swapped in at the same
head, so it is pre-existing and independent of this fix: **#6409**. The
probe table (`.tmp/probe/hono/rows7.js`…`rows10.js`) is reproduced there.

## A/B

Measured at ONE head — the merged branch tip (upstream/main `225f400089` +
this change), base = the upstream/main copies of the five touched files
(`.tmp/ab2/base-src`, the two new modules removed) swapped in by file copy,
fix = the branch's files; suites one at a time, `JS2WASM_EVAL_ENGINE=interpreter`
for the scoped test262 runs.

**Regression tests** (`node node_modules/vitest/vitest.mjs run …`): base 20
failing rows (`issue-5367` 5/8, `issue-5372` 15/28, `issue-3722` 0/4), fix
0 failing (39/39 → 40/40 with the `r13` control).

**Scoped test262** (`language/expressions/await` ·
`language/statements/async-function` · `built-ins/Promise/all`, 387 tests):

| lane | base | fix |
| --- | --- | --- |
| JS-host GC | 190 pass · 193 fail · 4 CE | **191** pass · 192 fail · 4 CE (`language/statements` 66 → 67, the other two categories identical) |
| standalone (interpreter) | 161 pass · 111 fail · 115 CE | 161 pass · 111 fail · 115 CE (identical per category; probe binary sha256 `0ed867fc616cfa8d` on both sides) |

**17 dogfood suites, per test file** (`tests/dogfood/<pkg>-upstream-suite.mjs`,
`admitted` headline and exit 0 present on every run, both legs):

| suite | base | fix | per-file delta |
| --- | --- | --- | --- |
| marked | 9/30 | **16/30** | `test/unit/Hooks.test.js` 9 → 16 |
| hono | 255/324 | 255/324 | none (`src/utils/concurrent.test.ts` 0/6 both — #6409; `src/helper/dev/index.test.ts` 1/8 both after the #6410 gate; without the gate it read 0/8 — module invalid) |
| webpack | 16/16 | 16/16 | none |
| three | 17/18 | 17/18 | none |
| clsx | 32/32 | 32/32 | none |
| cookie | 63740/63740 | 63740/63740 | none |
| lodash | 59/62 | 59/62 | none |
| redux | 67/82 | 67/82 | none |
| axios | 202/231 | 202/231 | none |
| stylelint | 108/108 | 108/108 | none |
| tailwindcss | 13/13 | 13/13 | none |
| jsdom | 6/6 | 6/6 | none |
| styled-components | 9/9 | 9/9 | none |
| uuid | 75/75 | 75/75 | none |
| moment | 10/10 | 10/10 | none |
| prettier | 105/151 | 105/151 | none (the same 6 known compile problems — worker timeout / `--allow-fs` — on both legs) |
| jest | 335/356 | 335/356 | none |

Total: 65058 → 65065 (+7), no file lower than its base.
