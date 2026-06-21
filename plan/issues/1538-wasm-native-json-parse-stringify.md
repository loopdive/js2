---
id: 1538
title: "Wasm-native JSON.parse and JSON.stringify (standalone, no host)"
status: done
assignee: ttraenkler/sd2
created: 2026-05-20
updated: 2026-06-19
completed: 2026-06-19
priority: medium
feasibility: medium
reasoning_effort: high
task_type: feature
area: runtime
language_feature: json
goal: standalone-wasm
sprint: 64
related: [1535, 1537, 2166]
---

## CLOSED 2026-06-19 (sd2) — SUPERSEDED by #2166 (already implemented + merged)

The entire scope of this issue — a pure-Wasm, host-import-free JSON parser and
stringifier for `--target standalone`/`wasi` — was implemented and **merged**
under **#2166** ("Standalone JSON conformance residual", `status: done`,
completed 2026-06-18), the #1599 Phase-2 dynamic JSON codec. The codec lives in
`src/codegen/json-codec-native.ts` (`emitJsonStringifyValue`, `emitJsonParseText`,
`emitJsonParseTextReviver`), wired into `src/codegen/expressions/calls.ts`
(`emitJsonStringifyValue` @ ~6149/6208, `emitJsonParseText` @ ~6304,
`emitJsonParseTextReviver` @ ~6296). Landed PRs: PR-A #1653, PR-C #1657,
PR-C2 #1658, PR-B #1660, PR-D1 #1665, PR-D2 #1666, PR-D3 (replacer, closes #2166).

**This issue's A1/A2/Phase-B slicing plan (below) is fully covered by #2166's
PR-A/B/C/C2/D1/D2/D3.** No code left to write here.

### Verification on current main (2026-06-19, sd2)

`--target standalone`, no `env` host-import leak (`WebAssembly.Module.imports`
empty for every case), internal numeric/length probes (native strings don't
marshal across the JS export boundary, so assert on `.length`/`.charCodeAt`/
property reads, per #2166's own test discipline):

| expr | standalone result | note |
|---|---|---|
| `JSON.stringify({a:1,b:2}).length` | `13` (`{"a":1,"b":2}`) | ✓ object stringify |
| `JSON.stringify([1,2,3]).length` | `7` (`[1,2,3]`) | ✓ array stringify |
| `JSON.parse('{"a":5}').a` | `5` | ✓ object parse |
| `JSON.parse('[10,20,30]')[1]` | `20` | ✓ array parse + index |
| `JSON.parse('{"x":[1,2,{"y":3}]}').x[2].y` | `3` | ✓ nested round-trip graph |
| `JSON.stringify({a:1}).charCodeAt(0)` | `123` (`{`) | ✓ |

The #1599-refusal this issue documented is gone for dynamic object-graph
stringify/parse standalone. Residual method-lookup items (shorthand/class
`toJSON`, instance-field stringify, closure-`this`, PR-A2 `number[]` array
stringify) are the **architect-scale follow-ups** already tracked under #2166's
closure note — NOT dev-claimable slices of #1538.

**Disposition:** mark `done` (superseded). The dependency it waited on (#1537
Ryū number formatting) is also merged.

---

# #1538 — Wasm-native JSON.parse / JSON.stringify

## Problem
`JSON_parse` and `JSON_stringify` are host imports that delegate to the JS engine. In WASI/standalone mode, applications that read JSON config or emit JSON results cannot do so without a JS runtime — yet JSON is one of the most common standalone use cases (edge functions, CLI tools, config parsing).

## Proposed solution
Implement a pure-Wasm JSON encoder and decoder operating on the existing `--nativeStrings` (i16 WasmGC array) and the union value representation.

- **Parser**: recursive-descent over the input string buffer; standard JSON grammar (RFC 8259). Output: a tagged union value (object → `Map`-style struct, array → WasmGC array, string → i16-array, number → f64, true/false/null → sentinels).
- **Stringifier**: walks the union value; emits to a growable i16-array buffer. Supports the `replacer` arg only for the function form (host-friendly subset) and indent arg.
- **Number formatting**: depends on #1537 (Ryū) for `Number → string` inside stringify.
- **String escapes**: `\u{...}`, `\\`, `\"`, control-char escapes per spec.

## Library/approach
Reference implementations to study (license-compatible):
- **jsmn** (MIT, ~1 KB, parser-only) — too minimal but useful as skeleton.
- **QuickJS** (MIT) — high-quality C reference for both parse and stringify.
- **Duktape** (MIT) — clean C reference.
Re-implement from spec; no FFI.

## Binary size impact
~15-20 KB Wasm: parser ~6 KB, stringifier ~8 KB, escape tables ~2 KB.

## Test262 impact (estimated)
- `built-ins/JSON/parse/*`: ~80 tests
- `built-ins/JSON/stringify/*`: ~120 tests
- Many feature tests use `JSON.stringify` as their oracle; fixing those raises secondary passes too.
- Estimate **+150-300 passes** in standalone mode.

## Implementation steps
1. Define a uniform "JS value" union representation (depends on #1540 if not already present, or use the current `externref`-or-typed pattern).
2. Add `src/codegen/json-helpers.ts` with `__json_parse`, `__json_stringify` Wasm functions.
3. Register them via `addImport`-equivalent for defined functions; remove `JSON_parse`/`JSON_stringify` host import calls in `src/codegen/index.ts:4772,4776`.
4. Provide a host-mode fallback for non-`nativeStrings` builds.
5. Test against test262 `built-ins/JSON/*`.

## Risk
The recursive parser is straightforward; the stringifier is harder because of `toJSON` invocation, replacer-function semantics, and cyclic-object detection (spec §25.5.2). Cyclic detection needs a side-set of "seen" object refs (~256-entry hash set, ~1 KB extra).

## Implementation Plan (architect, 2026-06-16)

### Host imports leaked today
`JSON_stringify` (`index.ts:8097`, `declarations.ts:1260`, allowlist `host-import-allowlist.ts:334`), `JSON_parse` (`index.ts:8103`, `declarations.ts:1266`, allowlist :340; #2013 added the reviver param).

### What already exists — build on it
- `$AnyValue` tagged union (`any-helpers.ts:22`): tags 0=null,1=undefined,2=i32,3=f64,4=bool,5=string,6=object/ref. This IS the JSON value model.
- `__json_quote_string` (`json-runtime.ts:66`, §25.5.4.3 QuoteJSONString, pure Wasm).
- `__json_parse_primitive` (`json-runtime.ts:423`, single primitive → `$AnyValue`).
- Compile-time literal folding (`json-standalone.ts`).
- Open-object runtime (`object-runtime.ts`): `$Object` with **insertion-ordered keys** maintained explicitly for JSON.stringify; `__obj_insert`/`__obj_find`/`__new_plain_object`.

Gap = the runtime object/array codec: parse text → `$Object`/array graphs; walk a graph → text. Primitives/quoting/literals done.

### Design — `src/codegen/json-codec.ts`, gated `ctx.wasi || ctx.standalone`
**Parser `__json_parse(text) -> ref $AnyValue`**: recursive-descent over flattened `$NativeString` units (reuse `__str_flatten` preamble). Worker `__json_parse_value(data, cursor-cell, end)` with a 1-field `struct (mut i32)` cursor ref-cell advancing across recursive calls. Productions: object→`__new_plain_object` + `__obj_insert` pairs (box tag 6); array→standalone array (box tag 6); string→unescape (`\"\\\/ bfnrt`, `\uXXXX` + surrogate pairs)→`$NativeString` (tag 5); number→reuse §21 scanner (tag 3); true/false/null→tags 4/4/0. Malformed→`throw new SyntaxError` via `$Error_struct`+`throw $tag` (#1536), NOT `unreachable` (§25.5.1). Reviver (§25.5.1 InternalizeJSONProperty, #2013): bottom-up walk; **defer to Phase B** (gate `JSON.parse(s,reviver)` to host path in JS-host mode, document standalone gap).

**Stringifier `__json_stringify(value, indent) -> externref`** (§25.5.2 SerializeJSONProperty): recursive dispatch on tag — null→"null"; bool→"true"/"false"; undefined/function→omit (array→"null", object→skip key); number→`number_toString`/Ryū (**depends #1537**), non-finite→"null"; string→`__json_quote_string`; tag6→`ref.test` array vs `$Object`: array→`[...]`, object→`{...}` in insertion order. Support numeric (1-10) + string `space` indent (`\n`+indent*depth, `": "` after keys). `toJSON`/`replacer`→Phase B. **Cycle detection** (§25.5.2 step 1): `seen` set `(array (mut (ref null eq)))` checked by `ref.eq`, push on descent/pop on ascent; re-entry→`throw new TypeError("Converting circular structure to JSON")` (#1536).

### Call-site wiring
- `calls.ts` `tryEmitJsonParsePrimitive` (~514): under standalone stop bailing on object/array consumption → route to `__json_parse`; keep primitive fast path.
- `calls.ts` JSON.stringify dispatch (~473-492): extend beyond string-only to call `__json_stringify` for object/array/`$AnyValue` with resolved space/indent.
- `index.ts` needStringify/needParse (~8087-8104): under standalone emit native `emitJsonCodec(ctx)` instead of `addImport(JSON_parse/JSON_stringify)`; keep host imports for JS-host.

### Edge cases
NaN/Inf→"null", `-0`→"0"; deep nesting (~1000 levels, document cap if traps); circular→TypeError; surrogate pair→astral; empty `{}`/`[]`/`""`; duplicate keys→last wins; whitespace; undefined/function top-level→undefined, array elem→"null", object value→key omitted; `1e21`→"1e+21" (#1537); `JSON.parse("")`/malformed→SyntaxError throw.

### Scoping & dependency
All gated `ctx.wasi || ctx.standalone`; JS-host keeps imports. **Depends on #1537** for number→string inside stringify (disjoint files: #1537 number-ryu.ts, #1538 json-codec.ts — no conflict; sequence #1537 first or accept interim non-round-tripping numbers). No new host imports.

### test262 gate & phasing
`built-ins/JSON/parse/` (~80), `built-ins/JSON/stringify/` (~120) standalone; reviver/replacer/toJSON tests gated to Phase B if deferred. `tests/issue-1538.test.ts` `{target:"standalone",testRuntime:true}`: round-trip deep-equal, circular→throws, escapes, indent `=== JSON.stringify(x,null,2)`. Est. +150-300 passes. **Phase A** = parse(objects/arrays/strings/escapes, no reviver) + stringify(value types, indent, cycle detection); **Phase B** = reviver/replacer/toJSON. Ship A first.

## Recon (2026-06-16, dv3) — current standalone behavior + slicing

Verified the standalone gap on current main (`--target standalone`, no `env`
imports leak — the host imports are already DCE'd, they're just non-functional):

| input | standalone result | want |
| --- | --- | --- |
| `JSON.stringify({a:1,b:2})` | `undefined` (no object walk) | `{"a":1,"b":2}` |
| `JSON.stringify([1,2,3])` | `undefined` | `[1,2,3]` |
| `JSON.parse('{"a":5}').a` | TRAP `unreachable` | `5` |

Primitive stringify (`null`/bool/number/string) already works standalone via
`tryEmitJsonStringifyPrimitive` (`calls.ts:406`) + `__json_quote_string`
(`json-runtime.ts:66`). Primitive parse works via `__json_parse_primitive`
(`json-runtime.ts:422`). The gap is purely the **runtime object/array codec**.

Building blocks confirmed in-tree to build on (do NOT reinvent):
- `$AnyValue` tagged union (`any-helpers.ts:23` `ensureAnyValueType`): 0=null
  1=undefined 2=i32 3=f64 4=bool 5=string 6=object/ref.
- `object-runtime.ts` (`ensureObjectRuntime`): `$Object` with **insertion-
  ordered** keys (#1837 seq field), `__new_plain_object`, `__obj_insert`,
  `__obj_find` — the stringify key-order + parse object-build primitives.
- `__json_quote_string` (string→quoted), `__json_parse_primitive`.

**Slicing (independently-shippable PRs, new file `src/codegen/json-codec.ts`):**
- **A1** — `JSON.stringify(object|array)`: recursive `$AnyValue`-tag dispatch,
  `$Object` insertion-order walk, array vs object via `ref.test`, numeric/string
  `space` indent, cycle detection (`seen` eq-set → `throw TypeError` via #1536),
  NaN/Inf→`null`. Reuses existing number→string (full Ryū edge-numbers are the
  #1537 dependency; interim is acceptable per architect).
- **A2** — `JSON.parse(object|array|string|escapes)`: recursive-descent over
  flattened `$NativeString` with an i32 cursor ref-cell; object→`__new_plain_object`
  +`__obj_insert`, array→standalone array, string-unescape, number→§21 scanner,
  malformed→`throw SyntaxError`.
- **Phase B** — reviver/replacer/toJSON (separate follow-up; gate to host in the
  interim).

Wiring points: `calls.ts` `tryEmitJsonParsePrimitive`(~565) + JSON.stringify
dispatch(~6028); `index.ts` needStringify/needParse(~8087) emit native codec
under `ctx.wasi||ctx.standalone` instead of `addImport`. All gated standalone;
JS-host keeps host imports unchanged.

## Suspended Work (2026-06-16, dv3)

Worktree `/workspace/.claude/worktrees/issue-1538-host-native-json`
(branch `issue-1538-host-native-json`, from upstream/main @0275de164).
No code committed yet — only the **Recon** section above (verified gaps,
building-block map, struct layouts, sliced A1/A2/Phase-B plan).

**Resume steps for slice A1 (`JSON.stringify(object|array)`):**
1. New file `src/codegen/json-codec.ts`, `emitJsonStringify(ctx)` gated
   `ctx.wasi||ctx.standalone`; idempotent in `ctx.funcMap` like
   `emitJsonQuoteString`. Call `ensureObjectRuntime(ctx)` (gives
   `$Object`@objectTypeIdx, `$PropEntry`@propEntryTypeIdx {key:0,value:1,
   flags:2,seq:3}, `$PropMap`@propMapTypeIdx) + `ensureAnyValueType` +
   `ensureNativeStringHelpers` (`__str_concat`).
2. Recursive `__json_stringify_value(ref $AnyValue, i32 depth) -> ref $AnyString`
   dispatching on `$AnyValue` tag (0 null→"null", 1 undefined→omit, 2/3
   number→`number_toString` (NaN/Inf→"null"), 4 bool, 5 string→
   `__json_quote_string`, 6 ref). Tag-6: `ref.test` array-vec vs `$Object`.
   **Known sharp edge:** standalone arrays are closed-shape `__vec_<elem>` types
   (per element type), so array detection needs the registered vec type idx(s),
   not one canonical array type — resolve via `ctx.shapeMap`/vecTypeIdx. Object:
   walk `$PropMap` entries, sort by `seq` (insertion order), skip tombstones
   (null entries) + undefined/function values, emit `"key":value` joined by ",".
3. `space` indent (numeric 1-10 / string) → `\n`+indent*depth, `": "` after keys.
4. Cycle detection: `seen` `(array (mut (ref null eq)))`, `ref.eq` check,
   push on descent/pop on ascent; re-entry → `throw TypeError` via `$Error_struct`
   + `throw $tag` (#1536 machinery).
5. Wire `calls.ts` JSON.stringify dispatch (~6028, after
   `tryEmitJsonStringifyPrimitive` returns undefined for object/array under
   standalone) to call `__json_stringify_value`; `index.ts` needStringify (~8087)
   emit `emitJsonStringify(ctx)` instead of `addImport(JSON_stringify)` under
   standalone.
6. `tests/issue-1538.test.ts` `{target:"standalone",testRuntime:true}`: object
   round-trip, array, nested, indent `=== JSON.stringify(x,null,2)`, circular→throws.

Slice A2 (parse) and Phase B (reviver/replacer/toJSON) per the Recon plan.
