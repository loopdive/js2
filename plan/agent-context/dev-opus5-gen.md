# dev-opus5-gen — context summary (2026-07-24, Sprint 77)

Senior developer (Opus 5). Task: **#2864 D4 — sync-generator try/catch across
yield.** Branch `issue-2864-d4-catch-across-yield` on the **fork**, tip
`b6db7a6`, 2 commits, 0 behind `origin/main`. PR creation blocked by a
GitHub-side HTTP 500 (repo-wide, confirmed independently by the tech lead, who
owns landing it).

> **Landed since (status as of 2026-07-26).** The 500 cleared and this work
> merged as PR **#3575** (`fix(#2864 D4): doneState must be the real fallthrough
> state, not states.length-1`). The handoff line above is historical — nothing is
> owed. The stale-premise finding and probe results below still stand.

---

## 1. The headline: the D4 premise was stale

The dispatch (and the `## D4` note in
`plan/issues/2864-standalone-generator-carrier.md`) said try/catch
across a yield "still bails to the host path —
`generators-native.ts`: `if (stmt.catchClause) fail()`" and that D4 was the
trigger to converge sync generators onto the **#2906 CFG planner**.

**Both were false on current main.** #3050 (`fdc11cbd`, "try-region state
machine for native generators — catch across yield + yielding finally") landed
`lowerTryRegion` in `generators-native.ts` before that note was written. There
is no `if (stmt.catchClause) fail()` anywhere in the file. **No planner
convergence was needed and none was done.**

A 12-shape probe on main (`--target standalone`, host-free asserted, each
compared against Node on the same source) showed **9/12 already passing**.

**Method that caught it in ~15 min:** grep for the exact bail the note cited,
then a probe matrix instead of trusting the prose. `grep -n "catchClause"` and
`grep -n "TryStatement"` immediately surfaced `lowerTryRegion` — the note's
claimed code did not exist. Do this before ANY spec-driven work on this issue
family; the notes in #2864 are long-lived and drift.

## 2. Root cause of the one real failure: `doneState` aliasing

`registerNativeGenerator` derived:

```ts
doneState: plan.states.length - 1, // "the final `done` state id"
```

That coincides with the final `done` state **only for a straight-line body**.
Every structural lowering — `lowerFor` / `lowerWhile` / `lowerDoWhile` /
`lowerIf`, and #3050's `lowerTryRegion` — reserves its **exit/join state before
lowering the nested body**. So a body that _ends_ in one of those leaves the
fallthrough cursor (`curId`) at a **lower** id, and `states.length - 1` is then
a **live yield-successor state**.

Measured plans (dumped by temporarily instrumenting `buildNativeGeneratorPlan`;
`curId` = the state given the final `done` terminator):

| body shape                         | states | fallthrough | `states.length-1`   |
| ---------------------------------- | ------ | ----------- | ------------------- |
| straight-line (control)            | 7      | 6           | 6 ✓                 |
| `try { yield } catch {}` as body   | 5      | **3**       | 4 ✗ live yield succ |
| `for … { try { yield } catch {} }` | 9      | **4**       | 8 ✗ live yield succ |
| `if (…) { yield } else { yield }`  | 6      | **3**       | 5 ✗ live yield succ |
| nested `for` / `for`               | 10     | **4**       | 9 ✗ live yield succ |

The consumer's suspension test (`generators-native-consumer.ts`) is
`suspended = state != START && state != doneState`. With the alias in place a
genuinely suspended generator reported **DONE**, so `.throw(e)` / `.return(v)`
took the §27.5.3.4 already-completed arm and **never resumed** — the enclosing
`catch` across the yield never ran and the error escaped as a raw
`WebAssembly.Exception`.

**Why it presented as try/catch-specific but is not.** With no handler to run,
the already-completed arm's observable behaviour _coincides_ with the correct
one (`.return(v)` → `{v, done:true}`, `.throw(e)` → throws `e`). Only a
finalizer/handler makes the misroute visible. The bug is **loop/if/try-TAIL
shaped** and has been latent in every such generator since the structural
lowerings landed. It also made the `done` terminator store a LIVE state id as
"completed", so a post-exhaustion `.next()` re-entered live states (benignly
idempotent for a simple loop, but it re-ran the loop's update expression).

**Fix.** `buildNativeGeneratorPlan` returns the real `doneState` — the
fallthrough cursor, or the dedicated empty placeholder it already mints when
that state carries trailing statements (#3050's re-run guard) — and
`registerNativeGenerator` consumes `plan.doneState`.

**Safety argument (verified, not asserted).** A `yield` terminator always mints
a FRESH successor as the new cursor, so the state receiving the final `done`
terminator can coincide with a suspension point only when the body's last
statement is itself a `yield` — in which case the two ids were already equal
before the change and the pre-existing (spec-equivalent, handler-free)
behaviour is preserved bit-for-bit. Confirmed by dumping the
`for(...){yield i} yield 99;` plan: fallthrough == the `yield 99` successor,
both before and after.

Also verified: `doneState` can never newly become `0` (state 0 = NOT-STARTED).
`curId == 0` at the end implies `states.length == 1` — every lowering that adds
states also moves the cursor off 0.

## 3. Measurement method worth reusing

**Plan dump.** Temporarily add an env-gated `console.error` right after the
throw-route stamps in `buildNativeGeneratorPlan`, printing per state:
terminator kind + its numeric fields, `unwind` (kind + region), whether
`abruptResume` is set, `throwRoute`, prelude length, resume bindings. **Do NOT
`JSON.stringify` a terminator wholesale** — it holds `ts.Expression` nodes and
throws on the circular AST, which silently truncates the dump after state 0 and
looks like the loop exited early. Filter to primitive fields. **Remove the
block before committing** — it is a `process.env` read in a codegen hot path.

**Byte-stability matrix (the evidence this codebase expects).** 12 programs ×
3 lanes (gc / standalone / wasi), sha256 of `result.binary`, branch vs
`origin/main`:

```
npx tsx .tmp/bytes.mts .tmp/after.json
git checkout origin/main -- src/codegen/generators-native.ts
npx tsx .tmp/bytes.mts .tmp/before.json
git checkout HEAD -- src/codegen/generators-native.ts     # restore
npx tsx .tmp/diffbytes.mts
```

`git checkout <ref> -- <path>` is the right swap primitive here — **not**
`git stash` (forbidden in worktrees) and not a branch switch.

Result: **24/24 control entries byte-identical**; the 12 changed entries were
exactly the four predicted `curId != lastId` shapes on all three lanes.
Predicting _which_ entries will change before running the diff is what makes
the matrix evidence rather than decoration.

**Host-lane (gc) verification.** `WebAssembly.instantiate(binary, {})` only
works for standalone/wasi. For gc use
`buildImports(result.imports, undefined, result.stringPool)` from
`src/runtime.js`, then call `imports.setExports(instance.exports)` after
instantiation (see `tests/issue-3051.test.ts`). This is how I established the
bug hit the **js-host lane too** (#3032 W6 routes host-lane generator
declarations native): `try { yield 1 } catch (e) { log = 5 }` + `.throw()`
threw a raw `WebAssembly.Exception` on gc before the fix, returns `511` after.

## 4. Measured delta

8 shapes × 3 lanes, host-free asserted. **4 flip from a raw escaping exception
to spec behaviour; 4 controls unchanged.** No regressions.

| shape                                                    | before (sa/wasi)   | after     |
| -------------------------------------------------------- | ------------------ | --------- |
| `try { yield } catch {}` as whole body, `.throw()`       | raw wasm exception | 511       |
| `for … { try { yield } catch {} }`, `.throw()`           | raw wasm exception | 101       |
| `while … { try { yield } catch {} }`, `.throw()`         | raw wasm exception | 101       |
| nested `for`/`for` under one try, `.throw()`             | raw wasm exception | 301       |
| `.return()` through a finally (loop / if / loop-tail) ×3 | correct            | unchanged |
| straight-line try/catch + trailing yield (control)       | correct            | unchanged |

Gates run locally, all green: `test:equivalence:gate` exit 0 (no new
regressions; 1 baseline failure now passes, baseline deliberately **not**
ratcheted), the new 11-case suite, ~25 generator suites, `check:loc-budget`
(allowance already on #2864's frontmatter), `check:oracle-ratchet` (+0/+0),
`check:godfiles`, `check:stack-balance`, `check:issue-ids{,:against-main}`,
`check:done-status-integrity`, `format:check`, `typecheck`.

## 5. #3582 — the spin-off, and its DEAD ENDS

`return v` inside a try whose `finally` is **yield-free** does **not** run the
finally. Standalone returns `15` where Node returns `315`. **Silent wrong
answer**, and it reproduces even with **no yield inside the try**, so it is the
`return` lowering itself, not a suspension-crossing issue.

Root cause: in `lowerStatements`, the `ts.isReturnStatement` branch bails only
on `unwind.some(e => e.kind === "finally")`. A **legacy kind-L region**
(finally-only, yield-free finally — the byte-identical pre-#3050 path)
contributes `replay` entries, which are neither run nor bailed on. The
finalizers ARE run on the normal fallthrough path and on the abrupt-resume path
(`startStateAfterYield` captures them into `abruptResume.finalizers`); only the
explicit-`return` path drops them.

**Dead end 1 — do NOT put the finalizers in the state prelude.** JS order is:
evaluate the return expression FIRST, then run the finally
(`try { return f() } finally { g() }` calls `f()` before `g()`). Pushing them
into `curStatements` runs them _before_ the terminator compiles `expr`. Put
them on the **`return` terminator** (`finalizers?: ts.Statement[][]`) and emit
expr → result local → finalizers → complete, mirroring the abrupt tail.

**Dead end 2 — do NOT introduce a synthetic `const __genret = expr;`
`VariableStatement`** to hold the value. A `ts.factory`-created identifier has
no checker type, so `resolveSpillLocalValType` and the whole spill-typing
cascade cannot type it. Every existing synthetic node in this file re-uses a
REAL declaration list / expression for exactly this reason.

**Ordering gotcha:** `unwind` is threaded **outermost-first**; every existing
consumer `.reverse()`s it to innermost-first before use. Match that.

## 6. Still bailing cleanly after D4 (documented, non-silent)

Both give the #680 CE refusal — correct behaviour, missing capability:

- **`yield*` inside a try-region** — the
  `unwind.some(e => e.kind !== "replay")` bail in `emitYield`'s asterisk
  branch. Needs the delegation states to observe the resume mode so an abrupt
  can route into the region. This is the natural **D5**.
- **`return` inside a try whose finally is STATE-LOWERED** (yielding finally) —
  the `unwind.some(e => e.kind === "finally")` bail. The
  return-through-a-_suspending_-finally path; #2906 3c-ii-b solved the
  analogous async case and is the model to copy.

## 7. Loose ends handed to the tech lead

- **PR not created**: GitHub `POST /pulls` returns HTTP 500 for this repo
  (confirmed repo-wide by the lead). Endpoint itself is healthy — an invalid
  head still returns a normal 422, and an identical-to-main branch returns the
  normal "No commits between" 422. Bisected: same 500 with a different branch
  name, with only the source commit, and with a trivial commit message — so it
  is not ref-keyed, not message-keyed, and not body-keyed. Lead owns the retry.
- **Pre-existing failures, NOT from this work**: `tests/issue-3164.test.ts` (3)
  and `tests/issue-3386.test.ts` (1) fail identically on unmodified
  `origin/main` — confirmed by re-running both suites after
  `git checkout origin/main -- src/codegen/generators-native.ts`. Now TaskList
  task #5; same stale-guard-test family as #3558 / #2961, and they sit outside
  the required checks, which is why they drifted unnoticed.
- **Claim**: `#2864` is claimed to `ttraenkler/dev-opus5-gen` on the
  `issue-assignments` ref. Release or `--complete` it once the PR lands.
  `#3582` was allocated via `claim-issue.mjs --allocate` (unclaimed, ready).
