---
id: 3947
title: "sync-conformance-numbers fights prettier over CLAUDE.md, and its failure message names a cause that never happened"
status: done
created: 2026-07-31
completed: 2026-08-01
assignee: ttraenkler/dev-fmt-gate
priority: medium
feasibility: easy
horizon: s
task_type: ci
area: ci
goal: ci-hardening
sprint: 78
related: [3612, 3915, 3880, 3902]
---

# #3947 — two gates undo each other, and the error blames the wrong thing

Two defects in `scripts/sync-conformance-numbers.mjs`. The second is the expensive one.

Full diagnosis, measurements and both-directions verification are in the `#3915` addendum
(PR #3923) — **read that rather than re-deriving it**. This issue is scoped to the **fix**.

## 1. The message names a plausible cause that is not the actual one

```
[sync-conformance] --check failed: 1 file(s) would change. Run `pnpm run sync:conformance` and commit the result.
[sync-conformance] DRIFT  CLAUDE.md
```

`DRIFT` under a script called **sync-conformance-numbers** reads as _"your conformance
number is stale"_. So triage goes after the figure — and the figure is fine. The actual
diff is **two blank lines**:

```diff
 <!-- AUTO:conformance-start -->
-
 **test262 conformance**: 29,846 / 43,099 (69.2 %)
-
 <!-- AUTO:conformance-end -->
```

**Cost, measured on 2026-07-31:** ~50 minutes for one agent, plus a wasted cycle for
another, plus **a second CI round-trip on a third branch** — all on a two-blank-line diff,
because the message sent everyone after a number that never moved. The number was
byte-identical on the branch, on `origin/main`, and after the sync.

Worse, the remedy the message prescribes **does not work**: `pnpm run sync:conformance`
rewrites the _number_, not the whitespace, so it reports a drift it cannot repair. An
instruction that cannot fix the thing it names is worse than no instruction.

Same family as the `Newly trapping:` wording corrected in #3902.

**Fix:** print the **actual diff**, and say **"generated block differs"** rather than
anything implying the number. A three-line diff would have collapsed both investigations
to seconds.

## 2. Prettier and the sync script mutually undo each other

`sync-conformance-numbers.mjs` regenerates the block **without** blank lines around the
bolded line. **Prettier adds them back.** Verified in both directions: prettier re-adds
exactly the two lines the sync script removes.

**There is no deadlock, and the post-sync form is the correct one** — two independent
proofs:

- _Mechanistic:_ `format:check` is scoped to
  `prettier --check 'src/**/*.ts' 'tests/**/*.ts' 'scripts/**/*.ts'`. **`CLAUDE.md` is in
  none of those globs, so CI never prettier-checks it.** The prettier runs that broke this
  were entirely self-inflicted — a check CI does not run, breaking one it does.
- _Empirical:_ `origin/main`'s own `CLAUDE.md` carries those two lines and main is green,
  so prettier demonstrably does not gate that file.

**Fix:** make them stop disagreeing — either emit prettier-stable output from the sync
script, or add the block/file to `.prettierignore`. Preferring the former: an ignore
entry silently permits future drift elsewhere in the file.

## Why it recurs (and why "just don't run prettier there" is not the fix)

Running prettier over a markdown file you just edited is the obvious, correct-feeling
thing to do. It caught the **same author on two separate branches in one session**, the
second time **after a peer had explicitly warned them about it**, and after they had
predicted their branch was safe on the reasoning _"my edits don't touch the conformance
block"_ — true, and irrelevant: **prettier touched it, not the edit.**

A trap that catches a forewarned, specifically-attentive person twice is not an attention
problem. Fix the tools so they agree.

## Second file, and the damage is worse than whitespace (observed 2026-08-01, #3915)

`CLAUDE.md` is not the only file this hits, and the `CLAUDE.md` case is the **mild** one.

While adding a section to `docs/ci-policy.md`, a run of `prettier --write` on that file
produced **6 unrelated changes** to pre-existing prose. Five were cosmetic
(`*you*` → `_you_`). The sixth **corrupted a code span**:

```diff
-    (`tests/test262-slow-tests.json` / `-standalone.json`). **All of `src/**`
-    stays both-lane** — `target: "standalone"` is a flag through the same
+    (`tests/test262-slow-tests.json` / `-standalone.json`). **All of `src/**`stays both-lane** —`target: "standalone"` is a flag through the same
```

Three words lost their separating spaces and two inline-code spans were re-delimited
around the wrong text. That is **content damage**, not formatting: a reader now sees
`` `src/**`stays `` and `` —`target: "standalone"` `` as code.

Three things make this worth recording next to the `CLAUDE.md` case rather than separately:

1. **`docs/ci-policy.md` is NOT in the prettier gate.** `format:check` covers only
   `'src/**/*.ts' 'tests/**/*.ts' 'scripts/**/*.ts'`. So prettier has **no authority**
   over this file and running it there is pure, unreviewed damage.
2. **`origin/main`'s own copy is already prettier-dirty, and `main` is green** — which is
   the positive proof that it is ungated. The same reasoning that made the `CLAUDE.md`
   post-sync form safe to commit shows the prettier-formatted form here is simply wrong.
3. It is the **same underscore-emphasis mangling** as `7327b3ac` ("backtick `merge_group`
   so prettier stops corrupting the emphasis run") — third occurrence, second file.

**Mitigation that generalises past both files:** the hazard is not "remember which files
are gated", it is that `prettier --write <path>` **silently rewrites everything in the
file, not just what you touched**. So: never run it on a markdown file that
`format:check` does not cover, and after any prettier run on a doc, read
`git diff --numstat` — a purely additive edit that reports deletions has been rewritten
underneath you. On #3915 the fix was to extract the added section, `git checkout HEAD --`
the file, and re-insert; the resulting diff was **62 added, 0 deleted**.

The cheap structural fix is to make the ungated files ungated _loudly_: add `docs/**` and
`CLAUDE.md` to `.prettierignore`, so `prettier --write` on them is a no-op instead of a
silent rewrite. That closes the whole class without asking anyone to remember a list.

## Acceptance

- [x] A `--check` failure prints the actual diff and does not imply the conformance
      number changed when it did not.
- [x] The prescribed remedy in the message actually repairs the failure it reports.
      (It always did — see the correction below; now it is asserted by a test.)
- [x] Running `prettier --write CLAUDE.md` followed by `sync:conformance:check` exits 0
      (i.e. the two agree), by whichever of the two mechanisms above is chosen.
      Proven **on the merits** before `CLAUDE.md` was ignored — `md5sum` identical
      across `prettier --write`, `--check` exit 0. Carried forward by
      `tests/issue-3947.test.ts`, not by the (now ignore-shadowed) manual command;
      see §3 for why that is a strengthening rather than a dodge.
- [x] `prettier --write docs/ci-policy.md` produces **no** diff — i.e. the files prettier
      has no authority over are ignored explicitly rather than merely unchecked. Verify by
      running it on a clean tree and asserting `git diff --numstat` is empty; the current
      behaviour rewrites 6 lines and breaks a code span.

## Resolution (2026-08-01)

Three changes. All four acceptance boxes are ticked above, each by a command
whose output is quoted below rather than by a structural claim.

### 1. `--check` now classifies and prints the real diff

`DRIFT <file>` is gone. `--check` computes an LCS line diff of the anchor block
and splits the failure into the two cases that have completely different triage
paths:

```
[sync-conformance] DIFFERS  CLAUDE.md

[sync-conformance] CLAUDE.md: generated block differs — WHITESPACE/FORMATTING ONLY.
  The generated line is byte-identical, so nothing about the conformance figures
  has changed. (Usual cause: a markdown formatter reflowed the block. See #3947.)
[sync-conformance]     <!-- AUTO:conformance-start -->
[sync-conformance]   + (blank line)
[sync-conformance]     **test262 conformance**: 30,530 / 43,099 (70.8 %)
[sync-conformance]   + (blank line)
[sync-conformance]     <!-- AUTO:conformance-end -->
```

versus, with a genuinely stale figure:

```
[sync-conformance] CLAUDE.md: the generated line CHANGED — the committed value
  does not match benchmarks/results/test262-current.json.
[sync-conformance]   committed: **test262 conformance**: 29,999 / 43,099 (69.6 %)
[sync-conformance]   generated: **test262 conformance**: 30,530 / 43,099 (70.8 %)
```

Blank lines render as `(blank line)` deliberately — the whole #3947 failure was
blank-line-only, which is invisible in a diff that prints an empty string.

### 2. The sync script now emits prettier-stable output

`replaceAnchorBlock` emits `\n\n${body}\n\n`. That is **exactly** what prettier
3.8 produces: after the change the sync-written `CLAUDE.md` is byte-identical to
the prettier-written one (same git blob, `7ee35143c1b5a2`). Verified on all four
targets including `README.md`'s two adjacent anchor pairs, which was the one
shape that could have disagreed.

### 3. All markdown is `.prettierignore`d — `CLAUDE.md` included

`**/*.md`, no exceptions. `format:check` covers only
`src/**/*.ts tests/**/*.ts scripts/**/*.ts`, so prettier has no authority over
any markdown; ignoring it turns `prettier --write <doc>` into a no-op instead of
a silent whole-file rewrite.

**This was originally scoped to exclude `CLAUDE.md`, and the evidence reversed
it mid-branch.** The argument for keeping `CLAUDE.md` visible was that
acceptance box 3 is the evidence fix 2 worked, and ignoring the file would make
that box pass because prettier could not see it. That argument died on the
merge: after merging current `main`, `prettier --write CLAUDE.md` **damages**
`CLAUDE.md` — it de-indents a list-item continuation line, dropping the fenced
code block that follows out of the list item:

```diff
 - **Verify, don't trust the date.** Enforcement is a repo **ruleset**, not
   classic branch protection (the classic endpoint answers `404 Branch not
-  protected`):
+protected`):
```

Same content-damage class as `docs/ci-policy.md`, in the file every agent edits.
Leaving the foot-gun armed inside the very fix whose subject is "stop prettier
silently damaging ungated markdown" was not defensible.

The agreement stays **non-vacuously tested** because the detector moved from a
hand-run command to `tests/issue-3947.test.ts`, which calls prettier's
**programmatic** `format()` on the generated block in a temp fixture — and
`format()` does not consult `.prettierignore`. That is the stronger detector on
three counts: it isolates the anchor block from unrelated prose drift (which is
precisely what began confounding the manual command), it cannot be silenced by
an ignore rule, and it runs in CI on every PR instead of when someone remembers.

### Measurements taken with `prettier --write` on a clean tree

| file                | delta      | nature                                                          |
| ------------------- | ---------- | --------------------------------------------------------------- |
| `CLAUDE.md`         | 2 +/0 −    | on `origin/main`: the two blank lines only — mutual undo         |
| `CLAUDE.md`         | 1 +/1 −    | after merging main: **list-continuation de-indent** (damage)     |
| `docs/ci-policy.md` | 5 +/6 −    | 4 cosmetic `*em*`→`_em_`, **1 code-span corruption** (see below) |
| `README.md`         | 17 +/12 −  | tables realigned, `*em*`→`_em_` in prose                         |
| `ROADMAP.md`        | 18 +/16 −  | same                                                             |

The `docs/ci-policy.md` corruption reproduced exactly as recorded: a backtick
span adjacent to `**bold**` makes prettier mis-parse the emphasis run and delete
the spaces between words, joining `` `src/**` `` to `stays` and `—` to
`` `target:` ``. `README.md`/`ROADMAP.md` were **not** previously recorded and
are the same class — that is why the ignore rule is by category rather than a
list of two files.

Note the `CLAUDE.md` row moved from 2 +/0 − to 1 +/1 − in the span of one merge.
That is the argument for the category rule in one line: which markdown files are
prettier-dirty is not a stable fact anyone can hold in their head.

### Correction: the prescribed remedy was NOT broken

The issue states that `pnpm run sync:conformance` "rewrites the *number*, not
the whitespace, so it reports a drift it cannot repair." **That is false on
current `main`, and was false before this PR.** Measured:

```
$ npx prettier --write CLAUDE.md   # re-adds the two blank lines
$ node scripts/sync-conformance-numbers.mjs
[sync-conformance] wrote  CLAUDE.md
$ node scripts/sync-conformance-numbers.mjs --check ; echo $?
0
```

`processFile` rewrites the **entire** anchor block via `replaceAnchorBlock`, so
it normalises whitespace and value together; it always repaired both.

This matters for the post-mortem: the ~50 minutes were lost purely to the
**wording**, not to a remedy that failed. What almost certainly happened is the
mutual-undo *loop* — run the remedy, then run `prettier --write` again (a
reflex, or format-on-save), and the block comes straight back. That reads
indistinguishably from "the remedy did nothing." Fix 2 is what actually kills
that loop; fix 1 is what makes the one remaining failure self-explanatory.

Nothing in the repo auto-formats markdown: `.husky/post-merge` and `lint-staged`
both filter to `.ts/.js/.mjs` (`+ .json` for lint-staged), so the prettier runs
were hand-run, as the issue says.

### Regression guard

`tests/issue-3947.test.ts` (7 tests) runs the script as a real subprocess
against a throwaway repo skeleton in a temp dir, so the CLI contract — exit
codes and stderr wording — is what is covered, with no testability refactor of
production code. It asserts prettier-stability of the generated block, the
sync→prettier→`--check` round-trip, both message branches, that the remedy
repairs both, and that `.prettierignore` keeps `CLAUDE.md` visible while
ignoring the ungated docs.

**Mutation-checked**: reverting `\n\n` to `\n` in `replaceAnchorBlock` fails
4 of the 7 tests. The suite is a detector, not a green rubber stamp.

### Known one-time cost

`promote-baseline` writes the new block shape on `main` once this lands, so any
PR open across the merge will hit a one-line conflict in each anchor block the
next time it merges `main`. Resolve by taking either side and re-running
`pnpm run sync:conformance`.

## Not this issue

- **#3612** is `baseline-summary-sync` clobbering fresher conformance docs — a
  read-then-write race on the **number**. Same file family, different defect.
- **#3915 / PR #3923** carries the diagnosis and the evidence tables. This issue owns the
  fix only.
