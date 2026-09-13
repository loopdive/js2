---
id: 5404
title: "standalone: the RegExp backend refuses every RUNTIME-BUILT pattern (`Unsupported dynamic regular expression pattern`), which is how the Temporal polyfill parses ISO strings — 13 `new RegExp(<template>)` sites composed at module init"
status: done
completed: 2026-09-12
assignee: ttraenkler/sendev-5383-s8
sprint: current
priority: medium
horizon: m
goal: standalone
feasibility: hard
reasoning_effort: high
requested_by: ttraenkler/dev-5383-s2d
created: 2026-09-08
loc-budget-allow:
  # 2026-09-12 (#5404 / #5383 S8) — the composition fold and its safety gate.
  #   `staticConstStringValue` already folded `a + b` and `re.source`; this
  #   adds the two spellings the Temporal polyfill actually uses at all 13 of
  #   its `new RegExp` sites (measured: 11 template literals, 2
  #   `[...].join("")`), plus `nativeRegExpPatternCompiles` — the trial compile
  #   that keeps a widened fold from converting a catchable runtime TypeError
  #   into a STICKY compile error. The fold lives next to the other
  #   `static*Value` recoverers it recurses through; splitting it out would
  #   have to export three private helpers and the `FoldWidening` protocol
  #   across a module boundary for ~90 lines.
  - src/codegen/regexp-standalone.ts
---

# #5404 — a runtime-built RegExp pattern is refused under `--target standalone`

## Problem

`--target standalone` compiles a regular expression whose pattern is a
**literal** (`/[0-9]+/`) to the #682 native backtracking VM at COMPILE time. A
pattern that is only known at RUNTIME goes through
`__regex_compile_dynamic_simple`, whose grammar is a small subset; anything
outside it produces a **poisoned** `$NativeRegExp` that raises
`TypeError: Unsupported dynamic regular expression pattern` on first use
(`REGEX_UNSUPPORTED_DYNAMIC_PATTERN`, `src/codegen/native-regex.ts` L54; the
poisoned-value design is #4439).

That is the wall `Temporal.PlainDate.from("2024-01-01")` hits on the standalone
lane (measured 2026-09-08 while driving the compiled `@js-temporal/polyfill`
from inside its own module — #5383 S2c/S2d). It is NOT a linked-provider or
boundary problem: the same throw happens single-module.

### What the polyfill actually builds (measured, `.tmp/s2d/regexp-scan`)

The bundle contains **13** `new RegExp(...)` call sites and **1** literal used
with `.test`/`.exec`. Every one of the 13 is a template literal that splices the
`.source` of previously built expressions — i.e. a **finite, closed set fixed at
module-initialisation time**, with no user input anywhere:

```
new RegExp(`(?:${/(?:[+-](?:[01][0-9]|2[0-3]) … `)      // UTC offset
new RegExp(`(${ye.source} …`)                            // date
new RegExp(`([zZ] …`)                                    // Z designator
new RegExp([`^${we.source}`, `(?:(?:[tT]|\\s+ …`)        // date-time
new RegExp([`^[tT]?${ve.source}`, `(?:${De.source} …`)   // time
new RegExp(`^(${ye.source} …`)
new RegExp(`^(?:-- …`)                                   // month-day
new RegExp(`(?:${Oe.source}H …`)                         // duration
new RegExp(`^([+-] …`)
new RegExp(`^${fe.source}$`, "i")                         // (case-insensitive)
new RegExp(`^${/([+-] …`)
new RegExp(`^${be.source}$`)
```

`String.raw` is not used; there are no `\d{n}`-style constructions. The
composition happens once, at init, into module-level bindings the ISO parsers
then reuse.

## Why this matters

Every `Temporal.*.from("<ISO string>")` row in test262 goes through these
parsers, and string parsing is the single largest Temporal entry point. It also
blocks the same shape anywhere else: a library that composes its grammar from
fragments (a very common idiom) is unusable on the standalone lane even though
every fragment is a compile-time constant.

## Plan (two candidate fixes, pick by measurement)

1. **Precompile the closed set at provider/compile time.** The 13 patterns are
   fixed once the bundle's own initialisation has run, so a build-time pass
   could evaluate the composition and lower each result through the SAME
   compile-time path a literal takes. Cheapest at runtime, but it needs a
   defensible answer to "when is a template-composed pattern provably constant?"
   — const-folded `.source` reads of already-const regexes is the narrow rule
   that covers all 13.
2. **Grow the runtime compiler** (`__regex_compile_dynamic_simple`) toward the
   feature set the literal path already implements, so a runtime pattern is
   compiled by the native engine rather than poisoned. Strictly more general,
   pays a runtime cost, and is the honest fix for arbitrary user input.

Either way, keep #4439's poisoned-value contract for what remains outside the
grammar: refuse on first USE with a catchable `TypeError`, never at construction
and never as a Wasm trap.

## Acceptance criteria

- A standalone module that builds a pattern by composing `.source` of literal
  regexes at init can `.test`/`.exec` with it, host-free.
- The exact 13 polyfill spellings above are covered (a fixture test, not a
  Temporal end-to-end).
- `Temporal.PlainDate.from("2024-01-01").day === 1` through the standalone
  provider — as a follow-on measurement in #5383, once its boundary work lands.
- No change to the JS-host (`gc`) lane: byte-identical artifacts.

## Notes

Filed out of #5383 S2d, which deliberately used the OBJECT-form spellings
(`Temporal.Duration.from({hours: 1})`, `new Temporal.PlainDate(2024, 1, 1)`) to
keep its smoke test off this gap.

## Resolution (2026-09-12, #5383 S8)

**Route 1 of the plan above — precompile the closed set — with the narrow rule
the plan named.** Route 2 (growing the runtime Wasm pattern compiler) was
measured and NOT taken; the reasoning is below.

### The measurement that chose the route

`.tmp/s8/census.mjs` parses the bundle `buildTemporalProvider` actually links
(157,541 bytes, 7 lines, via `loadTemporalPolyfillSource()`), so the census is
of the shipped text and not of an upstream `regex.js`:

| | count |
| --- | --- |
| regex LITERALS | 23 |
| `new RegExp(...)` sites | 13 |
| …whose argument is a template literal with substitutions | 11 |
| …whose argument is `[...].join("")` | 2 |
| …whose argument is anything else | **0** |
| sites taking a flags argument | 2 (both `"i"`) |
| substitutions that are NOT a `.source` read | **0** |

Every fragment is a **module-level `const`** — `me ye pe ge ve be Te Oe` are
regex literals, `fe we De $e` are themselves `new RegExp(<template>)` whose
`.source` later sites splice. No user input reaches any of them.

Then the decisive reduction (`.tmp/s8/reduce.mts`), three spellings of ONE
pattern, standalone, base compiler:

| spelling | base |
| --- | --- |
| `new RegExp("^" + a.source + "-(\\d{2})$")` | **PASS** |
| `` new RegExp(`^${a.source}-(\\d{2})$`) `` | REFUSED |
| `new RegExp(["^", a.source, "-(\\d{2})$"].join(""))` | REFUSED |

So the backend **already** compiled a composed pattern to the native engine —
#2161 had folded `a + b` and `re.source` for exactly this reason. The gap was
not "runtime-built patterns"; it was **two missing spellings of the same
compile-time composition**. That reframes the issue: no runtime regex compiler
is needed for this bucket, and building one (porting ~78 kB of
`regex/{parse,compile}.ts` into hand-authored Wasm) would have been a large
change that this bucket does not require. Route 2 remains the honest fix for
*genuinely* runtime patterns, which stay refused — see the last acceptance row.

### The change

`staticConstStringValue` (`src/codegen/regexp-standalone.ts`) gains two arms:

- a **template literal** with substitutions — each substitution folded
  recursively, and the literal spans taken COOKED (`` `\d` `` cooks to `d`, which
  is why the polyfill writes `\\d`; the fold must not re-raw them or it would
  disagree with the host);
- **`[…].join(sep)`** over a direct array literal — no spread, no holes, no
  binding; an absent separator is `","` per §23.1.3.16 step 3.

Both are **opt-in**: they fire only when the caller passes a `FoldWidening`
tracker. Two lowering sites pass one (`staticRegExpPatternFlags`, the metadata
recoverer `.exec`/`.test` use; and the `new RegExp` lowering itself), and both
apply the same gate afterwards.

### Why the gate, and why it is the load-bearing part

`reportStandaloneRegExpUnsupported` is a **sticky** compile ERROR (#3724/#3725),
not a demote. So widening the fold has an asymmetric downside: a composed
pattern that folds but lands on a construct the compile-time engine cannot
lower would turn a **catchable runtime `TypeError`** into a **hard build
failure for the whole module** — on a 157 kB bundle built entirely out of this
idiom, strictly worse than the refusal it replaces. `nativeRegExpPatternCompiles`
therefore trial-compiles the composed pattern (flags parse + supported-flag
mask + `compilePattern`, memoised, silent on failure); when it fails, the
widened fold is discarded and the site keeps its **pre-#5404** lowering
verbatim. Measured: `` new RegExp(`${frag.source}{1,100000}`) `` (over the
expansion cap) compiles fine and throws the ordinary catchable TypeError.

### Results

`tests/issue-5404-standalone-composed-regexp.test.ts` — 18 assertions, **Node is
the oracle for every match**, comparing the FULL capture list, not just
match/no-match:

| corpus | base | branch |
| --- | --- | --- |
| the 13 polyfill spellings (`.exec` + all captures) | 0/13 (all REFUSED) | **13/13 agree with Node** |
| the 3-spelling reduction | 1/3 | **3/3** |
| nested composed `.source` (`new RegExp` of a `new RegExp`) | REFUSED | **agrees** |

Byte A/B over a fixed 11-module corpus × 2 targets (`.tmp/s8/ab.mts`): **21 of
22 hashes identical**, the sole difference being the one standalone module that
composes a pattern with a template literal — and its new hash is **equal to the
`+`-concat module's**, i.e. the composed form now lowers to exactly the bytes
the already-working spelling produced.

### Acceptance criteria

- [x] A standalone module that composes `.source` of literal regexes at init can
      `.test`/`.exec`, host-free.
- [x] The exact 13 polyfill spellings are covered by a fixture test.
- [x] No change to the JS-host (`gc`) lane: byte-identical artifacts (11/11).
- [x] `Temporal.PlainDate.from("1976-11-18")` no longer **throws** through the
      linked standalone provider (it did in S5/S7). It does not yet answer
      correctly — see #5408, where the residual is now attributed.
- [x] A genuinely runtime pattern keeps #4439's poisoned-carrier contract:
      refuse on first USE with a catchable `TypeError`, never at construction
      and never as a trap.
