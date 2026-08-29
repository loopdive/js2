---
id: 5206
title: "Intl is not provided at all — `Intl.DateTimeFormat` throws; eighth Temporal blocker, a capability gap, not an init-window bug"
status: done
completed: 2026-08-29
assignee: ttraenkler/opus-dev-5206
sprint: current
priority: high
horizon: l
goal: standalone-gap
feasibility: hard
reasoning_effort: max
requested_by: ttraenkler/fable-lead
created: 2026-08-29
# 2026-08-29 (#5206): the host-`Intl` arm is one condition + its rationale on
# the existing #3087 host-global-materialization branch — the cheapest place
# that already owns "ambient name → real host global object". Splitting a
# 13-line addition (12 of them the comment explaining WHY `Intl` is not
# claimed by any value-shaped arm) into a new module would cost more than it
# buys.
loc-budget-allow:
  - src/codegen/expressions/identifiers.ts
func-budget-allow:
  - src/codegen/expressions/identifiers.ts::compileIdentifierCore
---

# #5206 — no `Intl` global (capability gap)

## Problem

Eighth Temporal module-init blocker (#4628 Option A). On the full fix stack
(#5252 + #5258 + #5262 + #5264 + #5266), the `@js-temporal/polyfill` bundle
advances through both `Object.fromEntries` tables and stops at position
4:10198 — `ct = Intl.DateTimeFormat`:

```
TypeError: Cannot access property on null or undefined
```

`Intl` is simply not provided. A scoped probe fails identically AFTER init
too (verified by dev-5205), so unlike #5193/#5202/#5203/#5205 this is a
**missing-global capability gap**, not the init-window timing family —
and likely a bigger piece of work.

## Direction (decide with evidence)

The polyfill needs `Intl.DateTimeFormat` (constructor + `formatToParts` /
`resolvedOptions` at minimum — measure what it actually calls) for calendar
and time-zone resolution. Options to evaluate:

1. **Host-lane import of the real host `Intl`** (the JS host has a full
   ICU-backed `Intl`) — likely the fast path: a boxed global like
   `Temporal`'s own eventual wiring, marshalled through the existing
   host-object bridges. Must work in the init window → needs the
   #5193/#5202 start-export channel for anything it reads back.
2. Minimal compiled shim covering exactly the polyfill's call surface —
   only if (1) is architecturally blocked; record why.

Keep standalone/WASI out of scope for this issue (no host Intl there —
that's a separate, much larger gap; note it, don't fix it).

Watch for the CLOSURE_UNSAFE_HOST_AMBIENTS interaction: if `Intl` becomes a
recognized ambient, re-verify the #2838 hazard the same way `Temporal`'s
entry is handled.

## Acceptance criteria

1. Reduced repro: `const f = new Intl.DateTimeFormat("en-US"); f` (and the
   polyfill's actual call shapes, measured) at init AND after init, host
   lane. New tests/issue-5206-*.test.ts failing on base, passing with fix.
2. Temporal harness advances past 4:10198 on the full stack. New later
   blocker → file it (coordinator allocates ids); `moduleInitRuns` true →
   say so LOUDLY — that un-gates the #4628 integration.
3. No regressions in the issue-5193/5202/5203/5205 test files + scoped
   runs (name them). Gates green.

## Implementation notes (2026-08-29, ttraenkler/opus-dev-5206)

### Measured Intl call surface

Grep of the linked ESM bundle (`@js-temporal/polyfill@0.5.1` + `jsbi@4.3.0`,
157,541 B): **30** `Intl` occurrences, of which 14 `Intl.DateTimeFormat`, 9
`Intl.DurationFormat`, 1 `Intl.supportedValuesOf`; the rest are error-message
strings and the `reviseIntlEra` method name.

Runs **at module init** (inside the wasm `start` section):

| offset | statement |
| --- | --- |
| 38918 | `ct = Intl.DateTimeFormat` ← the blocker, source position 4:10198 |
| 121621 | `ai = Intl.DateTimeFormat` |
| 130727 | `di.supportedLocalesOf = ai.supportedLocalesOf` |
| 130783 | `const { format, formatToParts } = Intl.DurationFormat?.prototype ?? Object.create(null)` |
| 130850 | `Intl.DurationFormat?.prototype && (Intl.DurationFormat.prototype.format = …)` |

Runs **lazily** (after init): `new ct(locale, options)` in `ht()`,
`Intl.supportedValuesOf?.("timeZone")` in `hr()`,
`new Intl.DateTimeFormat().resolvedOptions().timeZone` in `Uo()`,
`getFormatter()` / `getCalendarParts()` → `formatToParts`, and
`formatRange` / `formatRangeToParts`.

### Root cause

`Intl` is `declare namespace Intl` in `lib.es5.d.ts` — a namespace, not a
`declare var`. Every value-shaped arm in `compileIdentifierCore`
(`src/codegen/expressions/identifiers.ts`) is keyed on something `Intl` is
not (a local, a module global, a registered extern class, a declared global,
a class, a function), so the read fell through to the graceful
`ref.null.extern` default. The emitted WAT for `Intl.DateTimeFormat` was
literally `ref.null extern` followed by the null-check throw — hence "Cannot
access property on null or undefined", identically at init and after init.

### Fix

One condition on the #3087 host-global-materialization arm, which lowers a
bare ambient name to `__extern_get(__get_globalThis(), name)`. `Buffer`,
`process` and `crypto` already ride it. Both helpers are **imports**, not
module exports, so — unlike #5193/#5202/#5203/#5205 — no start-export channel
was needed: it resolves during `start` unchanged. Verified by the at-init
half of every test case.

Considered and rejected: a compiled `Intl` shim (option 2 in the direction
above). Nothing is architecturally blocked about option 1, the host `Intl` is
ICU-backed and complete, and a shim would have to reimplement calendar and
time-zone data. Standalone/WASI stay on the null default; the arm is
`!ctx.standalone && !ctx.wasi` and a test asserts neither lane gains a
`__get_globalThis` import.

**#2838 / CLOSURE_UNSAFE_HOST_AMBIENTS re-verified:** `Intl` was already in
that deny set (`src/codegen/array-methods.ts`), and the check is by
identifier TEXT and runs *before* `oracle.valueDeclarationOf`, so making
`Intl` resolvable does not change which HOF callbacks take the closure lane.
No edit needed there.

### Temporal harness (acceptance criterion 2)

Full stack (#5252+#5258+#5262+#5264+#5266 + this), ESM lane, 2026-08-29:

| tree | outcome |
| --- | --- |
| base (this branch, `identifiers.ts` reverted) | `TypeError: Cannot access property on null or undefined at 4:10198` |
| + this fix | init advances past all five top-level Intl statements; throws later with `RangeError: Invalid era data: eras are required` |

Both rows were run here, on this tree, with a host-import trace
(`.tmp/harness-trace2.mts`) rather than inherited from #5205's note — the
base row reproduces #5205's string exactly, including the position.

`moduleInitRuns` is **still false** — this clears the eighth blocker, not the
last one. Compile is clean (0 errors, 2 warnings, 1,576,404 B, validates).

**Ninth blocker — NOT an Intl or init-window bug; a general codegen scope
leak. Reduced, and it fails after init too:**

```js
function C(e, t) {
  return (function (e) { let t, n = e; return n === null ? "NULL" : "len" + n.length; })(t);
}
C("x", [1, 2]);   // native: "len2"   ·   js2wasm: "NULL"
```

An **immediately-invoked** function expression / arrow whose body declares
any binding named `X` (`var`, `let`, `const`, or a parameter) makes a bare
`X` in its own ARGUMENT LIST read as `null` — the argument is evaluated in
the callee's scope instead of the caller's. Measured matrix (`.tmp/s14.js`,
`.tmp/s15.js`):

| shape | js2wasm | native |
| --- | --- | --- |
| IIFE param `x`, inner `let t`, called `(t)` | `NULL` | `len2` |
| IIFE param `e`, inner `let q`, called `(t)` | `len2` | `len2` |
| inner `var t` / `const t` | `NULL` | `len2` |
| arrow instead of function expression | `NULL` | `len2` |
| caller binding is a `const`, not a param | `NULL` | `len3` |
| inner PARAMETER shadows (no `let`) | `NULL` | `len2` |
| argument is `t.length` rather than `t` | `undefined` | `2` |
| **function stored in a variable, then called** | `len2` | `len2` |
| **hoisted named function called normally** | `len2` | `len2` |

So the trigger is the IIFE call form specifically. Pre-existing on base
(verified by reverting only `identifiers.ts`), so it is independent of this
change. It is a **silent wrong-value** defect, not a throw, and minifiers
reuse short names constantly — every minified bundle with an IIFE is
exposed.

The polyfill's failing statement is exactly this shape —
`class GregorianBaseHelper { constructor(e, t) { … (function (e) { let t, n = e; if (0 === n.length) throw new RangeError("Invalid era data: eras are required"); … })(t) … } }`
— and a host-import trace of module init shows the IIFE receiving `Array(0)`
while `EthiopicHelper` passed a two-element era table. **One caveat, stated
because it is not yet resolved:** the reduced repro delivers `null` at that
argument, the polyfill delivers an empty host array. Same call site and same
symptom (the caller's value does not arrive), but I have not proven they are
one root cause. Reported to the coordinator for id allocation.

**Separate, wider gap noted, not fixed:** a compiled `Date` is a plain
compiled object with a `timestamp` field, not a host `Date`
(`Object.prototype.toString.call(new Date(0))` → `[object Object]`,
`JSON.stringify({d})` → `{"d":{"timestamp":null}}`). So
`formatToParts(new Date(e))` — the polyfill's `getCalendarParts` — throws
`RangeError: Invalid time value`, while `formatToParts(0)` works. That is a
compiled-`Date` ↔ host-`Date` bridging issue, not an `Intl` one, and is out
of scope here.

**Standalone/WASI Intl remains a gap by design** — there is no host `Intl`
there and this issue deliberately does not add a compiled one.

### Validation

- New `tests/issue-5206-intl-global.test.ts`: 8 cases. On base **6 failed /
  2 passed** (the two passing are the deliberate controls — user shadowing,
  and the standalone/WASI host-free assertion). With the fix: 8/8.
- No regressions across `issue-5191`, `issue-5193`, `issue-5201`,
  `issue-5202`, `issue-5203`, `issue-5204`, `issue-5205` + this file:
  **85 passed**.
- Scoped host-global / namespace runs: `issue-1058-ambient-performance-global`,
  `issue-2603-process-ambient-typing`, `issue-2929-cd-global-materialization`,
  `issue-4150-declared-global-cache`, `issue-3956-global-object-binding-aliasing`,
  `issue-3176-json-namespace-reflection`,
  `issue-3081-number-namespace-const-receiver`,
  `issue-1690b-var-shadows-module-global` — all green.
  `issue-3061-host-buffer-bytelength` has 1 failure
  (`throw[0] expected type externref, found call of type f64`) — verified
  **identical on base**, pre-existing and untouched.
- `equivalence-gate.mjs` shards 1–8, `typecheck`, `biome lint`, and the
  loc / func / coercion / oracle-ratchet / dead-export gates all green.

## Notes

- Blocker chain: #5191 → #5193 → #5201 → #5202 → #5203 → (#5204) → #5205 →
  this.
- Stack on PR #5266's branch (issue-5205-fromentries-marshal) — sanctioned
  predecessor-stacking; lands after the whole stack.
- Id #5206 reserved with a degraded PR scan (gh offline); manually verified
  against open PR head branches 2026-08-29. `check:issue-ids:against-main`
  arbitrates.
