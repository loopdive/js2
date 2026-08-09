---
id: 2542
renumbered_from: 2511
title: "standalone: dynamic property read/write by a runtime string key (o[k]) returns default — needs native key enumeration + dynamic [[Get]]/[[Set]]"
status: done
sprint: 64
created: 2026-06-19
updated: 2026-06-21
completed: 2026-06-21
assignee: sd-2
priority: high
feasibility: hard
reasoning_effort: high
task_type: bugfix
area: codegen, standalone, runtime
language_feature: property-access, dynamic-keys
goal: standalone-mode
related: [2371, 2151, 2001]
origin: "2026-06-19 sd1 standalone host-import-leak hunt — the broad gap underlying #2371-phase2 (native for-in) and #2151 (any-receiver dispatch)"
# (#3102/#3400) The wasi-arm follow-up below widens three existing gates by one
# disjunct each (`ctx.standalone` -> `ctx.standalone || ctx.wasi`) plus short
# pointer comments; the long-form analysis lives in this file rather than in the
# god-files. Comments were trimmed from +23 to +8 lines across both files.
loc-budget-allow:
  - src/codegen/index.ts
  - src/codegen/literals.ts
func-budget-allow:
  - src/codegen/index.ts::resolveWasmType
  - src/codegen/index.ts::ensureStructForType
  - src/codegen/literals.ts::compileObjectLiteral
---

# #2542 — standalone dynamic property read/write by a runtime string key

## Problem

In `--target standalone --nativeStrings`, reading or writing an object property by
a **runtime** string key — `o[k]` where `k` is a `string` *variable* (not a
compile-time literal) — does not resolve to the real property. It returns the
element-type default (`0`/`undefined`) on read, and the write does not persist.

```ts
// returns 0 in standalone; should be 5
export function test(): number {
  const o: { [s: string]: number } = { a: 5, b: 7 };
  let k = "a";
  return o[k];
}
```

Verified 2026-06-19 (standalone, empty importObject, and confirmed independent of
for-in): `o[k]` with a static-literal key (`const k: "a" = "a"`) works, but a
runtime `let k = "a"` returns 0.

## Why this matters (epic-blocking)

This is the **broad capability** underlying several standalone gaps:

- **#2371 phase 2 (native for-in)** — `for (k in o) … o[k] …` is the dominant
  for-in body shape; even with native key enumeration, the value read needs this.
  (The #2371 phase-1 import-gate/refusal slice was abandoned — PR #1734 net -89 —
  because the test262 standalone harness *provides* the `__for_in_*` imports, so
  for-in already passes there; the real gap is the native runtime path, gated on
  this.)
- **#2151 any-receiver method dispatch** — `o.method()` on a closed object-literal
  struct via a dynamic receiver is the method analog of this dynamic read.
- Object rest destructuring (#2373) for `any`/index-signature receivers (the
  static-struct case is separately tractable in #2373).

## Root cause (sketch — architect to confirm)

The WasmGC object representation is a **nominal struct** with `struct.get`/`set`
keyed by a *static* `fieldIdx`. A runtime string key has no compile-time field
index, so `o[k]` falls through to a default-returning path (no native
string-key → field-index lookup, no host `__extern_get`/`__extern_set` in
standalone). A correct standalone implementation needs a runtime
**[[Get]]/[[Set]] by string key** over the struct — e.g. a per-struct
(key-hash → fieldIdx) dispatch table, or a side map, emitted natively. This is
the same machinery native for-in key enumeration needs.

## Acceptance criteria

- `o[k]` (runtime `k`) reads the real property value in standalone for a
  statically-typed object / index-signature object.
- `o[k] = v` (runtime `k`) persists.
- Unblocks #2371 phase 2 (native for-in) value reads.

## Scope note

`feasibility: hard` / **needs an architect spec** — this is a
representation/runtime change to the object model (dynamic [[Get]]/[[Set]] by
string key), not a localized fix. Filed for the standalone epic pivot; do NOT
attempt as a dev slice without a binding/representation design. Pairs naturally
with #2371-phase2 and #2151.

## Resolution (2026-06-21, sd-2) — representation routing, NOT a new runtime

The dynamic [[Get]]/[[Set]]-by-string-key runtime the issue called for **already
exists**: the native `$Object` open-object machinery (`__new_plain_object` /
`__extern_get` / `__extern_set` / `__obj_find`, all emitted as defined Wasm
functions under `--target standalone`, no host imports) services exactly this.
The bug was a **representation mismatch**, not a missing runtime: index-signature
objects were being lowered to a CLOSED nominal struct that those readers can't
reach.

### Root cause (confirmed by WAT inspection)

For `const o: { [s: string]: number } = { a: 5, b: 7 }`:

1. The literal `{ a: 5, b: 7 }` has an *inferred* type with named props `a,b`, so
   `compileObjectLiteral` built it as `struct.new $Closed`, then
   `extern.convert_any`-wrapped it to externref. `__extern_get`'s `ref.test
   $Object` cannot match a closed struct → `o[k]` returned null → `0`; `o[k] = v`
   targeted nothing → dropped.
2. The index-signature TYPE `{ [s: string]: number }` (declared type of `o`,
   params, returns) has an EMPTY `getProperties()`, so `resolveWasmType` →
   `ensureStructForType` registered an **empty** WasmGC struct and resolved the
   binding to `ref $empty`. A `$Object` argument then guard-cast to null at the
   call boundary (the `idxSig-param` / `return-dict` cases returned `0`).

(The issue text's "static-literal key works, runtime key returns 0" framing was
imprecise — the real split is **plain inferred struct** `{a,b}` runtime-key reads
*already worked* via the legacy externref-fallback path, while **index-signature
typed** objects failed on both literal and runtime keys.)

### Fix — three scoped, `ctx.standalone`-only routing changes

A pure string-index-signature type (anonymous `{ [s:string]:T }`, a `type`-alias
to one, or an `interface Dict { [s:string]:T }` — **no own named properties**) is
semantically an open dictionary, so it must flow as a `$Object` externref end to
end. Mirrors #1901's open-`$Object` routing.

- **`src/codegen/literals.ts` `compileObjectLiteral`** — two gates extended to
  fire when the contextual type has a string index signature + zero own props:
  the non-empty `#1901` open-`$Object` gate (builds the literal via
  `compileObjectLiteralAsExternref`), and the empty-`{}` `__new_plain_object`
  arm (so `const o: Dict = {}` is a real `$Object` open to dynamic writes).
- **`src/codegen/index.ts` `resolveWasmType`** — a pure string-index-signature
  Object type resolves to `externref` (placed BEFORE the named-struct lookup so a
  pure-index-signature *interface*, already registered as an empty struct by
  `collectInterface`, still resolves to externref — the empty struct stays
  registered but is never used as a value type, so **no type-index shift**).
- **`src/codegen/index.ts` `ensureStructForType`** — skips registering such a
  type as an empty anonymous struct (defense-in-depth for direct callers).

A MIXED `{ a: number; [s: string]: T }` (own named props) is intentionally
**excluded** — it has a static shape consumers read by field, so it keeps its
struct (routing it to `$Object` would mismatch the struct-typed binding). gc /
host / wasi are byte-identical (the open-object runtime is standalone-only).

### Verified

`tests/issue-2542-standalone-dynamic-key.test.ts` (15 cases): runtime-key
read/write, write-then-read, brand-new absent key, static member, param, return,
`type`-alias, `interface`, concatenated key, read-modify-write, empty-`{}` +
dynamic write, spread, nested dict-of-dict — all correct value, valid Wasm, and
**zero host-object-import leak** (the standalone contract). Plain-struct fast
path preserved (regression guard). `string`/`boolean`-valued index sigs compile
valid + leak-free. The pre-existing `for-in` `env.__for_in_*` leak is unchanged
and remains #2371's job (this fix unblocks #2371-phase-2's value reads).

## Follow-up (2026-08-01) — the same defect on `--target wasi`

The three routing gates above were written `ctx.standalone`-only, with the
stated rationale that "gc/host/wasi keep their existing struct/externref mapping
byte-identical". That holds for **gc/host**, where a JS host services `o[k]`
through the `__extern_get` host import. It does **not** hold for **wasi**, which
is equally host-free: it had neither the host import nor this routing, so an
index-signature object silently answered the DEFAULT.

Measured, identical source, only the target differing:

| target                 | `o["b"]` on `{ [s: string]: number } = { a: 5, b: 7 }` |
| ---------------------- | ------------------------------------------------------ |
| `--target standalone`  | **7** (correct)                                        |
| `--target wasi`        | **default** — no diagnostic, no trap                   |

Same silent-wrong-answer class as #2620's dropped collection calls: valid Wasm,
zero diagnostics, wrong number. This is NOT a regression of the original fix —
that fix was correct for the target it covered; it simply left the other
host-free target behind, because `compiler.ts` sets
`standalone: options.target === "standalone"` and `wasi` is a separate flag.

### Fix

`ctx.standalone` -> `ctx.standalone || ctx.wasi` at all three sites
(`resolveWasmType`, `ensureStructForType`, and both `compileObjectLiteral`
gates). Verified first that BOTH targets already emit the open-object runtime as
defined Wasm with **zero non-wasi imports**, so the routing cannot leak a host
import into the wasi build.

**One deliberate narrowing.** `objectLiteralTakesStandaloneAnyObjectPath` is an
exported lockstep predicate that also drives #1901's any/unknown/`object`
divert. Only the pure string-index arm was widened:

```ts
return (ctx.standalone && isAnyContextNonEmpty) || isPureStringIndexContext;
```

Widening the any-context arm would change the lowering of *every* any-typed
object literal under wasi — far beyond this defect. gc/host is provably
untouched: with neither flag set the early guard still returns `false`.

### Verified

- 6 previously-failing shapes now pass (inline index signature, `Record<string,
  number>`, key from a variable, key from an array element, key in a loop,
  8-property object).
- The original 15 standalone rungs still pass; 7 wasi rungs added to
  `tests/issue-2542-standalone-dynamic-key.test.ts` (22/22), including a
  regression guard that a plain inferred struct still takes the fast struct path
  on wasi, so the widened gate cannot over-reach.
- `#2804`'s 8 failures are A/B-confirmed identical with and without this change.
- typecheck + biome clean.
