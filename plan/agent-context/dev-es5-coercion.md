# dev-es5-coercion — session context (2026-07-30/31)

Lane: ES5 coercion / enumeration / frozen-semantics, then standalone descriptor
and reflection work. Written so a successor does not re-derive any of it.

## Landed

**#3872 / PR #3871 — the only behaviour change of the session.**
Non-writable data-property writes now fail correctly across **all four**
assignment lowering sites, both lanes. Standalone probe 10/13 → 13/13
(standalone was the objective lane).

Root cause, after three wrong hypotheses: `applyDescriptorFlags` leaves the
WRITABLE bit **clear** when a descriptor merely *omits* `writable`. Correct for a
fresh define, **wrong for a redefine** ("omitted" means keep-existing).
`definedPropertyFlags` had always been approximate that way and its historical
consumers tolerated it; the consult made it load-bearing for correctness. Fix:
only an **explicit** `writable: false` fires the consult, recorded from all three
`Object.defineProperty` lowering arms.

Also landed: #3420 (frozen bit consulted on element writes), and a chain of
docs/measurement PRs (#3876 retraction, #3880/#3879 gate + wedge evidence, #3881
#2916 groundwork, #3883 stale-claim + wedge evidence).

## Open, with diagnosis complete

- **#3647** — host-lane only; standalone already correct. Dispatch at
  `runtime.ts:12628` / `:12759` → `_wasmStructPropertyIsEnumerable` (`:5258`).
  **Next step is one fact:** what `C.prototype` actually *is* in the host lane
  (wasm struct / plain object / wrapper) and which dispatch path the call takes.
  That decides where the fix belongs.
- **#2916** — scope re-grounded (residual is **two** imports, not three),
  baseline counted, acceptance tiered (imports primary, rows secondary ~4/≤24).
  Claim record stale; issue file says so.
- **#3646** — severity corrected: `gOPD(C.prototype,"m")` **traps**, it does not
  return `null`. Minimal repro needs no computed-name field.

## Things that cost hours — read these before measuring anything

**Six instrument traps, every one locally indistinguishable from success.**

1. **Bare `compile()` cannot measure host-lane `Object.*` statics** (#3885). Its
   control returns `0` for `Object.keys({a:1,b:2}).length`. Use `runTest262File`,
   both lanes, **with a control that must hold under any spec version — discard
   the run if the control fails.** This produced a *phantom defect report*
   (retracted in #3876), the expensive direction.
2. **`git checkout <tree> -- <paths>` STAGES the revert.** After an A/B the index
   holds the reverted copies; the next `git add` silently undoes committed work.
3. **`git fetch origin main` can leave `refs/remotes/origin/main` stale.** Use
   `+refs/heads/main:refs/remotes/origin/main` and verify against
   `gh api repos/loopdive/js2/commits/main --jq .sha`. Cost me a published
   (retracted) "baseline defect" claim.
4. **A budget gate reporting `granted by <an issue your PR does not modify>.md`
   is a CI failure in waiting** — the grant resolves locally, not in CI.
5. **Never pipe a command whose exit status you need.** `cmd | tail; echo $?`
   reports the *pipe's* status, so a crashed script reads as success. Use
   `cmd > file 2>&1; echo $?` and **verify the effect, not the code**.
6. **A probe that scores identically on the broken and fixed versions
   discriminated nothing.** The diagnostic is "did it *distinguish* the two
   versions", not "did it pass". Write the probe against **the branch you
   actually edited**, not the bug you reasoned your way to.

**Standing rule that emerged:** every A/B must state its **lane**, its
**harness**, and **which two commits were diffed**. Host-vs-standalone,
local-vs-CI, and wrong-version-pair each produced a confident wrong conclusion
within one session, and from the inside they are indistinguishable.

## Measurement facts worth keeping

- The lane discriminator for baselines is **a separate file**, not a field:
  `test262-standalone-current.jsonl` alongside `test262-current.jsonl`.
- ES5 = test262's own **`es5id:`** frontmatter marker
  (`grep -rl "^es5id:" test262/test/{built-ins,language}` → ~8,088).
  **Not** `scope_official`, which is the whole corpus across every edition —
  using it inflated an "ES5" denominator to 42,014 and made ES6 generator
  imports look like the top ES5 lever.
- **Subtract ~20 before reading any merge_group net** (#3884): the regression
  numerator filters `compile_timeout`, the improvement numerator does not. A
  genuinely net-zero change passed showing +18.
- **PR-level `check for test262 regressions` green is a designed no-op.** Only
  the `merge_group` re-validation is evidence.

## Working relationships

`shepherd-ci-fix` owns enqueueing (one-shot, `expectedHeadOid` pinned) and
extracts per-path failure lists from merged-report artifacts — that extraction is
what turned a statistical argument into a diagnosis on #3872.
`dev-eslint-graph` holds the reflection cluster (#3875/#3876).
`dev-es5-descriptors` holds descriptor record/read fidelity (#2668).
