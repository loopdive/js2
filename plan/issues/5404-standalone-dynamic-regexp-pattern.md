---
id: 5404
title: "standalone: the RegExp backend refuses every RUNTIME-BUILT pattern (`Unsupported dynamic regular expression pattern`), which is how the Temporal polyfill parses ISO strings — 13 `new RegExp(<template>)` sites composed at module init"
status: ready
sprint: current
priority: medium
horizon: m
goal: standalone
feasibility: hard
reasoning_effort: high
requested_by: ttraenkler/dev-5383-s2d
created: 2026-09-08
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
