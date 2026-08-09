---
id: 3658
title: "Landing-page summary sync reports SUCCESS while committing nothing — report page frozen since 15:43Z"
status: ready
created: 2026-07-26
priority: high
horizon: s
feasibility: medium
area: ci
goal: ci-hardening
sprint: current
related: [1951, 3634, 3467]
---

# #3658 — the summary sync succeeds without committing

## This is the user-visible symptom, and it is NOT the promote deadlock

On 2026-07-25 the report page showed data ~7-9h stale. That was initially — and
**incorrectly** — attributed entirely to the baseline-promote deadlock (#3634).
The deadlock was real and was fixed; promotes have flowed since (22:43Z, 22:46Z,
23:02Z, 00:06Z, 00:37Z). **The report page did not recover.**

## Measured

`benchmarks/results/test262-current.json` on `main` — the file the landing page
reads — is stuck at:

```
2026-07-25 15:43:36 +0000  chore(test262): scheduled baseline summary sync — 30390/43098 pass
```

Verified still stale at **00:06:11Z** after 30 minutes of polling, and again later.
Meanwhile the promoted baseline in `loopdive/js2wasm-baselines` read
**30,511/43,104** as of 23:02Z.

**The sync ran and reported SUCCESS in between and committed nothing:**

| sync run | conclusion | committed? |
|---|---|---|
| 18:29:43Z | success | no |
| 19:45:45Z | success | no |
| 21:27:01Z | success | no |
| 22:28:35Z | success | no |
| **23:32:36Z** | **success** | **no** — and fresh 23:02Z baseline data existed |

Commits to that file land only ~3-hourly (09:19, 12:33, 15:43) and stopped
entirely after 15:43. So the hourly schedule fires, the job is green, and the
artifact does not move.

## Why it matters

This is the **only** part of the outage a human actually sees. Everything
downstream of it — landing page, pass/total badges, the trend graph — reports
numbers that are hours or days old while CI is perfectly healthy. It also made a
genuine promote outage look like it had been fixed when the visible symptom had
not changed at all.

## The shape to note

**A green job is not evidence it did its work.** Identical in shape to the
`quality` fail-fast case (an early `bash -e` abort skips 25 later gates while the
step that ran reports fine). Any diagnosis here must confirm the *commit*, never
the *conclusion*.

## Investigate

1. Does the sync compare against a stale local cache, or a ref it never refreshes,
   so it concludes "no change" while the remote baseline has moved?
2. Does it commit to a branch other than `main`, or open a PR that nobody merges?
3. Is a `git diff --cached --quiet` style guard short-circuiting on a path that
   was never re-staged (cf. #3607, where the standalone summary was not staged in
   promote)?
4. Does it need the baselines repo fetched fresh, and is it reading a cached
   `.test262-cache/` copy instead?

## Acceptance

- A promote to the baselines repo is reflected in committed
  `benchmarks/results/test262-current.json` within one sync cycle.
- The job **fails loudly** when it finds new baseline data but produces no commit,
  rather than exiting 0.
