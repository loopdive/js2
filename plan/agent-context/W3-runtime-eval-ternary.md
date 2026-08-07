# W3 — #4178 concat-of-a-boxed-any: PR body + handover

**Branch**: `issue-4178-mixed-ternary-ir-box` (pushed to `origin`, no PR — this
container has no `gh`).
**Base**: `bcf4a75c72` (`origin/main`, 2026-08-06).

---

## PR body (copy verbatim)

### fix(#4178): concat of a boxed-any value returned `null` (then trapped) or folded numerically

Two independent **legacy-path** defects, both reached by `"" + <any-valued expr>`.
Neither is the IR bail #4178 names, and neither is eval-mode- or ternary-specific.

**(A) `coerceType`'s `ref → ref_null` arm was missing the `$AnyValue` unbox case.**
It is one of four arms in the same function that dispatch on
`from.kind`/`to.kind`; the other three (`ref_null→ref_null`, `ref_null→ref`,
`ref→ref`) all carry the unbox, including the #1988 "a native string rides in
`externval` (field 4), not `refval` (field 3)" split. `compileAnyBinaryDispatch`
returns exactly `{kind:"ref", typeIdx:$AnyValue}`, so every `any`-operand
`+`/`-`/`*` result assigned to a **nullable** slot fell through to the generic
guarded `ref.cast` below — which tests the **box** against the target type,
always fails, and stores `ref.null`. The next reader (`__str_concat`,
`.length`) then dereferences null and **traps**.

**(B) `tryStaticToNumber` traced `const` initializers for an operand's VALUE but
not for its STRING-NESS.** Its `+` guard only asked "is this a syntactic string
literal?" and "does the checker say `string`?", so for

```ts
const a: any = "1"; const b: any = 2; a + b
```

neither fired (`a` is an identifier; its declared type is `any`) — while the
identifier arm at the bottom of the same function happily resolved `a` through
its `const` initializer to `Number("1") === 1` and folded the whole expression
to `f64.const 3`. The new `resolvesToStringConstant` traces the same way,
through `ctx.oracle.constInitializerOf` (#1930), with the same `const`-only and
#1607 self-reference restrictions, so the guard can no longer be weaker than
the folder it guards.

### Measured

| instrument | before | after |
| --- | --- | --- |
| `scripts/equivalence-gate.mjs` | 36 known-failures | **12 now PASS, 0 new regressions** |
| `tests/equivalence/spec/coercion-arithmetic-add.test.ts` | 8/20 fail | **20/20 pass** |
| 30 scoped test262-harness probes (`--target standalone`, #4162 shim) | 7 trapping + 1 wrong-answer | **all 8 correct, 0 moved backwards** |
| test262 ES5-label standalone A/B, 800-file sample (500 baseline-fails + 300 baseline-passes) | — | **0 gained, 0 lost — no measurable delta** |
| `pnpm run check:ir-fallbacks` | OK | OK (no bucket moved) |
| `tests/issue-{1988,745,2104,2107}.test.ts` | 6 fail | 6 fail — **byte-identical set on base**, all pre-existing |

**State the null result plainly: this change has no measurable test262 delta on
that sample.** The raw run looks like `+25 / −22` against the committed
standalone baseline, and both numbers are artifacts:

- the **+25** (heavily `Object/defineProperty|defineProperties|create|isFrozen`)
  are baseline **staleness** — main moved 76.90% → 78.87% across seven PRs while
  this lane was paused, and the committed jsonl predates them;
- **18 of the 22 −** are my own instrument: I built the provider
  `--refusal-only`, so anything reaching real `eval` reports
  `dynamic code evaluation is not supported in this standalone build`. CI links
  the full interpreter.

I settled it rather than arguing it: re-running the 25 gains + the 4 non-shim
losses on **base** and on **patched** gives `pass 25 / 29` **both times, with 0
per-file differences**. So the honest reading is: the equivalence evidence is
real and cross-lane; the conformance yield is **unproven at this sample size**
(500 of the 2,063 ES5-label failures, ~24%, so a true effect below roughly
±4 tests would not surface).

The 12 equivalence rows are **all 8** `coercion/arithmetic-add` any-concat
entries (`host`, `host-O`, `standalone`, `standalone-O` × two cases) — 22% of
the 36-entry baseline, and #4178's own stated acceptance criterion — plus four
that came free: `#1197 i32 element specialization … x | 0 collapses`,
`Math.pow/min/max with array element args (test262 pattern)`, and two
`Symbol basic support (#471)` rows.

Run `node scripts/equivalence-gate.mjs --update` post-merge to ratchet the
baseline (deliberately **not** committed here — the gate prints the exact
command and CI refreshes on main).

### What this does NOT fix

`lowerConditional`'s arm-type bail (`src/ir/from-ast.ts:8645`) is untouched. A
mixed-type ternary inside an **IR-eligible** function still hard-errors with
`ir/from-ast: ternary branches have different types`. `tests/issue-4178.test.ts`
pins that as the boundary, so the next owner sees it rather than rediscovering
it. See "Attempted and reverted" below — I implemented the `emitBox` fix and
backed it out on measured evidence.

### Notes

- `loc-budget-allow: src/codegen/type-coercion.ts` in #4178's frontmatter, with
  the reason: the arm is a `coerceType` branch selected by `from.kind`/`to.kind`,
  and splitting one four-way dispatch across two files is what let the fourth
  arm silently diverge in the first place.
- Oracle ratchet: net-neutral (`getTypeAtLocation +0`, `ctx.checker +0`).

---

## Findings that refute the framing (the valuable part)

Three successive framings were handed to this lane; all three were wrong, and
the last one was the tech lead's own correction.

### 1. "Runtime-eval-consumer mode miscompiles mixed-type ternaries" — refuted upstream

Already refuted in #4178 before I resumed. My measurements agree and add one
thing: the eval-consumer twins of my 30 probes were mostly **correct** where the
plain versions **trapped** — the opposite sign from the original report.

### 2. "The IR bail demotes to legacy, and legacy miscompiles the concat" (#4178's root cause) — refuted for the population that matters

The IR bail is real and reachable by default (IR-first runs without
`experimentalIR`), but it is **not** the cause of the observed failures:

- Every unit in the failing shapes is rejected at IR **SELECT** stage
  (`body-shape-rejected` / `call-graph-closure`, via `trackIrOutcomes`) and
  therefore never reaches `lowerConditional`. Module-init — the shape test262
  top-level statements compile to — is always in this class.
- The two behaviours #4178 describes as "the same mechanism, two outcomes" are
  in fact two different mechanisms: the hard `IR-FALLBACK` error is the bail;
  the wrong answer / trap is the legacy coercion arm (A).
- Fixing the bail alone would have moved **zero** of the measured failures.

### 3. "The 8 `coercion-arithmetic-add` failures are the ternary bug's acceptance test" — refuted, then satisfied anyway

Those rows contain **no ternary at all**. They are defect (B) plus (A):
`const a: any = "1"` folded numerically, and the inliner then dropped the
mismatched `f64` argument and substituted `ref.null` (visible in the WAT as
`f64.const 3; drop; ref.null 3; ref.as_non_null`). They were tagged `#1988`
("`__any_add` has only i32/f64 branches") in the test file, which is also not
what breaks them. They pass now, but via a different mechanism than #4178
predicted.

### 4. A fourth, still-open defect this uncovered — `$AnyValue === nativeString`

```ts
const a: any = "1"; const b: any = 2;
const g = a + b;  g === "12"      // → true   (correct)
(a + b) === "12"                  // → FALSE  (wrong)
```

Binding the concat to a local first is correct; comparing the `ref $AnyValue`
result **inline** against a native-string literal answers false. Not filed —
worth its own issue, and it is the reason `tests/issue-4178.test.ts` asserts
through a `string`-annotated local rather than inline.

### 5. Eval-consumer mode has its own, separate `$AnyValue`/externref break

Not this issue, but measured in detail and worth an issue of its own:
`registerReassignedFunctionGlobals` (`src/codegen/index.ts:6006-6027`) widens
**every** top-level `var`/lexical global to `externref` for representation
neutrality. Consumers keep deriving the expected carrier from the *TS type*
(`resolveWasmType` → `ref_null $AnyValue`), nothing coerces, and
`stack-balance.ts`'s `fixCallArgTypesInBody` (`:1504`) papers over the mismatch
with a blind `any.convert_extern; ref.cast_null $AnyValue`. That is:

- a **trap** (`illegal cast`) when the externref is a `$BoxedNumber` /
  `$BoxedBoolean` — which is exactly what `__any_to_extern` produces for tags
  2/3/4; and
- a **wrong tag** when it happens to be an `$AnyValue`, because
  `__any_box_extern_s1` tags every non-nullish externref **5 = string** (the
  deliberate #1888 lie, whose blanket removal measured −788/−794).

Reproduces as `typeof v === "string"` for a number in eval-consumer modules.
Fixing the boxer alone converts the wrong answer into a trap, so the read site
must be fixed first — do not take one without the other.

### 6. Sizing note the next lane should not reuse

I measured **739 ES5-label standalone failures in eval-consumer modules** and,
on `db0f72fb6a`, **8/739 passing**. That number is real but it is a different
population (finding 5's, not this issue's). Do not read it as this bug's yield.

---

## Attempted and reverted: the `emitBox` fix for the IR bail

I implemented #4178's proposed fix — box mismatched arms to `dynamic` via
`IrFunctionBuilder.emitBox` instead of throwing, each box appended to its own
arm's `collectBodyInstrs` buffer (preserving #1820), with a
`jsTagOfIrType` refinement so lowering picks the honest boxing helper. It
type-checked and compiled. **I backed it out on measured evidence, twice over:**

1. **Correctness regression.** `"" + (true ? someBoolean : "s")` IR-compiles and
   returns `"1"` instead of `"true"` — the boolean brand on the arm's `i32`
   does not survive to `emitBox`, so it boxes tag-2 (number) rather than tag-4.
   This is precisely the hazard `emitBox`'s own header warns about, and it is a
   *silent wrong answer* where the status quo is a loud compile error.
2. **The bail just moves.** With the ternary bail retired, the same functions
   immediately hit the next one —
   `local 'g' annotated as string but initializer is dynamic`, then
   `arg 0 of call to len is dynamic, expected string`. Retiring the ternary bail
   without the downstream `dynamic → concrete` consumers is a net-zero change in
   IR coverage that trades a compile error for a different compile error.

So the real slice is: **(a)** carry the boolean/symbol brand onto the arm IrType
(or derive the partition from the arm's TS type at the lowering site), **(b)**
teach annotated-local writes and call-arg positions to accept a `dynamic`
producer with an explicit unbox/ToString, **then** (c) retire the bail. That is
an L, not an M. The coordinator's warning that `emitBox` has no producers today
was accurate and load-bearing — I was the first, and the lowering is not ready.

---

## Instrument (reusable, CI-aligned)

Everything is in the worktree
`/home/user/js2/.claude/worktrees/agent-ac8a75cd5b9532d81/.tmp/` (gitignored):

- `w3-child.mts` — `runTest262File` in standalone mode with the
  `js2wasm:runtime-eval` provider monkey-patched into `WebAssembly.instantiate`
  (the #4162 shim; without it half the descriptor corpus dies at instantiate).
- `w3-run.mjs` — batching parent. `node .tmp/w3-run.mjs <list|dir:PATH> <out.jsonl> [workers] [batch]`,
  `W3_PRINT=1` for a per-file table.
- `pi.mts` / `p.mts` — single-source probes; `pi.mts` prints the per-unit IR
  outcome table (`IR`/`LEG` + rejection code), which is what settled finding 2.
- `build-lever.mts`, `size-lever.mts` — population builders off
  `.test262-cache/test262-standalone-current.jsonl` + `classifyEdition`.
- `probes2/gen.mjs` — the 30-probe matrix (15 shapes × ±eval-boundary).

Prerequisite before every measurement (the provider cache key folds in the
compiler-bundle hash, so it must be rebuilt against the tree you are measuring):

```bash
./node_modules/.bin/esbuild src/index.ts   --bundle --platform=node --format=esm \
  --outfile=scripts/compiler-bundle.mjs --external:typescript --external:binaryen
./node_modules/.bin/esbuild src/runtime.ts --bundle --platform=node --format=esm \
  --outfile=scripts/runtime-bundle.mjs  --external:typescript --external:binaryen
node scripts/build-runtime-eval-provider.mjs --refusal-only
```

**Two traps that cost real time here:**

- `tests/test262-runner.ts` hardcodes `TEST262_ROOT` as `<repo>/test262`; the env
  var is ignored. A bare symlink there gets replaced by an empty directory
  (git sees an uninitialised submodule). Make `test262/` a real directory
  containing `harness` and `test` symlinks instead.
- Do **not** edit `src/` while a background measurement is running — each child
  compiles from source at spawn, so a mid-flight edit silently contaminates part
  of the sample. I lost a 1400-file run to this.

---

## Housekeeping

- Issue #4175 was reserved by this lane before the re-aim and then **released**
  without a file being created (`claim-issue.mjs --release`, verified on
  `origin/issue-assignments`). The id is a permanent hole in the sequence.
- #4178 claimed on `origin/issue-assignments`, frontmatter set to
  `status: in-progress`, `assignee: ttraenkler/W3-runtime-eval-ternary`. It
  should stay open after this PR — the IR bail is still its stated scope.
- The `## RESIDUAL BLOCKER` section in
  `plan/issues/3251-array-descriptor-overlay-substrate.md` (branch
  `issue-3251-s2-port`, not on main) records the refuted framing and should be
  replaced by a pointer to #4178.
