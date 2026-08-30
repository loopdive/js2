---
id: 5161
title: "nativeStrings and fast host configs throw on new Error(msg, {cause}) — opaque-struct ToPrimitive at the constructor boundary"
status: blocked
sprint: current
created: 2026-08-28
updated: 2026-08-28
priority: low
horizon: s
feasibility: medium
reasoning_effort: medium
task_type: bugfix
area: codegen
goal: core-semantics
related: [5159, 3481, 3912]
# 2026-08-28 (#5161) — the measured defect is NOT the one filed. The throw is at
# the constructor's MESSAGE slot and fires with no options at all, so the fix is
# a native-string decode in `_errorMessageToString` (+22 in `src/runtime.ts`,
# almost all of it the comment recording why the #3481 cause-2 walker contract is
# untouched) plus the bridge request at the three host Error-ctor sites in
# `tryCompileBuiltinGlobalNew` (+21, likewise mostly the measurement that shows
# the runtime half alone is insufficient). The two halves cannot be split: the
# runtime decode is a silent no-op without the exports the codegen half
# requests, which is exactly the failure mode that made the same source compile
# to a throw or not depending on unrelated module content.
loc-budget-allow:
  - src/runtime.ts
  - src/codegen/expressions/new-builtin-globals.ts
func-budget-allow:
  - src/codegen/expressions/new-builtin-globals.ts::tryCompileBuiltinGlobalNew
---

# Two host configs still throw where the default host now succeeds

Measured during #5159 (PR #5169) via file-copy A/B — **pre-existing**,
identical before and after that fix:

| host config | `new Error("m", {cause: c})` |
| --- | --- |
| default | works (fixed by #5169: `e.cause === c`) |
| `nativeStrings` | **TypeError: Cannot convert object to primitive value** |
| `fast` | **TypeError: Cannot convert object to primitive value** |

Same defect class as #3481 cause-2 (fixed for the default host in PR #5161's
`_errorMessageToString`): a WasmGC struct crosses the host boundary opaquely
and V8's own coercion cannot introspect it. In these two configs the throw
happens before #5159's `__error_install_cause` companion can run, so the whole
construction fails rather than merely dropping `cause`.

Start by measuring WHICH boundary throws in each config (the ctor's message
slot, the options slot, or the companion import) — the two configs may differ.
The #3481 cause-2 record (`plan/issues/3481-bigint-symbol-coercion-value-rep.md`)
and the #5159 resolution record document the walker rules
(`_hostToPrimitive` "found nothing" sentinels, the refused-NUMBER rule) any fix
must not violate.

## Acceptance criteria

- `new Error("m", {cause: c}).cause === c` in `nativeStrings` and `fast`
  configs; the #5159 (30) and #3481 cause-2 (37) suites stay green.
- Byte-identity for option-less Error constructions in all configs.
- A/B with base at first edit; pinned tests red on base; equivalence clean.

---

# Resolution (2026-08-28) — partial: the throw is fixed, `cause` is blocked

## The mandated boundary measurement contradicts the issue's premise

The issue asks which of three boundaries throws — the message slot, the options
slot, or the `__error_install_cause` companion. **Measured: it is the message
slot, and the options bag is not involved at all.** Instrumenting each host
import on `origin/main` 02b050f8f0 (`.tmp/probe-boundary.mts`):

| config | shape | boundary reached | outcome |
| --- | --- | --- | --- |
| default | `new Error("m", {cause})` | `__new_Error` → `__error_install_cause` | both OK, `cause` installed |
| default | `new Error("m")` | `__new_Error` | OK |
| `nativeStrings` | `new Error("m", {cause})` | `__new_Error` | **THROWS**, companion never entered |
| `nativeStrings` | `new Error("m")` | `__new_Error` | **THROWS** |
| `fast` | `new Error("m", {cause})` | `__new_Error` | **THROWS**, companion never entered |
| `fast` | `new Error("m")` | `__new_Error` | **THROWS** |

The two configs do **not** differ — `fast` implies `nativeStrings`
(`src/index.ts`, "Enabled automatically when fast: true"), so there is one
defect, not two. And the last row is the finding that reframes the issue: the
**option-less** `new Error("m")` throws just as hard. `{cause}` was never the
trigger; it was collateral, and this issue's title attributes the failure to a
mechanism (the options bag) that the measurement clears.

## Root cause

In these lanes a string literal is a WasmGC `array i16` carrier, not a host
string, so `_errorMessageToString` received a struct that HOLDS a string. Both
#3481 cause-2 walkers hunt for coercion methods, find none on a string carrier,
and bottom out into the pre-existing TypeError. Measured directly
(`.tmp/probe-msgvalue.mts`): the value at the boundary answers
`__str_is_native → 1` and `__str_to_extern → "m"`, i.e. the module could always
have told the host what it was.

## The fix — two halves, neither sufficient alone

1. **`src/runtime.ts`** — `_errorMessageToString` decodes a native-string
   carrier via the existing `_nativeStringToHost` (the module's own
   `__str_is_native` / `__str_to_extern` discriminator) **before** either walker
   runs. §7.1.1 step 1 returns a String argument unchanged, so a value the
   module itself certifies as a string never reaches ToPrimitive: the "found
   nothing" sentinels, the commit-to-a-returning-walker rule and the
   refused-NUMBER rule are all unreached and unmodified. The default lane does
   not export the discriminator, so it misses and behaves exactly as before.
2. **`src/codegen/expressions/new-builtin-globals.ts`** — requests that bridge
   (`ensureNativeStringBoundaryBridge`, an existing helper) at the three host
   Error-ctor sites: plain Error family, `AggregateError`, `SuppressedError`.

**Why half 2 is load-bearing, measured rather than assumed.** Those exports are
otherwise emitted only when some *unrelated* part of the module needs them.
With the runtime half alone (`.tmp/probe-exports.mts`):

| module | `__str_is_native` / `__str_to_extern` | `new Error("m")` |
| --- | --- | --- |
| `... return String(e.message);` | present | works |
| `const e = new Error("m"); return 1;` | **absent** | still throws |
| `throw new Error("m");` | **absent** | still throws |

The same source, two outcomes, decided by content that has nothing to do with
the Error. A runtime-only fix would have shipped as a silent coin-flip.

## Measured A/B — host-observed, file-copy on the same worktree

Base copies were taken at the first edit (`git show HEAD:src/runtime.ts` etc.).
Every observation is made **host-side** (the module throws, the host inspects
the caught object) because reading a property back into wasm is independently
broken in these lanes — see the blocker below; an in-wasm assertion would have
measured that defect instead of this one.

| row | default base→fix | nativeStrings base→fix | fast base→fix |
| --- | --- | --- | --- |
| `throw new Error("m")` | `Error:"m"` → same | **TypeError** → `Error:"m"` | **TypeError** → `Error:"m"` |
| `throw new TypeError("tm")` | `TypeError:"tm"` → same | **TypeError** → `TypeError:"tm"` | **TypeError** → `TypeError:"tm"` |
| `throw new RangeError("rm")` | unchanged | **TypeError** → `RangeError:"rm"` | **TypeError** → `RangeError:"rm"` |
| `throw new SyntaxError("sm")` | unchanged | **TypeError** → `SyntaxError:"sm"` | **TypeError** → `SyntaxError:"sm"` |
| `throw new AggregateError([], "am")` | unchanged | **TypeError** → `AggregateError:"am"` | **TypeError** → `AggregateError:"am"` |
| `throw new Error(a + "b")` (computed) | unchanged | **TypeError** → `Error:"ab"` | **TypeError** → `Error:"ab"` |
| construct only, never thrown | reached | **TypeError** → reached | **TypeError** → reached |
| `throw new Error("om", {cause})` → message | `Error:"om"` → same | **TypeError** → `Error:"om"` | **TypeError** → `Error:"om"` |
| `throw new Error()` (no message) | `Error:""` → same | `Error:""` → same | `Error:""` → same |
| `throw new Error({toString})` | `Error:"TS"` → same | TypeError → **TypeError (unchanged)** | TypeError → **TypeError (unchanged)** |
| `throw new Error("om", {cause})` → `hasOwn(cause)` | `true` → same | `false` → **`false` (unchanged)** | `false` → **`false` (unchanged)** |

**8 of 11 rows repaired in each native lane; 0 of 11 changed in the default
lane.** The two unrepaired rows are the residuals below.

## Byte-identity — 186 rows, per-row sha256, both sides run here

62 shapes × 3 configs: the seven intrinsic Error ctors × {string literal,
thrown, no-arg, numeric, `undefined`, computed, variable}, `AggregateError`
with and without a message, the eight option-ful `{cause}` twins, plus two
controls that construct no Error at all.

| lane | rows | byte-identical |
| --- | --- | --- |
| **default** | 62 | **62 / 62 (0 changed)** — option-less *and* option-ful |
| `nativeStrings` | 62 | 2 / 62 (the two no-Error controls) |
| `fast` | 62 | 2 / 62 (the two no-Error controls) |

**This deviates from the acceptance criterion as written, deliberately, and the
criterion is the thing that is wrong.** It asks for byte-identity on option-less
Error constructions *in all configs*. In the two fixed lanes the option-less
construction **is the defect** — it threw — so its bytes must move; the criterion
was written on the premise that only option-ful shapes were broken, which the
boundary measurement above disproves. Byte-identity is held exactly where it is
still meaningful: the default lane, in full.

## Tests

`tests/issue-5161-native-string-error-message.test.ts` — 45 cases: the seven
intrinsic ctors × 3 configs, `AggregateError`, computed and variable messages,
construct-without-throw (the shape that pins why the codegen half is needed),
the absent-message row, and the message surviving alongside an options bag.
The two residuals are pinned as **current** behaviour with their reason inline,
so whoever closes them sees these lines go red rather than finding them untested.

- **Non-vacuity: 24 of 45 fail against base**, 45 / 45 pass with the change.
- **#5159 (30) and #3481 cause-2 (37): 67 / 67 green.**

## Gates

`typecheck` · `lint` · `prettier --check` · `check:loc-budget` (also with
`LOC_GATE_BASE=origin/main`) · `check:func-budget` (ditto) ·
`check:coercion-sites` · `check:oracle-ratchet` · `check:dead-exports` ·
`check:host-import-policy` · 8/8 equivalence shards.

**No host import was added.** `plan/audit/host-import-policy-baseline.json` is
ratcheted to the exact measured line count, per the precedent in the #3481
record. Both sides run here — only the one line count moves:

| metric | base | new |
| --- | --- | --- |
| `runtimeTsLines` | 18707 | 18729 (+22) |
| `resolveImportLines` | 7642 | 7642 |
| `resolveImportCases` | 15 | 15 |
| `ownedAdapterLines` | 792 | 792 |
| `explicitCapabilityLines` | 1194 | 1194 |
| native-first `imports` | 394 | **394** |
| native-first `legacySemanticImports` | 0 | 0 |

`imports` holding at 394 is the load-bearing row: the fix reuses the module's
existing `__str_is_native` / `__str_to_extern` bridge, so the standalone /
native-first surface is untouched and the dual-mode rule needs no new fallback.

## Why this issue is `blocked`, not `done`

Its stated goal — `new Error("m", {cause: c}).cause === c` in these lanes — is
**not reached, and cannot be reached from the Error code at all.** Two
independent boundaries stand in the way, both measured here and both larger
than this issue:

1. **`cause` cannot be read off the options bag.** `_installErrorCause` answers
   HasProperty via `__struct_field_names`, which native-string lanes
   deliberately do not emit — the export's body reads string-constant globals
   that do not exist there, and `emitStructFieldNamesExport` already records
   this as a known gap needing separate work (#3912). The obvious fallback is
   unusable: measured on a single-shape module, `__sget_cause` answers `null`
   under `fast` **even for a struct that has the field**, and `__sget_k` answers
   `0` for a struct that does not — so it is not a sound presence oracle.
2. **Reading any property off a genuine host object is broken in these lanes.**
   Not Error-specific — measured on a plain host object handed to the module
   (`.tmp/probe-hostprop2.mts`):

   | expression | default | nativeStrings | fast |
   | --- | --- | --- | --- |
   | `typeof o.s` | `"string"` | `null` | **`illegal cast`** |
   | `typeof o.n` | `"number"` | `null` | **`illegal cast`** |
   | `(o.n as number) === 42` | `true` | `false` | `false` |
   | `o.self` reaching the host as the same reference | `true` | `false` | `false` |

   So even with `cause` installed, `e.cause === c` evaluated *inside* wasm
   cannot succeed. This was confirmed rather than reasoned: a throwaway
   `__sget_cause` fallback that did install `cause` under `nativeStrings` still
   left `e.cause === c` reading `DIFFERENT`.

**Follow-ups needed (ids to be allocated by `claim-issue.mjs --allocate`, not
hand-picked):** one for the #3912 `__struct_field_names` gap in native-string
lanes, one for the host-object property-read boundary in the same lanes. This
issue should stay open against the second half of its acceptance criteria until
those land.

## Also observed, recorded not fixed

Adjacent native-lane defects surfaced by the same sweep, none touched here:

- `new Error()` / `new Error(undefined)` **trap with `illegal cast`** when the
  result is used in wasm (the `ref.null.extern` absent-message path).
- `new Error(42)` / `new Error(true)` / `new Error(null)` read back a `null`
  message in wasm — the same host-property-read boundary as above.
- Under `fast`, an Error returned from an export does not arrive host-side as an
  `Error` at all (`e instanceof Error === false`), while the same module's
  *thrown* error does.
- An **object** message (`{toString(){…}}`) still throws in these lanes: that
  needs the compiled module's own method dispatch, a different boundary from the
  native-string decode fixed here.
