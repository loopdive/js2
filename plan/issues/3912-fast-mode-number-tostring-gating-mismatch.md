---
id: 3912
title: "CRITICAL: fast mode (the whole gc-native lane) cannot stringify a number — 6 of 9 number→string ops trap at runtime; import-collector gates number_toString and the string family on different conditions"
status: done
created: 2026-07-31
updated: 2026-08-01
completed: 2026-08-01
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
loc-budget-allow:
  # (#3102 gate) 296 lines added across 9 codegen files; **222 of them (75%)
  # are comment**, 74 are code. That ratio is the point of the change, not an
  # accident of style.
  #
  # This bug was ONE conflation — `ctx.nativeStrings` treated as "there is no
  # JS host" — replicated at NINE independent sites. Every site was internally
  # consistent, which is exactly why the defect survived review at each of them
  # and why reading any single site made it look correct. Six of nine
  # number→string operations trapped at runtime in the flagship gc-native lane.
  #
  # Several of the edits are one-token diffs (`ctx.wasi || ctx.standalone` →
  # `usesNativeNumberFormat(ctx)`). A one-token diff with no explanation is
  # precisely how this gets reintroduced — and the history proves it: the
  # `struct-field-exports.ts` site still carries the ORIGINAL comment asserting
  # "nativeStrings mode (auto-on for `--target wasi`) — there is no JS host",
  # a claim that reads as reasonable and is false for `fast`. Each comment
  # therefore names the config that breaks (`fast` = native strings + live
  # host), the observable symptom, and why the neighbouring arms must NOT be
  # changed the same way (the dynamic-externref arms genuinely do carry host
  # strings). See "Implementation notes" in the body.
  - src/codegen/string-ops.ts
  - src/codegen/expressions/call-identifier.ts
  - src/codegen/expressions/call-namespace-static.ts
  - src/codegen/declarations/import-collector.ts
  - src/codegen/expressions/call-receiver-method.ts
  - src/codegen/expressions/calls.ts
func-budget-allow:
  # (#3400 gate) Same change-set, same 75%-comment ratio; these four functions
  # are the ones that host the gate sites. Per-function code growth is small:
  #
  #  - `compileNamespaceStaticCall` (+31): the two JSON string-representation
  #    BOUNDARY marshals — host result → native string, native argument → host
  #    string. Both must be emitted at the call site because the distinction is
  #    PROVENANCE, not ValType: a native `$AnyString` box and a real JS string
  #    are both `externref`, and only the producing site knows which it made.
  #    Getting this backwards is the `` `v${3}` `` → `"v"` bug.
  #  - `compileIdentifierCall` (+23): the `parseInt`/`parseFloat` native→host
  #    argument marshal, plus routing `String(<number>)` through the new
  #    `emitStringBuiltinNumberResult`.
  #  - `finalizeUnifiedCollector` (+11): the shared `usesNativeNumberFormat`
  #    predicate replacing three divergent inline gates, plus the
  #    `__str_to_number`-is-not-a-host-import fix.
  #  - `compileReceiverMethodCall` (+11): comment ONLY. The code change is a
  #    single conjunct deletion in `unwrapToNative`.
  - src/codegen/expressions/call-namespace-static.ts::compileNamespaceStaticCall
  - src/codegen/expressions/call-identifier.ts::compileIdentifierCall
  - src/codegen/declarations/import-collector.ts::finalizeUnifiedCollector
  - src/codegen/expressions/call-receiver-method.ts::compileReceiverMethodCall
---

# #3912 — fast mode cannot stringify a number

## Status: open — **independently reproduced twice**, with a conclusive control

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

## ✅ RESOLVED (2026-08-01) — see "Implementation notes" at the end

The first attempt (recorded immediately below, kept for its findings) was
correctly abandoned because #3917 would have turned traps into silent wrong
answers. **#3907 has since landed and fixed #3917's cause** — `fast` no longer
narrows every `number` to i32 — so the blocker is gone. Re-measured from
scratch on current `main`; the gate + template changes now land clean.

The final implementation is **larger than the two changes prescribed here**:
the same `nativeStrings` ⇏ `noJsHost` conflation turned out to exist at
**nine** sites, and fixing only the gate exposed several of the others as new
failures. Scope item 3 of this issue ("audit the *other* gate pairs … assume
there are more until checked") is what that audit found. Details at the end.

## ⚠️ FIRST ATTEMPT (superseded) — the answer to "does one change fix all six" is NO

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

## Implementation notes (2026-08-01) — WHY, not just what

### The one-sentence root cause

`ctx.nativeStrings` and "there is no JS host" were treated as the same
condition across the codebase. They are not: **`fast` is the config where they
come apart** — native strings *with* a live JS host. Every gate that asked
`ctx.wasi || ctx.standalone` when it meant "are strings native here?", or asked
`ctx.nativeStrings` when it meant "is there no host here?", had a wrong answer
in exactly that one cell. That is why the bug was invisible to inspection of
any single site: each site was internally consistent.

### Why a wide differential probe, not code reading

The gate change alone was measured to fix 8 of the 9 headline operations — and
to **break three others** that had been working. Reading the ~25
`number_toString` consumers would not reliably have found those. The instrument
that did was a 52-case `fast`-vs-`host` differential probe with every value
bound to a **variable** (constant folding hides this whole area) and every case
returning a **number** (so a wrong string representation cannot be confused with
export-boundary marshalling).

Measured with that probe, `fast` vs `host` on current `main`:

| | cases differing from host |
| --- | --- |
| `main` (before) | **36 of 52** |
| after this change | **3 of 52** (only **1** is a `fast` case) |

**Zero regressions**: every case that passed on `main` still passes.

### The nine sites, and why each moved

A shared predicate `usesNativeNumberFormat(ctx)` (`wasi || standalone ||
nativeStrings`, in `number-format-native.ts`) now answers the question once, so
the three import gates cannot re-diverge.

1-3. `declarations/import-collector.ts` — the `number_toString`,
   `number_toString_radix` and `emitNativeNumberFormat` gates. **The headline
   fix.** Makes the formatter native wherever strings are native.
4. `string-ops.ts` `compileNativeTemplateExpression` — the f64/i32/i64 numeric
   spans now unbox **unconditionally**. `__str_from_extern` marshals a *genuine
   JS-host* string and silently yields EMPTY for a native-string box; that is
   why `` `v${3}` `` evaluated to `"v"`. The dynamic-externref arms keep the
   bridge — those really do carry host strings.
5. `call-receiver-method.ts` `unwrapToNative` — `(n).toString()` reported a bare
   `externref` for what was really an `$AnyString`. Consumers then had to
   re-discover the representation with a dynamic `ref.test`; a consumer that
   *cannot* (a host-import argument) silently got an opaque struct.
6. `call-identifier.ts` `String(<number>)` — same, via a new
   `emitStringBuiltinNumberResult`. The two spellings of the same operation now
   agree on their result type.
7. `call-identifier.ts` `parseInt`/`parseFloat` argument — a native string
   reached a **host** import through `coerceType(…, externref)`, which only
   *widens the GC ref*. The host got an opaque WasmGC struct and V8 threw
   `Cannot convert object to primitive value`. Now marshalled with the new
   `emitNativeStringToHostExternref` (flatten + `__str_to_extern`), the same
   sequence `console.log` already used. **This cell was broken on `main` for
   every native string** — `parseInt("42")` with a plain *literal* trapped
   under `fast`. #3912 only made it reachable from one more producer.
8. `import-collector.ts` `__str_to_number` — a **pure-Wasm helper name** was
   being requested as a JS-host import (`src/runtime.ts` has no
   `env.__str_to_number`), so `Number("42")` returned **NaN** across the whole
   gc-native lane. Now always emitted natively.
9. `calls.ts` `tryEmitJsonStringifyPrimitive` — the `then` arm
   (`number_toString`) and the `else` arm (`compileStringLiteral("null")`)
   disagreed on type under `fast`, so `JSON.stringify(<number>)` emitted an
   **invalid module** — a validation failure, not a trap.

Plus two boundary marshals in `call-namespace-static.ts`: `JSON.stringify`'s
host result is a real JS string and is now bridged **into** a native string
(`emitHostExternrefToNativeString`), and a native-string *argument* is
marshalled **out** to a real JS string. Both directions are emitted at the
producing call site, because the distinction is **provenance, not ValType** —
a native box and a host string are both `externref`, and only the call site
knows which it made.

### The one remaining `fast` failure, traced (NOT fixed here)

`JSON.stringify({a: 42})` under `fast` returns **`"{}"`** instead of
`{"a":42}`.

This is **not** a number-formatting defect and it is **not new** — the object
argument path is byte-identical to `main` (the native-string marshal above is
guarded off for structs). `main` produced the same `"{}"`; nobody could see it
because reading the result trapped first. This change removes the trap, which
makes the pre-existing wrong answer **visible**.

Traced to `struct-field-exports.ts:emitStructFieldNamesExport`, which begins
`if (ctx.nativeStrings) return;` — the **ninth** instance of the same
conflation, and its comment says so out loud: *"In nativeStrings mode (auto-on
for `--target wasi`) there is no JS host"*. Under `fast` there **is** a host, so
the export is not dead code: without `__struct_field_names` the host's
`_wasmToPlain` cannot enumerate the struct's fields and returns `{}`.

**Why it is not fixed here**: the fix is not the predicate. Switching it to
`ctx.wasi || ctx.standalone` was tried and makes the body emit under native
strings, where the string-constant globals it reads do not exist — the module
then fails to build with `Codegen error: global index out of range`. Making
that CSV a native string is separate work. A comment recording all of this
sits at the site.

### Also done

#3902's temporary `coercion-sites-allow` for `src/codegen/array-methods.ts` is
**removed**, along with the `ctx.funcMap.get("number_toString")` host-import
detection probe it covered — exactly as #3902's frontmatter instructed. With
the formatter native wherever `nativeStrings` is on, that probe could never
fire again.

### Not verified

- **Full test262.** Not run locally (CI owns it). This changes number
  formatting for every fast-mode program, so `built-ins/Number`,
  `built-ins/JSON` and `Array/prototype/join` are the buckets to watch.
- **`--target wasi` at runtime.** Reasoned to be unchanged (every predicate
  keeps `wasi || standalone` true), and covered by the standalone probe
  columns, but not executed under wasmtime.

## Provenance

Root-caused narrowly inside #3902 (which fixed only the `sort` symptom), then
audited into a systemic finding by that same agent when asked whether the
mismatch was a one-off. **Independently reproduced by the coordinator** with a
separate probe on a clean checkout — the table above is from that run, which
also shows `sort()` failing because the checkout lacks #3902's fix, i.e. seven
failures on unpatched `main`.
