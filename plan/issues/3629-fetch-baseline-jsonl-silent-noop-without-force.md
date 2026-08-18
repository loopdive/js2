---
id: 3629
title: "fetch-baseline-jsonl.mjs is a silent no-op without --force — exits 0, prints nothing, leaves a week-stale cache"
status: done
completed: 2026-08-02
sprint: 78
created: 2026-07-25
updated: 2026-08-18
priority: high
horizon: s
complexity: S
feasibility: easy
task_type: ci
area: ci, tooling
language_feature: n/a
goal: test-infrastructure
related: [3628, 1528]
origin: "2026-07-25: the lead and multiple dev lanes were instructed to 'fetch fresh' with the bare command and silently received a 7-day-stale baseline."
---

# #3629 — `fetch-baseline-jsonl.mjs` silently serves a stale cache

## Problem

`node scripts/fetch-baseline-jsonl.mjs` is **cache-aware and no-ops if a cache
file exists**, regardless of its age. It then **exits 0 and prints nothing**.

The failure mode is the dangerous one: it is indistinguishable from a
successful fresh fetch.

Observed 2026-07-25:

```
$ node scripts/fetch-baseline-jsonl.mjs
EXIT=0                                    # no output at all
$ ls -la .test262-cache/test262-current.jsonl
Jul 18 10:03                              # SEVEN DAYS OLD
# contents: pass 25,545  — while main was at 30,931
```

Only `--force` refetches:

```
$ node scripts/fetch-baseline-jsonl.mjs --force
[fetch-baseline-jsonl] downloaded ... (66,854,653 bytes, 47,874 entries).
# contents: pass 30,931 / fail 14,814 / compile_error 657
```

That is a **5,386-test difference** — an entire session's landed work invisible.

## Why it matters

The baseline JSONL is the **authoritative input** for regression triage, trap
censuses, edition/bucket analysis, and de-vacuification sizing. Analysis run on
the stale cache is silently wrong in a way that looks perfectly healthy, and the
error scales with cache age.

Concretely, on 2026-07-25 several dev lanes were told to "fetch fresh" with the
bare command as part of their briefs. Any that did received a 7-day-old file.
One lane independently hit the sibling case: the local standalone cache was a
snapshot from a run where the lane was compile-erroring wholesale
(`compile_error 43,469 / pass 4,508`), so **every "pass" in it was a negative
test** — an input that would have yielded a confident _"standalone lane: 0 %
vacuous, all clean"_ from any detector without a vacuity guard.

This is the same shape as the other silent-zero defects found the same day: a
tool returning a benign-looking answer that is not a measurement.

## Proposed fix (weigh these)

1. **Always report what it did**, even on the cache-hit path — one line naming
   the path, the byte count, the entry count, and **the cache's age**. Silence
   is what makes this invisible.
2. **Warn or refuse on a stale cache.** A cache older than N hours (or older
   than the current `origin/main` baseline SHA) should either refetch
   automatically or print a loud warning. Prefer comparing the cached
   `baseline_sha` against the current one over a wall-clock heuristic.
3. **Make the default safe.** Callers overwhelmingly want current data;
   consider inverting so freshness is the default and `--cached`/`--offline` is
   the opt-in. Keep the graceful-fallback semantics for the genuinely offline
   case (exit 1 only when upstream is unreachable AND no cache exists).
4. Update the standing instructions and `CLAUDE.md` so the documented incantation
   is the one that actually fetches.

## Acceptance

- [x] A cache-hit run prints what it served and how old it is.
- [x] A stale cache cannot be served silently — refetch or warn loudly.
- [x] A test pins the behaviour: with a stale cache present, the command either
      refetches or emits a warning; it must not exit 0 silently.
- [x] Docs/briefs updated to the correct incantation.

## Resolution 2026-08-02

**Freshness is now the default**, per proposal 3 — without inverting the flag,
which would have broken every existing caller. `--force` still forces;
`--offline` is the new opt-in for the genuinely disconnected case.

| behaviour                                  | before                             | after                                                              |
| ------------------------------------------ | ---------------------------------- | ------------------------------------------------------------------ |
| cache hit (fresh)                          | **silent, 0 bytes, exit 0**        | reports path, bytes, age, and the window it was judged against     |
| cache hit (older than 6h)                  | **silent, served anyway**          | says it is STALE and **refetches automatically**                   |
| `--offline` with a stale cache             | n/a                                | serves it, and says freshness was **NOT established**              |
| download fails, cache present              | warned, **never named the age**    | names the age + state, and says this is **not** a currency claim   |
| unreadable `mtime`                         | n/a                                | classifies **STALE**, never FRESH                                  |

Reporting goes to **stderr** so the stdout contract is untouched — `--print-path`
and the path echoed under `--force`/`--no-cache` still parse cleanly. Loud to a
human and clean to a pipe are not in tension when they use different streams.

### Controls

The end-to-end **before/after** was run against the *same* deliberately-staled
cache (2 MB of well-formed rows, `mtime` set 7 days back — the shape of the real
incident):

| run                                                   | result                                                                                        |
| ----------------------------------------------------- | ----------------------------------------------------------------------------------------------- |
| **BEFORE** (`upstream/main` copy of the script)       | `EXIT=0`, **stdout 0 bytes, stderr 0 bytes** — the defect reproduced exactly                  |
| **AFTER**, default                                    | `cached baseline is STALE (…, 7.0d old, window 6h) — refetching automatically` → 48,349 entries |
| **AFTER**, `--offline`                                | `⚠ OFFLINE: serving a cache whose freshness is NOT established — (…, 7.0d old, state=STALE)`  |
| **AFTER**, fresh cache                                | `serving CACHED baseline — (…, 0m old); within 6h freshness window`                           |
| `--print-path`                                        | one clean path on stdout, unchanged                                                           |

**A size check alone could never have caught this**, and there is a test that
says so: the stale file was a perfectly well-formed 66 MB baseline that passed
the pre-existing `MIN_REASONABLE_BYTES` guard. Age is the only discriminator.

**Third state.** An unreadable/absent `mtime` classifies **STALE**, not FRESH.
This is the subtle one: under a naive `now - mtime` comparison a missing mtime
yields `NaN`, every comparison is false, `age > max` is false, and the cache is
served as **current** — the exact false-empty the issue is about. `formatAge`
returns `"age UNKNOWN"` rather than a blank or a zero, because both would read
as "brand new".
