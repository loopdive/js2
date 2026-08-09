# dev-eslint-graph — session context (2026-07-30 → 2026-07-31)

Developer, ESLint `compileProject` lane, then standalone ES5 / codegen.

## Landed

- **#3867 (#3655) MERGED** — static CommonJS `require("./x.json")` materialised in
  `compileProject`. Removed the last unresolved-module diagnostic in the ESLint
  graph: entry errors 125 → 124, exact multiset diff **0 added / 1 removed**.
  Ported from `f4c95a0` on the held PR #3687 and re-verified from scratch.
- **#3870 (#3876) MERGED** — prototype-alias reflection defect filed.

## Open

- **#3891** (branch `issue-3559-cross-fctx-capture`) — #3559 re-measurement.
- **#3887** — body-less prototype members answer `null` instead of raising.
  **Fix location UNKNOWN** — see below.
- **#3888** — null-receiver method call never raises TypeError.

## Findings that outlived their tasks

**#2046 is a phantom.** Cited 1,499 records, but of the 1,484-row signature only
**2** have host `pass`, and one is `Iterator/zipKeyed` collateral — so **one real
`Reflect/get` row**. Three prior branches are all **ancestors of main** (they
landed; the issue was never closed). Released. Its status should be `ready` with
"one real row remains, not 1,499"; that one-line frontmatter edit is unlanded.

**The yield discriminator.** A record count is a **ceiling**; the yield is how
many of those rows pass **on the other lane**. Rows that are host-`skip` or
host-`fail` have no first-party demonstration the semantics are achievable, and
`compile_error → fail` is not a conformance gain. It killed #2046 (1,484 → 2)
while *clearing* the generator family (1,907 → 1,094), so it discriminates rather
than merely shrinking. **Owed: record on #2751 next to the picker gap.**

**#3559 — two corrections + a safety unlock.** Not standalone-only and not
latent: all four named files fail on **both** lanes on current `main`. And
`method-call-arg` is **not** a necessary ingredient (v1, a plain call,
reproduces) — the necessary set is enclosing function scope + TDZ `let` + hoisted
nested fn reading it + a callback calling that fn. The traced *mechanism*
(cross-fctx) survives; only the narrative was wrong.

The unlock for the #1177 landmine: gate the fix on the emission being **invalid
Wasm** (name absent from `localMap` **and** `cap.outerLocalIdx` out of range).
No passing test can depend on invalid Wasm; the #1177 regressions were a *valid*
module reading a wrong slot. **Still an argument, not a demonstration.**

**Blocker:** corruption 1 alone cannot green the four files — corruption 2
(funcIdx minted, never pushed) means the call target does not exist. Both must
land together. Corruption 2 is the harder unknown.

## Instrument traps hit (all cost real time)

1. **Grepping WAT text for a string in the string pool** — zero was structurally
   guaranteed. Led me to file a wrong claim in #3887, retracted in place.
   *Before believing a zero, name the input that would have made it fire.*
2. **Harness in the measurement path** — bare `compile()` mishandles an inline
   object literal passed as an argument (`Object.keys({a:1,b:2}).length` → 0 on
   host). Use `runTest262File` for reflection, always with a spec-invariant
   control.
3. **Repro that didn't reproduce** — an `any`-annotated receiver inverted the
   #2742 matrix; a bare-`compile` #3559 repro dies on a TypeScript diagnostic
   instead. **Verify the repro exhibits the phenomenon before diffing it.**
4. **Homemade claim-ref filter** — reported three known-claimed ids as free.
   Silent over-permission. Not a substitute for `pre-dispatch-gate`.
5. **`gh pr edit` silently fails** on the Projects-classic GraphQL error, leaving
   title/body unchanged. Use `gh api -X PATCH repos/.../pulls/N`; read back.

## Process

- **#3877 was my duplicate of #2742**, self-reported and folded. `pre-dispatch-gate`
  on a **freshly allocated id** finds nothing *by construction* — the most
  suspicious input gives the most reassuring output. **Search the symptom before
  allocating; gate the id after.** Recorded on #3879.
- **Verify shared state against the live remote at the moment of action** — a
  claim nobody holds, three merged PRs with no claim, and a ref stale within
  minutes, all in one session. `ls-remote` before a contended push, fresh
  `git show` on the claim ref, `rev-list --count` for merged-ness.
- **Never push to a queued PR.** Check `mergeQueue` membership before *every*
  push, not only when you suspect it.
- Three plausible mechanism attributions from source reading were all wrong here
  (two compiled byte-identical). **Use a marker bisect for attribution.**

## Next

#3559 needs corruption 2 diagnosed first — senior-dev or fresh window; a wrong
move costs 100+ regressions. #3887's fix location is genuinely unknown. #2742 is
claimed by `ttraenkler/issue-2742-fn-length-dontenum`; the folded matrix is on
their issue and flagged in #3877's PR body.
