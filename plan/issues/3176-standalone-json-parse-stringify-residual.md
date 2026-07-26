---
id: 3176
title: "standalone: JSON.parse/stringify spec residual — reviver array walk illegal-cast, SyntaxError strictness, replacer/space edges (67 gap tests)"
status: ready
created: 2026-07-12
updated: 2026-07-26
priority: high
feasibility: hard
task_type: bug
area: codegen
es_edition: multi
language_feature: json
goal: standalone
umbrella: 2860
sprint: current
horizon: m
related: [2860, 2671, 3046, 1353, 1636]
origin: "PO groom of #2860 umbrella, 2026-07-12 lane-baseline diff; slices the JSON area of tracking issue #2671"
loc-budget-allow:
  - src/codegen/json-codec-native.ts
  - src/codegen/expressions/calls.ts
  - src/codegen/expressions/call-namespace-static.ts
  - src/codegen/expressions/call-builtin-static.ts
  - src/codegen/builtin-static-globals.ts
  - src/codegen/native-proto.ts
  - src/codegen/object-runtime.ts
coercion-sites-allow:
  - src/codegen/json-codec-native.ts
---

# #3176 — standalone: JSON.parse/stringify spec residual

## Problem

**67 host-pass tests are not host-free-standalone passes** under
`built-ins/JSON/` (parse 30, stringify 29, rawJSON 5, isRawJSON 2,
Symbol.toStringTag 1; 58 fail + 9 compile_error; measured 2026-07-12
lane-baseline diff, method in #3169). Slices the JSON area of tracking issue
#2671 for the standalone lane.

Measured signatures:

- **`L80:3 illegal cast [in test()]`** (10 rows, the largest single bucket) —
  the parse **reviver** walking ARRAY holders:
  `reviver-array-non-configurable-prop-delete.js` and siblings. The
  InternalizeJSONProperty walk over array elements (delete-on-undefined,
  `[[Delete]]`/`[[DefineOwnProperty]]` fidelity, holder `this` — #3046 fixed
  the object-holder binding) mis-casts on the array arm.
- **SyntaxError strictness** (6 rows: `assert.throws(SyntaxError, …)` not
  thrown) — the native parser accepts invalid JSON (15.12.2-2-\* corpus:
  bare `+`, trailing garbage, control chars in strings, leading zeros).
- stringify edges: replacer-array key filtering with numeric keys,
  `space` coercion (`JSON.stringify(obj, null, boxedNumber)`), circular
  detection `TypeError`, `Symbol.toStringTag` descriptor row, holes
  (`arr.hasOwnProperty('1')` after roundtrip).
- rawJSON/isRawJSON (7 rows): new ES2025 statics — recognizer + carrier over
  the existing codec.

## ANTI-BLOAT directive

- The native codec EXISTS across `src/codegen/json-codec-native.ts`,
  `json-runtime.ts`, `json-standalone.ts`. Fix the reviver's ARRAY-holder arm
  inside the existing InternalizeJSONProperty walk (it already handles object
  holders per #3046) — do not fork a second walk.
- Grammar strictness: tighten the EXISTING scanner's token rules; add the
  rejected-input corpus as unit tests. No second parser.
- rawJSON: register via the existing builtin-static tables
  (`builtin-static-globals.ts` / `builtin-fn-meta.ts`, the #2933 namespace
  pattern) — table entries, not a new dispatch path.

## Acceptance criteria

- ≥48 of the 67 measured gap tests under `built-ins/JSON/` flip to host-free
  standalone passes (the 9 CE rows must at minimum stop CE-ing).
- Sample tests:
  - `test/built-ins/JSON/parse/reviver-array-non-configurable-prop-delete.js`
  - `test/built-ins/JSON/parse/15.12.2-2-9.js` (SyntaxError strictness)
  - `test/built-ins/JSON/Symbol.toStringTag.js`
- Zero host-mode regressions; zero standalone high-water regressions.
- One PR, JSON only.

## 2026-07-12 — root-cause correction + honest scoping (dev-json)

Faithful reproduction (via `wrapTest`, gc-vs-standalone scan of all 165
`built-ins/JSON` tests) revised the plan's root-cause attribution:

- **The "illegal cast (10 rows)" bucket is NOT the reviver ARRAY-holder walk.**
  It is the `parse/15.12.2-2-*` SyntaxError-strictness family, and the trap is a
  **general standalone `for (var k in arr)` + array string-index bug in the test
  harness loop** — NOT in the JSON codec (proved by ablation: the trap persists
  after removing the `JSON.parse` call from the loop body). Filed as **#3179**
  (broad-impact standalone for-in bug). Those 10 files are BLOCKED on #3179;
  once it lands they pass, because this PR's SyntaxError strictness already
  makes them reject correctly.
- **The `reviver-array-non-configurable-prop-delete.js` file** is `FAIL`, not
  illegal-cast; array-holder `[[Delete]]` fidelity is separate residual scope.
- **Realistic JSON-only ceiling ≈ 43 rows** (of the 67): 10 illegal-cast rows
  are blocked on #3179 and the 2 `*-proxy-revoked` rows are deferred (Proxy is a
  deferred feature). So the "≥48" threshold is **not reachable via JSON alone** —
  it depends on #3179.

### Shipped in this PR (host-free standalone; all `ctx.standalone`-gated)

1. **JSON.parse SyntaxError strictness** in the native string parser
   (`json-codec-native.ts` `__json_parse_str`): unescaped control chars
   (U+0000..U+001F) and invalid `\uXXXX` escapes (short / non-hex) now throw
   `SyntaxError`. Flips **`parse/15.12.1.1-g4-1..4`, `g5-2`, `g5-3`** (6 files).
2. **ES2025 `JSON.rawJSON` / `JSON.isRawJSON`** (`emitJsonRawJson` /
   `emitJsonIsRawJson` in `json-codec-native.ts` + dispatch in
   `expressions/calls.ts`). The `[[IsRawJSON]]` internal slot is a bit on
   `$Object.flags` (`OBJ_FLAG_RAWJSON`, exported from `object-runtime.ts`), so a
   plain `{ rawJSON: '…' }` is not recognised. `rawJSON` reuses the native
   parser to validate a single-primitive argument. Flips
   **`rawJSON/{returns-expected-object,invalid-JSON-text,illegal-empty-and-start-end-chars}`**
   and **`isRawJSON/basic`** (4 files).

Total shipped: **10 files (~20 rows)** flipped standalone, zero host-lane change
(all changes are standalone/wasi-gated; the native codec is not used in gc mode).

Note on reuse: the plan pointed rawJSON at `builtin-static-globals.ts` /
`builtin-fn-meta.ts`; the actual dynamic `JSON.<method>` call dispatch lives in
`expressions/calls.ts`, and the carrier is minted through the existing
`object-runtime` — that is where the code went. Also: the codec's own
`ToString` is self-contained (tag-dispatch on the boxed value) rather than
`__any_to_string`, because that helper's boxed-number/boolean arms go dead when
it is baked before the union-import box structs are registered (a harness
`assert_compareArray` triggers exactly that order) — a pre-existing shared-codegen
fragility out of scope for a JSON-only PR.

### Remaining (keeps #3176 in-progress)

- **Blocked on #3179**: `parse/15.12.2-2-1..10` (10 files).
- **stringify edges**: `space-number-range`, `space-wrong-type`,
  `space-number-float` (runtime `space` coercion of boxed/out-of-range Number);
  `replacer-array-number`, `replacer-array-wrong-type` (numeric replacer keys).
- **descriptor rows** (`rawJSON/builtin`, `isRawJSON/builtin`, `parse/builtin`,
  `stringify/builtin`, `Symbol.toStringTag`): need real function-object /
  `@@toStringTag` descriptors — separate reflection scope.
- **`parse/S15.12.2_A1`** (`__proto__` own-property on parse),
  `parse/text-negative-zero`, `parse/text-object-abrupt`.
- **ES2025 reviver source-text** (`reviver-context-source-*`): `JSON.parse`
  3rd-arg `context.source` — larger feature.
- **`value-string-escape-ascii`**: blocked on `Object.values` / computed keys,
  not JSON.
- **deferred**: the 2 `*-proxy-revoked` rows (Proxy).

## Stale-verify (2026-07-24, dev-std-4) — headline PASSES, keep ready

MEASURED on current `main` (`--target standalone`, host-free): the JSON headline
now works — `JSON.stringify({a:1})`→`{"a":1}`, `JSON.stringify({a:[1,2]})`→
`{"a":[1,2]}`, `JSON.parse('{"a":7}').a`→7, and (the SyntaxError-strictness
bucket) `JSON.parse("+1")` throws SyntaxError. The native codec + object/array
stringify + parse are solid; #1353 (the open-ended shape-walking spec request)
is now superseded by this issue. Keep `ready` but RE-MEASURE the full
`built-ins/JSON/**` dirs (parse 77 + stringify 66) to size the true residual
against the stale "67 gap tests" figure — the reviver-array-walk illegal-cast
and replacer/space edges likely remain, but the count needs refreshing.

## 2026-07-26 — rawJSON stringify integration (pre-reflection A/B)

Re-measured all 165 `built-ins/JSON/**` records on pristine
`origin/main@afe92ffd291651bd43c599fc027435a1a5bbe482` through the literal
test262.fyi original-harness assembler under the authoritative Node 25 /
Unicode 17 runtime:

- standalone: **73/165**
- gc/host control: **116/165**
- host-pass / standalone-fail gap: **44 files**

This replaces the stale 130/165 standalone headline: that number came from an
older, inflated lane rather than the current de-inflated original-harness
contract. The current gap is dominated by stringify (27 files), followed by
parse (9), rawJSON (4), isRawJSON (3), and `Symbol.toStringTag` (1).

### Shipped slice

The highest-impact bounded JSON-only slice was rawJSON composition through the
existing native stringify codec:

1. `__json_stringify_value` now recognizes the existing
   `OBJ_FLAG_RAWJSON` internal-slot brand after `toJSON` / replacer processing
   and emits the carrier's validated source text verbatim.
2. Direct non-spread JSON array literals are normalized into the existing
   `$ObjVec` carrier. Nested arrays and plain object elements reuse the existing
   object runtime, which also lets the empty replacer-array path serialize
   `[1, {a: 2}]` correctly.
3. `JSON.rawJSON` now applies its self-contained primitive ToString conversion
   to `$AnyValue` carriers as well as native number/boolean boxes. This covers
   generic array/union lanes without depending on shared helper-emission order.

No parser, serializer, object walk, or array ABI was forked.

The emitted instruction sequences are assembled in small top-level builders
rather than inline in `compileNamespaceStaticCall`, `emitJsonStringifyValue`,
and `emitJsonRawJson`. This is a structural quality-gate fix: it keeps those
already-large dispatcher/generator functions within the R-FUNC ceilings while
preserving the exact stack order and reusing the same runtime helpers.

### Exact local A/B

- standalone: **73/165 → 76/165**
- FAIL → PASS:
  - `built-ins/JSON/isRawJSON/basic.js`
  - `built-ins/JSON/rawJSON/basic.js`
  - `built-ins/JSON/stringify/replacer-array-empty.js`
- standalone PASS → FAIL: **0**
- gc/host: **116/165 → 116/165**, with **0** file-level verdict changes

On that pre-reflection base, the residual was 41 host-pass /
standalone-fail files.

### Test results

- `pnpm exec vitest run tests/issue-3176.test.ts` — **6/6 passed**
  (standalone and WASI; empty WebAssembly import table asserted)
- authoritative full `built-ins/JSON/**` standalone and gc/host A/B — results
  above
- `pnpm run typecheck`
- `pnpm exec prettier --check ...`
- `pnpm run check:coercion-sites`
- `pnpm run check:test262-hard-errors`
- `pnpm run check:ir-fallbacks`

## 2026-07-26 — runtime JSON reflection completion (codex)

Authoritative local-v-local measurement used the literal test262.fyi harness,
the real standalone worker, Node 25.9.0 / Unicode 17, and all 165
`built-ins/JSON/**` rows:

- pre-change standalone: **73/165**
- pre-change gc/host: **116/165**
- post-change standalone: **82/165** (**+9**, zero regressions)
- post-change gc/host: **116/165** (zero flips, zero regressions)

The stale descriptor note above was accurate about the symptom but not the
shared root cause. Direct `<Builtin>.<method>` accesses already had closure and
metadata lowering. Test262's `propertyHelper.js` erases the receiver/key types,
so reflection instead observes the runtime namespace carrier. The standalone
JSON carrier was an empty `$Object`; dynamic gOPD/hasOwn therefore reported the
four methods absent, while dynamic `JSON[Symbol.toStringTag]` returned
undefined.

The fix seeds the JSON carrier at lazy materialization time with the same
identity-stable builtin-function singletons used by direct VALUE reads:

- `parse`, `stringify`, `rawJSON`, and `isRawJSON` are genuine own data
  properties with `{writable:true, enumerable:false, configurable:true}`;
- `@@toStringTag` uses the real well-known-symbol carrier and the descriptor
  `{writable:false, enumerable:false, configurable:true}`.

This seed is intentionally separate from `SUPPORTED_STATIC_PROPS`. Adding the
JSON methods there would reroute direct property/call lowering through the old
Array/Object-only static-function path and regress working codec calls.

The four `*/builtin.js` rows exposed the next shared layer: metadata-bearing
builtin closure wrappers were treated as primitives by object-integrity and
prototype runtime helpers. Their type set is source-order dependent, so eager
runtime construction would be incomplete. `fillBuiltinFnMeta` now splices the
complete finalized subtype set into `isExtensible`/`isFrozen`/`isSealed` and
`getPrototypeOf`; matches are extensible function objects whose prototype is
the existing identity-stable `%Function.prototype%` singleton. This is why the
change lives in the shared builtin-function metadata finalizer rather than four
JSON-specific call-site exceptions.

Exact standalone flips:

- `JSON/{parse,stringify,rawJSON,isRawJSON}/prop-desc.js`
- `JSON/{parse,stringify,rawJSON,isRawJSON}/builtin.js`
- `JSON/Symbol.toStringTag.js`

The independently completed rawJSON-stringify branch
(`codex/3176-json-residual`, implementation commit
`f147f6c9d3858b04f6641ff2756958ed439258f9`) was inspected and deliberately
excluded here; this slice does not modify `json-codec-native.ts` or its
raw-carrier serialization.

The current measured host-pass/standalone-fail residual is **35 rows**:
stringify 25, parse 7, rawJSON 2, isRawJSON 1. These are codec/coercion,
Proxy/RegExp, or global-environment semantics, not more namespace reflection.

## 2026-07-26 — combined post-reflection rawJSON A/B

After the reflection slice merged as PR #3654 and the RegExp range slice merged
as PR #3647, the rawJSON codec slice was composed with pristine
`origin/main@fa10458427350db9b9b7912d6577f9b72bbb4a6c` and all 165
`built-ins/JSON/**` records were rerun through the same literal test262.fyi
original-harness assembler under Node 25 / Unicode 17:

- standalone: **82/165 → 85/165**
- FAIL → PASS:
  - `built-ins/JSON/isRawJSON/basic.js`
  - `built-ins/JSON/rawJSON/basic.js`
  - `built-ins/JSON/stringify/replacer-array-empty.js`
- standalone PASS → FAIL: **0**
- gc/host: **116/165 → 116/165**
- gc/host file-level verdict changes: **0**

The current host-pass / standalone-fail residual is therefore **32 rows**:
stringify 24, parse 7, rawJSON 1. `isRawJSON` has no remaining host-pass gap.
Keep #3176 `ready`: the remaining rows are separate codec/coercion,
Proxy/RegExp, or object-model semantics.

Combined validation also passed 25/25 focused tests across rawJSON composition,
JSON namespace reflection, shared builtin-function metadata, and the
GeneratorPrototype call/apply safeguards, plus typecheck and the function/LOC
quality gates.
