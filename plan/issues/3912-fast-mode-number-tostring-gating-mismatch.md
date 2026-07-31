---
id: 3912
title: "CRITICAL: fast mode (the whole gc-native lane) cannot stringify a number — 6 of 9 number→string ops trap at runtime; import-collector gates number_toString and the string family on different conditions"
status: in-progress
created: 2026-07-31
updated: 2026-07-31
priority: critical
feasibility: medium
reasoning_effort: max
task_type: bug
area: codegen
language_feature: number-to-string
goal: performance
sprint: current
horizon: l
es_edition: multi
related: [3902, 3904, 3909, 3907, 3917]
---

# #3912 — fast mode cannot stringify a number

## Status: IMPLEMENTED — 8 of 9 operations pass; see "Implementation (landed on branch)" below

The prescribed fix is implemented and measured. Read
**"Implementation (landed on branch)"** near the end before anything else in
this file — several statements above it were written before the root cause of
the *remaining* failures was known, and are corrected there.

## Problem

In `fast: true` — which is the **entire gc-native lane**, the flagship
"no host calls" mode — most number→string operations **trap at runtime** on
`main` today.

Measured on `main` (`.tmp/verify-gating.mts`, each case returns a **number** so
it cannot be confounded by fast-mode string marshalling):

| operation | `fast: true` | `fast: true, target: "standalone"` |
| --- | --- | --- |
| `(3).toString()` | **dereferencing a null pointer** | ok |
| `String(n)` | **dereferencing a null pointer** | ok |
| `n.toFixed(2)` | **dereferencing a null pointer** | ok |
| `n.toString(16)` | **dereferencing a null pointer** | ok |
| `JSON.stringify({a: 42})` | **dereferencing a null pointer** | ok |
| `[1,22,333].join(",")` | **illegal cast** | ok |
| `` `v${n}` `` template literal | ok | ok |
| `"v" + n` | ok | ok |
| `[10,9,1].sort()` | **illegal cast** (fixed by #3902) | ok |

## Observed vs. inferred — read this before designing the fix

An earlier revision of this issue presented a tidy 2×2 matrix labelled by
`nativeStrings` state and `number_toString` provider, and concluded the fix
direction was "settled". **That overstated the evidence.** The outcomes were
measured; the *labels* on the cells were inferred from reading the gating code.
Separating them changes what an implementer may assume.

### Observed (measured, three independent reproductions)

| mode | 6 number→string ops | control `1+1` |
| --- | --- | --- |
| `host-call` (`fast: false`) | **6/6 ok** | ok |
| `fast: true` | **6/6 FAIL** | ok |
| `fast: true, target: "standalone"` | **6/6 ok** | ok |

Also observed, by inspecting the compiled module's imports per mode
(`.tmp/verify-wiring.mts`) rather than by reading the gates:

| mode | `number_toString` |
| --- | --- |
| `host-call` | **host import** |
| `fast` | **host import** |
| `standalone` | **native** |

### What that actually implies — and the problem it creates

`host-call` and `fast` **both** use the host `number_toString`, yet host-call
passes 6/6 and fast fails 6/6. So the host provider **cannot on its own** be
the cause. Something else differs between those two modes, and the obvious
candidate is the string representation — but that is where the evidence stops.

### The labels are now OBSERVED too — read off the emitted WAT

The remaining gap was closed by dumping the module for each config and reading
the provider and string backend directly out of the WAT, rather than inferring
them from the gating code. Reproduced independently twice
(`.tmp/verify-wat.mts`, and `.tmp/probe-matrix-labels.mts` in the #3902
worktree):

| config | `number_toString` | native `__str_` helpers |
| --- | --- | --- |
| `host-call` | **HOST IMPORT** | **absent** |
| `fast` (gc-native) | **HOST IMPORT** | **present** (incl. `__str_compare`) |
| `standalone` | **DEFINED (native)** | **present** |

Note why an imports-only probe cannot see this: the native string helpers are
**defined functions, not imports**, so their absence from the imports object is
expected and proves nothing. The WAT is the right instrument.

The mechanism now reads straight off the table:

- `host-call` — consistent **host** provider + **host** strings → passes
- `standalone` — consistent **native** provider + **native** strings → passes
- `fast` — the **only** config pairing a **host** provider with **native**
  strings → the only mismatched one, and the only failing one

There is no fourth reachable config.

**Consequence for the fix**: making `number_toString` native whenever
`ctx.nativeStrings` is on converts the `fast` row into the `standalone` row,
and the `standalone` row is empirically a working end-to-end reference for all
six operations. It is also feasible today — a native path already exists
(`emitNativeNumberFormat` at
`src/codegen/expressions/new-builtin-globals.ts:281` and
`src/stdlib/number-format.ts`, whose comment says it mirrors the deleted
hand-written `number_toString_radix` step for step).

Still requires the full conformance run in the scope list — this changes number
formatting for every fast-mode program.

## Root cause

`src/codegen/declarations/import-collector.ts`, finalize block (~L1378-1446):

- the **number-formatting** family is gated on `ctx.wasi || ctx.standalone`
  (L1382, L1393, L1414)
- the **string** family is gated on `ctx.nativeStrings` (L1442, L1525)

`fast: true` sets `nativeStrings` but **neither** `wasi` nor `standalone`. So
fast mode gets native string helpers alongside a **host** `number_toString`
that disagrees with them about representation.

Each family's gates are internally consistent, which is why this reads as fine
when inspecting either one alone. The bug lives *between* the two families.

## Why it survived this long — it was invisible, not red

Every one of these is a **runtime trap on a module that compiles and
instantiates cleanly**. That is exactly the `failedPhase: "warmup"` shape that
`benchmarks/harness.ts` silently converted into a **missing bar** rather than a
failure (see #3904, which fixes the swallowing). So a correctness hole in the
headline lane showed up on the public performance page as *nothing at all*.

It also means any gc-native benchmark touching number formatting was either
absent from the page or quietly written to avoid the surface.

## Two signatures, probably one cause — confirm before designing the fix

- `illegal cast` (`join`, and `sort` before #3902): representation
  disagreement, **verified in the WAT** by the #3902 agent.
- `dereferencing a null pointer` (the other five): **not traced to an
  instruction. No current lead.**

  ⚠️ **A previously-recorded hypothesis here has been RETRACTED — do not chase
  it.** An earlier revision suggested `emitNativeNumberFormat`'s
  `!ctx.funcMap.has("number_toString")` early-return skips emitting the native
  formatter's support structures (`__num_fmt_finalize`, the buffer globals).
  That is **wrong**: `ensureNativeStringHelpers` and `emitFinalize` are called
  **unconditionally** at the top of that function (L376-377), *before* any
  `funcMap.has` guard. Whatever produces the null deref is downstream of that.
  The retraction came from the agent who originally proposed it. It is recorded
  here rather than deleted, because the hypothesis circulated in three
  escalation messages and someone may otherwise re-derive it and go to the
  wrong line.

**Why the split still matters.** Five cases give one signature and `join` gives
another. Until that is explained, it is unknown whether one change fixes all
six or whether there are two independent bugs. Settle this before designing the
fix.

## ⚠️ IMPLEMENTATION ATTEMPTED — the answer to "does one change fix all six" is NO

The prescribed fix was implemented and measured. **It is not landable on its
own, and #3917 now blocks it.** Findings, so the next person starts here
instead of repeating the work:

### The gate change is correct and does most of the job

Extending the number-format gate in `import-collector.ts` from
`ctx.wasi || ctx.standalone` to also include `ctx.nativeStrings` (one named
predicate, used at the three sites: the `number_toString` gate, the
`number_toString_radix` gate, and the `emitNativeNumberFormat` block) takes
`fast: true` from **3 of 9 passing to 8 of 9**.

Fixed by the gate change alone: `(3).toString()`, `String(n)`,
`n.toString(16)`, `[1,22,333].join(",")`.

### It also needs an accompanying consumer fix, or it regresses templates

The gate change alone makes `` `v${3}` `` evaluate to **`"v"`** — the
interpolated number contributes nothing.

Cause, read off the emitted WAT. In `compileNativeTemplateExpression`
(`src/codegen/string-ops.ts`), the numeric spans choose their bridge on
`standaloneNativeStrings = noJsHost(ctx)`:

```
standalone:  number_toString → any.convert_extern; ref.cast → __str_concat
fast:        number_toString → __str_from_extern          → __str_concat
```

`__str_from_extern` marshals a genuine JS-host string via `__str_from_mem`. The
native formatter returns a native string *boxed* as an externref, and the
bridge silently yields **empty** for that box. The condition is wrong: it asks
"is a JS host available" when the real question is "did this externref come
from the native formatter". Since this is the **native-strings** template
compiler and #3912 makes `number_toString` native in every mode there, the
three numeric branches (f64/i32/i64) should use `emitNativeStringRefFromExternref`
**unconditionally**. The dynamic-externref branches below them keep the bridge,
correctly — those really are host strings.

With both changes, templates are correct again and match standalone exactly.

### What still fails, and why it blocks

Two operations remain wrong under `fast` with both changes applied:

- `JSON.stringify({a: 42})` — still `dereferencing a null pointer`
- `n.toFixed(2)` — returns **`"3.00"`** for `3.14159`
- and `` `v${3.5}` `` returns `"v3"`

These are **not** caused by the gate change. They are #3917: the native
formatter truncates non-integers whenever `fast` is set, which is already wrong
on `main` today for `standalone + fast` and `wasi + fast`. The gate change
merely routes plain `fast` onto that broken path.

**So applying #3912 alone converts loud traps into silent wrong answers.** That
is a regression in kind, and it is why the change was NOT committed. The
working tree was restored to pristine via file copy and verified clean.

**Sequence: fix #3917 first, then land #3912's gate + template changes
together.**

### Beware: constant folding masks the remaining failures

`String(3.5)` as a *literal* folds at compile time and returns the correct
`"3.5"`. Only a variable (`const n = 3.5; String(n)`) reaches the runtime
formatter. A 12-case formatting matrix run during this work reported all-pass —
including `1e21`, `1e-7` and `0.1+0.2` — purely because every case was a
literal. Bind to variables when testing this area.

## Scope

1. Trace the null-pointer signature to an instruction and confirm or kill the
   `emitNativeNumberFormat` hypothesis.
2. The likely fix — make `number_toString` native whenever `ctx.nativeStrings`
   — was explicitly **deferred out of #3902** because it changes number
   formatting for every fast-mode program and needs its own conformance run.
   That deferral was correct; this issue is where it gets done properly.
3. Audit the *other* gate pairs in the finalize block for the same
   between-family mismatch. Two families disagreeing was found by accident;
   assume there are more until checked.
4. Full test262 conformance run — number formatting is spec-dense
   (`toFixed`, `toString(radix)`, `JSON.stringify`) and this changes it for
   every fast-mode program.

## Acceptance criteria

1. All nine operations pass under `fast: true`.
2. The null-pointer root cause is stated as a traced fact, not a hypothesis.
3. A regression test covers all nine shapes in both `fast` and `standalone`.
4. The gate audit reports how many other between-family mismatches exist.
5. No test262 regression in `built-ins/Number`, `built-ins/JSON`, or
   `built-ins/Array/prototype/join`.

## Do NOT conflate with #3909

Surface similarity is misleading here. All six failures in this issue are
**runtime** traps on modules that **validate cleanly**. #3909's
`__str_trimStart` is a **validation** failure — a different phase.

#3909's "only fails when `JSON.stringify` + regex + case conversion coexist" is
the signature of the late-import **index-shift** family: enough late
registrations are needed before indices actually move, which is precisely why
it takes three features to trigger. The #3902 agent hit that hazard directly
and had to order `flushLateImportShifts` before reading `funcMap`; there is a
pre-existing comment on the `__extern_toString` path in `array-methods.ts`
saying the same.

**Cheap discriminator:** validation-time failure ⇒ index shift (#3909);
runtime trap ⇒ representation mismatch (this issue).

## Implementation (landed on branch `issue-3917-fast-native-number-format`)

Base: `claude/performance-benchmark-optimization-4ebyuz` @ `30c88194`. Two
changes, exactly as prescribed. Result under `fast: true`: **3 of 9 → 8 of 9**.

### (a) The gate — one predicate for both families

New `usesNativeNumberFormat(ctx)` in `src/codegen/number-format-native.ts`
(`ctx.wasi || ctx.standalone || ctx.nativeStrings`), consumed at all three
number-format sites in `collectPrimitiveMethodImports`'s finalize block
(`src/codegen/declarations/import-collector.ts`): the `number_toString` gate,
the `number_toString_radix` gate, and the `emitNativeNumberFormat` block. One
predicate, so the two families can never drift apart again.

The disjunction is spelled out rather than reduced to bare `ctx.nativeStrings`
on purpose: `wasi`/`standalone` only *default* `nativeStrings` on
(`options?.nativeStrings ?? …` in `create-context.ts`), so
`{ standalone: true, nativeStrings: false }` is expressible and must still get
the native formatter — it has no JS host at all. Standalone/WASI behaviour is
therefore byte-identical; only the previously-missing `nativeStrings` cell moves.

### (b) The consumer — templates must not use the host bridge

In `compileNativeTemplateExpression` (`src/codegen/string-ops.ts`) the three
numeric span arms (f64 / i32 / i64) now call `emitNativeStringRefFromExternref`
**unconditionally** instead of choosing on `standaloneNativeStrings`. The
dynamic-externref and struct arms below keep `__str_from_extern` — those really
do carry host strings.

Without (b), (a) alone makes `` `v${3}` `` evaluate to `"v"`: the native
formatter returns a `$AnyString` merely widened by `extern.convert_any`, and
`__str_from_extern` (which marshals a genuine JS string via `__str_from_mem`)
silently yields EMPTY for that box. The old condition asked "is a JS host
available?" when the deciding question is "did this externref come from the
native formatter?".

**Host-import effect, measured.** `` `v${n}` `` in `fast` goes from 6 imports to
5 — `env.number_toString` is gone, everything else unchanged; `standalone` stays
at 0 and `host` stays at 6 (still `env.number_toString`, i.e. the gate widened
rather than inverted). Strictly fewer host calls in the "no host calls" lane.

**Follow-up left on the table (not a regression, pre-existing).** The bridge
setup a few lines above the span loop still keys on
`hasNonStringSpan && !standaloneNativeStrings`, so a `fast` template whose only
non-string spans are numeric still registers `__str_from_mem` / `__str_to_mem` /
`__str_extern_len` even though no arm calls them any more. Those three imports
were already there before this change (the numeric arm used to call them —
wrongly), so this is dead weight rather than new leakage. Narrowing that
condition to "has a span that actually needs the bridge" is a separate, safe
tidy-up worth doing while touching this function again.

### Measured result

Nine operations, all integer-valued, all bound to `const` variables, all
returning a number (`.length` / `.charCodeAt`):

| operation | host | fast | standalone | standalone+fast |
| --- | --- | --- | --- | --- |
| `n.toString()` | ok | **ok** | ok | ok |
| `String(n)` | ok | **ok** | ok | ok |
| `n.toFixed(2)` | ok | **ok** | ok | ok |
| `n.toString(16)` | ok | **ok** | ok | ok |
| `[1,22,333].join(",")` | ok | **ok** | ok | ok |
| `` `v${n}` `` | ok | **ok** | ok | ok |
| `"v" + n` | ok | ok | ok | ok |
| `[10,9,1].sort()` | ok | **ok** | ok | ok |
| `JSON.stringify({a:42})` | ok | **TRAP** | **"null"** | **"null"** |

Bold = changed by this fix, except `JSON.stringify`, which is unchanged (below).
Regression test: `tests/issue-3912-fast-number-stringify.test.ts` (37 cases).

### Behaviour change to be aware of: fast mode now uses the native formatter

`fast` modules now get the WasmGC `number_toFixed` / `toPrecision` /
`toExponential` instead of the host's. `number-format-native.ts`'s own header
documents a precision limit — digit extraction is f64, so results are exact to
~15-16 significant decimal digits, and V8's bignum expansion of the exact binary
value (`(7.7).toFixed(20)` → `"7.70000000000000017764"`) is NOT reproduced.
Standalone/WASI already accept that; fast mode now does too.

Measured, integer receivers (the only ones readable until #3907 lands), host vs
fast vs standalone — **no divergence**:

| expression | all three | node |
| --- | --- | --- |
| `(7).toFixed(20)` | `7.00000000000000000000` | same |
| `(123).toPrecision(18)` | `123.000000000000000` | same |
| `(1234).toExponential(15)` | `1.234000000000000e+3` | same |

The deep-fractional-digit case that WOULD diverge cannot be tested under `fast`
today: `const n = 7.7` truncates to `7` at its binding (#3907), so the input
never reaches the formatter. Re-check it when #3907 lands. This is a known,
bounded consequence of representation consistency, not a surprise.

### CORRECTION to "Two signatures, probably one cause"

That section asked whether one change fixes all six. **It does — for the five
number-format signatures.** `join`'s `illegal cast` and the four
`dereferencing a null pointer` cases in the number family were the *same*
host-provider/native-consumer mismatch presenting differently depending on
whether the consumer cast the box (illegal cast) or guarded the cast and
dereferenced the guard's null fallback (null deref). The gate change fixes both.

`JSON.stringify` is not one of them — see below.

### `JSON.stringify` is a THIRD bug, not this one

Measured **byte-identically before and after** this change (same trap, same
message, every shape), so it is neither caused nor cured here. It is not #3907
either — `{a: 42}` is integer-only, so i32 narrowing cannot explain it.

It is the same *class* as this issue (a between-family gate mismatch) in a
*different family*: `src/codegen/expressions/call-namespace-static.ts` gates the
native JSON codec on `ctx.standalone || ctx.wasi`, so a `fast` module gets the
HOST `env.JSON_stringify` — a real JS string — while its native-strings
consumers expect a `$AnyString`. Traced to the instruction, from the emitted WAT
of `const o = {a:42}; const s = JSON.stringify(o); return s.length;` under
`fast`:

```wat
call $JSON_stringify              ;; host import -> externref (a real JS string)
any.convert_extern
local.tee 3
ref.test (ref $AnyString)         ;; 0 — it is a host string, not a native one
(if (result (ref null $AnyString))
  (then local.get 3  ref.cast null (ref null $AnyString))
  (else ref.null $AnyString))     ;; <- TAKEN
local.tee 1
struct.get $AnyString 0           ;; <- TRAPS: dereferencing a null pointer
```

**A second, independent JSON defect surfaced while measuring it**, and it is
masked by the same constant-folding trap as #3917: under `standalone` and
`wasi`, `JSON.stringify({a: 42})` written INLINE folds statically and yields the
correct `{"a":42}`, but through a **variable** —
`const o = {a: 42}; JSON.stringify(o)` — it yields **`"null"`**. Same for
`{a: 1, b: 2}` and `{a: "x"}`. That is a silent wrong answer in the standalone
lane on `main` today, unrelated to `fast`. Both need their own issue ids.

### Gate audit (acceptance criterion 4)

Between-family mismatches found so far: **two**.

1. number-format vs string — this issue, fixed.
2. JSON codec vs string — open, described above.

`string_compare` (`import-collector.ts`, same block) already keys on
`ctx.nativeStrings` and is consistent. The audit is not exhaustive: it covered
the finalize block plus every `ctx.standalone || ctx.wasi` gate reachable from a
number→string operation. A systematic sweep of all `wasi || standalone` gates
against their consumers' `nativeStrings` assumptions is worth its own task.

### What is verified, on what base, and what is NOT

Verified on this branch (base `30c88194`, which does NOT contain #3907's fix):

- the 8 integer-valued operations above, in `fast`, `standalone` and
  `standalone+fast`;
- `fast` imports no `env.number_*` formatter; `host` still imports
  `env.number_toString` (the gate widened, it did not invert);
- `tests/issue-3912-fast-number-stringify.test.ts` — 37/37;
- 17 further local test files chosen because they are the ones this change can
  reach — `native-strings`, `native-strings-standalone`, `issue-1537`,
  `issue-1321-standalone`, `issue-1335-standalone`, `issue-2163-tostring-standalone`,
  `issue-2176-template-literal-interp`, `issue-2510-tagged-template-standalone`,
  `issue-2195-js-mode-template-process`, `issue-1342-json`,
  `issue-1636-json-stringify`, `issue-2671-json-replacer`,
  `issue-2097-standalone-highwater` (the host-import floor), `issue-1471`,
  `issue-1776`, `issue-2058-any-plus-string`,
  `issue-2029-tagged-template-capture-local-index`. **258 pass, 1 fail**, and
  that one (`issue-1776 › preserves object reference identity in dynamic
  equality (standalone)`) fails identically on pristine `HEAD` — A/B'd on the
  same checkout by restoring the three source files from `git show HEAD:` and
  re-running. Pre-existing, not this change.
- repo gates: tsc, prettier, biome lint, func-budget, loc-budget,
  oracle-ratchet, coercion-sites, pushraw, stack-balance.

**Why that file list and not a blanket suite run:** the configuration this
change can affect is exactly `nativeStrings && !standalone && !wasi` — i.e.
`fast`, or an explicit `nativeStrings: true`. Standalone/WASI take the identical
`standaloneNativeStrings` branch they took before and see an unchanged predicate;
host mode never enters `compileNativeTemplateExpression` at all. So the blast
radius is one configuration, and the files above are the ones that exercise it.

NOT verified here, deliberately:

- **non-integer** formatting (`String(3.5)`, `` `v${3.5}` ``, `(3.14159).toFixed(2)`)
  under `fast`. Those are still wrong on this branch and this fix cannot make
  them right: `mapTsTypeToWasm` lowers every `number` to i32 under `fast`, so
  the value is truncated at its BINDING, before any formatter runs. That is
  #3907 (and #3917, which is the same defect seen through the formatter). The
  9-operation table must be re-run on top of #3907 with non-integer values.
- test262 `built-ins/Number` / `built-ins/JSON` — not runnable locally at this
  scale; left to the merge-queue re-validation.

## Provenance

Root-caused narrowly inside #3902 (which fixed only the `sort` symptom), then
audited into a systemic finding by that same agent when asked whether the
mismatch was a one-off. **Independently reproduced by the coordinator** with a
separate probe on a clean checkout — the table above is from that run, which
also shows `sort()` failing because the checkout lacks #3902's fix, i.e. seven
failures on unpatched `main`.
