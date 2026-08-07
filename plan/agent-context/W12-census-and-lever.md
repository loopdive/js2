# W12 — re-census + biggest tractable mechanism

Branch: `issue-4190-sloppy-this-binding` (pushed to `origin`). Issue: **#4190**.
I cannot open PRs (`gh` 401) — the PR body is below, verbatim.

---

## PART 1 — The census (the deliverable that re-aims the next wave)

Re-derived on current `main` from a **freshly downloaded** standalone baseline
(25.6 MB, 48,619 entries, run stamped 2026-08-06 16:59), joined to
`website/public/benchmarks/results/test262-file-editions.json`, scoped to
edition `ES5` + `scope_official !== false`, deduped by file.

### Scale has moved since the brief

| | files | pass | % | need for 90% |
| --- | ---: | ---: | ---: | ---: |
| brief | 8,931 | 7,044 | 78.87% | +890 |
| **now** | 8,931 | **7,165** | **80.23%** | **+873** |

### The prescribed bucketing order was right; the winner was the third cut

1. **Frames** — only **103 of 1,766** failures (5.8%) carry an `[in fn()]`
   frame, and **56 of those name `__module_init()`**, which is "top-level code",
   not a mechanism. Frames are a dead end at this scale.
2. **Explicit compiler refusals** — **84 files**. Highest certainty, small:
   `Object.defineProperties unsupported descriptor shape` (15),
   `String.prototype.split not yet implemented` (11), `Unsupported dynamic
   regular expression pattern` (8), `__get_builtin` dynamic-shape (17),
   `String.prototype.replace` with RegExp/function (16).
3. **`es5id` spec clause — this is the cut that works.** Stronger than
   `description:`, and it is the reason the previous cut left 1,376 files
   "described, unmatched": **`description:` is prose *about* a mechanism;
   `es5id` *is* the mechanism**, pre-labelled by the test author as a pointer
   into the ES5 spec. Every ES5-label test that has frontmatter has one.

**Attribution: 1,766 / 1,766 = 100%.** 1,609 by `es5id` clause; the remaining
157 have no `es5id` and are **100% `annexB/`** (they enter the ES5 label via the
path heuristic, so their directory *is* their mechanism). **I did not need to
read a single test body.**

### Ranked table

| files | clause / mechanism | owner |
| ---: | --- | --- |
| **481** | descriptor family: 15.2.3.6 `defineProperty` (211), 15.2.3.7 `defineProperties` (151), 15.2.3.5 `create` (68), 15.2.3.3 `gOPD` (29), .4/.14/.9 (22) | #4180/#4176 |
| **168** | **10.4.3 Entering Function Code — `this` binding (100) + 15.3.4.4 `call` (25) + 15.3.4.3 `apply` (25) + 11.2.3 calls (18)** | **#4190 (this PR)** |
| 153 | annexB (no `es5id`): global-code 55, function-code 49, eval-code 42, comments 7 | #4182 + L3 |
| 99 | 12.10 `with` | #4179 |
| 45 | 15.5.4.14 `split` (24) + 15.5.4.11 `replace` (21) | — |
| 34 | 15.3.4.5(.2) `bind` — mostly `[[Construct]]` curry, **not** this-binding | — |
| 34 | 15.10.\* RegExp `exec`/`test`/ctor | — |
| 32 | 15.4.4.20 `Array.prototype.filter` | — |
| 31 | 13.2.2 `[[Construct]]` | — |
| 31 | array exotic 15.4.5.1 / 15.4 / 15.4.2.2 | #3251 |
| 321 | long tail: **141 clauses averaging 2.3 files each** | — |

### The strategic finding

**There is no unowned mechanism above ~170 files.** +873 will not come from one
lever. The realistic shape of 90% is: descriptor family (481, owned) +
this-binding (168, this PR) + annexB (153) + `with` (99) ≈ **901** — those four
*are* the ballgame, and after them the distribution is genuinely flat. Any plan
that assumes a fifth big rock exists is planning against a tail of 141 clauses.

---

## PART 2 — PR body for `issue-4190-sloppy-this-binding`

### fix(#4190): ES5 10.4.3 — sloppy unbound `this` is the global object; an inlined IIFE keeps its own strictness

Two independent defects in the same arm of `src/codegen/expressions.ts`, both on
ES5 §10.4.3 *Entering Function Code* (ES2015+ `OrdinaryCallBindThis`, §10.2.1.2).

**(A) The sloppy half of the strict/sloppy split was never implemented.** The
`ThisKeyword` arm falls through to `emitUndefined()` whenever it finds no
receiver binding. §10.4.3 makes the value depend on the *callee's own
strictness*: strict keeps the thisArg verbatim, **sloppy binds the global
object**. Only the strict half existed.

```js
function sloppy() { return typeof this; }
sloppy();            // "undefined"  — want "object"
sloppy.call(null);   // "undefined"  — want "object"
```

**(B) An inlined top-level IIFE inherits `__module_init`'s `this`.** The #3365
arm ("Script-goal top-level `this` is the global object") keys on
`fctx.name === "__module_init"` — a statement about the *emitted* function, not
the source. `compileIIFE` inlines a top-level IIFE into `__module_init`, so the
IIFE body's `this` took that arm and became the global object **even under a
`"use strict"` prologue**. The tell is that the same callee behaves differently
purely by whether it was inlined:

```js
(function () { "use strict"; return typeof this; })()            // "object"    — want "undefined"
var f = function () { "use strict"; return typeof this; }; f()   // "undefined" — already right
```

(B) is the `language/function-code/10.4.3-1-*gs` family and is **pre-existing** —
verified by reverting (A) and re-running the repro.

#### Why the earlier attempts stopped short

The comments in that arm record #1636-S1 (read `__current_this` unconditionally →
regressed 171 tests, because a directly-called function never has it installed
and observes the global's `ref.null.extern` initial value as `null`) and #1702
(null-guard that read → fixed the *strict* half). Both were about *where the
receiver comes from*. Neither supplied the sloppy answer for "there is genuinely
no receiver", and neither noticed the top-level arm was keyed on the emitted
function's name. `fctx.directEvalSloppyThisFallback` had emitted exactly the
right value for sloppy direct-eval bodies the whole time — the substrate was one
branch away.

#### Change

New `src/codegen/helpers/sloppy-this-global.ts`:

- `unboundThisIsGlobalObject(ctx, expr)` — `!isStrictContext(expr,
  ctx.inferModuleStrictArguments)`.
- `emitUnboundThis(ctx, fctx, expr)` — the emission, so both call sites share one
  decision and the god-file driver does not grow the logic.
- `thisBelongsToTopLevelCode(expr)` — walks to the nearest `this`-binding
  construct (arrows transparent), added as a third conjunct to the #3365 arm.

Target-independent on purpose: the **host** lane fails these clauses *harder*
than standalone (124 vs 138 passing of the same 306 files), so nothing depends
on the old answer.

#### Measured

| run | lever (168 baseline failures) | control (138 baseline passes, same clauses) |
| --- | ---: | ---: |
| base (`origin/main`) | **0 / 168** | **138 / 138** |
| + fix (A) | 39 / 168 | 138 / 138 |
| + fix (B) | **58 / 168** | **138 / 138** |

**+58 fixed, 0 regressed.** Plus a broad control of 600 randomly sampled
currently-passing ES5-label standalone files whose source mentions `this`:
**599 / 600**. The single non-pass (`language/future-reserved-words/
let-strict.js`) fails **identically on base and on the branch** — A/B'd in
isolation — so it is a pre-existing local-runner/baseline divergence, not a
regression.

The two-sided validation is the point: 0/168 at base proves the instrument
agrees with the baseline, and 138/138 proves it can *see a pass*. Earlier lanes
in this campaign measured against instruments that could only ever report
failure.

#### Deliberately out of scope — the residual 110, root-caused

- **~30 files: `.call`/`.apply`/`.bind` drop the thisArg entirely when the
  callee is a function EXPRESSION.** `src/codegen/named-this-call.ts` (#4025)
  installs the receiver only for a stable named `FunctionDeclaration`
  (`resolveDeclaration` requires `ts.isFunctionDeclaration`):
  ```js
  function decl() { return this; }         decl.call(o) === o   // true
  var expr = function () { return this; }; expr.call(o) === o   // FALSE
  ```
  This is the `S15.3.4.4_A3_*` / `S15.3.4.3_A5_*` residue (`this["field"]`,
  `obj.touched`, `this["shifted"]`). It needs the closure-dispatch path to
  install `__current_this` — a different subsystem. `tests/issue-4190.test.ts`
  carries a **canary that fails the day this starts working**, so the follow-up
  cannot land unmeasured.
- **~15 files: `new Function("…")` with a strict body** (`10.4.3-1-8?gs`) —
  runtime-eval interpreter tier, not codegen.
- **~10 files: primitive thisArg not `ToObject`-boxed in sloppy code**
  (`sloppy.call(1)` → `"number"`, want a boxed `Number`). Same seam as bullet 1.
- **6 files: `illegal cast in __module_init()`** — unrelated mechanism that
  happens to sit in this clause.

#### Gates

`check:oracle-ratchet`, `check:loc-budget`, `check:func-budget`,
`check:coercion-sites` all green. No `loc-budget-allow:` was needed — the
emission moved into the new subsystem module rather than growing
`expressions.ts`, which is what the gate is actually asking for.

---

## PART 3 — Instrument notes (this cost three prior lanes; please propagate)

1. **`runTest262File` still does not supply `js2wasm:runtime-eval`.** #4147 /
   #4162 are filed and **unlanded** — the brief's "PR #4163 may be merged" is
   not true on today's main. An eval-mentioning standalone module dies at
   instantiate and **the link error overwrites the real signature**; 3 of my
   first 6 files hit it. I shimmed it by wrapping `WebAssembly.instantiate` in
   my own driver (`.tmp/w12-run.mts`), touching no repo file.
2. **Only the FULL INTERPRETER provider tier is CI-comparable.** The
   `--refusal-only` tier makes those modules instantiate and then throw
   `dynamic code evaluation is not supported`, which is *not* what the baseline
   records — it silently swaps one failure for another and looks like a result.
   Build both with `node --import tsx scripts/build-runtime-eval-provider.mjs`
   (~99 s for the interpreter) and run with `TEST262_FULL_RUNTIME_EVAL=1`. With
   that tier my error strings match the baseline verbatim.
3. **A fresh worktree has neither `node_modules` nor a populated `test262/`.**
   `bash scripts/provision-worktree-deps.sh` is the fix. A hand-made `ln -s` for
   `test262` was silently clobbered under me mid-session and the census went from
   1,609 attributed to 0 with no error — resolve test262 paths absolutely if you
   are not going to re-check the link.
4. **Always build a two-sided instrument**: the failing lever list *and* a
   currently-passing control from the same population. A lever-only measurement
   cannot distinguish "my fix did nothing" from "my runner cannot see a pass".
