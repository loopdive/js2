---
id: 3260
title: "Whitepaper: auto-update Test262 numbers + date AND surface the JS-host vs standalone lane distinction with both figures"
status: done
completed: 2026-07-17
assignee: ttraenkler/fable-s2
sprint: current
priority: medium
horizon: s
feasibility: easy
task_type: chore
area: website, ci
goal: ir-full-coverage
created: 2026-07-14
related: [1147, 1216, 1781]
origin: "whitepaper hardcodes 73.5% / 31,700 / 'As of May 2026' (stale vs live 76.5% / 32,990) AND reports a single unlabeled conformance number — never states the standalone host-free rate"
---

# #3260 — Whitepaper conformance numbers + date must auto-update

## Problem

`website/docs/whitepaper.md` and `website/docs/whitepaper.html` **hardcode** the
Test262 conformance figures and a date, so they silently rot as the real number
climbs. As of 2026-07-14 the whitepaper says:

- "**73.5% Test262 compliance**" (line 16, 216, 320)
- "**31,700 / 43,106** official conformance tests passing" (line 216)
- "**As of May 2026**, we are not aware of another AOT JavaScript-to-Wasm…" (line 273)

…but the authoritative baseline (`benchmarks/results/test262-current.json`,
refreshed by the `promote-baseline` job on every push to main) already reads
**76.5% — 32,990 / 43,106** (generated 2026-07-14). The doc is ~1,300 tests /
3 percentage points stale and the date is two months old. This is exactly the
kind of number a public whitepaper must not get wrong.

Root cause: `scripts/build-pages.js:256` **copies `whitepaper.html` verbatim** —
there is no build-time substitution of live figures, and the `.html` is
maintained by hand alongside the `.md`.

### Second gap — the standalone lane number is missing entirely

The whitepaper discusses the JS-host vs standalone modes **conceptually** (§5,
§5.2) and even says "Standalone support is meaningful and growing, but it is not
yet the primary public conformance path today" (line 157) — but it reports a
**single, unlabeled conformance figure** and **never states the standalone
(host-free, pure-Wasm) conformance number.** A reader cannot see the two lanes'
progress side by side, even though dual-mode (JS-host optional) is a headline
architectural claim of the project and the standalone rate is the priority-#1
metric internally.

The two lanes are distinct conformance metrics on different targets and must
never be summed:

| Lane                                                 | Live figure (2026-07-14)     | Authoritative source                                                                     |
| ---------------------------------------------------- | ---------------------------- | ---------------------------------------------------------------------------------------- |
| **JS-host** (default `gc` target)                    | **32,990 / 43,106 = 76.5%**  | `benchmarks/results/test262-current.json` (in-repo)                                      |
| **Standalone** (`--no-host-imports`, host-free pass) | **~22,962 / 43,106 ≈ 53.3%** | `test262-standalone-current.json` in `loopdive/js2wasm-baselines` (fetched, not in-repo) |

The conformance-figure prose should present **both**, each labeled with its lane,
and both auto-updating.

## Authoritative source (already in-repo, already CI-refreshed)

`benchmarks/results/test262-current.json` (committed, ~kB, updated every push to
main by `test262-sharded.yml`'s `promote-baseline`):

```
official_summary.pass   = 32990
official_summary.total  = 43106      // → 76.5%
baseline_generated_at   = "2026-07-14T00:12:41.734Z"
baseline_sha            = "4bc8763166…"
```

## Scope

1. **Tokenize** the conformance figures + date in `whitepaper.md` (and `.html`)
   with placeholders, e.g. `{{TEST262_PCT}}`, `{{TEST262_PASS}}`,
   `{{TEST262_TOTAL}}`, `{{REPORT_DATE}}` (and drop the brittle "As of May 2026"
   in favour of the generated date, or a plain relative phrasing).
2. **Inject at build time** in `scripts/build-pages.js`: read
   `benchmarks/results/test262-current.json`, compute
   `pct = round(pass/total*100, 1)`, format `pass`/`total` with thousands
   separators and `baseline_generated_at` as a human date, and substitute the
   tokens when emitting `PAGES_DIST/docs/whitepaper.{html,md}`. Keep the source
   files carrying the tokens (not baked numbers) so they never re-stale.
3. Decide the `.html`↔`.md` relationship: either (a) generate the `.html` from
   the `.md` at build (preferred — single source), or (b) run the same token
   substitution over both. Do NOT leave two hand-maintained copies with baked
   numbers.
4. **Add the standalone lane figure alongside the JS-host one.** Introduce
   `{{STANDALONE_PCT}}`, `{{STANDALONE_PASS}}`, `{{STANDALONE_TOTAL}}` tokens and
   revise the conformance prose to present BOTH lanes, each explicitly labeled
   (JS-host vs standalone/host-free), so the dual-mode story is legible. The
   standalone baseline lives in `loopdive/js2wasm-baselines`
   (`test262-standalone-current.json`), not in-repo — pick one:
   - (a) **preferred:** have `promote-baseline` also commit a tiny
     `benchmarks/results/test262-standalone-current.json` summary into the main
     repo (symmetry with the JS-host summary, no build-time network), or
   - (b) fetch it at build time in `build-pages.js` (pattern already exists —
     `scripts/fetch-baseline-jsonl.mjs`), with a committed fallback so an
     offline/rate-limited build still renders a number.
5. Since `promote-baseline` already re-commits the baseline JSON and
   `deploy-pages` rebuilds on every push to main (#1216), the whitepaper then
   tracks both live numbers automatically — **no separate cron needed.**

## Acceptance

- `whitepaper.{md,html}` source contains tokens, not baked figures/date.
- `scripts/build-pages.js` substitutes live values from
  `benchmarks/results/test262-current.json`; the built page shows the current
  JS-host number (76.5% / 32,990 / 43,106) and the baseline's generation date.
- **The built page also states the standalone (host-free) figure
  (~53.3% / ~22,962 / 43,106), explicitly labeled as a distinct lane, sourced
  from the standalone baseline and auto-updating.**
- A stale-guard: a quick check (unit or `build:pages` assertion) that fails if a
  bare `NN.N% Test262` or `As of <Month> 2026` literal reappears in the source,
  so the rot can't silently return.
- Rebuild is idempotent and wired to the existing deploy-pages flow (no new cron).

## Non-goals

- No redesign of the whitepaper content/prose beyond the tokenized figures+date.
- Not touching the benchmark/perf sidebar (`playground-benchmark-sidebar.json`,
  already auto-refreshed by #1216) — this issue is only the whitepaper's
  conformance figures + date.

## Implementation (2026-07-17, fable-s2)

- Tokenized `website/docs/whitepaper.{md,html}`: `{{TEST262_PCT}}`,
  `{{TEST262_PASS}}`, `{{TEST262_TOTAL}}`, `{{STANDALONE_PCT}}`,
  `{{STANDALONE_PASS}}`, `{{REPORT_DATE}}` — no baked figures remain (the
  only regex leftovers are SVG path coordinates).
- `scripts/build-pages.js` substitutes at build from the two committed,
  promote-baseline-refreshed summaries — scope option (a), NO network:
  - JS-host: `test262-current.json` `official_summary` (+
    `baseline_generated_at` → the visible report date)
  - Standalone: `test262-standalone-highwater.json`
    `official_pass/official_total` (the reviewed host-free floor, #3322)
- Both lanes now render side-by-side and auto-update on every push to main
  (promote-baseline commits → deploy-pages rebuilds, #1216). Verified live
  values at implementation time: JS-host 75.4% (32,504/43,106; the honest
  post-oracle-v6 number), standalone 57.2% (24,644) — the whitepaper now
  tracks reality instead of flattering-but-stale marks.
- The substituted `.md` is also emitted to `PAGES_DIST/docs/whitepaper.md`
  (single tokenized source, two rendered artifacts).
