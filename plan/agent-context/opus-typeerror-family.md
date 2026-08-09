# opus-typeerror-family — context dump (CLOSED 2026-07-25)

Lane: standalone `type_error` (3,038) + `runtime_error` (113) + `promise_error`
(54) + `range_error` (18).

**Outcome.** One root cause found, fixed and landed: **#3616** (PR #3608, merged
`1f04fafab`) — BigInt TypedArray constructors were `null` in value position under
standalone. Measured gross +2 / −1, net +1 on a 22-row sample; **~14 % of the
627-row cluster converted**, which is the lane's most transferable result (see
the symptom-label warning below). One PR-saving **negative** result recorded: the
235 `Array.prototype.<m> is not yet callable as a value` rows are a masking
artifact, not a gap. The rest of the lane is untouched and ranked at the bottom
of this file.

Lane closed with the fleet reduction; nothing is in flight and no claims are
held (#3616 released as `done`). This file is the handoff.

## Data provenance

- Post-#3592 standalone merged artifact:
  `/workspace/.claude/worktrees/agent-aeb44e25b6597e676/.tmp/mg3601/test262-standalone-results-merged.jsonl`
  (ts 10:02:53, oracle 11 honest) — pass 22,621 · fail 18,325 · CE 7,002.
- Pre-#3592 baseline:
  `/workspace/.claude/worktrees/agent-aeb44e25b6597e676/.tmp/standalone-baseline.jsonl`
  (ts 04:43:57) — pass 27,709 · fail 13,236 · CE 7,003.
- Diff scripts (mine, reusable):
  `.tmp/diff.mjs`, `.tmp/bucket.mjs`, `.tmp/bucket-full.mjs`, `.tmp/sub.mjs`,
  `.tmp/split2.mjs`, `.tmp/sample.mjs` in this worktree.
- Local single/batch test runner: `.tmp/run-one.mts`, `.tmp/batch.mts`
  (4th arg of `runTest262File` = `"standalone"`; there is **no env var** for the
  lane — that cost me a wasted first run). Direct-compile probe: `.tmp/p1.mts`
  (note `compile()` is **async** — `await` it or `r.errors` is undefined).

## Newly-revealed subset (the lead's stated priority)

pass→non-pass = **5,129**. Split by `error_category`:

| category       | n       |
| -------------- | ------- |
| assertion_fail | 4,496   |
| other          | 371     |
| **type_error** | **179** |
| illegal_cast   | 43      |
| null_deref     | 21      |
| (none)         | 15      |
| range_error    | 3       |
| oob            | 1       |

**My lane is only 182 of the 5,129 newly-revealed.** The bulk of my 3,038
`type_error`s are PRE-EXISTING, not de-vacuified today. So within my lane the
highest-yield work is in the pre-existing population, not the flip set.

## Cause taxonomy — full post-landing lane (n = 3,223, 132 distinct signatures)

| n     | signature                                                                                                 | verdict                                        |
| ----- | --------------------------------------------------------------------------------------------------------- | ---------------------------------------------- |
| 1,128 | `TypeError: Cannot access property on null or undefined at N:N`                                           | **REAL standalone gap** — see root cause below |
| 527   | `dynamic eval is not supported in standalone mode`                                                        | wont-fix (deliberate)                          |
| 400   | `Cannot convert undefined or null to object`                                                              | unexamined                                     |
| 137   | `Cannot access property on null or undefined` (no loc)                                                    | unexamined                                     |
| 235   | `Array.prototype.<m> is not yet callable as a value in --target standalone` (34 methods; `map` alone 117) | **SECONDARY — do not chase, see below**        |
| 111   | `Cannot read properties of undefined (reading a class field)`                                             | unexamined                                     |
| 83    | `Object method called on null or undefined` (annexB 64)                                                   | unexamined                                     |
| 78    | `Object.defineProperties unsupported descriptor shape`                                                    | narrow, self-describing                        |
| 51+43 | `Cannot destructure 'X' or 'X'` (+ async variant)                                                         | unexamined                                     |
| 37    | `Generator.prototype.next requires that 'X' be a Generator`                                               | unexamined                                     |
| 31    | `Reduce of empty array with no initial value`                                                             | unexamined                                     |

### The distinction the lead asked for (spec-correct vs missing-builtin)

Two findings, both verified with real repros, not bucket labels:

**(1) `Array.prototype.<m> is not yet callable as a value` (235) is NOT a
standalone-gap win — it is a MASKING artifact. Do not spend a PR on it.**
Emitted at `src/codegen/array-object-proto.ts:733` (`emitArrayProtoMemberBody`
— only `slice` has a `*FromVecLocal` core; #2193 PR-C never landed). The reason
it is secondary: the call site is the real test262 harness
`harness/assert.js:140`

```js
compareArray.format = function (arrayLike) {
  return `[${Array.prototype.map.call(arrayLike, String).join(", ")}]`;
};
```

and `assert.compareArray` (line 120–124) **returns early on success** — `format`
is reached ONLY on the failure branch. So every one of these tests had ALREADY
failed its content comparison; the missing `map`-as-value merely replaces the
honest `Test262Error: Actual [...] and expected [...]` message with a TypeError.
Verified: `built-ins/Object/keys/order-after-define-property-with-function.js`
fails identically in the JS-host lane with the honest message
(`Actual [length] and expected [length, a] should have the same contents`).
Landing the `*FromVecLocal` cores would yield **zero** passes; it would only
un-mask ~235 rows into the `assertion_fail` lane. Worth telling
`opus-assertfail-triage` — it means ~235 of their future rows are currently
hiding in my bucket, and their true error text is only visible in the host lane.

**(2) `Cannot access property on null or undefined at N:N` (1,128) IS a real
standalone-gap defect, and 627 of them share ONE root cause.** Split:
BigInt-path 627 · Temporal 213 · rest 288.

## ROOT CAUSE FOUND (627 tests) — BigInt TypedArray ctors are `null` as VALUES in standalone

`BigInt64Array` / `BigUint64Array` used in **value position** (not `new X()` /
type position) evaluate to `ref.null.extern` under `--target standalone`.

Chain: `src/codegen/expressions/identifiers.ts:1220` gates the first-class
`$__ta_ctor` value on `taCtorKindOf(name) >= 0`; `taCtorKindOf`
(`src/codegen/registry/types.ts:356`) indexes `TA_CTOR_KINDS`, which listed only
the **9 non-BigInt** views. So the two BigInt names fall through to the
`reportSilentFallback("const-fallback", "identifiers:unimplemented-global-default")`
default at line 1248 → `ref.null.extern`.

The host/gc lane was already fixed by #3087 (`identifiers.ts:834-862` routes
both names through `__extern_get(globalThis, name)`, comment explicitly says
"Covers the BigInt views too (not in the standalone `taCtorKindOf` list)"). Only
the host-free lane was left behind. This is a **third residual of #2401**,
distinct from its recorded (a) `BUILTIN_TYPES` method routing and (b) unsigned
i64 semantics.

Why it hits 627 rows: the test262 runner's shim
(`tests/test262-runner.ts:2157`) is
`const constructors = [BigInt64Array, BigUint64Array]; … fn(constructors[i], …)`
— so `TA` is `null` in every `testWithBigIntTypedArrayConstructors` callback and
`new TA(...)` yields null, then `sample.<anything>` is the reported TypeError.

### Verified probes (all in `.tmp/`, standalone lane)

- `.tmp/t5.ts` — `[Int8Array, Uint8Array, Int32Array, Float64Array,
BigInt64Array, BigUint64Array]`: indices 0–3 non-null, **index 4 is `null`**
  (returned 104). After the fix: returns 1 (all six non-null, and dynamic
  `new TA(4)` gives `.length === 4` for all six).
- `.tmp/t3.ts` / `.tmp/t2.ts` — reproduce the exact harness shape
  (`fn(constructors[i], makeCtorArg)` → `new TA(makeCtorArg([...]))`), returned
  21 = "sample is null" before the fix.
- `.tmp/t1.ts` — direct `new BigInt64Array(4)` **already worked** (`.length === 4`),
  confirming #838's native i64-vec landed and isolating the defect to the
  VALUE-position path only.
- `.tmp/t6.ts` — separate, narrower gap found in passing: `new names[i](4)`
  (`new` directly on an element-access callee) returns null even for the
  non-BigInt views, while `const TA = names[i]; new TA(4)` works. NOT fixed by
  this change; worth its own issue if anyone wants it (the harness uses the
  working shape, so low yield).

### Corpus size / regression surface

BigInt TypedArray corpus in the post-landing artifact: **pass 28 · fail 685 · CE 64**.
Small pass surface ⇒ low regression risk, large upside. Note the 8 sampled
passes include vacuous ones (e.g. `byteoffset-is-symbol-throws` —
`assert.throws(TypeError, …)` is satisfied by _any_ TypeError, including
"TA is null"), so a few of the 28 may honestly flip to fail; that must be
measured, not assumed.

## Change implemented (uncommitted at pause)

Branch `issue-3616-standalone-bigint-ta-ctor-value`, issue id **#3616**
allocated via `claim-issue.mjs --allocate`, lock taken for
`ttraenkler/opus-typeerror-lane`. Three edits:

1. `src/codegen/registry/types.ts` — **append** (never insert) `BigInt64Array`,
   `BigUint64Array` to `TA_CTOR_KINDS` as kinds 9/10, and `8, 8` to
   `TA_CTOR_BYTES`. Appending is load-bearing: the `kind` index is baked into
   the `$__ta_ctor` singleton globals and into every `if`-chain arm of the
   decode/encode/BYTES_PER_ELEMENT dispatches, so inserting would silently
   repoint existing kinds.
2. `src/codegen/dataview-native.ts` — `TA_VIEW_DECODE` gains the two rows with
   `bytes: 8, float: false, int64: true` (signed / unsigned respectively). The
   `int64` flag matters: without it an 8-byte non-float read takes the
   `f64.reinterpret_i64` path (correct for `Float64Array`, garbage for an
   integer view). These rows are **inert for the static lane** — `taViewDecode`
   resolves names via `getTaViewName` over `ctx.taViewTypeMap`, and #838 gave
   the BigInt views a native i64 vec rather than a `$__ta_view_<name>`, so no
   static BigInt view type is ever registered.
3. Same file — `emitDynDecodeDispatch` / `emitDynEncodeDispatch` thread
   `int64: desc.int64` into `emitReadBytes`/`emitWriteBytes`, and the decode
   arm appends `f64.convert_i64_s` / `_u` after the read. Required because
   `emitReadBytes` deliberately LEAVES the i64 on the stack for an `int64`
   accessor (the DataView `getBigInt64` BigInt carrier), while every arm of this
   dispatch's `if` is typed `f64` — the BigInt arms must converge to the same
   carrier. **Convert, not reinterpret.**

Scope note: element VALUES in a dynamically-constructed BigInt view remain the
f64 carrier, NOT i64-branded BigInts. That representation split is
#1349/#2401(b) and is deliberately out of scope. This change buys the
STRUCTURE — non-null identity-stable ctor, correct 8-byte width, working
`length`/`byteLength`/MOP — which is what the harness rows gate on. Content
assertions keep failing honestly.

`f64.convert_i64_s`/`_u` are both already in the `Instr` union
(`src/ir/types.ts:258-259`) — no union extension needed.

## Resume steps

1. `cd /workspace/.claude/worktrees/agent-ac28deeda1c1e07e1` — branch
   `issue-3616-standalone-bigint-ta-ctor-value` is checked out; the three edits
   above are **in the working tree, uncommitted**. `git diff` to confirm.
2. Re-claim if needed: `node scripts/claim-issue.mjs 3616
ttraenkler/<agent> --branch issue-3616-standalone-bigint-ta-ctor-value --force`.
3. **The measurement that was interrupted** — this is the one thing that must
   finish before the PR: `npx tsx .tmp/batch.mts after.json` and diff against
   `.tmp/before.json`. BEFORE is already captured and matches CI exactly
   (14 fail / 8 pass on the 22-test stride sample — local harness verified
   faithful). AFTER was killed at the PAUSE. If AFTER shows net-positive,
   widen the sample (`.tmp/sample.mjs`, raise the `pick` counts to ~60) for a
   confident before/after count, then write the issue file
   `plan/issues/3616-standalone-bigint-ta-ctor-value.md` (`sprint: current`,
   `status: done`, `umbrella: 2860`, `related: [2401, 3054, 3087, 3177, 838]`)
   and open the PR.
4. `npx tsc --noEmit -p tsconfig.json` had not completed at the pause — rerun.
5. Run `prettier --write` on the two touched files before pushing (CI `quality`
   uses prettier, not biome).
6. Push to **`fork`**, `gh pr create -R loopdive/js2 --head ttraenkler:<branch>`,
   verify the URL starts with `github.com/loopdive/`.

## Unexamined, ranked, for whoever picks this lane up next

> **These are SYMPTOM LABELS, not causes — do not size a fix from a bucket
> count.** Every number below is "rows sharing an error string", which is a
> cross-section of unrelated defects, not a work item. Three independent
> confirmations on 2026-07-25: (a) the trap lane's largest bucket dissolved into
> unrelated defects that merely shared one stack frame; (b) the 1,128-row
> `Cannot access property on null or undefined` signature split into ≥3
> unrelated causes (BigInt ctors 627 / Temporal 213 / rest 288); (c) even
> _within_ the single verified root cause of #3616, fixing it converted only
> **14 %** of its 627 rows — the defect was necessary but not sufficient, and the
> other ~86 % proceeded to a _different_ downstream defect. Treat each cluster as
> a population to sample and root-cause per-cause, and expect a ladder of
> defects behind each row rather than one fix. **Always verify with a real repro
> before committing to a cluster** (and see the `runTest262File` warning below —
> the category label itself can be wrong).

1. **`Cannot access property on null or undefined` — 1,128 total**, the largest
   single signature in the lane, and the proof that these labels are symptoms:
   it splits into BigInt TypedArray ctors 627 (root-caused and fixed by #3616,
   but only ~14 % converted), Temporal 213, and other 288 — at least three
   unrelated causes. The 627 sub-population is **not closed**; it is now a stack
   of downstream defects behind the fixed constructor.
2. **Temporal 213** rows inside that same signature — plausibly the same
   "constructor/namespace is null as a value" shape as #3616, different builtin.
   Cheapest next probe: repeat the `.tmp/t5.ts` pattern with `Temporal.*` names.
   Unverified.
3. **`Cannot convert undefined or null to object` (400)** — TypedArray 64,
   Date 53, annexB 38, Symbol 21. Not yet root-caused.
4. **`Cannot read properties of undefined (reading a class field)` (111)** —
   evenly split language/expressions 56 / language/statements 55, so _possibly_
   one codegen shape. Unverified — the even split is suggestive, not evidence.
5. **`Object method called on null or undefined` (83)** — annexB-dominated (64).

## Standing rule: `runTest262File` cannot classify a standalone failure

Learned the hard way here; it cost this lane and the `assertion_fail` lane real
time on the same day. `runTest262File` (`tests/test262-runner.ts`) is **not** the
CI path — it does not use `tryNativeExnRender`, so a standalone Wasm-GC payload
renders as `uncaught Wasm-GC exception (non-stringifiable payload)`. Downstream
of that opaque string, **both the error category and the reported line number
are wrong**: on #3616 it reported category `other`, a null innermost frame, and
`at L16` (a top-level assertion) for a row whose real failure was
`Test262Error: following shrink (out of bounds)` — category `assertion_fail` —
deep inside a harness callback. That manufactured a false blocker (an apparently
frameless trap-tier row, which no allowance can excuse).

**Only pass/fail STATUS from `runTest262File` is trustworthy.** Any question
about category, message, or location must go through the CI-equivalent path:

```
assembleOriginalHarness → CompilerPool(n, "unified") → scripts/test262-worker.mjs
```

Working harness: `.tmp/run-pool.mts` (pool size 1 for a single row). It needs two
generated bundles that are gitignored and not in the tree:

```bash
npx esbuild scripts/compiler-bundle-entry.ts --bundle --platform=node --format=esm \
  --outfile=scripts/compiler-bundle.mjs --external:typescript --external:binaryen \
  --external:@typescript/native-preview '--external:@typescript/native-preview/*'
npx esbuild src/runtime.ts --bundle --platform=node --format=esm \
  --outfile=scripts/runtime-bundle.mjs --external:typescript --external:binaryen
```

## Out-of-lane handoffs

- `opus-3610-brandchecks` (trap lane): nothing handed over yet. The
  `illegal_cast` 43 / `null_deref` 21 in the newly-revealed set are theirs.
- `opus-assertfail-triage`: see finding (1) — ~235 rows of theirs are currently
  masked inside my `type_error` bucket by the missing
  `Array.prototype.map`-as-value; their true assertion text is only readable in
  the JS-host lane until #2193 PR-C lands.
