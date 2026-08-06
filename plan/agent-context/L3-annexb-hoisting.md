# L3 — annexB B.3.3 lever (2026-08-06): context + PR body

Agent `ttraenkler/L3-annexb-hoisting`. Issue **#4137** (claimed on
`origin/issue-assignments`), branch `issue-4137-interp-eval-residuals` on
`origin` (this repo has no `fork` remote; `origin` **is** upstream
`loopdive/js2`).

Lever list: `.tmp/levers/L3-annexb-function-hoisting.txt` in the shared
checkout — 185 standalone ES5-label failures under
`annexB/language/{global,function,eval}-code`.

Reproduction assets live in the worktree's gitignored `.tmp/` and do not
survive it: `lever.mts` (the measurement harness), `build.sh`, `probe/*.ts`
(including the `pa9.ts` / `pa10.ts` diagnostic pair for the handoff below),
`before.json` / `after1.json` / `after2.json` / `final.json` / `reg-after.json`.
Everything load-bearing from them is restated here and in the issue file.

---

## PR body (verbatim)

Closes two of the three arms of #4137 (standalone interpreter residuals after #4013). Measured **0 → 40 of 185** on the annexB B.3.3 standalone lever list, **0 regressions**, plus **0 regressions across a 631-file eval×catch corpus**.

Neither arm turned out to be an Annex B semantics gap. One is a standalone ABI mismatch, the other is missing lexical scoping in the interpreter's emitter.

## 1. `setEvalVariableEnvironmentBinding` null-deref (16 records) — `src/interp/eval-environment.ts`

A `Map`/`WeakMap` miss whose value type is a **class** reads back as `null`, not `undefined`, because the standalone ABI has no distinct `undefined` for a nullable class reference. Measured directly:

| expression | standalone result |
| --- | --- |
| `WeakMap.get(missing) === null` evaluated **inline** | `false` |
| `const v = WeakMap.get(missing); v === null` | **`true`** |
| `typeof WeakMap.get(missing) === "undefined"` inline | `true` |

The coercion happens **at the local store** — exactly where an absence test reads it. `setEvalVariableEnvironmentBinding` tested `existing !== undefined` only, so the miss passed the guard and `setOwnEnvironmentBinding` dereferenced it. That is the published `dereferencing a null pointer [in setEvalVariableEnvironmentBinding() ← callBuiltin ← run ← interpEnter]` signature.

`variableEnvironmentFor` had the same shape with a different consequence — it *returned* the miss instead of continuing the parent walk, truncating the chain at the first unregistered record. Fixed alongside. **It is not what moved the number**, and the commit says so: the 24 failures I expected it to fix stayed at 24 until arm 2 landed.

## 2. Catch parameter has no Environment Record (24 records) — `src/interp/emitter.ts`

`emitTry` bound the CatchParameter with `bind()`, which writes into `names` — a flat, function-wide name→register map **with no pop**. §14.15.3 gives the parameter its own declarative Environment Record, so `catch (f)` shadowed `f` for the whole rest of the body and every name resolution emitted *after* the clause read the catch register:

```js
// annexB/language/eval-code/**/*-no-skip-try — 24 files, one shape
var before = typeof f;                                   // "undefined"  ok
try { throw null; } catch (f) { { function f(){ return 123; } } }
var after  = typeof f;                                   // want "function", got "object"
                                                         //   ^ the caught `null`
```

Routed through the lexical-scope machinery blocks already use (`BUILTIN_PUSH_LEXICAL_ENV` + control-stack marker + `RESTORE_ENV`), so `emitLoadName` / `storeName` / `initializeName` and the `typeof` fast path see it via `isActiveBlockLexical` and stop seeing it when the clause ends.

**Why there is a second scope label.** Making the parameter an ordinary block lexical *cancels* Annex B, and measurably did — the intermediate build removed the null leak but never assigned the function. B.3.5 **exempts a simple `CatchParameter: BindingIdentifier`**; only a destructuring parameter cancels, and `emitTry` rejects those earlier. `SIMPLE_CATCH_SCOPE_LABEL` marks the scope so name resolution counts it while the two Annex B cancellation sites do not.

Side effects, both in the right direction: `boundNames` no longer gains a permanent entry (which is what kept `typeof f` on the stale register), and a closure declared inside a catch block can now see the parameter at all — previously it could not, since registers are frame slots invisible to a nested `FunctionEmitter`.

## Measurement

**The instrument matters more than usual here.** `tests/test262-runner.ts`'s in-process `runTest262File` does **not** attach the `js2wasm:runtime-eval` provider namespace, so on the standalone lane every eval-mentioning module fails to instantiate — 81 of these 185 files were pure instrument artifact under it. Filed as #4162; three agents hit it independently the same day. Every number below uses a mirror of `tests/test262-shared.ts`'s real path (`CompilerPool(n, "unified")` + `assembleOriginalHarness` + strict rerun), with both esbuild bundles rebuilt, the runtime-eval provider rebuilt *after* them (its cache key folds in the compiler-bundle hash), and `TEST262_FULL_RUNTIME_EVAL=1` set.

Responsiveness was confirmed, not assumed: the baseline run reproduces the published error histogram term for term (27/24/24/16/15/13…), and the score moved in step with each change, flipping exactly the predicted buckets.

| build | pass / 185 | delta | regressions |
| --- | ---: | ---: | ---: |
| `origin/main` (176e4408f) | 0 | — | — |
| + arm 1 | 16 | **+16** | 0 |
| + arm 2 | 40 | **+24** | 0 |

Wider sweep — 631 files, every test262 file that runs `eval` **and** has a `catch` clause, plus all of `language/statements/try`, `built-ins/eval`, `language/eval-code`, standalone: **525 pass, 0 candidate regressions** against the published standalone baseline (`+16` vs it). The final commit re-folds two identical scope scans to hold the LOC budget; the lever was re-measured on that exact build and returned **verdict-identical results on all 185 files**, so the trim is behaviour-preserving by measurement, not by inspection.

## Tests and gates

`tests/issue-4137-interp-catch-scope.test.ts` — 12 cases, run in Node against node-acorn (no Wasm, no 2-minute provider build) and differentialled against the host's own `eval`: parameter does not leak past the clause, is readable inside it, nests, assignment stays local, `typeof` is off the stale register, all five B.3.3 declaration positions update the web-compat binding through a simple catch parameter, the function is callable, **and** the negative control — an ordinary `let` in the catch block still cancels.

`tests/interp` (208), `issue-2929-annexb-eval-lifecycle`, `issue-2928`: green. `issue-2923-eval-const-broaden` and `issue-3632-eval-early-errors` fail 11 tests — verified **identical on unmodified `origin/main`** by swapping in main's copies of both changed files and re-running; pre-existing, not from this PR.

`tsc --noEmit`, prettier, biome, `check:func-budget`, `check:oracle-ratchet`, `check:pushraw`: clean. `check:loc-budget` needs an allowance for `src/interp/emitter.ts` (+60): the CatchParameter's record has to be pushed inside `emitTry`, there is no subsystem module to move a try-clause emission into without inventing one, and the markers it adds are read by five other emit sites in the same file. Reason recorded per-entry in the issue frontmatter.

## Not fixed here — `SyntaxError: NaN` (24 on this list, 36 published)

Diagnosed, deliberately left out, and written up in the issue.

It is Acorn's `pp.raise` message and the "NaN" is a **number**: `acorn.mjs:3756` is `message += " (" + loc.line + ":" + loc.column + ")"`, and on `any`-typed operands that lowers to f64 arithmetic. Proof is a case where node-acorn genuinely raises — `eval("try { throw {}; } catch (f) { function f() {} }")` gives node `Identifier 'f' has already been declared (1:39)` and standalone gives exactly `"NaN"`.

Two reasons it is not in this PR:

- It is a **codegen** bug in `src/codegen/expressions/operator-assignment.ts`, not an interpreter one, and that file is concurrently owned by another lane today.
- **Fixing the message will not flip these 24 tests.** They are the `skip-early-err` family, whose point is that an early error must *not* be raised — and node-acorn does **not** raise on their actual shape (`catch ({ f }) { if (true) function f(){} }` parses fine). So a second, separate defect in compiled-acorn's scope tracking sits underneath the unreadable message. #4137 already said "fix the message first"; that ordering is now confirmed and the second half is real.

Whoever picks it up should start from the probe pair recorded in the issue: the bug is **context-sensitive**, not a flat rule — one probe compiles correctly and a near-identical one does not.

---

## Preserved probes

These live in a gitignored `.tmp/` that dies with the worktree, and two of them
are the only concrete handle on work that is being handed off. Compile each with
`target: "standalone", skipSemanticDiagnostics: true, inferModuleStrictArguments:
false`, instantiate with an empty import object, and call the named exports.

### The `SyntaxError: NaN` diagnostic PAIR — the whole point is that they disagree

`pa9.ts` returns `run = 1` and `control = 1` — **correct**. `pa10.ts`, the same
function interrogated from four call sites instead of one, returns
`viaLength = 3` (`"NaN".length`) and `viaTypeof = 2` (number) — **wrong**. Same
shape as `acorn.mjs:3756`. Anyone who tests only one of these will conclude the
opposite of the truth about whether the bug exists.

`.tmp/probe/pa9.ts`:

```ts
// Acorn's pp.raise, verbatim in shape (acorn.mjs:3756).
// No `typeof` on an `any` anywhere — that is itself unreliable in this lane and
// invalidated an earlier probe. Compare String(...) against the two candidates.
function raiseMessage(message: any, line: any, col: any): any {
  message += " (" + line + ":" + col + ")";
  return message;
}
export function run(): number {
  const m = raiseMessage("Identifier 'f' has already been declared", 1, 39);
  const s = String(m);
  if (s === "Identifier 'f' has already been declared (1:39)") return 1; // correct
  if (s === "NaN") return 2; // the observed SyntaxError message
  return 100 + s.length;
}
export function control(): number {
  // Same operands, desugared to a plain assignment — the working form.
  let message: any = "Identifier 'f' has already been declared";
  const line: any = 1;
  const col: any = 39;
  message = message + " (" + line + ":" + col + ")";
  const s = String(message);
  if (s === "Identifier 'f' has already been declared (1:39)") return 1;
  if (s === "NaN") return 2;
  return 100 + s.length;
}
```

`.tmp/probe/pa10.ts`:

```ts
function raiseMessage(message: any, line: any, col: any): any {
  message += " (" + line + ":" + col + ")";
  return message;
}
// Same call, four different ways of interrogating the SAME `any` result.
export function viaString(): number {
  return String(raiseMessage("boom", 3, 7)) === "boom (3:7)" ? 1 : 0;
}
export function viaDirectEq(): number {
  return raiseMessage("boom", 3, 7) === "boom (3:7)" ? 1 : 0;
}
export function viaTypeof(): number {
  const t = typeof raiseMessage("boom", 3, 7);
  if (t === "string") return 1;
  if (t === "number") return 2;
  return 3;
}
export function viaLength(): number {
  const v = raiseMessage("boom", 3, 7);
  return String(v).length; // "boom (3:7)" => 10
}
```

### The standalone null-vs-undefined ABI fact

Returns `7` = 1+2+4: the hit is found, **and** the miss compares
`!== undefined` (wrong) **and** `=== null` (the actual representation). Compare
with the inline form, which behaves correctly — the coercion is at the local
store.

`.tmp/probe/wm.ts`:

```ts
class Box {
  x: number;
  constructor(x: number) {
    this.x = x;
  }
}
const M: WeakMap<object, Box> = new WeakMap();
export function run(): number {
  const a = new Box(1);
  const b = new Box(2);
  M.set(a, b);
  const hit = M.get(a);
  const miss = M.get(b);
  let r = 0;
  if (hit !== undefined) r += 1;
  if (miss !== undefined) r += 2; // 2 => .get() returned NON-undefined for a miss (the bug)
  if (miss === null) r += 4; // 4 => it returned null
  return r;
}
```

---

## What I deliberately left undone

- **`SyntaxError: NaN`** — diagnosed, not fixed. Reasons in the PR body above:
  wrong file for this PR (`src/codegen/expressions/operator-assignment.ts`,
  concurrently owned), and fixing the message alone does not flip the 24 tests
  because a second compiled-acorn scope-tracking defect sits behind it.
- **`interp/emitter: unsupported in Phase 1` (22 records)** — #4137's third arm,
  untouched. `binary operator '|'` in that list is a one-line gap and is the
  cheap one.
- **The 15 `Initialized binding created prior to evaluation`** — the **AOT**
  twins of the catch fix (`annexB/language/function-code/*-no-skip-try`). They
  need #2200 Phase 2 (`annexBOuterBindings`) plus B.3.5. #2200 Phase 2's last
  attempt (#1769) cost **-1180 net** test262 and was reverted; do not retry it
  without a local test262 slice over the buckets that regressed.
- **A sweep of the remaining `!== undefined` absence tests in `src/interp`** —
  roughly 30 sites, of which the class-typed ones (several
  `INTERP_BINDINGS.get(...)` reads in `loop.ts`) carry the same latent
  null-vs-undefined hazard as the one I fixed. Each needs its own reachability
  argument; I fixed only the two on the measured path rather than pattern-matching
  the file.
