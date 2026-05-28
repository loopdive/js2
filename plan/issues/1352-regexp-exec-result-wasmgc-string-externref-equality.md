---
id: 1352
title: "RegExp exec result: wasmGC string struct ≠ externref string in strict equality (S15.10.2 cluster)"
status: done
completed: 2026-05-28
created: 2026-05-08
updated: 2026-05-28
priority: medium
feasibility: medium
reasoning_effort: high
task_type: bugfix
area: runtime, codegen
language_feature: regexp, strings
goal: spec-completeness
sprint: ~
parent: 1333
---

## Resolution (2026-05-28, developer reconciliation)

**ALREADY FIXED ON MAIN — close as `done`, no implementation work needed.**

The S15.10.2 cluster cited as the primary failure surface is already
fully passing in the current baseline:

```
$ grep '"S15.10.2' .test262-cache/test262-current.jsonl | jq -r .status | sort | uniq -c
    290 pass
      1 compile_error
```

No strict-equality failures remain. The fix landed earlier under a
different issue:

- **`4b7c1411` — fix(#1383): typeof-gated strict-equality fallback for
  cross-type comparisons** — replaced the unsound
  `host_eq(a,b) || unbox(a)===unbox(b)` shape in the strict-equality
  codegen with a typeof-gated fallback, which routes the wasmGC-struct
  / externref-string mixed-operand case through real JS `===` semantics
  via the host bridge.
- Followed by **`c3f55339` — fix(#786): Array indexOf/lastIndexOf/
  includes use spec equality for externref elements** for the
  SameValueZero side.

Reproducer used to confirm (current main, `.mts`, default mode):

```ts
function test(): number {
  const m = /(\d+)/.exec("abc42xyz");
  if (m === null) return 99;
  if (m[0] === "42") return 1;
  return 0;
}
// test() = 1 → PASS
```

Multi-element `String.prototype.match` + element-by-element strict
comparison also returns `1`.

### Out of scope (carved to follow-up if surfaced)

- `--nativeStrings` / `--target wasi` mode: the i16-array string struct
  has no `Symbol.toPrimitive` and would need a dedicated
  `__str_extern` reader at the host bridge. The architect spec below
  flagged this; no S15.10.2 nativeStrings failures observed in the
  baseline, so no follow-up filed.

### Notes on prior attempt

An orphaned branch `origin/issue-1352-host-eq` carries commit
`383fb8fd2` ("fix(#1352): normalize wasmGC string structs in host
equality bridges") that implemented the architect spec's Option 1
(_normalizeForHostEq helper on host_eq / host_loose_eq /
same_value_zero). It was never opened as a PR; the codegen-level fix in
#1383 superseded it before it landed. The branch is now severely out of
sync (5 ahead / 2583 behind) and can be deleted.

---

# #1352 — RegExp exec result: wasmGC string struct ≠ externref V8 string in strict equality

## Problem

~40 test262 failures in the S15.10.2 cluster (legacy RegExp exec-result tests) fail not because
of broken RegExp semantics, but because of a **strict-equality mismatch** between:

- Elements returned by V8's `RegExpExec` — externref JS strings (e.g. `"42"`)
- Expected values constructed in js2wasm — wasmGC `i16` string structs (e.g. `__expected = ["42"]`)

When a test does:
```js
assert.sameValue(result[0], "42"); // result[0] is externref string, "42" is wasmGC struct
```

The `===` comparison in the host bridge (`__host_eq`, `src/runtime.ts:121`) does identity
comparison on the externref side. A wasmGC string struct is never `===` to an externref V8 string
even when they contain the same characters.

## Sample failures

- `built-ins/RegExp/S15.10.2.7_A1_T1.js` (and ~39 sibling S15.10.2.* tests)

All follow the same pattern:
1. Construct an expected array of strings using JS literals (wasmGC struct path)
2. Run a regex and get the exec result (externref V8 array with externref string elements)
3. Compare element-by-element via `assert.sameValue` (or `===`)

## Root cause

`__host_eq` (the host import used for `===` between externref values) does not handle the case
where one operand is a wasmGC string struct and the other is a V8 externref string. It falls back
to reference identity, which is always false across the wasmGC/JS boundary.

The fix is either:
1. In `__host_eq`, detect when one arg is a wasmGC string struct (via `_isWasmStruct` +
   checking for the string-struct layout) and stringify it before comparing — `String(a) === b`.
2. Or: teach the RegExp exec-result bridge to convert V8 string elements in the result array
   to wasmGC string structs before returning.

Option 1 is broader and fixes all strict-equality mismatches between wasmGC strings and
externref strings, not just in RegExp. Option 2 is narrower but safer.

## Scope

This is broader than RegExp — any host value containing strings that js2wasm then compares with
a locally-constructed string will hit the same mismatch. The RegExp exec-result tests are just
the most visible manifestation.

See also: `#983 — wasmGC objects leak to JS` (related cross-boundary equivalence problem).

## Acceptance criteria

- S15.10.2.7_A1_T1.js through S15.10.2.7_A4_T10.js (the exec-result cluster) pass
- `===` between wasmGC string struct and V8 externref string with same content returns `true`
- No regression in existing string comparison tests

## Files to modify

- `src/runtime.ts` — `__host_eq` (or whichever equality bridge is used for `===`)
- Possibly `src/codegen/expressions.ts` — where `===` / `!==` is emitted for externref vs ref

## Notes

Filed from #1333 triage (architect-regexp, 2026-05-08). The S15.10.2 cluster was explicitly
deferred out of #1333 scope to avoid scope creep. Fix here unlocks ~40 tests.

## Implementation Plan

_Filed by architect 2026-05-21 (issue #1352)._

### Root cause (confirmed via codegen audit)

Two operands reach `__host_eq` in `src/runtime.ts` (line ~4706):

```ts
case "host_eq":
  return (a: any, b: any) => (a === b ? 1 : 0);
```

In default test262 mode (no `--nativeStrings`, no `--fast`) most string literals lower to
externref JS strings. **However**, two routes still produce a WasmGC value on one side:

1. **Array literal element storage** — when an array literal element is assigned a known-string
   value but the codegen needs to box it (e.g. for `Array<any>` element typing), the literal can
   be stored as a struct field that gets retrieved as an opaque object. (`compileArrayLiteral`
   uses `__js_array_push` for externref, but mixed-type vec elements with a const-string seed
   sometimes go through a struct path that doesn't externalize.)
2. **`String.prototype.match` / regex match result** — when js2wasm constructs its own
   match-result struct (vec-of-string) rather than returning the V8 array directly, the strings
   inside are externref JS strings. Comparing `match[0] === expectedArr[0]` where `match` is
   the host array and `expectedArr` is a js2wasm-built vec mixes a V8 string and (in some
   codegen paths) a wasmGC-boxed wrapper. `__host_eq` does identity-only equality and returns 0.

Even where both sides nominally externref, `__host_eq` is **strict identity** (`a === b`).
For two distinct V8 string objects with the same content `===` IS structural, so that path is
fine. The breakage is specifically when one side is a **WasmGC opaque object** (`_isWasmStruct`
returns true) holding string-shaped content. JS `===` against any externref is false.

The robust fix is to **normalise opaque-struct operands at the host-bridge boundary** before
the `===` check, so any structural string content reaching `__host_eq` is compared as a real
JS string.

### Chosen approach: Option 1 (broader, defense-in-depth)

Per the issue write-up, Option 1 fixes all strict-equality mismatches between wasmGC structs
and V8 strings, not just RegExp. The same fix also unblocks future `String.prototype.match`,
`split`, `replace`-with-RegExp result comparisons in test262 once those land on the same
host-bridge.

Option 2 (convert exec-result elements to wasmGC strings) is rejected: it requires touching
every host-call return path (replace, split, match, matchAll, …) and bloats the runtime per
call. Option 3 (force exec to return externref) is already what V8 does — the leak is on the
**other** operand.

### Changes

#### 1. New runtime helper (small, ~12 LOC)

**File: `src/runtime.ts`** — add helper next to `_isWasmStruct` (around line 285):

```ts
/**
 * (#1352) Convert a WasmGC value to a primitive comparable to externref values
 * via JS `===`. If `v` is a wasmGC struct that exposes string-shaped content
 * (Symbol.toPrimitive / toString returns a string), returns that string.
 * Otherwise returns `v` unchanged.
 *
 * Used by `__host_eq` / `__host_loose_eq` to bridge the wasmGC/externref
 * equality gap for string-typed cross-boundary comparisons.
 */
function _normalizeForHostEq(v: any): any {
  if (v == null) return v;
  if (typeof v !== "object") return v;
  if (!_isWasmStruct(v)) return v;
  // Try the existing host ToPrimitive (string hint). _toPrimitive is already
  // defined above and walks Symbol.toPrimitive → toString → valueOf, plus the
  // Wasm-export sidecars (`__sget_Symbol_toPrimitive`, `__sget_toString`).
  try {
    const prim = _toPrimitive(v, "string", callbackState);
    if (typeof prim === "string") return prim;
  } catch {
    // ToPrimitive threw — return original; caller falls back to identity.
  }
  return v;
}
```

> **Note**: `callbackState` is in scope inside the IIFE returned by `buildImports`.
> The helper must be defined where `callbackState` and `_toPrimitive` are both in scope —
> probably inside `buildImports` near the `host_eq` case, **not** at module top-level.
> Place it next to `host_eq` so it's adjacent to its only callers.

#### 2. Patch `host_eq` (1 LOC change)

**File: `src/runtime.ts`**, line 4706-4709:

```ts
case "host_eq":
  // #1065 — strict equality for two externref operands that the GC path
  // could not compare via ref.eq (e.g. host functions like `Array === Array`).
  // #1352 — normalise wasmGC opaque operands to string primitives so
  // a V8 string `"42"` and a wasmGC string struct with content "42" compare
  // equal under JS strict equality.
  return (a: any, b: any) => {
    if (a === b) return 1;
    const na = _normalizeForHostEq(a);
    const nb = _normalizeForHostEq(b);
    return na === nb ? 1 : 0;
  };
```

#### 3. Mirror in `host_loose_eq` (1 LOC change)

**File: `src/runtime.ts`**, line 4710-4714:

```ts
case "host_loose_eq":
  // #1134 — loose equality for two externref operands (§7.2.15).
  // #1352 — normalise wasmGC opaque operands first.
  return (a: any, b: any) => {
    // eslint-disable-next-line eqeqeq
    if (a == b) return 1;
    const na = _normalizeForHostEq(a);
    const nb = _normalizeForHostEq(b);
    // eslint-disable-next-line eqeqeq
    return na == nb ? 1 : 0;
  };
```

#### 4. Mirror in `same_value_zero` (#1360) (1 LOC change)

**File: `src/runtime.ts`**, line 4715-4725 — same pattern. `Array.prototype.includes` and other
SameValueZero paths can hit the same mismatch when the receiver is a host array and the search
value is a js2wasm-side string struct.

```ts
case "same_value_zero":
  return (a: any, b: any) => {
    if (a === b) return 1;
    if (typeof a === "number" && typeof b === "number" && a !== a && b !== b) return 1;
    const na = _normalizeForHostEq(a);
    const nb = _normalizeForHostEq(b);
    if (na === nb) return 1;
    if (typeof na === "number" && typeof nb === "number" && na !== na && nb !== nb) return 1;
    return 0;
  };
```

### Wasm IR pattern

No codegen changes required. The fix is entirely in the host-bridge runtime —
`src/codegen/binary-ops.ts:1632-1654` already routes the eqref-fail case through
`__host_eq`, so making `__host_eq` smarter is the minimal touch.

### Edge cases

1. **`null` / `undefined`** — short-circuited at `v == null` check; `null === null` and
   `undefined === undefined` still return 1 via the initial `a === b` check.
2. **Both operands wasmGC structs** — both get normalised; if both yield strings with the same
   content, returns 1. If one normalises and the other doesn't, the comparison falls back to
   the original (struct) identity, which is still correct.
3. **`Symbol.toPrimitive` throws** — caught locally; returns original `v` so `===` proceeds
   with identity (false). Test262 assertion fails loudly rather than silently coercing.
4. **Wasm closures (`_isWasmStruct` true but no `Symbol.toPrimitive`)** — `_toPrimitive`
   returns `undefined`, helper returns original; behaviour unchanged.
5. **Boxed numbers** — already handled by the existing numeric-unboxing fallback in
   `binary-ops.ts:1647-1652`. The new helper only kicks in when `_isWasmStruct` is true AND
   ToPrimitive("string") returns a string.
6. **`new String("x") === "x"`** — already handled by the wrapper-object branch
   (`binary-ops.ts:1438-1460`); not in scope here. The new helper preserves that path because
   `new String(...)` constructs a real JS String object, not a wasmGC struct.
7. **WeakMap/WeakSet keys** — Not affected. The host-eq bridge isn't used for `has`/`get`
   lookups (those are direct host calls).

### Verification (before implementing)

The dev should **first reproduce the bug** to confirm the root cause holds. Write a 5-line
`.tmp/repro-1352.ts`:

```ts
const re = /\d+/;
const match: any = re.exec("abc1234");
const expected = ["1234"];
console.log("match[0]:", match[0], "expected[0]:", expected[0]);
console.log("strict:", match[0] === expected[0]);
console.log("loose:", match[0] == expected[0]);
```

Compile with `pnpm build && node dist/cli.js .tmp/repro-1352.ts && node .tmp/repro-1352.wasm` (or
`pnpm vitest run .tmp/repro-1352.test.ts`). Expected current behaviour: `strict: false`. Expected
after fix: `strict: true`.

If repro shows `strict: true` already, the operand-side bug is elsewhere — message architect.

### Regression gate

Confirm no regression in these test262 categories (run via `pnpm run test:262` shard-targeted):

- `language/built-ins/RegExp/prototype/exec/` — primary target (the S15.10.2 cluster)
- `language/built-ins/RegExp/prototype/Symbol.match/`
- `language/built-ins/RegExp/prototype/Symbol.replace/`
- `language/built-ins/String/prototype/match/`
- `language/built-ins/String/prototype/split/` (where pattern is a RegExp)
- `language/expressions/strict-equals/` — pure `===` semantics, no regression allowed
- `language/expressions/equals/` — pure `==`, no regression allowed
- `built-ins/Array/prototype/includes/` — covers same_value_zero path

### Lines-of-change estimate

- `src/runtime.ts`: ~20 LOC added, 3 case branches edited.
- Tests: 1 new vitest file `tests/issue-1352-host-eq-wasmgc-string.test.ts` (~30 LOC) with
  a wasmGC-string-vs-externref-string strict equality assertion.

**Total**: ~50 LOC. Junior-dispatchable. Single-file fix. No codegen touch.

### Out of scope

- Per-call exec-result conversion (Option 2) — explicitly rejected above.
- Auto-coercion in `wasm:js-string equals` — the polyfill is intentionally strict-string-only
  and used in fast paths where both operands are guaranteed JS strings. Patching it would
  slow the common path.
- The `extern_call_method` DataView fallback (`runtime.ts:3451`) — orthogonal, already works.
- WasmGC-string-struct mode (`--nativeStrings`) — that path is a separate issue (the i16 array
  shape has no `Symbol.toPrimitive`; needs a dedicated `__str_extern` export reader). File a
  follow-up if dev sees nativeStrings failures after this fix.

