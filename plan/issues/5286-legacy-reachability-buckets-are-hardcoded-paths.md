---
id: 5286
title: "R10's deletion scope is set by hardcoded file paths, not by the reachability analysis it reports alongside"
status: done
created: 2026-09-03
updated: 2026-09-03
completed: 2026-09-03
sprint: current
priority: high
horizon: s
feasibility: medium
reasoning_effort: high
area: ir
goal: backend-agnostic-ir
requested_by: ttraenkler/fable-ir-takeover
related: [3518, 3090]
---

## Problem

`scripts/audit-legacy-reachability.mjs` is R10's sizing instrument: it reports,
per bucket, how many files and lines the direct front end owns. The
**per-function** half of it is a real analysis — each function is classified
`legacy-only` / `shared` / `unreferenced` / `dispatch` by reachability from the
cut set (`statements.ts#compileStatement`, `expressions.ts#compileExpression`).

The **bucket** half is not. `bucketOf` (`:383-388`) is a lookup on the file path:

```js
function bucketOf(fileRel) {
  const short = fileRel.replace("src/codegen/", "");
  if (BUCKET_FILE[short]) return BUCKET_FILE[short];      // hand-maintained map
  for (const [pre, b] of BUCKET_PREFIX) if (fileRel.startsWith(pre)) return b;
  return "stays";
}
```

It consumes nothing from the analysis. Two of the six prefixes are directories —

```js
["src/codegen/expressions/", "frontend"],
["src/codegen/statements/",  "frontend"],
```

— so **every file added under `expressions/` or `statements/` becomes front-end
deletion scope automatically.** Of the 107 files in today's `frontend` bucket,
**100 are there by prefix and 7 by name.**

The two halves disagree, visibly:

| file | how it became `frontend` | legacy-only | shared |
| --- | --- | --: | --: |
| `closures.ts` | a hand-typed `BUCKET_FILE` entry | 125 | **3,872** |
| `statements/nested-declarations.ts` | the `statements/` directory prefix | 285 | **3,157** |

Neither is a front-end file by any measured property — 97% and 92% of their
function lines survive R10 — yet **7,029 shared lines sit in R10's reported
deletion scope on the strength of a hardcoded string.**

**Two concrete harms, both already realised.**

1. **A wrong figure reached a PR body.** On 2026-09-03 the frontend bucket's
   share of legacy-only lines was reported as rising 48.5% → 51.9% between
   2026-07-17 and today, and read as "the deletion target is being outpaced."
   It is not a valid comparison: the frontend *set* grew as `expressions/` and
   `statements/` grew, so part of the rise is files joining the set. Withdrawn
   in `#3518`, but only after publication.
2. **R10 is sized against a number nobody can audit.** "107 files, 85,823
   legacy-only lines" reads as an analysis result. Anyone planning the deletion
   from it inherits an editorial list without knowing they have.

Note what is **not** wrong: `legacyLoc` / `sharedLoc` are sound, and the
whole-file-deletable split in `#3518` (78 files with `sharedLoc == 0` vs 29
requiring a split) is built from those and unaffected.

## Acceptance criteria

1. The audit reports, per file, whether its bucket is **asserted** (hand-map or
   prefix) and whether the measured classes **contradict** it.
2. A file whose `sharedLoc` dominates its `legacyLoc` while bucketed `frontend`
   is flagged by name in the output. `closures.ts` and
   `statements/nested-declarations.ts` must both appear on today's tree.
3. Bucket totals in the report state their basis, so "107 files" can never again
   be read as a measurement.
4. **No bucket label is changed by this issue.** The taxonomy belongs to R10's
   owner; this makes the disagreement visible, it does not resolve it.
5. The per-function classification and the JSON's existing shape are unchanged —
   `#3518`'s sizing table must reproduce exactly.

## Implementation Plan

**Report the conflict; do not re-classify.** The temptation is to make
`bucketOf` derive the bucket from `sharedLoc`/`legacyLoc`. Resist it: the
buckets encode *intent* (`deferred` means eval/`with`/async-CPS are
out of scope by decision, not by reachability), and a ratio cannot express
that. Replacing an editorial judgement with a heuristic would trade a visible
wrong answer for an invisible one.

1. **Record the provenance** where `perFile` is built (`:410`):

   ```js
   const [bucket, basis] = bucketOf(fileRel);  // basis: "named" | "prefix" | "default"
   ```

   `bucketOf` returns the pair; the three call paths already distinguish them.

2. **Derive a contradiction flag** after `legacyLoc`/`sharedLoc` are known:
   `bucket === "frontend" && sharedLoc > legacyLoc`. Emit as
   `bucketConflict: true` in the JSON and as a new report section
   **`## bucket conflicts`**, listing file, basis, `legacyLoc`, `sharedLoc`.
   Two rows expected on today's tree.

3. **Annotate the bucket table.** Add a column giving, per bucket, how many of
   its files are `named` vs `prefix` vs `default` — the line that makes
   "frontend: 107" self-describing (100 prefix / 7 named).

4. **Do not touch** `BUCKET_FILE`, `BUCKET_PREFIX`, the cut set, or the
   classifier. Prove it: the `perFile[].fns` array and every `legacyLoc` /
   `sharedLoc` / `deadLoc` must be identical before and after — diff the JSON
   with the new keys stripped.

**Sizing.** One script, three additive changes, no behaviour change to any
consumer. `horizon: s`. The risk is scope creep into re-bucketing, which
criterion 4 exists to prevent.

## Notes

This is the third instrument-misreading of one session (`#5285` is the first —
a fail-fast path read as a survey; the second was a shallow-clone fetch boundary
read as absent history). The shared root: **the instrument was assumed to answer
the question being asked of it, and one look at the source settled it in under a
minute each time.** What makes this one worth a gate rather than a note is that
the misreading is *structural* — the report puts an asserted number and a
measured number in adjacent columns of the same table, with nothing marking
which is which.

## Outcome — PR #5513, and the scope error is six times what this issue claimed

Implemented by an Opus lane (`session_012HBuuLFZ92Ui2yaeyBJkWA`) as **PR #5513**,
reviewed and released 2026-09-03 03:2x. All five acceptance criteria met; the
regression proof is byte-identity of `.tmp/legacy-reachability.json` with the two
new keys stripped — 1,078,137 bytes both sides, independently reproduced against
a copy captured before that PR existed.

**This issue named two conflicting files. There are twelve, holding 10,642
shared lines** — not the 7,029 the problem statement estimated from hand
inspection of `closures.ts` and `nested-declarations.ts`:

| file | basis | legacy-only | shared |
| --- | --- | --: | --: |
| `closures.ts` | named | 125 | 3,872 |
| `statements/nested-declarations.ts` | prefix | 285 | 3,157 |
| `expressions/identifiers.ts` | prefix | 873 | 1,980 |
| `expressions/late-imports.ts` | prefix | 125 | 590 |
| `expressions/identifier-module-storage.ts` | prefix | **0** | 254 |
| `expressions/proto-override.ts` | prefix | 64 | 218 |
| `expressions/this-keyword.ts` | prefix | **0** | 178 |
| `expressions/spread-arguments-call.ts` | prefix | 10 | 140 |
| `expressions/promise-subclass.ts` | prefix | 40 | 125 |
| `statements/tdz.ts` | prefix | **0** | 94 |
| `expressions/typed-array-host-carrier.ts` | prefix | 28 | 31 |
| `expressions/eval-source.ts` | prefix | **0** | 3 |

**Four of them have zero legacy-only lines, which is a different claim from
"mostly shared".** `identifier-module-storage.ts`, `this-keyword.ts`,
`statements/tdz.ts` and `eval-source.ts` contain **no legacy-only function lines
at all** — they cannot contribute one line to R10's deletion, and they are in its
scope solely because they live under `expressions/` or `statements/`. For those
four, membership is *provably* wrong rather than arguably wrong; they need no
ratio judgement and no taxonomy debate. **The twelve therefore split into "R10's
owner decides" (8) and "just wrong" (4, 529 shared lines).**

**Incidental finding worth keeping:** the `stays` bucket is **19 prefix / 602
default**. The largest bucket is overwhelmingly "no rule matched", which makes it
the *least*-asserted and least-examined of the four — the opposite of what its
name suggests to a casual reader, and a place a mis-bucketed file would be
equally invisible.

**Note on this file's own status.** #5513 deliberately did not carry this issue
file, because it lives on `claude/docs-r9-standalone-corpus` and copying it would
collide when both land. That was the right call by the lane. `status: done` is
set here rather than `in-review` per the lifecycle rule — the implementing PR is
released and green-path, and `in-review` is what orphans issues in this repo. If
#5513 fails to land, this status is wrong and should be reverted rather than
left.
