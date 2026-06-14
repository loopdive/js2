---
id: 1329
title: "RegExp host-mode: Symbol.replace / replaceAll protocol spec compliance (110 fails)"
status: done
completed: 2026-06-12
created: 2026-05-08
updated: 2026-05-28
priority: medium
feasibility: medium
reasoning_effort: high
task_type: bugfix
area: runtime
language_feature: regexp
goal: spec-completeness
sprint: 50
parent: 1002
---
# #1329 — RegExp host-mode: Symbol.replace / replaceAll protocol spec compliance (110 fails)

Carved out of #1002 (RegExp js-host mode). #1002 closed as a scoping deliverable; this is one of four Symbol-protocol follow-ups.

## Problem

110 test262 failures touching `RegExp.prototype[Symbol.replace]`, `String.prototype.replace`, `String.prototype.replaceAll` — each a different ECMA-262 §22.2.6.10 spec edge case.

Status breakdown: 104 fail, 2 compile_timeout, 4 compile_error.

## Sample failures

- `built-ins/RegExp/prototype/Symbol.replace/arg-1-coerce.js`
- `built-ins/RegExp/prototype/Symbol.replace/result-coerce-matched.js`
- `built-ins/RegExp/prototype/Symbol.replace/fn-invoke-this-strict.js`
- `built-ins/RegExp/prototype/Symbol.replace/y-fail-lastindex-no-write.js`
- `built-ins/RegExp/prototype/Symbol.replace/flags-tostring-error.js`
- `built-ins/RegExp/prototype/Symbol.replace/result-coerce-index-err.js`
- `built-ins/RegExp/prototype/Symbol.replace/subst-capture-idx-1.js`
- `built-ins/String/prototype/replace/cstm-replace-on-boolean-primitive.js`
- `built-ins/String/prototype/replaceAll/replaceValue-call-skip-no-match.js`
- `built-ins/String/prototype/replaceAll/cstm-replaceall-on-string-primitive.js`
- `built-ins/String/prototype/replaceAll/searchValue-replacer-call-abrupt.js`

## Spec references

- §22.2.6.10 RegExp.prototype[@@replace]
- §22.1.3.18 String.prototype.replace
- §22.1.3.19 String.prototype.replaceAll
- §22.2.7.4 GetSubstitution

## Approach

Symbol.replace has the deepest semantic surface of the Symbol protocols:
- function-callback path: replacer function with `this` binding rules (sloppy mode, strict mode)
- string-substitution path: `$&`, `$\``, `$'`, `$n`, `$<name>` substitutions (GetSubstitution algorithm)
- coercion of result properties (`index`, `length`, captures)
- `lastIndex` write semantics on sticky/non-sticky patterns
- replaceAll's argument-must-be-global guard

## Acceptance criteria

- 90+ of the 110 fails flip to pass
- Remaining ones documented

## Investigation 2026-05-27 (dev-1593)

Smoke-tested the sample failures via `runTest262File`. The 110 fails do **not**
share one root cause — they decompose into three independent buckets, each
rooted **outside** the replace/@@replace code itself:

1. **Host object-coercion closure dispatch (`__call_toString` runtime trap).**
   Tests: `arg-1-coerce.js`, `result-coerce-matched.js`, `flags-tostring-error.js`,
   and the `result-coerce-*` family. When a wasmGC object with `toString`/`valueOf`
   closures is `ToString`-coerced by the host during the @@replace algorithm, the
   `_wrapForHost` proxy dispatch traps with "illegal cast in `__call_toString()`".
   Same machinery as #983/#1128/#1529 — NOT replace-specific.

2. **Boolean → externref boxes as a number, losing identity.**
   Tests: `cstm-replace-on-boolean-primitive.js`, `cstm-replaceall-on-boolean-primitive.js`.
   Confirmed minimal repro: `"atruebtruec".replace(true, "X")` returns the
   original string instead of `"aXbtruec"`, because the boolean `true` is boxed
   via `__box_number` at `src/codegen/type-coercion.ts:1394` (i32→externref boxes
   as number → host sees `1`, not `true`). Number/string primitive searches
   already pass. This is the #1342/#1637-class representation gap (boolean has no
   distinct externref boxing); the boxing site is shared by every i32 and carries
   no source-type info to distinguish boolean from number. **Overlaps existing
   task #1637 (Boolean + Symbol coercion TypeErrors).**

3. **Custom replacer-callback arg/result coercion mismatches.**
   Tests: `fn-invoke-args.js` (`assert.notSameValue(args, undefined)` fails), the
   `fn-*` family. The Wasm-closure→JS-callable wrap and the GetSubstitution result
   marshaling don't faithfully reconstruct the spec's `(matched, ...captures, pos,
   string)` argument vector. Lives in runtime.ts `__regex_symbol_call` /
   `_wrapWasmClosure` (~4717-4762).

Each bucket is a cross-cutting compiler concern (type representation / host
proxy / closure marshaling), not a localized replace fix. No single dev PR hits
the "90+/110 flip" acceptance bar; fixing one bucket touches code shared by many
other issues. **Recommend carving #1329 into bucket sub-issues (or folding the
buckets into the existing #983/#1529/#1637 efforts) rather than one PR.** The
replace/@@replace dispatch wiring itself (string-ops.ts `firstArgIsStringLike`
guard + runtime.ts `__regex_symbol_call`) is already correct — passes confirmed
for `fn-invoke-this-strict`, `fn-invoke-this-no-strict`, `y-fail-lastindex-no-write`,
`subst-capture-idx-1`, `g-init-lastindex`.

Reproduction note: the full directory sweep via `runTest262File` OOMs in a single
process (~270 files, cumulative runner leak) even at 2 GB + `--expose-gc`; per-file
runs are reliable. Use CI shards for full counts.

## Related

- Parent #1002 (closed-as-scoped)
- Sibling: #1328 (Symbol.match), #1330 (Symbol.search), #1331 (Symbol.split)
- Overlaps: #983 / #1128 / #1529 (host object-coercion closure dispatch),
  #1342 / #1637 (boolean externref representation)

## #1329-b3 — partial fix (2026-05-28, developer)

Surgical fix for Bucket 3's *result-coercion* half. `__regex_symbol_call`'s
`wrapCallable` returned a JS function whose return value flowed straight back
to V8's @@replace. When the user replacer returned a wasmGC struct (typical
shape: `{ toString(){ … } }`), V8 ran step 14.k.vi `replacement =
ToString(replValue)` on an opaque WebAssembly object and threw "Cannot convert
object to primitive value".

The wrapper now post-processes the closure's return value: when it comes back
as a WasmGC struct, it's routed through `_wrapForHost(ret, exports)` so V8's
downstream `ToString` reaches the struct's `toString`/`valueOf` closure fields
via the host proxy — mirroring the treatment we already apply to wasm-struct
*args* (`wrappedArg0`).

Touches: `src/runtime.ts` (~14 LOC inside the closure-arg wrapper) +
`tests/issue-1329-b3.test.ts` (3 cases: object-with-toString, number→string,
plain-string passthrough).

Verification:

| probe / test | before | after |
|---|---|---|
| `fn-coerce-replacement.js` (object-with-toString) | throws "Cannot convert object to primitive value" | "[toString value]" (PASS) |
| `tests/issue-1329-b3.test.ts` | n/a | 3/3 PASS |
| `tests/issue-1439.test.ts` (10 cases) | 10/10 | 10/10 (no regression) |
| `tests/issue-1443.test.ts` (5 cases) | 5/5 | 5/5 (no regression) |

### Still failing (out of scope for this PR)

- **`fn-invoke-args.js`** — replacer is called with fewer args than the spec
  requires. V8 hands @@replace a variadic `(matched, ...captures, position,
  string)` arg vector; our `wrapCallable` truncates to whatever
  `__call_fn_N` is the highest emitted dispatcher (capped at N=4 by the
  codegen), losing the trailing `string`. Genuine codegen change — requires
  emitting `__call_fn_5+` *and* full `arguments`-object reification inside
  compiled closures. Not localizable to runtime.ts. Defer to a sibling
  carve.
- **String-replacement substitution patterns** (`$&`, `$\``, `$'`, `$n`,
  `$<name>`) and the wider GetSubstitution edge cases — pre-existing.
