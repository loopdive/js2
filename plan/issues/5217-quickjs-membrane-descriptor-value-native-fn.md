---
id: 5217
title: "QuickJS eval membrane: a descriptor's `enumerable` value reads back as a native function, not `true` (regressed by #5202)"
status: done
sprint: current
created: 2026-08-30
updated: 2026-08-31
completed: 2026-08-31
priority: high
feasibility: medium
reasoning_effort: high
task_type: bugfix
area: runtime
language_feature: eval
goal: runtime-eval
related: [5202, 5263, 5260, 4245, 5148]
loc-budget-allow:
  # 2026-08-31 — the #5217 fix (78d58325, "preserve QuickJS boolean mirror
  # values") lands in the boolean mirror path, which lives in this god-file:
  # src/codegen/expressions/calls.ts 10304 -> 10339 (+35). The growth IS the
  # fix, not incidental accretion, and splitting the mirror path out of
  # calls.ts is a refactor this bugfix should not carry. Granted for this
  # change-set only.
  - src/codegen/expressions/calls.ts
origin: "2026-08-30 bisect of the quickjs-wasi-artifact lane, which had been red since 2026-08-29 and was blocking #5260 and #5263 from auto-enqueue."
---

# QuickJS eval membrane: descriptor property values read back as native functions

`tests/quickjs-eval-membrane.test.ts` → `#4245 slice 1 … > descriptor VALUES
cross faithfully, including a false flag` fails on `main`:

```
AssertionError: expected +0 to be 1 // Object.is equality
  ❯ tests/quickjs-eval-membrane.test.ts:1125:37   // expect(outward.enumValProbe()).toBe(1)
```

## What is actually wrong

Eval'd QuickJS code calls a **compiled** function with a descriptor object built
inside the QuickJS realm:

```js
inspectDescriptor({ enumerable: true, writable: true, configurable: false, value: 1 })
```

Inside the compiled function, `String(desc.enumerable)` should be `"true"`. It
is not. Narrowed by successively encoding the value through the probe's return
channel (the probes return numbers, so the string had to be decoded in stages):

1. not `"true"`, `"false"`, `"undefined"` or `""`
2. length 29, first char `f` (char code 102)
3. exact match against `"function () { [native code] }"` — **confirmed**

So reading the `enumerable` property off a QuickJS-created object from compiled
code yields **a native function object** instead of the boolean value.

**It is not specific to `enumerable`.** Probing both fields at once shows
`configurable` (`false`) comes back as the same
`"function () { [native code] }"`. Those two are the only **booleans** in the
fixture — `value: 1` is a number and the ordinary `.k` / `.v` reads in
`readProbe` are a number and a string, and all of those cross correctly.

**Working hypothesis: boolean property values do not survive the outward
crossing** — they materialize as a native function object rather than as
`true`/`false`. That is a value-marshalling bug, not a property-name collision.
It predicts that any boolean read off a QuickJS object from compiled code is
broken, which is much wider than descriptors and should be the first thing a
fix confirms or refutes.

## What still works — this is a narrow break, not a broken membrane

The same test file's other 56 assertions pass. In particular:

- `fieldsProbe() === 3` — `Object.getOwnPropertyNames(desc)` sees the real own keys
- `badProbe() === 0` — no `__qjs_handle__` leakage into the key set
- `hasEnumProbe() === 1` — `Object.hasOwn(desc, "enumerable")` is correct
- `readProbe() === 412` — reading ordinary properties (`.k`, `.v`) off a QuickJS
  object from compiled code is fine

Key enumeration and key presence are right; only the **value read** for these
descriptor-shaped names is wrong. That asymmetry is the useful clue: whatever
resolves the property is finding a native method before it reaches the object's
own data property.

The test's own comment names this the anti-vacuity check — it exists to catch a
synthesized all-true descriptor rather than a faithfully-crossed one, so this is
the exact failure mode it was written to detect.

## Regressed by

**`598163a6` — PR #5202, "feat(standalone): Deno runtime integration — PR #5148
checkpoint continued".**

Found by `git bisect --first-parent` over 76 merges between `39ef2141` (good)
and `c914ccb1` (bad), zero skips, then confirmed by re-testing the pair
directly:

| commit | | verdict |
| --- | --- | --- |
| `e953e398` | #5242 (first parent) | GOOD — 57/57 |
| `598163a6` | **#5202** | BAD — 1 failed / 56 passed |

The diff is 74 files, +4,501/-854 under `src/`.

I checked the obvious suspect and it does **not** explain this: #5202's changes
to `src/codegen/property-access-dispatch.ts` cover `.byteLength`,
`.BYTES_PER_ELEMENT` and `fn.length` only — nothing that would intercept
`enumerable` or `configurable`. An earlier guess that a native-prototype method
table was shadowing the read is therefore unsupported; recording it here only so
nobody re-runs that check.

Given the boolean hypothesis above, the places worth looking first are the
value-marshalling paths the PR did touch — `src/ir/runtime-eval-boundary-plan.ts`
(+47), `src/interp/emitter.ts` (+445) and `src/interp/runtime-ops.ts` — for how
a QuickJS boolean is boxed on the way out.

## Why nobody noticed

Two independent reasons, both worth fixing separately from this bug:

1. **`.github/workflows/quickjs-wasi-artifact.yml` runs on `pull_request` only**,
   over a narrow path list, and never on `main` — no cron either. A regression
   here is invisible until some PR happens to touch one of those paths, and then
   it blocks that PR.
2. **The failure was masked by an OOM.** #5202 also pushed the suite past the
   512 MB vitest worker default, so every run since died in
   `quickjs-eval-membrane.test.ts` before its assertions ran — only
   `issue-4242-eval-engine-parity.test.ts` completed. #5263 raises the cap
   (`VITEST_FORK_MAX_OLD_SPACE_SIZE: 1024`), which is what made this visible.

Because the lane is red, `classifyChecks()` in `scripts/enqueue-green-prs.mjs`
applies its zero-FAILURE rule (which covers non-required checks too, #3878/#3904)
and `auto-enqueue` skips the PR outright — observed on #5260:
`- #5260 skip (failing-checks: quickjs eval-engine lane (non-required): fail)`.

## Reproducing locally

It does reproduce locally; the trick is that the provider must be built first
and the adapter cache must not be shared.

```bash
node --import tsx scripts/build-quickjs-eval-provider.mjs      # ~45s, builds the artifact
JS2WASM_EVAL_ENGINE=quickjs VITEST_FORK_MAX_OLD_SPACE_SIZE=1024 \
  npx vitest run tests/quickjs-eval-membrane.test.ts
```

Two traps that cost real time here:

- `--require-cache` **refuses to build** by design (it only verifies an existing
  cache). Its failure is not evidence that a local build is impossible.
- **The adapter cache key collides across commits.** Building at `39ef2141` and
  at `c914ccb1` both produced key `3760c638cb762b27` with outputs of
  **1,856,831** and **3,433,113** bytes. A shared `.test262-cache` therefore
  serves an adapter compiled from different source, silently — which produced 8
  phantom failures instead of the real 1 until the adapter was purged per
  commit. Any bisect or A/B over this lane must `rm -f
  .test262-cache/quickjs-eval-adapter-*.wasm` at every step. Worth its own
  issue.

## Acceptance criteria

- `desc.enumerable` read from compiled code on a QuickJS-created object yields
  the boolean `true`, so `String(...)` is `"true"`
- `tests/quickjs-eval-membrane.test.ts` passes 57/57
- The fix is understood at the dispatch level, not papered over by special-casing
  the four descriptor field names — the same path presumably mis-resolves any
  data property that collides with a native method name
- A regression test that would fail on `598163a6` without the fix

## Resolution

Completed on 2026-08-31 while shepherding PR #5263.

The outward mirror now stores canonical provider-to-caller value carriers
instead of leaking provider-local primitive boxes. Booleans use a scalar-only
intrinsic so their i32 payload enters the carrier before any module-local box is
materialized; mirror push unwraps that carrier before writing back to QuickJS.
The caller's dynamic `String(any)` lowering now recognizes rebuilt boolean
boxes before the generic object/callable ToPrimitive path.

Validation: `tests/quickjs-eval-membrane.test.ts` passes 58/58, including a
new property-name-independent object with both `true` and `false` fields and
their `String(...)` results.
