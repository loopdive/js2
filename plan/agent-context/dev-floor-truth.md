# dev-floor-truth — standalone vacuity investigation (2026-07-25)

Senior-dev session context. Written for whoever picks up **task #10 (land the
`__apply_closure` arity widening)** and the **`verifyProperty` root-cause** task.
Everything below is MEASURED, not inferred.

> **Measurement base — the RC2 numbers are PRE-#2984.** RC1's A/B ran on
> `bb5b414a`, RC2's on `7652f033`; `main` advanced to `b12141da` mid-session,
> which brought in `src/codegen/builtin-ctor-own-props.ts` (#2984 ctor-carrier
> own-props). That is the **same builtin-ctor/`$Object` substrate the
> closure-own-property path RC2 dispatches through**, so expect the 15/100 figure
> to move on a re-measure — reconcile that as base drift, not as a contradiction.
> Task #10 re-measures full-corpus anyway. RC1 is unaffected in substance (an
> exhaustive census in an unrelated area, and CI is green on the merged state).

## Deliverables produced

| artefact                                                       | where                                                      |
| -------------------------------------------------------------- | ---------------------------------------------------------- |
| RC1 fix (top-level `throw`) + test + issue                     | PR **#3583**, branch `issue-3585-toplevel-throw`           |
| RC2 fix (arity widening) + test — **READY BRANCH, not merged** | branch `issue-3585-apply-closure-arity` (pushed to `fork`) |
| Full measurement write-up                                      | the `3592-*` issue file on both branches                   |

> **Landed since (status as of 2026-07-26).** This is a dated snapshot; the
> handoff it describes is complete. RC2 landed as PR **#3601**
> (`feat(#3592): apply-closure arity de-vacuification`), followed by **#3603**
> (re-raise the standalone high-water mark) and **#3616** (25 %-corpus A/B
> record). The "READY BRANCH, not merged" row above is historical — do not
> re-land it. The method and measurements below still stand.

> **The issue is #3592, not #3585 — the branch NAMES still say 3585.**
> `claim-issue.mjs --allocate` reserved 3585, but another lane landed
> `plan/issues/3585-standalone-mapget-call-result-eq-false.md` on `main` while
> this work was in flight, so `quality` → "Issue-ID fresh-claim gate (#2531)"
> rejected PR #3583. Per
> `reference_cross_session_issue_id_collision_renumber_loser` the loser
> renumbers: both branches now carry
> `plan/issues/3592-standalone-vacuous-asserts-arity-and-toplevel-throw.md`,
> `id: 3592`, and
> `#3592` in the source comments and test filenames. The branch names were left
> alone (renaming would have meant re-opening the PR). No behavioural change —
> the collision is only reachable because `--allocate` cannot see an id that
> lands on `main` after it scans.

## The method that produced every finding: the A/B wrong-expectation control

**Never credit a harness-mediated pass without feeding the harness a deliberately
WRONG expectation and checking it still fails.** A vacuous pass and a real pass
are indistinguishable from the outside; only the wrong-expectation arm separates
them.

Two refinements that mattered here, both worth reusing:

1. **Use a numeric observation channel, not exception rendering.** Standalone
   exception payloads frequently render as `[object Object]`, so "did it throw?"
   read off the message is unreliable, and a top-level `throw` in the probe is
   itself dropped (RC1!). Instead have the probe body record its outcome in a
   module global and expose it:

   ```js
   var q = 0;
   try { <CALL>; q = 1; } catch (e) { q = 2; }
   export function probeQ() { return q; }
   ```

   then read `instance.exports.probeQ()` after `__module_init`. `q === 1` is
   VACUOUS, `q === 2` is CORRECT, `q === 0` means the exception escaped the try.
   Note the `export` — plain top-level function declarations are **not**
   auto-exported, which silently returns `NaN` and looks like a harness bug.

2. **Toggle ONE thing, in ONE process, over the SAME sample.** Never diff a local
   sweep against the committed baseline JSONL — the committed baseline comes from
   the sharded CI worker and differs on the `L:N ` error prefix and on a large
   `env::X` host-import population. Local-vs-local only: a temporary
   (uncommitted!) `process.env` switch read at codegen time, flipped between the
   two passes inside a single `runTest262File` loop.

## RC1 — top-level `throw` dropped (LANDING in #3583)

`src/codegen/declarations.ts` had a `ThrowStatement` arm gated on `ctx.wasi`
(#2968). Outside WASI a bare top-level `throw` was collected into nothing: no
code emitted, `__module_init` ran to completion, and a module whose only
statement is `throw new Test262Error(...)` scored **pass**. **Not
standalone-specific — the JS-host lane drops it too.**

Exposed population = exactly the 40 non-`_FIXTURE` test262 files with a top-level
`ThrowStatement` (TS-parser scan; 19,202 mention `throw` at all), so the A/B is a
**census, not a sample**:

- standalone n=40: 26 pass→pass, **5 fail→pass**, 2 fail→fail, 7 CE→CE, **0 pass→fail**
- host n=40: 26 pass→pass, **5 fail→pass**, 3 fail→fail, 6 CE→CE, **0 pass→fail**

Gainers (both lanes): `language/module-code/eval-self-abrupt.js`,
`language/line-terminators/comment-single-{cr,lf,ls,ps}.js` — all `negative:`
tests that scored FAIL _because_ the throw never happened.

Park pre-check: the one new **standalone** signature (`eval-rqstd-abrupt.js`)
routes to an existing `STANDALONE_ROOT_CAUSE_BUCKETS` entry, so #3439's hard-0
gate is clear. The two new **host** signatures need no equivalent check —
`--max-unclassified-root-causes` is wired only to the standalone root-cause map
and there is no non-standalone bucket set with an unclassified gate.

## RC2 — under-applied calls never happen (task #10, BLOCKED)

### Mechanism

`fillApplyClosure` (`src/codegen/object-runtime.ts`) dispatched on the raw
argument count `n`, but `emitClosureMethodCallExportN`
(`src/codegen/closure-exports.ts`) carries only closures with
`info.paramTypes.length <= arity`. An arity-3 closure dispatched at `n = 2`
therefore matched **no** arm, fell through to the bridge's undefined sentinel,
and **the call silently did not happen**.

That is the whole test262 assert harness: `assert.sameValue(found, expected,
message)` is virtually always called with two args. `assert.sameValue(1, 2)` is
vacuous; `assert.sameValue(1, 2, "m")` throws correctly. Same for
`assert.notSameValue`, `assert.throws`. The JS-host lane fixed the identical bug
in JS at #2623 P-7 (`max(args.length, __closure_arity(fn))`); the in-Wasm bridge
never did.

### The fix (on the ready branch)

`buildApplyClosureArityWidening` in `closure-exports.ts` widens the dispatch
index to `max(argc, declaredArity)` via an **inlined** arity probe.

- **Inline, not `call __closure_arity`** — that export is minted at
  `index.ts:3975`, _after_ `fillApplyClosure` runs at `:3817`; minting a function
  inside that finalize window is the #1839/#117/#1886 late-registration
  index-shift hazard.
- **Widen, don't pad** — widening only to the callee's OWN count keeps
  `N === closureArity`, where the #820l plumbing sets `__argc = closureArity`
  with a null `__extras_argv`, byte-identical to an arity-matched call. Padding
  the arg vector to the highest dispatcher fills `__extras_argv` with synthetic
  `undefined`s — exactly the `arguments.length` regression #2623 P-7 removed.
- The builder lives in `closure-exports.ts` (not the god-file); the call site
  still costs +8 LOC in `object-runtime.ts`, so the issue frontmatter carries
  `loc-budget-allow: src/codegen/object-runtime.ts`.

### Honest split (N=200 uniform sample, seed 20260725, standalone)

`skip→skip 39 · CE→CE 5 · pass→pass 85 · fail→fail 56 · **pass→fail 15** ·
fail→pass 0 · same-status signature drift 0`

**15 of the 100 previously-passing sampled tests flip.** Sample counts —
**deliberately NOT scaled to a corpus number**; task #10 must re-measure
full-corpus before landing. Every flip cites a harness assertion at the failing
line, so they are honest flips.

Signature routing of the 15:

| family                                                                |   n | status                  |
| --------------------------------------------------------------------- | --: | ----------------------- |
| `uncaught Wasm-GC exception (non-stringifiable payload)`              |  11 | already classified      |
| `Test262:AsyncTestFailure:Test262Error: …SameValue…`                  |   3 | needs a bucket          |
| `RuntimeError: illegal cast … ← __call_fn_method_3 ← __apply_closure` |   1 | **BLOCKER — see below** |

The A/B rows themselves lived in `.tmp/` and are gone with the worktree, so the
**exact 15 flipped files** are listed here (the seed + N above reproduce them,
but the list saves a re-run just to find the blocker repro):

```
wasmgc-payload  language/statements/class/dstr/meth-obj-ptrn-prop-obj-init.js
wasmgc-payload  language/statements/class/dstr/meth-ary-ptrn-elem-id-iter-val-err.js
wasmgc-payload  language/statements/class/dstr/gen-meth-obj-ptrn-prop-id-get-value-err.js
wasmgc-payload  language/statements/class/elements/derived-cls-indirect-eval-contains-superproperty-1.js
wasmgc-payload  language/statements/for-of/dstr/var-obj-ptrn-id-get-value-err.js
wasmgc-payload  language/expressions/template-literal/tv-hex-escape-sequence.js
wasmgc-payload  language/expressions/array/spread-err-sngl-err-itr-get-get.js
wasmgc-payload  built-ins/TypedArrayConstructors/from/BigInt/source-value-is-symbol-throws.js
wasmgc-payload  built-ins/Iterator/prototype/some/iterator-already-exhausted.js
wasmgc-payload  built-ins/Set/set-undefined-newtarget.js
wasmgc-payload  built-ins/Object/assign/strings-and-symbol-order.js
async-T262Err   language/statements/for-await-of/async-gen-dstr-let-async-ary-ptrn-rest-obj-prop-id.js
async-T262Err   language/statements/for-await-of/async-func-decl-dstr-array-rest-nested-obj.js
async-T262Err   language/expressions/async-generator/dstr/dflt-ary-ptrn-rest-obj-prop-id.js
ILLEGAL-CAST    built-ins/TypedArrayConstructors/ctors-bigint/buffer-arg/byteoffset-is-negative-throws-sab.js   ← BLOCKER REPRO
```

### THE BLOCKER — mechanism, precisely

The widening supplies a missing formal by reading `__extern_get_idx(args, k)`
out of range, which yields the **undefined sentinel** (`ref.null.extern`). That is
right for an `externref`/`anyref` formal. But when the callee's parameter was
inferred to a **concrete WasmGC ref type** (e.g. `(ref null $AnyString)` under
native strings), the dispatcher's `buildArgConversion` →
`externToClosureParamRef` narrows it with `ref.cast`/`ref.cast_null`, and the
callee body's own casts then run on a null it never expected — so the call
**traps** (`illegal cast`) instead of the parameter reading `undefined`.

Before the fix the call simply never happened, so the trap was unreachable. Both
behaviours are wrong; the trap is a _different failure class_ (invalid-Wasm, not
an honest flip) and it is **introduced by this change**, which is why it must be
fixed before landing rather than classified around.

Sample repro from the A/B:
`built-ins/TypedArrayConstructors/ctors-bigint/buffer-arg/byteoffset-is-negative-throws-sab.js`
→ `illegal cast in __closure_57() at source L618 (via __closure_50@L507 ←
__call_fn_method_3@L24 ← __apply_closure@L622)`.

Likely shape of the fix: when a formal is _absent_ (index ≥ `argc`), feed the
callee's own undefined representation for that param ValType rather than a raw
null routed through the extern→internal narrowing — i.e. the missing-arg case
needs its own arm in `buildArgConversion`, not the ordinary externref path.

## Measured NON-findings (do not re-derive these)

- **`verifyProperty` vacuity is NOT the arity bug.** With the widening ON and
  OFF, `verifyProperty(Math.abs, "name", {…writable: TRUE})` and
  `verifyProperty(Math.abs, "length", {value: 999, …})` are **identically
  non-throwing** in both arms. Separate root cause; the 4,735-file lever is
  still unexplained. (Separately: `verifyProperty` on a _plain object literal_
  throws even for a CORRECT descriptor, in both arms — a second, opposite
  symptom worth folding into that investigation.)
- **The reported "dynamic-string `sameValue` false-positive" does not exist as
  described.** It is not string-specific: `assert.sameValue(1, 2)` is equally
  vacuous, and a direct `"" + true === "SHOWME"` compare (both statically-typed
  and through an untyped-param helper) is CORRECT in standalone.
- **`assert(false)` was never vacuous** — the direct call has a matching arity.
  Only the property-carried `assert.*` methods were affected, which is what made
  the original report look string-shaped.
