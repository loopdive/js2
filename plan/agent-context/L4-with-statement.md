# L4 — `with` statement lever: handoff (2026-08-06)

Handing off mid-lever on the coordinator's instruction (`model: fable` routing).
Everything below is **measured**, not estimated.

## Where the work is

| | |
| --- | --- |
| Worktree | `/home/user/js2/.claude/worktrees/agent-acef07a59fc9efb7d` |
| Branch | `issue-2663-with-compound-rmw` (pushed to `origin`, commit `373474de2`) |
| Issue | **#2663, the `with` half only.** L3 owns the AnnexB half and has taken a fresh id, so 2663 stays whole for `with`. |
| Claim | released — re-claim before continuing |
| PR | **none opened** — see "What I'd do next" |

The branch is green locally: `tsc --noEmit` clean, `biome lint` clean,
`check:loc-budget` and `check:func-budget` pass (both via `loc-budget-allow:` /
`func-budget-allow:` entries added to the #2663 frontmatter, with per-entry
reasons), and `tests/issue-2663-with-rmw.test.ts` is 10/10.

## Measurement harness (reuse it — it is validated)

`.tmp/l4/run-lever.mts` runs a file list on the **standalone** lane via
`runTest262File` and buckets errors with `.tmp/l4/bucket.mjs`:

```
npx tsx .tmp/l4/run-lever.mts .tmp/l4/lever.txt .tmp/l4/OUT.json
node .tmp/l4/bucket.mjs .tmp/l4/OUT.json -v
```

**One instrument bug you must not re-hit.** `tests/test262-runner.ts`'s
in-process `runTest262File` does **not** attach the `js2wasm:runtime-eval`
provider namespace that `scripts/test262-worker.mjs` does. Without it every
eval-mentioning standalone module dies at instantiation with
`Import "js2wasm:runtime-eval": module is not an object or func` — **44 of my
152 files**, pure artifact, and it *masks* the real signature. The harness now
monkeypatches `WebAssembly.instantiate` to inject
`instantiateRuntimeEvalNamespace(providerModule)`, loading the provider binary
directly from `.test262-cache/runtime-eval-provider-*.wasm` (prebuild once:
`node --import tsx scripts/build-runtime-eval-provider.mjs`, ~2 min). Loading
the cached binary directly, rather than through `selectCachedRuntimeEvalProvider`,
is deliberate: the cache key includes the compiler-bundle hash, so keying off it
would silently rebuild the provider between the A and the B of an A/B.

Validation that the instrument is honest: after the fix the bucket histogram
(30 / 15 / 12 / 12 / 11 / 10 / 9 / 8) reproduces the published 2026-08-06
baseline header exactly, and the `p1 === "x1". Actual: p1 === 1` signature
matches the 2026-08-04 re-measure. Before the fix it did not.

## Measured result

| lane | before | after |
| --- | ---: | ---: |
| full 152-file lever list, standalone | **0** | **15** |
| the 45-file compound-assign + inc/dec subset | 0 | 15 |

Zero regressions: every other bucket in the 152 is identical before and after.
Separately A/B'd the existing `with` unit tests by swapping main's source back
in via file copies (never `git stash`) — **13 failures in
`tests/issue-2663*.test.ts` + `tests/issue-1387*.test.ts` are pre-existing on
main and unchanged by this work.**

## Strategy chosen, and the evidence

**Neither (a) "widen the provable-shape analysis" nor (b) "build a real dynamic
tier" — both already exist on main, and neither was the binding constraint.**
That is the main thing I do not want re-derived.

What is actually on main (verify with `.tmp/l4/probe2.mts`, which prints the
emitted import list):

- **Tier 1 static, object literal** (#1387) — `with ({x: 1}) {…}`.
- **Tier 1 static, closed-struct-TYPED variable** (#3025 W1,
  `proveStructTypedWithTarget`) — `var o = {x:6}; with (o) {…}` compiles to
  `struct.get`/`struct.set` and emits **no** with-related import.
- **Tier 2 dynamic** (#2663 Slices 1/2/4) — `var scope = { get x(){…} };
  with (scope) {…}` emits `__with_has_binding` and routes reads/plain writes
  through a runtime HasBinding gate.

So the "proven closed object-literal shape" refusal is **not** the dominant
failure. On my list it fires on only **12 of 152**, and only for the one
condition it names: a body containing a nested function/class boundary
(`containsNestedFunctionBoundary`). The 12 refusals are the *honest* bucket.

The real hole was **Slice 3, which #2663 itself names as the residual**: neither
`compileCompoundAssignment` (operator-assignment.ts) nor the update-expression
paths (unary-updates.ts) consulted `fctx.withScopes` **at all**. Probe on main:

```
var x = 0; var o = { x: 6 }; with (o) { x /= 3; }   →  o.x = 6, x = 0
```

both wrong — the read and the write both went to the outer `x`. That is 45 of
the 152 files (all of `compound-assignment/S11.13.2_A5.*` + `prefix-`/`postfix-`
`increment`/`decrement`), i.e. the single largest coherent slice, and it needs
no new substrate at all. That is why I chose it.

The one genuinely new piece of reasoning: this is **not** "read then write."
§13.15.2 / §13.4 resolve the LHS to a Reference ONCE and then GetValue **and**
PutValue on that same Reference. The whole `_A5_*` family is built to catch a
compiler that re-decides — the with-object exposes
`get x() { delete this.x; return 2 }`, so by write time the property is gone and
a re-decided HasBinding would send the write to the surrounding environment
record, which the tests assert must stay untouched. Hence
`captureDynamicWithHasBindings` before the read, and both
`emitDynamicWithCascadeRead` and `emitDynamicWithIdentifierWrite` branching on
those captured i32s. Slice 2 already learned this the hard way for plain `=`
(the #2061 `S11.13.1_A6_T3` regression); Slice 3 needed the same capture
extended to cover the *read*.

## What I'd do next, in order

1. **Open the PR for this branch and land it.** +15 measured, zero regressions,
   all gates green. It is self-contained and blocks nothing. I did not open it
   only because the handoff arrived first.

2. **The `_T2`/`_T3` residual is NOT the RMW logic — do not re-work it.** All 15
   `_T1` variants (the `with` inside a `function`) now pass; all 15 `_T2`
   (top-level) and 15 `_T3` (nested, top-level) still fail with the same
   `Actual: NaN`. Diagnosed with `.tmp/l4/probe-top.mts` (compiles the `with` in
   `__module_init` rather than a function body): the RMW routes correctly, but
   the final `scope.x` read-back still runs the **getter**, i.e. the
   `delete this.x` and the `__extern_set` write are invisible to the compiled
   property read. This is the module-scope **struct-slot vs sidecar
   observability gap** — the #2659 family, which #2663 already flags for
   `delete`. Fixing that is worth **+30 on this list alone** and is a
   value-representation problem, not a `with` problem.

3. **Nested with over two STATIC scopes sharing a name picks the wrong scope.**
   Pre-existing, fails on main for the plain READ
   (`tests/issue-2663.test.ts > nested with: inner object shadows the outer for
   a shared name`). I deliberately left this unasserted in my test file with a
   comment rather than shipping a duplicate red. Small and probably cheap.

4. Remaining buckets on the 152, all still open and all distinct mechanisms:
   `12 null_deref in __str_concat` (`S12.10_A3.*`), `12` nested-function-boundary
   refusals, `11 p1 === null`, `10 myObj.p1`, `9 p2 === "x2"`,
   `8 result === "value"`.

## Dead ends / traps

- **`npx biome check --write` is NOT this repo's formatter.** `package.json`
  uses **prettier** for `format`; biome is lint-only. Running `biome check
  --write` reflowed four files wholesale (~2,800 lines of noise) and moved the
  license header below the imports via organize-imports. I recovered by
  `git checkout HEAD --` on the touched files and re-applying the edits by hand.
  Use `npx prettier --write`.
- **`operator-assignment.ts`, `unary-updates.ts` and `assignment.ts` are all
  over the 1,500-line LOC ratchet**, so *any* net growth fails CI. All new logic
  therefore lives in the new `src/codegen/with-rmw.ts`; the three hooks are 8-17
  lines each and are granted in the #2663 frontmatter. `check:func-budget` fires
  separately and needs its own `func-budget-allow:` — run **both** locally.
- The `__unbox_number` numeric path is `ToNumber`, not a full `ToNumeric`
  (BigInt is not handled). Same limitation as the existing property-compound
  path; it does not affect this corpus.
