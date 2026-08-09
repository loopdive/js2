---
id: 4228
title: "standalone: for…in over acorn's regex-descriptor objects yields nothing (natively enumerable plain objects) — 3 of the 6 copy-differential residuals; minimal fixture does NOT reproduce"
status: ready
sprint: current
created: 2026-08-08
updated: 2026-08-08
priority: medium
horizon: m
feasibility: medium
task_type: bug
area: runtime
es_edition: 5
language_feature: objects
goal: standalone-mode
related: [4194, 3920, 3927]
origin: "#4194's acorn-scale copy differential (PR #4232) — newly MEASURABLE because computed writes now land; before that fix the copy was uniformly blank and this class was invisible inside the noise"
---

# #4228 — acorn's regex descriptors don't enumerate in standalone, and the cheap repro is a non-repro

## Problem, with the exact numbers

`tests/dogfood/cold-tail-differential.mjs` `PROBE_READ=copy` (added in PR
#4232) copies every walked object via `for (k in src) copy[k] = src[k]` and
hashes the copies. Against direct computed reads over the same 32,506
objects, 58 of 64 fields are bit-exact; 3 of the 6 divergences are this
class:

| field | direct computed read sees | native ORACLE's for-in copy keeps | wasm for-in copy keeps |
| --- | ---: | ---: | ---: |
| `pattern` | 15 | 15 | **0** |
| `flags` | 19 (read) / 15 (oracle walk) | 15 | **0** |
| `source` | 5 | 1 kept natively (4 are RegExp `.source`, correctly non-own) | **1** |

Acorn stores `node.regex = { pattern: pattern, flags: flags }` — a plain
object literal, natively enumerable (the oracle's `{}` copy keeps all 15).
In the wasm lane the VALUE is stored and computed reads see it, but `for…in`
over that object yields nothing, so any enumeration-driven consumer
(copyNode included) silently loses it.

## The load-bearing negative result: the obvious fixture does NOT reproduce

`.tmp/probe-regexdesc.mjs` (2026-08-08, restated here): a fnctor + factory +
`node.regex = { pattern: p, flags: f }`, descriptor read back through a
dynamic receiver, `for (k in d)` — answers **2 keys in standalone, equal to
native**, both for the field-read path and for a directly-laundered literal.
So "plain `{pattern, flags}` literal behind a dynamic receiver" is NOT the
mechanism; something about the shape's context inside the compiled acorn
module is (candidates, unverified: a different carrier chosen for the
literal under acorn's shape-inference pressure; structural canonicalization
against a non-enumerable carrier; the literal flowing through a path that
erases its `__anon_*` identity). Whoever takes this should start from the
committed harness, not from a hand fixture:

```bash
PROBE_READ=copy npx tsx tests/dogfood/cold-tail-differential.mjs \
  --fields pattern,flags --json .tmp/copy.json
# non-vacuity: computed-mode `seen` for pattern is 15 on the same build
```

## Boundary against neighbouring issues (checked, not assumed)

- **NOT #4219** (the for…in static-unroll issue from PR #4229): that class is
  STRUCT-TYPED receivers whose for-in is statically unrolled. This receiver
  is dynamic (an externref child read mid-walk); the unroll never sees it.
- **NOT #4194's write half** (fixed in PR #4232): the copy loses these keys
  because enumeration never YIELDS them; the write path demonstrably lands
  everything enumeration yields.
- The `flags` 19-vs-15 spread: 19 objects answer `flags` to a direct read,
  only 15 are plain descriptors the oracle enumerates — the other 4 are real
  RegExp carriers whose `flags` is correctly non-own-enumerable. Only the 15
  are in scope.

## Acceptance criteria

- [ ] `PROBE_READ=copy` on standalone acorn: `pattern`/`flags` presence
      matches the oracle (15), and the copy-vs-computed hash divergence list
      shrinks from 6 to 3 (the three Node-shell instrument artifacts remain,
      documented in the harness header).
- [ ] The minimal-fixture non-repro is EXPLAINED (name the mechanism), so the
      fix is known to cover the class rather than the symptom.
- [ ] Builtin RegExp own-enumerability unchanged (`for (k in /ab/g)` yields
      nothing; the #4071 rule).
