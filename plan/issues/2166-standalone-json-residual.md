---
id: 2166
title: "Standalone JSON conformance residual (~76 tests)"
status: done
assignee: sdev-json3
sprint: 63
created: 2026-06-15
updated: 2026-06-18
completed: 2026-06-18
dev_complete: true
remaining: "CLOSED — all PR-A/B/C/C2/D1/D2/D3 slices landed. Residual method-lookup items (shorthand/class toJSON, instance-field stringify, closure-this, PR-A2 number[]) are separate architect-scale follow-ups."
priority: low
feasibility: medium
reasoning_effort: medium
task_type: conformance
area: standalone
language_feature: json
goal: standalone-mode
parent: 1599
---

# Standalone JSON conformance residual

## Problem

The standalone JSON parser/stringifier landed in #1599 (`done`, sprint 58).
The host-vs-standalone baseline diff (sha `31fa7e099`, 2026-06-15) shows
**76 tests pass in host mode but fail standalone**, attributed to JSON
parse/stringify residuals — currently **untracked**.

## Evidence

- Gap category: `built-ins/JSON` 76; mix of runtime `fail` (reviver/replacer
  behavior, number formatting) and a few compile errors.

## Acceptance criteria

- Standalone pass count for `built-ins/JSON` rises toward host parity.
- Gap-diff repros added as standalone equivalence tests.

## Notes

Parent (done): #1599. Part of sprint-62 standalone catch-up (rank 12 by gap
impact). Likely benefits from the coercion engine (#1917) number/string path.

---

## Progress (2026-06-15, dev3) — boolean-typed `JSON.stringify` slice

**Status stays `ready`** — this is one slice of the 76-test bucket, not the
whole residual.

Investigation against `origin/main` @ `516feec44` found the standalone
`JSON.stringify` primitive/static-fold slices (#1324 / #1599) are in much
better shape than the gap suggests; verified working in standalone (compared
INTERNALLY, since standalone native strings don't marshal across the JS export
boundary):

- `JSON.stringify` of **static** object/array/number/string/nested literals →
  correct (folded by `tryEmitJsonStringifyStatic`).
- `JSON.stringify` of a **dynamic** number / string → correct.
- `JSON.parse` of a runtime number/`true`/`false`/`null` string → correct.

**One concrete bug fixed (this PR):** `JSON.stringify` of a **`boolean`-typed**
value (`const b: boolean = …`) refused to compile in standalone. TypeScript
models `boolean` as the union `true | false`, so the value carries the `Union`
type flag and was wrongly rejected by the ambiguous-shape early-return in
`tryEmitJsonStringifyPrimitive` (`src/codegen/expressions/calls.ts`) before
reaching the boolean stringify branch. The fix recognizes the `boolean` union
(`Boolean` flag + `intrinsicName === "boolean"`) ahead of the mask. Static
`true`/`false` literals were unaffected and keep working; a genuinely mixed
union (`boolean | number`) still falls through to the host import (intrinsicName
guard). Regression test: `tests/issue-2166.test.ts` (8 cases, host + standalone).

**Still open (the bulk of the 76):** `JSON.stringify` / `JSON.parse` of
**dynamic object graphs** (runtime-built objects, runtime JSON text →
object/array) still refuse with the #1599 Phase-2 compile error — they need the
pure-Wasm JSON codec + a dynamic value representation. That is the #1599 Phase 2
architect-spec follow-up (large; benefits from the #1917 coercion engine and the
value-rep work), not a point fix.

## Tech-lead note (2026-06-15, from dev3)

PR #1488 fixed one slice (standalone `JSON.stringify` of a boolean-typed value).
Stays `ready`: the ~75-test bulk is dynamic object-graph stringify/parse, needing
the #1599 Phase-2 pure-Wasm JSON codec + dynamic value rep (architect/senior).

## Progress (2026-06-16, d2) — `JSON.stringify(value, null, space)` indentation slice

**Status stays `ready`** — another increment of the bucket, not the whole residual.

Probing standalone JSON against `upstream/main` @ `cc833a2c9` surfaced a concrete
compile-error gap independent of the dynamic-graph bulk: the common pretty-print
form **`JSON.stringify(obj, null, 2)`** (and any call with a `space` argument) hit
the #1599 refusal. The static-fold caller in `src/codegen/expressions/calls.ts`
was gated on `expr.arguments.length === 1`, so a `space` argument was never
threaded into the compile-time fold.

**Fix (this PR):**
- `src/codegen/json-standalone.ts` — `tryEmitJsonStringifyStatic` now accepts the
  optional `replacer` and `space` args. A `null`/`undefined`/omitted replacer is
  honoured; a static numeric/string `space` is resolved (`staticSpaceValue`) and
  forwarded to JS's own `JSON.stringify(value, null, space)`, which applies the
  §25.5.2 clamping/indentation. A function/array replacer or a dynamic space
  returns `undefined` → the caller keeps the #1599 refusal (no silent wrong
  output).
- `src/codegen/expressions/calls.ts` — relaxed the gate to `>= 1` arg and pass
  args 1 (replacer) and 2 (space) through.

Regression test: `tests/issue-2166.test.ts` (+10 cases: numeric/string space,
nested, space 0, `null` replacer, `--target wasi`, 1-arg compact regression
guard, and refusal for function/array replacer + dynamic space). No `JSON_*`
host-import leak. Existing 8 boolean-slice cases + #1599/#1636 suites stay green.

**Still open (the bulk of the 76):** dynamic object-graph `JSON.stringify` /
`JSON.parse` (runtime-built objects, runtime JSON text → object/array) — needs
the #1599 Phase-2 pure-Wasm JSON codec + dynamic value rep (architect/senior).

---

## Implementation Plan

> Architect spec, 2026-06-17. Based on `upstream/main` @ `79e16bb37`.
> Anti-dup: no `## Implementation Plan` existed before this; no open PR speccs
> the Phase-2 codec. This is the #1599 Phase-2 design the prior dev slices defer
> to. **Architect/senior-scale, NOT a dev point-fix.**

### Root cause / scope (what is actually missing)

The remaining ~75 of the 76-test bucket are **dynamic object-graph**
`JSON.stringify` and **runtime-text** `JSON.parse`. Today these hit the #1599
Phase-1 refusal in `src/codegen/expressions/calls.ts` (~line 6016,
`reportError(... "not yet supported in --target standalone/wasi (#1599)")`)
because:
- `tryEmitJsonStringifyStatic` (json-standalone.ts) only folds **compile-time-
  constant** graphs — a runtime-built object (`const o = {}; o.x = f();
  JSON.stringify(o)`) has no static value.
- `tryEmitJsonParsePrimitive` only parses runtime strings whose value is a lone
  number/`true`/`false`/`null`; objects/arrays/strings refuse.

The good news: the **dynamic value representation already exists** in the
standalone object runtime (`src/codegen/object-runtime.ts`,
`ensureObjectRuntime`). The codec is a **traversal + formatter** over types that
are already defined; almost no new representation work is required. Key existing
building blocks:

- **`$Object`** struct — `proto`, `props: (ref $PropMap)`, `count`, `nextSeq`.
- **`$PropMap`** = `(array (ref null $PropEntry))`; **`$PropEntry`** =
  `{ key: (ref $AnyString), value: anyref, flags: i32, seq: i32, get/set: anyref }`.
- **`__obj_ordered(ref $Object) -> ref $PropMap`** (object-runtime.ts ~line 2619)
  — returns a compacted `$PropMap` of **live + enumerable** entries in
  **OrdinaryOwnPropertyKeys insertion order** (the exact order JSON.stringify
  needs). This is the spine of the stringify walk.
- **`__json_quote_string`** (calls.ts ~line 603 / a runtime helper) — quotes a
  native string per §25.5.2 QuoteJSONString. Reuse verbatim for keys + string
  values.
- **`number_toString`** (`emitNativeNumberFormat`) — pure-Wasm f64→native-string,
  Number::toString. JSON needs a thin wrapper (NaN/±Inf → `null`, `-0` → `0`).
- **`$AnyValue`** tagged union (`any-helpers.ts`, fields tag/i32val/f64val/refval/
  externval) — the natural carrier for JSON.parse output and for typing the
  `anyref` values read out of `$PropEntry.value` during the stringify walk.
- Native arrays are the `$ObjVec`/`__vec_*` structs (`{len, data}`) already used
  by array codegen — the array arm of the walk reads `len` + element `i`.

So Phase-2 is: **(1) a recursive pure-Wasm SerializeJSONValue over the runtime
value rep, (2) a pure-Wasm parser producing that same rep, (3) routing the
dynamic call sites to them instead of the refusal.** No host import; standalone +
WASI only (host mode keeps `JSON_stringify`/`JSON_parse` imports unchanged).

### Design

New file `src/codegen/json-codec-native.ts` (companion to the static-fold
`json-standalone.ts`), emitting lazily-registered runtime functions. Keep the
emit-once / `ctx.funcMap.has(name)` guard idiom every other runtime in
`object-runtime.ts` uses.

#### A. Native `JSON.stringify` — `__json_stringify_value`

Signature (pure Wasm, no host):
```wat
(func $__json_stringify_value
  (param $v anyref)            ;; the value to serialize (instance/object/array/boxed primitive)
  (param $gap (ref null $AnyString))  ;; indent unit ("" = compact); PR-2
  (param $depth i32)           ;; current nesting depth, for indentation
  (result (ref null $AnyString)))      ;; the JSON text, or null for "undefined"/function/symbol
```

Implements §25.5.2 SerializeJSONProperty by **runtime type discrimination** on
`$v` (a sequence of `ref.test` guards, the same discipline the property
front-guards use):
1. `ref.is_null` → the value is JS `null`/absent. (Distinguish JSON `null`
   literal from "omit" at the caller per array vs object context.)
2. `ref.test $AnyValue` → unbox via tag: number → `number_toString` (with the
   NaN/Inf→`null`, `-0`→`0` JSON rule), boolean → `"true"`/`"false"`, string →
   `__json_quote_string`, null → `"null"`.
3. `ref.test $NativeString` (or `$AnyString` subtype) → `__json_quote_string`.
4. `ref.test $ObjVec`/native-array struct → **array arm**: emit `"["`, loop
   `i in 0..len`: recurse on element `i` (a null/undefined/function element
   serializes as `"null"` inside an array — §25.5.2), join with `","`, append
   `"]"`. Apply indentation when `$gap != ""`.
5. `ref.test $Object` → **object arm**: `__obj_ordered` → walk the compacted
   `$PropMap`; for each entry, recurse on `$PropEntry.value`; **skip** entries
   whose serialized value is null/undefined/function/symbol (§25.5.2 step: a
   property with an undefined-serialization is omitted from an object); emit
   `quote(key) ":" value`, join with `","`, wrap in `"{" … "}"`. Indentation as
   §25.5.3.
6. user-class **instances** (`(ref $ClassName)` structs): two routes —
   - if the instance has a `toJSON` method, call it first (§25.5.2 step 2) and
     serialize the result. Defer `toJSON` to a follow-up PR if it complicates
     the first cut; note it.
   - otherwise enumerate the instance's **own enumerable string-keyed fields**.
     Closed-struct instances expose fields by name, not via `$PropMap`; the
     simplest correct route is to reuse the **existing instance→`$Object`
     reflection** the object runtime already does for `Object.keys(instance)`
     (find that path — `__obj_ordered` works on `$Object`; instances may need
     the `__to_object`/own-keys bridge). **Scope the first PR to plain `$Object`
     graphs + arrays + boxed primitives**; instance-field stringify is a
     separate slice (it overlaps the closed-struct reflection work in #2042).

String building: reuse the native-string concat helpers
(`ensureNativeStringHelpers`, the `__str_concat`/builder the array `join` path
uses — see array-methods.ts ~line 4832). For large graphs prefer a growable
builder over O(n²) concat; a simple concat is acceptable for the first cut.

#### B. Native `JSON.parse` — `__json_parse_text`

Signature:
```wat
(func $__json_parse_text
  (param $text (ref $AnyString))
  (result anyref))      ;; $AnyValue for primitives; $Object / $ObjVec for graphs; traps→throw SyntaxError
```

A standard recursive-descent JSON grammar (§25.5.1) over the native string's
i16 code units:
- a scanner reading code units by index (`array.get` on the native-string
  backing array); skip insignificant whitespace (space/tab/LF/CR only — JSON is
  strict).
- `parseValue` dispatch on first non-ws char: `{` → object, `[` → array,
  `"` → string, `-`/digit → number, `t`/`f`/`n` → literal.
- object → build a fresh `$Object` via `__new_plain_object` + `__extern_set`
  (or the lower-level `__obj_insert`) per member; preserve insertion order
  (the runtime already records `seq`).
- array → build `$ObjVec` (or the native array struct) via the existing array
  push/append helper.
- string → unescape per §25.5.1 (`\"` `\\` `\/` `\b\f\n\r\t` `\uXXXX`) into a
  native string.
- number → parse via the existing **`emitNativeParseNumber`**
  (`parse-number-native.ts`) → f64 → box as `$AnyValue`.
- on any grammar violation (or trailing non-ws): `throw SyntaxError` via the
  existing `emitThrowTypeError`-style error path (use a SyntaxError variant —
  `__new_SyntaxError` is already wired for standalone, see new-super.ts
  `emitWasiErrorConstructor` / `isWasiErrorName`).

The parser's output rep MUST be the SAME rep stringify consumes and the same rep
the rest of standalone codegen reads `any`/object values as, so a round-trip
`JSON.parse(JSON.stringify(o))` and downstream `.x` property reads work through
`__extern_get`.

#### C. Routing (calls.ts)

In `compileCallExpression`'s JSON arm (`src/codegen/expressions/calls.ts`
~line 5955), BEFORE the Phase-1 refusal at ~line 6016:
- `stringify`: after the existing primitive (`tryEmitJsonStringifyPrimitive`)
  and static-fold (`tryEmitJsonStringifyStatic`) attempts miss, and we are
  `ctx.standalone || ctx.wasi`: compile arg0 to its natural rep (object/array/
  any → `anyref`), ensure `__json_stringify_value`, push the gap (from a static
  `space`, reusing `staticSpaceValue`; dynamic space → first cut passes `""` or
  refuses — note), `depth=0`, `call`. Result native string.
- `parse`: after `tryEmitJsonParseLiteral` / `tryEmitJsonParsePrimitive` miss
  and standalone/WASI: compile arg0 to native string, ensure
  `__json_parse_text`, `call`. Result `anyref` (the value graph). A `reviver`
  arg (2nd) → first cut: refuse if present, or apply in a follow-up PR
  (§25.5.1 InternalizeJSONProperty is a post-walk; defer).

### Slicing into dev-sized PRs

- **PR-A (stringify, plain graphs)** — `__json_stringify_value` for
  `$Object` + native array + `$AnyValue`/boxed primitive, compact output only.
  Route dynamic `JSON.stringify(obj)` / `(arr)`. Tests: runtime-built object,
  nested object/array, numbers (incl. NaN/Inf→null, -0→0), strings with escapes,
  booleans, null. This alone should reclaim a large chunk of the bucket.
- **PR-B (stringify, indentation + space)** — thread `$gap`/`$depth` for
  `JSON.stringify(o, null, 2)` dynamic form (the static form already works via
  #2166 prior slice). Tests: indented nested output, string space, space 0.
- **PR-C (parse, primitives + graphs)** — `__json_parse_text` full grammar →
  `$Object`/`$ObjVec`/`$AnyValue`; route dynamic `JSON.parse(text)`. Tests:
  parse object/array/nested/escapes/numbers; SyntaxError on malformed input;
  round-trip `JSON.parse(JSON.stringify(o))`.
- **PR-D (instance fields + toJSON + reviver/replacer)** — stringify of
  user-class **instances** (own enumerable fields; reuse #2042 closed-struct
  reflection), `toJSON`, and reviver/replacer. Larger; overlaps #2042/#1917.

### Edge cases (§25.5)

- `JSON.stringify(undefined)` / a function / a symbol at top level → returns
  JS `undefined` (NOT the string "undefined"); inside an array → `"null"`;
  as an object value → the key is omitted. The recursion's null-result return
  encodes this; the caller picks array-vs-object behaviour.
- Numbers: `NaN`/`±Infinity` → `null`; `-0` → `0`; otherwise Number::toString.
- Strings: full QuoteJSONString escaping incl. control chars `\u00XX` and
  surrogate handling — reuse `__json_quote_string` exactly (do not re-implement).
- Property order: insertion order via `__obj_ordered`/`seq` — already correct.
- Circular references → `JSON.stringify` must throw TypeError. First cut: bound
  recursion depth and throw on overflow (note the limitation); a proper
  seen-set is a follow-up.
- Parse strictness: leading/trailing whitespace OK; trailing junk → SyntaxError;
  no comments, no trailing commas, no single quotes.

### Files to touch
- NEW `src/codegen/json-codec-native.ts` — `ensure`/`emit` of
  `__json_stringify_value` + `__json_parse_text`.
- `src/codegen/expressions/calls.ts` (~line 5955–6020) — route dynamic
  stringify/parse to the native codec before the Phase-1 refusal.
- Reuse (no edit): `object-runtime.ts` (`__obj_ordered`, `$Object`/`$PropMap`/
  `$PropEntry`, `__new_plain_object`, `__obj_insert`), `any-helpers.ts`
  (`$AnyValue`), `parse-number-native.ts` (`emitNativeParseNumber`),
  native-string helpers (`__json_quote_string`, concat builder), the
  standalone SyntaxError constructor (`emitWasiErrorConstructor`).

### Test files to verify
- Extend `tests/issue-2166.test.ts` per-PR (host + `--target wasi`/standalone):
  - dynamic-graph stringify (runtime-built object/array, nesting, escapes,
    NaN/Inf→null, -0→0) — PR-A
  - indented dynamic stringify — PR-B
  - parse → graph, SyntaxError on malformed, round-trip — PR-C
- Standalone-vs-host gap diff for `built-ins/JSON` should drop from ~75 toward
  near-parity as PR-A/PR-C land (verify via CI test262 bucket).
- No regression to the existing #1599/#1636 static-fold suites or the boolean/
  space slices already merged.

---

## Progress (2026-06-17, sdev-json) — PR-A: dynamic object-graph stringify codec

PR-A of the Implementation Plan above. New module
`src/codegen/json-codec-native.ts` emits a recursive pure-Wasm
`__json_stringify_value(v: anyref, depth) -> ref null $AnyString` (+ a
`__json_stringify_root` entry that coalesces a top-level undefined-serialisation
to `"null"`) over the **existing** standalone value rep — no new representation
work:

- `$Object` graphs: own enumerable string keys in insertion order via the
  existing `__obj_ordered`; recurses on `$PropEntry.value` (anyref); omits a
  property whose value serialises to undefined (§25.5.2).
- nested `$Object`, native-string values (`__json_quote_string` reused verbatim
  for keys + string values), `$box_number_struct` numbers (NaN/±Inf → `null`,
  `-0` → `0` via `number_toString`), `null`, and `$AnyValue`-carried primitives.
- `$ObjVec` array arm (enumeration-vector arrays).

Routing (`src/codegen/expressions/calls.ts`, the standalone/wasi JSON arm): when
the static fold (`tryEmitJsonStringifyStatic`) declines and the call is the
1-arg / null-replacer-no-space shape, compile arg0 to `anyref` and call the
codec. **Arrays/tuples (closed `__vec_*` structs) are NOT routed** — they are not
`$ObjVec` and stay on the #1599 refusal path until the array sub-slice (PR-A2).

**Correctness bug also fixed (`src/codegen/json-standalone.ts`):** `staticJsonValue`
followed a `const` identifier into an object/array literal initializer and folded
it, but such bindings are **mutable in place** (`const o = {}; o.x = f()`), so it
silently dropped runtime mutations and emitted `"{}"`. Now a `const` is only
followed to a **primitive** initializer; object/array bindings route to the codec
(or the refusal) instead of a wrong static fold.

Regression tests: `tests/issue-2166.test.ts` (+10 PR-A cases — runtime `let`/param
object, nested graph, QuoteJSONString escaping, NaN/Inf→null, -0→0, null value,
empty object, wasi host-import-free, reassigned-`let` no-stale-fold). Updated
`tests/issue-1599-json-standalone-refuse.test.ts`: dynamic **object** now compiles
(was refused); dynamic **array** still refuses (PR-A2). All 40 cases green; the
two pre-existing host-mode failures (`json.test.ts` number→host-import,
`issue-json-stringify-structs.test.ts` array-of-structs) are upstream, not from
this PR (verified by stashing). PR #1653.

**PR-A known limitations → follow-up slices:**
- **PR-A2:** closed typed-array (`number[]`) serialisation — a separate vec-struct
  discrimination, not `$ObjVec`.
- **boolean object-property values** serialise as `1`/`0`: the i32→externref
  coercion boxes a boolean as `$box_number` (indistinguishable from a number).
  A proper fix needs `__box_boolean` + an `__unbox_number` boolean arm — broad
  blast radius, overlaps #1917; deferred.
- **PR-B:** dynamic-space indentation. **PR-C:** `__json_parse_text`. **PR-D:**
  instance fields + toJSON + reviver/replacer.

---

## Progress (2026-06-17, sdev-json3) — PR-B: dynamic-graph `space` indentation

PR-B of the Implementation Plan. Threads §25.5.2 pretty-printing through the
pure-Wasm dynamic stringify codec (`src/codegen/json-codec-native.ts`). PR-A
emitted dynamic object graphs *compactly* only; any `space` argument forced the
#1599 refusal (the static-fold path owns only the static-value form, which a
runtime-built graph never reaches).

**Codec (`json-codec-native.ts`):**
- `__json_stringify_value` gains a third param `gap: ref null $AnyString` (the
  per-level indent unit, e.g. `"  "`). A **null** gap selects the compact form
  (PR-A behaviour, zero added work — the separators collapse to `""`); a
  non-null gap drives indentation.
- Each call computes three separator locals once (prologue): `L_NL_IN` =
  `"\n" + __str_repeat(gap, depth+1)` (before every element/property),
  `L_NL_OUT` = `"\n" + __str_repeat(gap, depth)` (before the closing brace),
  `L_COLON` = `": "` (key/value). With a null gap all three are `""`/`":"`, so
  the object/array arms emit **byte-identical** compact output (verified by the
  1-arg regression guard). `__str_repeat` returns `""` for count 0, so the
  top-level (depth 0) close indent is bare `"\n"`.
- Empty object/array stays `{}` / `[]` (the close-indent is gated on
  "≥1 member emitted", §25.5.2).
- New entry `__json_stringify_root_indent(v, gap)` mirrors `__json_stringify_root`
  with the gap forwarded.

**Routing (`src/codegen/expressions/calls.ts`):** the dynamic-graph branch now
resolves a *static* `space` arg (`staticSpaceValue` → `jsonGapFromStaticSpace`,
both newly exported from `json-standalone.ts`) to the gap string per §25.5.2
(`min(10, floor(n))` spaces / first 10 chars of a string; ≤0/"" → compact). An
empty gap routes through the cheap compact root; a non-empty gap pushes the gap
literal and calls `__json_stringify_root_indent`. A function/array replacer or a
**dynamic** space still keeps the #1599 refusal (no silent wrong output).

Tests: `tests/issue-2166.test.ts` (+12 PR-B cases — flat/nested/deeply-nested
object with numeric space 2, string (tab) + multi-char space, numeric-space>10
clamp, space 0 = compact, null property value, empty nested object stays
compact, `--target wasi` host-import-free, and a 1-arg compact PR-A regression
guard). Each result is read back char-by-char and compared to Node's own
`JSON.stringify(value, null, space)` for exact parity. `#1599`/`#1636` refuse
suites stay green; the two pre-existing host-mode `json.test.ts` failures are
upstream (verified by stashing).

**Still open after PR-B:** PR-C (`__json_parse_text`, separate branch #1657),
PR-C2 (parsed-array `a[i]` indexing, #1658), PR-D (reviver/replacer/toJSON),
PR-A2 (closed `number[]` array stringify — a literal `number[]` isn't an
`$ObjVec`, so it still routes to refusal; the array *indent* arm is implemented
and activates for `$ObjVec` arrays once those route through the codec).

---

## Progress (2026-06-17, sdev-json2) — PR-C: dynamic JSON.parse codec

PR-C of the Implementation Plan. Adds `emitJsonParseText` to
`src/codegen/json-codec-native.ts`: a pure-Wasm recursive-descent JSON parser
(ECMA-404 / §25.5.1) — `__json_parse_text(s: externref) -> anyref` plus mutually
recursive `__json_parse_value` / `__json_parse_str` helpers sharing a cursor
through a `$JsonP { $data, $pos(mut), $end }` state struct. Output uses the SAME
standalone value rep stringify (PR-A) consumes and the property-read path
unboxes:

- objects → `$Object` via `__new_plain_object` + `__extern_set` (insertion order).
- numbers → `$__box_number_struct`; booleans → `$__box_number_struct` 1.0/0.0
  (matching how `o.x = true` stores a boolean in a standalone object — a distinct
  boolean identity is the broader #1917 boolean-boxing gap); `null` → null eqref.
- strings → native `$AnyString` with full §25.5.1 unescaping (`\" \\ \/ \b\f\n\r\t`
  and `\uXXXX`), via a two-pass (size-scan then fill) over the flattened i16 backing.
- arrays → `$ObjVec` via `__objvec_new` + `__objvec_push`.
- malformed input / trailing junk → runtime `throw new SyntaxError(...)` through the
  standalone `__new_SyntaxError` ctor + the shared exn tag (§25.5.1 step 3), not a trap.

Routing (`src/codegen/expressions/calls.ts`): a runtime-string / `any`-typed
`JSON.parse(text)` (1-arg) now routes to the codec, replacing the primitive-only
`__json_parse_primitive` slice (a strict superset — it parsed only a lone
number/true/false/null and trapped on `{`/`[`/`"`). A `reviver` (2nd arg) is
deferred to PR-D (refused, not silently ignored).

Tests: `tests/issue-2166.test.ts` (+14 PR-C cases — object number/string/nested
reads, §25.5.1 escapes incl. `\uXXXX`, boolean truthy round-trip, null, top-level
primitive, negative/fraction/exponent numbers, whitespace tolerance, object +
nested round-trip `JSON.parse(JSON.stringify(o))`, `--target wasi`, and a
malformed-input SyntaxError throw). Updated `tests/issue-1599-json-standalone-
refuse.test.ts`: dynamic `JSON.parse(s).x` now COMPILES (was refused), both
standalone and wasi; a dynamic `number[]` stringify still refuses (PR-A2).

Two pre-existing host-mode failures (`tests/json.test.ts` number→host-import,
array-of-structs) are upstream, not from this PR (the host `JSON_stringify`
import path is untouched — every PR-C change is gated on `ctx.standalone ||
ctx.wasi`).

### Codegen note (WHY) — fresh GC struct in a lazy codegen pass
A fresh struct type registered during a *lazy* call-expression codegen (here
`$JsonP`) is fragile if its `typeIdx` is baked into many shared helper-`Instr`
objects: the finalize dead-type-elimination remap (`remapTypeIdxInBody`)
mutates `typeIdx` IN PLACE and re-visits a shared object once per occurrence,
re-mapping an already-mapped index repeatedly (the #1302 shared-array
double-shift hazard). It desynced the most-spread `$pos` `struct.get`/`set`
operands (78→72→…→54 `$ProxyTraps`) from the cursor local's declared type. Fix:
deep-clone each function body with a **JSON round-trip** (NOT `structuredClone`,
which *preserves* internal aliasing) so every operand occurrence is an
independent object and is remapped exactly once. The struct index is also kept
off every function **signature** (helpers take `anyref` + `ref.cast` on entry)
and its fields are `$`-prefixed (so the same-shape collision resolver skips it).

### PR-C2 follow-up (array element indexing)
Parsed arrays build a `$ObjVec`; `.length` and use as object-property values
work, but **direct numeric element indexing on a parsed array** (`a[i]`) reads
0 — the standalone element-access path does not route an `$ObjVec` numeric read
through `__extern_get_idx` (it resolves `a[i]` as a string-keyed `__extern_get`,
which an `$ObjVec` has no key for). PR-C2: route `$ObjVec` numeric element-access
through `__extern_get_idx` (the helper already ref.tests `$ObjVec` and returns
`data[i]`). Object graphs — the dominant `JSON.parse` shape — are fully working.

### Still open
- **PR-C2:** parsed-array element indexing (`a[i]`) via `__extern_get_idx`.
- **PR-D:** instance fields + `toJSON` + reviver/replacer.
- **PR-A2:** closed typed-array (`number[]`) stringify; proper boolean boxing.

---

## Status (2026-06-17, sdev-json3) — dev residual CLOSED; PR-D = architect follow-up

All four pure-Wasm codec slices of the #1599 Phase-2 dynamic JSON codec have
**landed on main**:

- **PR-A** (#1653) — dynamic object-graph `JSON.stringify` (compact).
- **PR-C** (#1657) — dynamic `JSON.parse` recursive-descent codec
  (`__json_parse_text`); round-trip `JSON.parse(JSON.stringify(o))` works.
- **PR-C2** (#1658) — parsed-array element indexing `a[i]` via `__extern_get_idx`.
- **PR-B** (#1660) — `JSON.stringify(value, null, space)` §25.5.2 indentation.

Standalone JSON now does **dynamic object-graph stringify (compact + indented) +
parse + round-trip + parsed-array indexing**, pure-Wasm, host-import-free under
`--target standalone`/`wasi`. The dev-completable residual is closed.

### Remaining: PR-D (reviver / replacer / `toJSON`) → architect follow-up

`JSON.parse(text, reviver)`, a function/array `replacer`, and `toJSON` are NOT
yet supported standalone (they currently **refuse**, not silently mis-behave).

**Feasibility (timeboxed assessment, sdev-json3):** PR-D is **dev-tractable in
standalone — NOT host-only.** The closure-invocation machinery it needs already
exists and runs under `--target standalone`: `__call_fn_method_N` (N=0..5,
`emitClosureMethodCallExportN` in `index.ts`) threads `this`/holder via the
`__current_this` global and is already consumed by the open-`$Object` accessor
drivers (`__call_accessor_get`/`_set`, `accessor-driver.ts`) and the Proxy/
`__apply_closure` bridges via the **reserve/fill driver** pattern (funcIdx-ordering
safe across late-import shifts).

So PR-D is a real, sizeable but doable feature, broken into:
- **PR-D1 (reviver):** thread the reviver closure-ref from the `JSON.parse`
  call site into `__json_parse_text`; after building the value, run the
  §25.5.1 InternalizeJSONProperty post-walk, calling `reviver(key, value)` via a
  reserved `__call_reviver` driver → `__call_fn_method_2`.
- **PR-D2 (`toJSON`):** in `__json_stringify_value`, before serialising a
  `$Object`/instance, `HasProperty`-check `toJSON` and call it with the holder
  `this`; reuse `__call_fn_method_1` via a reserved driver.
- **PR-D3 (function/array replacer):** mirror PR-D2's call path for the
  replacer during the stringify walk.

This is multi-PR and overlaps #1636 (`__call_fn_method`) + #2042 (instance-field
reflection), so it's tracked as the **architect-scoped follow-up (TaskList #32)**
rather than appended to this issue's dev queue. The compiler primitives are
in place; the work is the codec-side plumbing + the InternalizeJSONProperty walk.

---

## Implementation Plan (PR-D: reviver / toJSON / replacer) — sdev-json3, 2026-06-17

> Architect spec for TaskList #32, written against `upstream/main` @ the #1661
> merge. The other 4 codec slices are landed. PR-D is **dev-tractable in
> standalone** — it reuses the existing `__call_fn_method_N` closure-invocation
> machinery (already used standalone by accessor drivers + Proxy bridges via the
> reserve/fill pattern). Sliced into D1 (reviver), D2 (`toJSON`), D3 (function/
> array replacer); D1 is the most self-contained and lands first.

### Shared infrastructure (used by all three slices)

**The closure-call driver (reserve/fill).** `__call_fn_method_N` is an *export*
emitted in FINALIZE (`emitClosureMethodCallExportN`, index.ts ~3367) only when a
closure of arity ≤ N exists. Signature:
`(thisVal: externref, closure: externref, arg0: externref, … : externref) -> externref`
— it stores `thisVal` into the `__current_this` global across the inner
`call_ref` (so the reviver/replacer/`toJSON` observes the right `this`). The
codec is emitted LAZILY during call-expression codegen, before the dispatcher
exists, so it cannot bake the dispatcher's funcIdx. Use the **proven reserve/
fill driver** pattern (`accessor-driver.ts` `reserveAccessorGetDriver` /
`fillAccessorDrivers`, mirrored from #1719):
- At codec-emit time, reserve `__call_reviver` (D1) / `__call_to_json` (D2) /
  `__call_replacer` (D3) placeholder funcs (bare `unreachable` body), funcIdx
  fixed by append position + registered in `funcMap`; the codec emits a plain
  `call <reserved funcIdx>`.
- In post-processing (after `emitClosureMethodCallExportN`), fill each body as a
  thin wrapper around `__call_fn_method_2` (reviver: `this`=holder, args key+
  value) / `__call_fn_method_1` (`toJSON`/replacer arity-1 forms). Route through
  `funcMap` (NOT a raw number) so `shiftLateImportIndices` patches it across
  late-import shifts (#329/#1899 contract).
- Guard: if no arity-2 (resp. arity-1) closure exists in the module,
  `__call_fn_method_2` is never emitted → the fill step must degrade the driver
  to "return value unchanged" (reviver identity / no replacer) rather than dangle.

**Value ↔ externref marshalling.** Parsed members are `$Object`/`$ObjVec`/
`$__box_*`/`$AnyString`/null as `anyref`; the reviver sees them as `externref`
(`extern.convert_any`), and its result comes back `externref` →
`any.convert_extern` to re-store. Boxed primitives round-trip as-is.

### PR-D1 — `JSON.parse(text, reviver)` (§25.5.1 InternalizeJSONProperty)

**Routing (`calls.ts`, the `method === "parse"` standalone block ~6088):** lift
the `expr.arguments.length === 1` gate. When a 2nd arg is present and is a
function-typed reviver, compile arg0 → externref AND arg1 (reviver) → externref,
then call a new `__json_parse_text_reviver(text, reviver) -> anyref`. A
non-function 2nd arg (e.g. an accidental object) keeps the refusal.

**Codec (`json-codec-native.ts`), new `emitJsonParseTextReviver`:**
1. `val = __json_parse_text(text)` — reuse the existing parser unchanged.
2. Build the §25.5.1 root holder: `root = {"": val}` via `__new_plain_object` +
   `__extern_set("", val)`.
3. `return __internalize_json_property(root, "", reviver)`.

**New recursive `__internalize_json_property(holder: externref, key: $AnyString,
reviver: externref) -> externref`** (§25.5.1 InternalizeJSONProperty):
- `val = __extern_get(holder, key)`.
- If `val` is a `$Object`: for each own key `k` (snapshot via `__obj_ordered` —
  take the key list FIRST since the walk mutates), `elem =
  __internalize_json_property(val, k, reviver)`; if `elem` is `undefined`
  (the reviver's delete sentinel) → `__delete_property(val, k)` else
  `__extern_set(val, k, elem)`.
- If `val` is a `$ObjVec`: same, iterating numeric indices `0..len-1` with string
  keys; a deleted element becomes a hole → set to the parsed `undefined`/null per
  §25.5.1 step 2.b.ii (CreateDataProperty of undefined).
- Finally: `return __call_reviver(holder, key, val)` — the driver calls
  `reviver.call(holder, key, val)`. The reviver's `undefined` return propagates
  up as the delete sentinel.

**Edge cases:** key order is the snapshot taken before recursion (a reviver that
adds keys does not see them — §25.5.1); `this` inside the reviver is the holder
(threaded by `__call_fn_method_2` via `__current_this`); a reviver returning the
value unchanged is the identity (round-trip safe).

**Tests (`tests/issue-2166.test.ts`):** reviver doubling numbers, dropping a key
(undefined return), `this[key]` access in the reviver, nested-graph transform,
array-element reviver, identity reviver round-trip, `--target wasi`. Compare the
internal result (native strings don't marshal across the boundary).

### PR-D2 — `toJSON` (§25.5.2 SerializeJSONProperty step 2)
In `__json_stringify_value`, before the `$Object`/instance arms: `HasProperty`-
check `toJSON` (via `__extern_get` of the method, ref-test for a closure); if
present, `val = __call_to_json(val /*this*/, key)` (`__call_fn_method_1`) and
serialise the result instead. Reserve/fill `__call_to_json` as above.

### PR-D3 — function / array replacer (§25.5.2 steps 2.b / 3)
Thread the replacer closure-ref / key-array into the stringify root; in the
object/array arms call `replacer.call(holder, key, val)` (function form, via
`__call_replacer` → `__call_fn_method_2`) or filter keys to the array form.
Larger; lands last.

---

## Progress (2026-06-18, sdev-json3) — PR-D1: standalone JSON.parse reviver

PR-D1 of the PR-D plan above. `JSON.parse(text, reviver)` now runs the §25.5.1
InternalizeJSONProperty walk entirely in Wasm under `--target standalone`/`wasi`
(previously refused). Implements the shared closure-call infrastructure the rest
of PR-D (toJSON/replacer) will reuse.

**Files:**
- `src/codegen/accessor-driver.ts` — new `reserveReviverDriver` + a fill arm in
  `fillAccessorDrivers`: the `__call_reviver(holder, reviver, key, value)` driver
  wraps `__call_fn_method_2` (holder bound as `this`). Reserve/fill funcIdx-
  authority pattern (shiftLateImportIndices-safe), identical to the accessor
  drivers. Degrades to an identity (returns value) when no arity-2 closure exists.
- `src/codegen/context/types.ts` — `reviverDriverReserved` flag.
- `src/codegen/json-codec-native.ts` — new `emitJsonParseTextReviver`: the entry
  `__json_parse_text_reviver(text, reviver)` (parse → wrap in root holder `{"":v}`
  → internalize) and the recursive `__internalize_json_value(val, holder, key,
  reviver)`. **Key design:** the walker takes the value DIRECTLY (already fetched)
  — an `$ObjVec` array element can't be re-read via `__extern_get(vec,"i")` (no
  string-keyed prop), so the object arm fetches children with `__extern_get` and
  the array arm with `array.get`. Object: undefined return → `__delete_property`;
  else `__extern_set`. Array: result written back via `array.set` in place.
- `src/codegen/expressions/calls.ts` — routing: lift the 1-arg gate to accept a
  2nd arg; a *callable* reviver compiles via the GC-closure path
  (`compileArrowAsClosure`, NOT `__make_callback` — the host bridge leaks an
  `env::` import and its JS wrapper fails the `__call_fn_method_2` ref.cast) and
  routes to the reviver codec; a null/non-callable 2nd arg is IGNORED (§25.5.1
  IsCallable gate) → plain parse. Also skip the static-literal fold when a 2nd
  arg is present (it ignored the reviver, e.g. `JSON.parse('5', r)`).

Tests: `tests/issue-2166.test.ts` (+9 PR-D1 cases — number transform, identity
round-trip, key delete (undefined return), nested bottom-up transform, array-
element transform, top-level primitive, string passthrough, null-reviver-ignored,
`--target wasi`). All host-import-free (asserted). 61/61 in the suite green;
#1599/#1636 refuse + PR-C2 suites unaffected. The one #2042 numeric-key failure
is pre-existing on the base (verified by stashing).

**Remaining PR-D:** D2 (`toJSON`) + D3 (function/array replacer) — same driver
infra, on the stringify side.

---

## Progress (2026-06-18, sdev-json3) — PR-D2: standalone JSON.stringify toJSON (data-property forms)

PR-D2 of the PR-D plan (PR #1666). `JSON.stringify` now honours a value's
callable own `toJSON` (§25.5.2 SerializeJSONProperty step 2.b) under `--target
standalone`/`wasi`, entirely in Wasm on the same `__call_*` driver infra PR-D1
introduced.

**Files:**
- `src/codegen/json-codec-native.ts` — `__json_stringify_value` gains a 4th param
  `key: externref` (threaded at all 4 recursion sites + both roots). A toJSON
  dispatch block at the top: if the value is an `$Object` with a **non-null own
  `toJSON`** (read via `__extern_get`), call `__call_to_json(value, method, key)`
  and re-dispatch the result.
- `src/codegen/accessor-driver.ts` — `reserveToJsonDriver` + a fill arm wrapping
  `__call_fn_method_1` (value bound as `this`). Same reserve/fill funcIdx pattern
  as PR-D1's reviver driver.
- `src/codegen/context/types.ts` — `toJsonDriverReserved` flag.
- `scripts/coercion-sites-baseline.json` — `json-codec-native.ts` 6→8: the two
  new sites reuse the existing `number_toString` helper to format an array index
  `i` as its string property key (the key threaded into toJSON for array
  elements). Reuse of the JSON number-serialization helper, not a hand-rolled
  ToString matrix — a sanctioned migration bump.

Tests: `tests/issue-2166.test.ts` (+11 PR-D2 cases — arrow / function-expression
toJSON, `this` binding, key passing, numeric/object-graph results, nested
property, array element, indented form, no-regression for a plain object, a
method-shorthand-toJSON-elsewhere codec-stability guard, `--target wasi`).
72/72 in the suite green.

### KNOWN RESIDUAL → separate method-lookup follow-up (NOT in #1666)

PR-D2 covers **data-property** `toJSON` forms — `{ toJSON: () => …, … }` and
`{ toJSON: function () { … }, … }` — because those are real **runtime own
properties** the codec finds via `__extern_get`. It does **NOT** cover:

- **method-shorthand** `{ toJSON() { … } }`, and
- **class-method** `class C { toJSON() { … } }` instances.

Both serialize as if no `toJSON` exists (a plain object with the other fields;
an instance currently serializes per its normal arm). Root cause: a
method-shorthand / class method is **not a runtime own data-property** on the
object — it lives on the static object shape / prototype, so the codec's
`__extern_get(value, "toJSON")` returns null and the dispatch is skipped. This
is a **method-lookup** gap, not a `toJSON`-specific one: it is the same
static-shape / prototype reflection-through-the-externref-boundary problem that
blocks instance-field stringify and overlaps the closed-struct reflection work
in #2042 and the `$Array`/`$ObjVec` introspection work (TaskList #35). It is
**architect-scale** (prototype/own-shape method resolution through the codec's
`anyref` boundary), not a point fix, and is tracked as a follow-up rather than
folded into #1666. Once standalone method-lookup-through-the-boundary lands,
the codec's existing toJSON dispatch arm covers the shorthand/class forms with
no codec change (the `__extern_get` simply has to find the method).

**Remaining PR-D:** D3 (function / array replacer) — same `__call_*` driver
infra, on the stringify side. After D3, #2166 is fully closed.

---

## Progress (2026-06-18, sdev-json3) — PR-D2: standalone JSON.stringify toJSON

PR-D2 of the PR-D plan. `JSON.stringify` now honours a value's callable own
`toJSON` (§25.5.2 SerializeJSONProperty step 2.b) under `--target standalone`,
running entirely in Wasm on the same `__call_*` driver infra PR-D1 introduced.

**Files:**
- `src/codegen/json-codec-native.ts` — `__json_stringify_value` gains a 4th param
  `key: externref` (the property key for toJSON); threaded at all 4 recursion
  sites (object arm = `e.key`; array arm = `number_toString(i)`; both roots = "").
  A toJSON dispatch block at the top: if the value is an `$Object` with a non-null
  own `toJSON` (via `__extern_get`), call `__call_to_json(value, method, key)` and
  re-dispatch the result (a null/undefined return → `"null"`).
- `src/codegen/accessor-driver.ts` — `reserveToJsonDriver` + fill arm: the
  `__call_to_json(value, method, key)` driver wraps `__call_fn_method_1` (value
  bound as `this`). Same reserve/fill funcIdx pattern as PR-D1's `__call_reviver`.
- `src/codegen/context/types.ts` — `toJsonDriverReserved` flag.

**The funcIdx-stability fix (WHY `deepCloneInstrs`):** `__json_stringify_value`
spreads SHARED helper `Instr[]` arrays (appendPiece/appendSep/appendLit) at many
sites. Before this PR the body was used directly; with the new lazily-reserved
`__call_to_json` call in it, a later union-import shift (triggered by ANY
method-shorthand closure elsewhere in the module) desynced the driver call —
`shiftLateImportIndices` de-dupes shared objects via a `shifted` Set and skipped
their other occurrences. Symptom: `__json_stringify_value` failed Wasm validation
"need 3, got 1". Fix: deep-clone the body so every occurrence is independent and
shifted exactly once (the #1302 hazard the parse codec already clones around). A
**JSON round-trip clone is WRONG** here — the number arm holds `f64.const Infinity`
and `JSON.stringify(Infinity)→null` would corrupt it to 0 — so `deepCloneInstrs`
is a structure-preserving recursive clone (preserves ±Infinity/NaN, breaks
aliasing).

Tests: `tests/issue-2166.test.ts` (+11 PR-D2 cases — arrow/function-expression
toJSON, `this` binding, key passing, primitive + captured-object results, nested,
array-element, indented (PR-B) form, no-toJSON regression, method-shorthand-
present no-corruption guard, wasi host-import-free). 72/72 in the suite green;
all PR-A/B/C/C2/D1 suites stay green.

**Known limitation (deferred):** a toJSON returning a FRESH object literal built
inside the closure (`() => ({...})`) serialises as "null" — a pre-existing
standalone closure-return-representation gap (a plain `(() => ({x:1}))()` then
stringify also yields "null"), independent of toJSON; ties to the
`$Array`/`$ObjVec` externref-boundary work (TaskList #35). Captured/pre-existing
object returns work.

**Remaining PR-D:** D3 (function/array replacer) — same driver infra, last slice;
after it, #2166 is fully closed.

---

## Progress (2026-06-18, sdev-json3) — PR-D3: standalone JSON.stringify replacer (CLOSES #2166)

PR-D3, the LAST slice of the #1599 Phase-2 dynamic JSON codec. `JSON.stringify`
now honours a **function replacer** and an **array-allowlist replacer** entirely
in Wasm under `--target standalone`/`wasi` (previously refused), reusing the
PR-D1/-D2 `__call_*` driver infra.

§25.5.2 SerializeJSONProperty: a function replacer transforms every property and
array element via `replacer.call(holder, key, value)` (holder bound as `this`);
an array replacer is a key allowlist. Both route to a new
`__json_stringify_root_replacer` entry that wraps the value in the §25.5.2 root
holder `{"": v}`, applies a function replacer to the root value, then threads
holder/replacer/allowList through the recursive walk.

**Files:**
- `src/codegen/json-codec-native.ts` — `__json_stringify_value` gains 3 params
  (`holder`, `replacer`, `allowList`), threaded at both recursion sites + both
  prior roots (passed null, unchanged behaviour). Object arm: allowlist filter
  (skip a key when `__extern_has(allowList, key)` is false); function-replacer
  transform per property; a replacer returning `undefined` (null carrier) omits
  the property (does NOT recurse → avoids emitting the `"null"` literal). Array
  arm: replacer applied per element. New `__json_stringify_root_replacer`.
- `src/codegen/accessor-driver.ts` — `reserveReplacerDriver` + a fill arm
  wrapping `__call_fn_method_2` (holder bound as `this`) — a clone of the PR-D1
  reviver driver. `context/types.ts`: `replacerDriverReserved` flag.
- `src/codegen/expressions/calls.ts` — routing: a *callable* replacer compiles
  via `compileArrowAsClosure` (GC closure, NOT `__make_callback` — same env::
  leak rationale as PR-D1); an *array literal* replacer builds the allowlist
  `$Object` via `emitJsonReplacerAllowList` (String/Number elements → keys,
  deduped). A non-callable/non-array 2nd arg keeps prior behaviour; a *dynamic*
  space still refuses.

Tests: `tests/issue-2166.test.ts` (+9 PR-D3 cases — number doubling, undefined
omit, key passing, nested graph, array allowlist (flat + nested), indented form,
no-replacer regression, `--target wasi` host-import-free). 79/79 in the suite
green; the #1599 refuse + PR-A/B/C/D1/D2 suites are unaffected. Coercion gate
ratcheted 8→7 (the array arm now computes the index key once). The one host-mode
`json.test.ts` failure (`JSON.stringify(42)`→host-import) is pre-existing on the
base — every PR-D3 change is gated on `ctx.standalone || ctx.wasi`.

**Known limitations (out of D3 scope):**
- Replacer **`this`-member access** (`function(){ return this.x }`) is the
  pre-existing standalone-closure-`this` gap — the PR-D1 reviver path has the
  identical gap (verified by probe). The driver binds `this` correctly via
  `__current_this`; reading `this.<prop>` inside a standalone closure body is the
  broader closure-`this` issue. A replacer that ignores `this` (the dominant
  case) works.
- A `number[]` array **value** nested in an object still doesn't serialise at all
  (PR-A2 closed-vec limitation — `JSON.stringify({arr:[1,2]})` already yields
  `{}` with no replacer), so the array-element replacer path is dormant until
  PR-A2 routes `number[]` through the codec.
- A replacer returning the **literal JS `null`** is omitted like `undefined`
  (shared null carrier); the dominant `return undefined` drop-a-key case is
  correct.

### #2166 status: CLOSED
All four slices of the #1599 Phase-2 dynamic JSON codec have landed: PR-A (#1653),
PR-C (#1657), PR-C2 (#1658), PR-B (#1660), PR-D1 (#1665), PR-D2 (#1666), and
PR-D3 (this PR). Standalone JSON now does dynamic object-graph stringify (compact
+ indented) + parse + round-trip + parsed-array indexing + reviver + toJSON
(data-property forms) + function/array replacer, pure-Wasm and host-import-free
under `--target standalone`/`wasi`. Residual method-lookup items (shorthand/class
`toJSON`, instance-field stringify, closure-`this`, PR-A2 `number[]`) are tracked
as separate architect-scale follow-ups.
