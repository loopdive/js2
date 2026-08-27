---
id: 4782
title: "tests/issue-4527-call-dyn-bridge.test.ts mixed-spread row is red on main and nothing gates it"
status: done
sprint: current
created: 2026-08-27
completed: 2026-08-27
assignee: ttraenkler/opus-4782
priority: medium
horizon: s
feasibility: medium
task_type: bug
area: codegen
language_feature: spread
related: [4527, 4775, 4780]
# (2026-08-27) +7 lines in the spread arm of `emitSetExtrasArgv`: one
# `ensureLateImport("__box_number")` call plus the six-line comment recording
# WHY it must run before the reader funcidxs are captured (registering it later
# shifts `lenFn`/`getFn`/`iterFn` out from under the already-emitted body — the
# next reader of this code would otherwise "simplify" it back into the bug).
# No behavioural code was added; the fix is the ordering.
loc-budget-allow:
  - src/codegen/statements/nested-declarations.ts
func-budget-allow:
  - src/codegen/statements/nested-declarations.ts::emitSetExtrasArgv
# (2026-08-27) **Id renumbered from 4779.** Open PR #5073 (codex lane) also adds
# an issue file under id 4779 — a different one, slug
# `es2015-bigint-tostring-symbol-radix-standalone` — and the required
# `check:issue-ids:against-open-prs` gate correctly failed PR #5076 on the
# collision. (Written without the `plan/issues/<id>-<slug>.md` path shape on
# purpose: the #1616 link gate resolves that shape anywhere under `plan/` and
# would fail `quality` on a file this branch does not carry.) The ref tie-break actually favoured THIS side (our 4779 reservation
# was recorded at 16:12:58Z on `origin/issue-assignments`; #5073's file carries
# no reservation at all, and its PR opened at 16:27:21Z), but that lane is
# unreachable and PR #5076 carries a 28.5x perf fix, so we yielded the id rather
# than block on a lane that cannot answer.
#
# The 4779 reservation could NOT be withdrawn: `claim-issue.mjs --release`
# operates on live CLAIMS only, and answers "not currently claimed — nothing to
# release" for a `status=reserved` record, which then survives unchanged
# (re-read after the attempt: still `RESERVED … 16:12:58Z`). So a yielded id
# leaves a permanent reservation record behind. Harmless here — it only keeps
# `--allocate` from re-handing out 4779, and #5073's file lands on `main` under
# that id regardless, after which `check:issue-ids:against-main` is the arbiter
# — but worth knowing before anyone plans a yield expecting a clean withdrawal.
#
# (2026-08-27) Reserved with `--allow-unscanned` — no `gh` in this container, so
# `claim-issue.mjs`'s open-PR scan degrades unconditionally. The scan was run
# directly against the REST API with curl instead: the 9 open PRs on
# loopdive/js2 (#5063, #5067, #5069, #5070, #5072, #5073, #5074, #5075, #5076)
# add or modify issue files {1691, 3481, 3525, 4775, 4777, 4778, 4779, 4780,
# 4781}. 4782 collides with none of them.
---

# #4782 — the `#4527` mixed-spread row is red on main

## Problem

`tests/issue-4527-call-dyn-bridge.test.ts` fails 1 of its 33 tests on
`origin/main` @ `2a7548ca81`:

```
issue #4527: cross-module dynamic callback invocation
  > routes mixed spreads to arguments for zero-formal class methods
AssertionError: expected 46 to be 52
```

The fixture calls a zero-formal class method with a mixed argument list —
literal, inline spread, spread of a local, and a trailing comma — and reads the
result back through `arguments`:

```js
class C {
  method() {
    return arguments.length + arguments[0] + arguments[1] + arguments[2] + arguments[3];
  }
}
export function t() {
  const tail = [2, 3];
  return C.prototype.method(42, ...[1], ...tail,);
}
```

Correct is `4 + 42 + 1 + 2 + 3 = 52`. Main returns **46**, which decomposes as
`4 + 42 + 0 + 0 + 0` — so `arguments.length` is right and `arguments[0]` is
right, but **every spread-sourced element reads as 0**. The spread contributes
to the count and not to the values.

## Provenance

Found incidentally while triaging
[#4775](https://js2wasm.loopdive.com/dashboard/issue.html?slug=4775-numeric-return-twin-suite-red-on-main),
which ran this suite as part of validating a fix against the test surface of
`ad543a660e`. **Verified pre-existing on an unmodified working tree** (`git
status` clean at `2a7548ca81`) — it is not collateral from that work.

## Why nobody noticed

Same structural gap #4775 documents: this file lives under `tests/`, not
`tests/equivalence/`, so `equivalence-gate` does not run it, and no other
required check does either. The suite is 32/33 green, so a casual run reads as
healthy.

## Acceptance criteria

- The row passes, with the spread-sourced elements reaching `arguments`.
- The verdict says whether this ever worked (bisect, as #4775 did) or whether
  the row was aspirational when `#4527` landed — those need opposite fixes and
  the difference is cheap to establish.
- If a value is wrong rather than a shape, do NOT re-pin the wrong value
  (#4743/#4747 precedent).

## Verdict (2026-08-27) — REGRESSION, not born-red

The row was **green when it landed**. Bisected on `origin/main` @ `76c47838e1`
by checking out `src/` per candidate commit and running the single row (the
test file itself is unchanged since it was added, so only `src/` moved):

| commit | first-parent # | row |
| --- | --- | --- |
| `655b3ab2ef` — the commit that ADDED the row | base | **GOOD** |
| `3841d12a17` | 30 | GOOD |
| `087a4a4f66` | 45 | GOOD |
| `653ee0715f` | 46 | GOOD |
| `f2ac1030e1` | 47 | **GOOD** (last good) |
| `52b61990fe` — merge of PR #4922, `fix(es5): combine standalone conformance gains` | 48 | **BAD** (first bad) |
| `9894d1ead5` / `91e77f7303` / `e64ef26521` / main | 49…119 | BAD |

PR #4922 did not touch the broken code. It changed *when* `__box_number` gets
registered in a module, which is all this defect needed — see below.

## Root cause

`emitSetExtrasArgv` (`src/codegen/statements/nested-declarations.ts`) builds
the `__extras_argv` vector for a call whose callee reads `arguments`. In the
spread arm it caches the boxer's funcidx **once**, before emitting anything:

```ts
const boxIdx = ctx.funcMap.get("__box_number");
const boxVecElem = (elemKind) =>
  elemKind === "f64"
    ? (boxIdx !== undefined ? [{ op: "call", funcIdx: boxIdx }]
                            : [{ op: "drop" }, { op: "ref.null.extern" }])
    : /* … */;
```

The `undefined` arm is a silent value-dropping fallback, and the cache can
legitimately be `undefined` at that point: the extras loop is often the FIRST
site in the module that needs the boxer, and the plain numeric argument that
registers it (`42`, via `coerceTopToExternref` → `coerceType` →
`ensureLateImport`) is compiled *after* the cache was taken. Every
spread-sourced numeric element therefore became `ref.null.extern`.

Disassembly of the failing module (`wasm-dis`), spread-of-a-local arm:

```wat
(array.set $0 (local.get $10) (local.get $11)
  (block (result nullexternref)
    (drop (array.get $2 (struct.get $5 1 (ref.as_non_null (local.get $8)))
                        (local.get $12)))
    (ref.null noextern)))          ;; ← value read, then discarded
```

That is why the symptom looked self-contradictory:

| read shape | broken build | why |
| --- | --- | --- |
| `arguments.length` | correct (4) | the runtime length is computed from the sources |
| `arguments[0]` (non-spread) | correct (42) | `coerceTopToExternref` re-reads `ctx.funcMap` per call |
| `arguments[1..3]` (spread) | `null` → `+ 0` | the stale `undefined` cache |
| `for (i…) s += arguments[i]` | correct (48) | **not a different read path** — a different MODULE. The callee body's own `s += arguments[i]` needs the boxer, and the callee compiles before the caller, so the cache was already valid when the extras arm ran |
| `const a = arguments; "" + a[1]` | correct | same reason: the string concat in the callee registers the boxer first |

The last two rows are the trap in this bug: the value that reaches
`arguments` depends on what *else* the module compiled before the call site,
so two fixtures that differ only in the callee's body disagree. Within ONE
module the split is clean — `tests/issue-4782.test.ts` compiles a spread call
and a non-spread call to the *same* callee, and only the spread one was
`null`.

`4 + 42 + null + null + null` is `46` in JS (`null` numifies to 0), which is
exactly the observed value — not `NaN`, which is what `undefined` elements
would have produced.

## Fix

One line of behaviour: register `__box_number` **before** the reader funcidxs
are captured and the import shift is flushed, in the spread arm of
`emitSetExtrasArgv`. Registering later is not an option — a late import added
after `lenFn`/`getFn`/`iterFn` are captured would shift them out from under the
already-emitted body. This mirrors the file's existing "box first, then flush"
precedent (`src/codegen/expressions/builtins.ts` ~L1726).

## Test Results (2026-08-27)

Measured in this worktree; every "before" number is a run of the reverted file
(`git show HEAD:… > .tmp/base…`), not an inherited figure.

- `tests/issue-4527-call-dyn-bridge.test.ts`: **32/33 → 33/33**. The row reads
  52.
- New `tests/issue-4782.test.ts`: 8 cases, **6 fail on base, 8 pass fixed**
  (class-method mixed spread, per-element constant-index reads, const-vs-loop
  agreement, local-array-only spread, plain-function callee, object-literal
  method + instance receiver, an all-spread call in a module that boxes no
  other number, and a host/standalone twin).
- Neighbour suites, base vs fixed, 28 files / 248 tests:
  **0 pass→fail, 0 fail→pass.** (`arguments-object`, `es5-array-isarray-arguments`,
  `es5-standalone-arguments-callee`, `issue-1053`, `issue-1609`, `issue-2026`×2,
  `issue-2151`×3, `issue-2162b`, `issue-2169`, `issue-2202`, `issue-2864`,
  `issue-3909-3910`, `issue-42`, `issue-4286`, `issue-4373`, `issue-4454`,
  `issue-4536`, `issue-4555`, `issue-4578`, `issue-4616`, `issue-4768`×2,
  `issue-4922`, `new-expression-spread`, `private-arguments-registration`,
  `spread-in-new-expressions`, `spread-rest`.)
- Byte-identity of near-miss shapes (sha256 of the emitted binary, base vs
  fixed): identical for a literal-only spread, a ref-only spread, a no-spread
  call, a plain-function spread, a module with no `arguments`, a spread into
  formals, and a rest-param spread. **Only the broken shape changed** — and it
  got 2 bytes *smaller* (`3101 → 3099`), because one `call` replaces
  `drop` + `ref.null.extern`.

## Residual findings (NOT fixed here)

1. **A formal-ful method with a mixed spread returns `null`.**
   `class C { method(a) { return arguments.length + arguments[0] + … } }` called
   as `C.prototype.method(42, ...[1], ...tail,)` answers `null` (node: 52); the
   same call with no spread answers 52. That is the *other* arm —
   `methodParamCount > 0` routes to `compileSpreadCallArgs`, not to
   `emitSetExtrasArgv` — and it is **pre-existing at `655b3ab2ef`**, i.e. older
   than this regression. Out of scope for #4782; needs its own issue.
2. **43 pre-existing failures in the neighbour suites on clean main** (24 in the
   first batch above, 19 in the second), unchanged by this PR. Same structural
   gap this issue documents: none of those files is under `tests/equivalence/`,
   so no required check runs them. Clusters: `issue-2026` dynamic-new spread
   (11), `issue-2864` generator × arguments standalone (5), `spread-rest` (9),
   `issue-2169` native-generator spread (5).
