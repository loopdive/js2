---
id: 1599
title: "host-indep: JSON.parse / JSON.stringify in standalone mode"
status: done
created: 2026-05-24
updated: 2026-09-28
completed: 2026-09-28
priority: high
feasibility: hard
reasoning_effort: max
task_type: feature
area: codegen, runtime
language_feature: json
goal: standalone-wasm
sprint: 58
related: [1474, 1539, 4085, 6667, 6733, 6734]
claimed_by: codex-developer
claimed_at: 2026-06-02T11:02:41.061Z
# (2026-09-28, Phase 2 carriers) The closed-struct arm, the cycle-stack entry
# and the root re-scoping are cases of `emitJsonStringifyValue`'s own receiver
# ladder: they re-use its locals (L_ANY / P_DEPTH) and its proxy object walk
# verbatim. Their builders live in the new json-stringify-carriers.ts; only the
# call sites (+26 lines) land in the codec.
loc-budget-allow:
  - src/codegen/json-codec-native.ts
func-budget-allow:
  - src/codegen/json-codec-native.ts::emitJsonStringifyValue
---
# #1599 — JSON standalone: refuse-and-document then pure-Wasm implementation

## Problem

`JSON.stringify` and `JSON.parse` unconditionally register JS host imports with no
`ctx.standalone` guard (`src/codegen/declarations.ts:1065, 1069`):

```ts
addImport(ctx, "env", "JSON_stringify", { kind: "func", typeIdx }); // line 1065
addImport(ctx, "env", "JSON_parse", { kind: "func", typeIdx }); // line 1069
```

Any standalone/WASI module that calls `JSON.parse(s)` or `JSON.stringify(v)` fails
at instantiation with `unknown import env::JSON_stringify`.

JSON is one of the most common serialization primitives in npm packages. Without it,
modules that do any serialization (config parsing, API responses, logging) cannot
run standalone.

## Evidence: real standalone test262 run 2026-06-01

Artifacts:
`benchmarks/results/test262-standalone-report-20260601-213702.json` and
`benchmarks/results/test262-standalone-results-20260601-213702.jsonl`.

Standalone result: 4,368 / 43,106 passing (10.1%) versus the canonical JS-host
baseline of 30,480 / 43,106 (70.7%). JSON unsupported appears in 134
non-exclusive standalone failures. Phase 1 refusal avoids host imports; Phase 2
needs the pure-Wasm parser/stringifier to recover this test262 surface.

## Evidence: refreshed standalone test262 artifact 2026-06-02

Source: `loopdive/js2wasm-baselines` commit
`b4684d8f97a462c6414716aea46f31b67f48b959`,
`test262-standalone-current.jsonl`; js2 baseline
`ac88301967d70be11c9abb456051ff4afcd3a9d7`.

The ordered root-cause classifier assigns **95** rows primarily to #1599:
87 `compile_error` rows and 8 assertion-failure rows. The latest diagnostics
show Phase 1 is doing the right thing for unsupported standalone JSON paths:
the host imports are gone and the rows now fail at compile time with a
specific #1599 message. Phase 2 remains the pass-rate recovery work.

Representative diagnostics:

```text
Codegen error: JSON.parse of this value is not yet supported in --target standalone/wasi (#1599).
```

```text
Codegen error: JSON.stringify of this value is not yet supported in --target standalone/wasi (#1599).
```

Example files:

- `test/built-ins/JSON/parse/15.12.1.1-0-9.js`
- `test/built-ins/JSON/stringify/space-string-range.js`

## Phase 1 — Refuse-and-document (fast follow to #1474 pattern)

Gate the import registration on `!ctx.standalone`. Add a `reportError` at the
call site when `ctx.standalone`:

```ts
if (state.jsonNeedStringify) {
  if (ctx.standalone) {
    // deferred to Phase 2 — emit compile error
    // (reportError will be called at the actual JSON.stringify call site)
  } else {
    addImport(ctx, "env", "JSON_stringify", { kind: "func", typeIdx });
  }
}
```

At the call sites in `string-ops.ts` / `expressions/calls.ts` that lower
`JSON.stringify(...)` and `JSON.parse(...)`, add:

```ts
if (ctx.standalone) {
  reportError(
    ctx,
    expr,
    "JSON.stringify / JSON.parse is not supported in --target standalone (#1599). " +
      "Use a pure-JS serializer compiled with js2wasm, or avoid JSON in WASI targets.",
  );
  return null;
}
```

Phase 1 is ~30 LOC, follows the exact same pattern as #1474 Phase 1.

## Phase 2 — Pure-Wasm JSON implementation

Implement JSON serialisation and deserialisation directly as Wasm helper emitters
operating on the existing WasmGC type graph. No C library, no side module, no
marshalling layer.

**Why not cJSON or a C side module**: cJSON returns a C struct tree, not WasmGC
types. stringify would need to walk the WasmGC value graph into C memory first;
parse would need to reconstruct WasmGC objects/arrays from the C struct output.
That marshalling layer is more code and more fragile than implementing the codec
directly against the types we already have.

### Serialiser (`JSON.stringify`) — `src/codegen/wasm-helpers/json-stringify.ts`

Recursive value walker over the WasmGC value graph:

- `null` / `undefined` → emit `"null"`
- `boolean` → emit `"true"` / `"false"` (tag check on externref)
- `number` (f64) → `__f64_to_string` (already exists); emit `"null"` for NaN/Infinity per spec
- `string` (`$StringArr`) → scan UTF-16 code units, escape `"`, `\`, and control chars U+0000–U+001F
- `array` (`$Array`) → `[` + iterate elements recursively + `]`
- `object` (`$PlainObject`) → `{` + iterate own enumerable string keys + `:`+ value + `}`
- Circular reference detection: thread a seen-set (linear scan over a local `(array ref)` — JSON depth is shallow in practice)
- `toJSON()` method: check for it via the existing property-lookup path before serialising

Result: accumulate into a `(array (mut i16))` builder, return as `$StringArr`.

### Deserialiser (`JSON.parse`) — `src/codegen/wasm-helpers/json-parse.ts`

Recursive-descent parser over a `$StringArr` (array i16, UTF-16). JSON grammar
has no lookahead beyond one character:

```
value    := null | true | false | number | string | array | object
string   := '"' chars '"'
array    := '[' (value (',' value)*)? ']'
object   := '{' (string ':' value (',' string ':' value)*)? '}'
number   := '-'? int frac? exp?
```

- Parser state: `(local $pos i32)` cursor into the string array
- `skipWhitespace`: advance past space/tab/CR/LF
- `parseString`: scan code units, handle `\uXXXX` and standard escapes, allocate `$StringArr`
- `parseNumber`: accumulate digits, call `__parse_f64` (or inline) → f64 → box as externref
- `parseArray`: allocate `$Array`, push parsed values
- `parseObject`: allocate `$PlainObject`, set key-value pairs via existing property-set helper
- Error: on malformed input, emit `unreachable` (Wasm trap in standalone; caller catches as SyntaxError in JS-host mode)

~350 LOC of helper emitters total across both files. No new WasmGC types needed.

## Files

### Phase 1

- `src/codegen/declarations.ts` lines 1065, 1069 — add `ctx.standalone` guard
- Call sites for `JSON.stringify` / `JSON.parse` in `src/codegen/expressions/calls.ts`
  — add `reportError` when `ctx.standalone`
- `tests/issue-1599-json-standalone-refuse.test.ts` — refusal tests

### Phase 2

- `src/codegen/wasm-helpers/json-stringify.ts` — serialiser helper emitter
- `src/codegen/wasm-helpers/json-parse.ts` — recursive-descent parser helper emitter
- `src/codegen/declarations.ts` — wire up helpers when `ctx.standalone && state.jsonNeed*`

## Acceptance criteria

### Phase 1

- `--target standalone` module using `JSON.parse` or `JSON.stringify` fails at
  compile time with a clear error referencing #1599.
- No `env::JSON_parse` or `env::JSON_stringify` in standalone output.

### Phase 2

- `JSON.stringify({a: 1, b: [2, 3]})` returns `'{"a":1,"b":[2,3]}'` in standalone.
- `JSON.parse('{"x":42}').x === 42` in standalone.
- Passes `test/built-ins/JSON/*` test262 subset under `--target standalone`.

## Effort

Phase 1: ~30 LOC, easy.
Phase 2: ~350 LOC (serialiser + parser helper emitters), hard. No external toolchain.

## Status — Phase 1 done (PR fix(#1599))

**Phase 1 (refuse-and-document) is implemented and merged.** Phase 2
(pure-Wasm codec) remains a follow-up.

### What landed

- `src/codegen/declarations.ts` — `env::JSON_stringify` / `env::JSON_parse`
  imports are now gated on `!(ctx.wasi || ctx.standalone)`. No JSON host import
  is registered in standalone / WASI output. (Both targets lack the JS host;
  the spec mentioned only `ctx.standalone`, but `--target wasi` has the same
  instantiation failure, so the guard covers both — matching the #1473 sibling
  precedent `ctx.wasi || ctx.standalone`.)
- `src/codegen/expressions/calls.ts` — at the `JSON.stringify` / `JSON.parse`
  call site, when `ctx.standalone || ctx.wasi` and the value is not handled by
  the pure-Wasm primitive slice (#1324), emit a `reportError` whose message
  starts with `Codegen error:` (required to flip `CompileResult.success` to
  `false` per `src/compiler.ts`) referencing #1599.
- `tests/issue-1599-json-standalone-refuse.test.ts` — 12 tests: refusal of
  object/array/string/number stringify + all parse (standalone AND wasi), no
  `env::JSON_*` import emitted, primitive `null`/`true` stringify still compiles
  standalone, and default JS-host mode unchanged.

### Spec anchors

- ECMA-262 §25.5.2 `JSON.parse` and §25.5.2.1 `ParseJSON`: full standalone
  support must parse ECMA-404 JSON text to ECMAScript values and throw
  `SyntaxError` for invalid JSON text.
- ECMA-262 §25.5.4 `JSON.stringify` and §25.5.4.2
  `SerializeJSONProperty`: full standalone support must return a UTF-16 JSON
  String or `undefined`, with `null`/boolean/number/string/object/array rules
  and `TypeError` for BigInt/cycles. Phase 1 intentionally refuses shapes that
  would otherwise route to the JS host.

### Acceptance criteria — Phase 1

- ✅ `--target standalone`/`wasi` module using non-primitive `JSON.stringify`
  or any `JSON.parse` fails at compile time with a clear `#1599` error + source
  location.
- ✅ No `env::JSON_parse` / `env::JSON_stringify` in standalone/wasi output.

### Notes for Phase 2 (follow-up — NOT in this PR)

- The primitive `JSON.stringify` slice (#1324) covers `null` / `undefined` /
  `boolean` standalone, but **`number` is NOT standalone-safe**: that slice
  lowers via `env::number_toString`, a host import absent in standalone/wasi.
  So `JSON.stringify(42)` is (correctly) refused with the #1599 message today.
  Phase 2 must add a pure-Wasm f64→string path (or reuse `__f64_to_string`) to
  unblock the number primitive standalone.
- Remaining Phase 2 scope unchanged from the spec above: pure-Wasm serialiser
  (`json-stringify.ts`) + recursive-descent parser (`json-parse.ts`) over the
  WasmGC value graph. Acceptance: `JSON.stringify({a:1,b:[2,3]})` →
  `'{"a":1,"b":[2,3]}'` and `JSON.parse('{"x":42}').x === 42` standalone.

### Validation — 2026-06-01

- `pnpm exec vitest run tests/issue-1599-json-standalone-refuse.test.ts` —
  12 tests passed after adding the standalone `JSON.stringify(number)` refusal
  regression case.

## Status — Phase 2A literal standalone slice implemented

This branch implements the first runtime-host-independent JSON slice for
standalone/WASI while keeping unsupported dynamic JSON on the existing clear
`#1599` compile-error path.

### What changed

- `src/codegen/json-standalone.ts` adds a bounded static JSON evaluator:
  - `JSON.stringify(<static JSON-compatible literal graph>)` is folded at
    compile time and emitted as a native string, with runtime output fully
    standalone.
  - `JSON.parse(<static string literal>).prop` and `[index]` are parsed by the
    compiler and lowered to Wasm constants/native strings.
  - static JSON primitive parses (`"x"`, `42`, `true`, `null`) lower without
    `env::JSON_parse`.
- `src/codegen/declarations.ts` now registers `number_toString` for
  `JSON.stringify(number)` so standalone/WASI use the existing pure-Wasm native
  number formatter instead of refusing or importing `env::number_toString`.
- `src/codegen/expressions/calls.ts` now returns the concrete emitted string
  type for primitive/static JSON stringify. This also fixes the native-string
  standalone path that previously could materialize string constants through
  the `stringGlobalMap` sentinel as `global.get -1`.
- `src/codegen/property-access.ts` bypasses the generic `__extern_get` path for
  static `JSON.parse(...).prop` / `[index]` reads, so these forms do not pull in
  JS-host property imports.
- `tests/issue-1599.test.ts` covers the concrete standalone runtime examples:
  `JSON.stringify({a:1,b:[2,3]})`, `JSON.parse('{"x":42}').x`, static array
  parse indexing, string escaping, dynamic number stringify, and dynamic parse
  refusal.
- `tests/issue-1599-json-standalone-refuse.test.ts` was updated so dynamic
  object/array/string stringify and dynamic parse still refuse, while the new
  static/number slices compile without JSON host imports.

### Current support boundary

- Supported now: static JSON-compatible object/array/string/number/boolean/null
  literal graphs for stringify; static JSON text property/index reads for parse;
  dynamic number stringify.
- Still refused: dynamic JSON text parsing and dynamic object/array/string value
  walking. These still need the full WasmGC JSON value graph/parser/stringifier
  described above before the full `test/built-ins/JSON/*` standalone subset can
  be claimed.

### Spec anchors

- ECMA-262 §25.5.2 `JSON.parse` / `ParseJSON`.
- ECMA-262 §25.5.4 `JSON.stringify`, especially §25.5.4.2
  `SerializeJSONProperty` and §25.5.4.3 `QuoteJSONString`.

### Validation — 2026-06-03

- `pnpm exec vitest run tests/issue-1599.test.ts tests/issue-1599-json-standalone-refuse.test.ts`
  — 20 tests passed.

## Status — Phase 2 Slice (a): runtime `JSON.stringify(string)` (pure-Wasm)

The first **runtime** (value-dependent) Phase 2 slice landed: `JSON.stringify(s)`
where `s` is a runtime string value now lowers to a pure-Wasm helper in
`--target standalone` / `--target wasi`, with **no** `env::JSON_stringify` host
import.

### What changed

- `src/codegen/json-runtime.ts` (new) — `emitJsonQuoteString(ctx)` emits
  `__json_quote_string(s: externref) -> ref $NativeString`: flattens the input
  `$AnyString`, two-pass (size then fill) over its `[off, off+len)` UTF-16 code
  units into a fresh `$__str_data` buffer, applying ECMA-262 §25.5.4.3
  `QuoteJSONString` escaping — `"`→`\"`, `\`→`\\`, the short escapes
  `\b \t \n \f \r`, and every other control char U+0000–U+001F as `\u00XX`.
  Returns the result as a **native string ref** (matching `compileStringLiteral`
  in nativeStrings mode) so downstream string ops (`===`, return) see the type
  they expect rather than an over-wrapped externref.
- `src/codegen/index.ts` — `collectPrimitiveMethodImports` pre-pass detects
  `JSON.stringify(<string-typed arg>)` under standalone/wasi and pre-registers
  `__json_quote_string` up-front (stable defined-function index, no mid-body
  shift).
- `src/codegen/expressions/calls.ts` — `tryEmitJsonStringifyPrimitive` now
  handles the `StringLike` case for standalone/wasi via `__json_quote_string`;
  JS-host mode still falls through to `JSON_stringify` (it observes
  replacer/space/toJSON, which the helper does not).
- `tests/issue-1599-runtime.test.ts` (new) — 6 wasmtime/WebAssembly round-trip
  tests: plain string, quote+backslash, short control escapes, `\u00XX`
  control escapes, empty runtime string, and "no `env::JSON_stringify` import".
- `tests/issue-1599-json-standalone-refuse.test.ts` — the obsolete
  "rejects JSON.stringify of a dynamic string" case flipped to
  `expectAccepted` (string stringify is now implemented).

### Spec anchors

- ECMA-262 §25.5.4 `JSON.stringify`, §25.5.4.3 `QuoteJSONString`.

### Validation — 2026-06-03

- `pnpm exec vitest run tests/issue-1599.test.ts tests/issue-1599-json-standalone-refuse.test.ts tests/issue-1599-runtime.test.ts`
  — 26 tests passed.

### Phase 2 remaining (follow-ups — NOT in this slice)

1. **Runtime `JSON.parse(s)` → primitive `$AnyValue`** (number/bool/null):
   feasible now via the host-free `$AnyValue` tagged union
   (`src/codegen/any-helpers.ts`). Carved as a dev follow-up.
2. **Runtime `JSON.parse(s)` → string**: blocked on a cross-cutting change —
   the shared `$AnyValue` strict-equals helper (`__any_strict_eq` in
   `any-helpers.ts`) degrades the tag-5 (string) branch to `i32.const 0` when
   the wasm:js-string `equals` import is absent (i.e. standalone), so a parsed
   string returned as `$AnyValue` compares unequal. Needs a native
   `__str_equals` (exists, `native-strings.ts`) fallback in that branch, storing
   the parsed string in `refval`. **Senior-dev owned** (edits shared runtime
   equality semantics).
3. **Object/array graphs** (parse→objects, stringify of object/array graphs):
   blocked on the Wasm-native open-object runtime (#1472 Phase B). Sequence
   after it lands.

`status` stays `ready` because Phase 2 (full dynamic codec) is not complete;
this slice only adds runtime string stringify.

## Status — Phase 2 Slice (b): runtime `JSON.parse(s)` primitive (pure-Wasm)

The next **runtime** Phase 2 slice landed: `JSON.parse(s)` where `s` is a
runtime string value holding a JSON **primitive** — number / `true` / `false`
/ `null` — now lowers to a pure-Wasm helper in `--target standalone` /
`--target wasi`, with **no** `env::JSON_parse` host import.

### What changed

- `src/codegen/json-runtime.ts` — `emitJsonParsePrimitive(ctx)` emits
  `__json_parse_primitive(s: externref) -> ref $AnyValue`: flattens the input
  `$AnyString`, skips ASCII whitespace, dispatches on the first non-ws char,
  and boxes the result into the host-free `$AnyValue` tagged union
  (`src/codegen/any-helpers.ts`):
  - `n` → box `null` (tag 0);
  - `t` / `f` → box boolean `true` / `false` (tag 4);
  - `-` or `0`–`9` → inline JSON-number scan (sign, integer, fraction,
    `e`/`E` exponent) accumulating an f64 mantissa + base-10 exponent, then
    `sign * mant * 10^exp` boxed as f64 (tag 3);
  - anything else → `unreachable` (Wasm trap; the standalone no-host analogue
    of a `SyntaxError`).
- `src/codegen/expressions/calls.ts` — `tryEmitJsonParsePrimitive` fires at the
  `JSON.parse` call site after `tryEmitJsonParseLiteral`, gated on
  `ctx.standalone || ctx.wasi` and a string-typed argument. It returns the
  `ref $AnyValue` type so the existing AnyValue→primitive coercion in
  `type-coercion.ts` unboxes the result to number / boolean as the consumer
  requires. It deliberately **does not** claim `JSON.parse(s).x` /
  `JSON.parse(s)[i]` (property/element reads imply an object/array parse) —
  those still hit the #1599 refusal pending the full Phase 2 codec.
- `tests/issue-1599-runtime.test.ts` — 8 new wasmtime/WebAssembly round-trip
  tests: number (`123.45`), negative exponent (`-7e2`), leading-zero fraction
  (`0.5`), `true`/`false`, `null` (typeof "object"), whitespace-trimmed number,
  and two "no `env::JSON_parse` import" assertions (standalone + wasi).

### Current support boundary

- Supported now: runtime `JSON.parse(s)` of a JSON **primitive** string
  (number / boolean / null) → boxed `$AnyValue`, consumed as number / boolean.
- Still refused: dynamic `JSON.parse(s)` consumed as an **object/array**
  (`.prop` / `[index]` reads), and `JSON.parse(s)` returning a **string** value
  — both need the open-object runtime / `__any_strict_eq` native string fallback
  per the Phase 2 follow-ups above.
- Note: `JSON.parse("null") === null` against the boxed `$AnyValue` is a
  separate pre-existing AnyValue-equality concern (the value is correctly boxed
  tag-0; `typeof` reports "object"); it rides with the string-`__any_strict_eq`
  follow-up, not this slice.

### Spec anchors

- ECMA-262 §25.5.2 `JSON.parse` / §25.5.2.1 `ParseJSON`; ECMA-404 JSON number
  grammar.

### Validation — 2026-06-03

- `pnpm exec vitest run tests/issue-1599-runtime.test.ts tests/issue-1599.test.ts tests/issue-1599-json-standalone-refuse.test.ts`
  — 34 tests passed.

## Implementation Plan — Phase 2 carriers (2026-09-28, executed)

Measured first (branch base `2e23e49fb1`, `--target standalone`, results
compared in-Wasm): every statically array-typed value (`number[]`, `T[]`,
`any[]`) hit the #1599 refusal, and every closed struct (class instance, typed
object literal, a literal with a `toJSON` method) serialised as `null`. The
codec already walked `$Object`, `$ObjVec`, `$__vec_base` (#4085) and `$Proxy`;
what was missing was routing and two carriers.

1. **Routing** (`call-namespace-static.ts`): refuse only a TUPLE (a positional
   closed struct no arm reads); every other array value goes to the codec, whose
   vec arm (#4085) already normalises it. The static type test moves from the
   raw checker to `ctx.oracle.typeFactOf` (oracle ratchet −1 `getTypeAtLocation`).
2. **Closed user structs** (`json-stringify-carriers.ts`, one arm in the codec):
   screened by the finalize-time `__object_assign_closed_struct_source`
   classifier (user-declared shapes only — builtins, vecs, strings, proxies and
   closures stay out) and walked by the codec's existing MOP object walk
   (`__object_keys` + `__extern_get`, the proxy object arm) — §25.5.2.5.
3. **toJSON on closed structs**: the toJSON gate admits the same classifier; a
   class-prototype `toJSON` is found through a `__get_member_toJSON`
   dispatcher reserved at the call site when some class declares `toJSON`.
4. **Cycles → TypeError** (§25.5.2.5/6 step 1): a depth-indexed stack
   (`__json_cycle_stack`, an `$ObjVecArr`) — the value at depth `d` is stored in
   slot `d` and compared (`ref.eq`) with slots `[0, d)`, which are exactly its
   ancestors because every value is entered and every recursion passes
   `depth + 1`. Each root saves/restores the stack so a re-entrant stringify
   from `toJSON`/a replacer cannot clobber its caller's chain.
5. **Function replacer on a primitive root** (§25.5.2 step 12): skip the
   primitive fold under a native callable replacer (except a statically
   `undefined` root, whose `undefined` result the codec root cannot yet return)
   and box the primitive as externref for the replacer root. Needed so that
   `replacer-function-result.js` does not flip: on the parent it passed only
   because both sides of its `sameValue` were the same wrong `"null"`.

JSON.parse already has the full pure-Wasm grammar (#2166 PR-C); no parse work
was needed for this slice.

## Resolution (2026-09-28)

- `tests/issue-1599-stringify-carriers.test.ts` — 10 tests, all zero-import
  standalone, compared in-Wasm against Node's answer: 10/10 with the fix,
  1/10 on the parent (the tuple-still-refuses control passes on both).
- Scoped standalone test262 `built-ins/JSON` (165 files,
  `scripts/run-test262-paths.mts --standalone`): parent 107 pass / 51 fail / 7
  CE → fix 113 / 49 / 3. Gains: `replacer-array-number`,
  `replacer-function-array-circular`, `replacer-function-object-circular`,
  `space-string`, `value-array-circular`, `value-tojson-object-circular`.
  Losses: none.
- three 0.185.1 standalone-dynamic lane: parent stops at
  `JSON.stringify of this value is not yet supported by the native JSON provider (#1599)`;
  fix compiles past it and stops at a program-ABI invariant filed as
  [#6733](https://js2wasm.loopdive.com/dashboard/issue.html?slug=6733-standalone-three-inherited-getter-alias-signature)
  (A/B: identical with the `toJSON` reservation disabled). The #6667 regex
  replace refusal no longer occurs on this base.
- Sampled standalone test262 outside JSON (268 files: every 60th of
  `built-ins/{Array,Object,Map}` and `language/{expressions,statements}/class`,
  plus the 16 non-JSON files that call `JSON.stringify`): 215 pass on both
  parent and fix; three Temporal files move compile_error → fail (they now
  compile and fail on Temporal, not JSON).
- Existing tests updated to the new contract: the #1599 refusal suite now
  refuses a tuple instead of `number[]`; #5269 F1 r6 expects Node's
  `"wrapped:1"` (it pinned the old ignored-replacer `1`). Three failures in the
  JSON test files (`json.test.ts` host-import, `issue-1599.test.ts` dynamic
  parse refusal, `issue-1599-runtime.test.ts` true/false) fail identically on
  the parent.
- Remaining stringify gaps (top-level `undefined`, wrapper objects, `$Object`
  getters, dynamic `space`, empty/builtin structs, BigInt, tuples) are
  [#6734](https://js2wasm.loopdive.com/dashboard/issue.html?slug=6734-standalone-json-stringify-carrier-residuals).
