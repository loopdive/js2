# dev-es3-editions — session context (2026-07-31)

Started on **#3628** (≤ES3 edition close-out). Ended having mapped the standalone
`iterator_protocol` leak class into **four distinct mechanisms** and landed two
fixes. Everything below is durable in issue files and PRs.

## Merged

| PR        | what                                                                          |
| --------- | ----------------------------------------------------------------------------- |
| **#3887** | **#3628 closed by measurement** (bucket is 273/273) + files **#3892**         |
| **#3889** | **#3893** — fn-expr whole-param-default generators route native in standalone |

## Open at stand-down

| PR        | what                                                                              |
| --------- | --------------------------------------------------------------------------------- |
| **#3894** | **#3896** private generator methods + honest sizing + `docs/` trap + shape map    |
| **#3895** | **#3893** retraction/scope-narrowing follow-up (couldn't push while #3889 queued) |

## The map: `iterator_protocol` (1,907) is not iterators

**0 of 1,907** rows carry a genuine `__iterator` / `__array_from_iter` import.
`classifyHostImportLeak` (`scripts/test262-worker.mjs:1074`) files the whole
**generator** family under a bucket named for iterators — regex
`/__iterator|__array_from_iter|__gen_|generator|async_iterator/`. Anyone sizing
work off the bucket name sizes the wrong defect. **Every row is
`compile_error`**, so the prize is host-free _instantiation_, never a pass delta.

Four mechanisms, none of them the label:

1. **fn-expr whole-param default** — `isNativeGeneratorExpressionShape`'s
   `param.initializer` bail. **FIXED** (#3893). ~98 rows.
2. **private generator methods** — `isNativeGeneratorCandidate`'s
   `!ts.isIdentifier(decl.name)`; a `PrivateIdentifier` is a distinct AST kind,
   so private names were collateral of a bail written for computed/string
   OBJECT-LITERAL names. **FIXED** (#3896, PR #3894). ≤252, reduced by overlap
   with (4).
3. **objlit method param default** — `{ *m({x} = {…}) }` leaks while the
   _identical class method_ does not. **UNOWNED**, ~102 rows.
4. **rest inside the binding pattern** — `buildNativeGeneratorPlan`'s
   `if (hasRest) return null;`. **UNOWNED**, **363 rows, 333 (91.7 %)
   host-`pass`** — the best remaining prize.

## Next agent: start here (#3894 has the detail)

**Rest-in-pattern is NOT another one-line relaxation.** The bail is a
_documented deliberate deferral_ (#3386 residual): the rest local's type is
minted inside the destructure helpers, not via `resolveBindingElementType`, so
the spill typing is unreconciled. Failure mode is an **invalid module**
(undefined funcidx), not a graceful fallback. Expect **M/L**.

**Likely shape of the fix — the #2938 precedent**: that bug
(`struct.new[k] expected i32, found externref`) was the class-bodies
**collection** phase param typing diverging from the **emit** phase, fixed by
applying the identical widen predicate in both. A rest slice will probably need
the same two-phase lockstep.

**Acceptance must span the shape buckets**, not one arm: 44 distinct rest shapes
in ~20-row groups. Cover at least array-rest, object-rest, elision, exhausted,
error-path (`-iter-step-err`), and getter/enumerability
(`obj-ptrn-rest-getter`, `-skip-non-enumerable`). A fix that handles
`ary-ptrn-rest-id` and leaves `-getter` broken reads as a large partial win.

Once it lands, restate #3894's yield as a number instead of "≤252, reduced by
overlap" — the 120 class-private rest rows are the overlap.

## Method notes worth copying

- **Enumerate the probe set from the population, not from imagination.** Three
  over-claims this session came from probing shapes I'd thought of. The
  filenames named 44 rest shapes including `-iter-step-err`, `-exhausted`,
  `-skip-non-enumerable`, `-getter` — variants nobody would invent. This is the
  one method that would have prevented all three.
- **`runTest262File` status cannot answer a host-import question.** It supplies
  the host imports, so a leaking module scores `pass`. A pre/post A/B produced
  byte-identical output and I published a vacuous "3 of 4 flip" result off it.
  Now stated as a rule in `docs/methodology.md`. Validate on the **import set of
  a bare standalone compile** + instantiate with **no import object**.
  (`{ standalone: true }` is rejected outright — #86 — it silently ran gc-host.)
- **Instrument the gate; don't reason about it.** One `process.stderr.write` at
  the admission gate falsified #3178's private-method hypothesis in a single
  step and printed the real cause.
- **Scope a fix by which AST node kinds reach the predicate.**
  `isNativeGeneratorExpressionShape` is consulted only for
  `ts.isFunctionExpression` — I claimed 603/523 for a fix that covers ~98.
- **`claim-issue.mjs` exit code is not evidence** — it hung _after_ writing the
  reservation, and separately failed with a `refs/claim-issue/base` lock race.
  Read the record back (`git show origin/issue-assignments:<id>.json`).
  **#3890/#3891/#3894/#3895 are burned reservation holes** from failed runs.
- **Never push to a queued PR.** Check
  `git ls-remote origin 'refs/heads/gh-readonly-queue/main/pr-<N>*'` first; a
  PR comment carries a correction queue-safely.

## Claims

`#3628` completed; `#3893` and `#3896` were held on
`ttraenkler/dev-es3-editions` — release with
`node scripts/claim-issue.mjs --release <id> ttraenkler/dev-es3-editions` and
verify against `origin/issue-assignments`, not the exit code.
