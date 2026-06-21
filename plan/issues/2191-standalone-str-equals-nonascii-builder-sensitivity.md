---
id: 2191
title: "Standalone case-conversion === literal: #40 ascii→uni toUpperCase repoint missed the called fn (funcIdx shift)"
status: done
assignee: ttraenkler/sdev-proxy3
created: 2026-06-18
updated: 2026-06-18
completed: 2026-06-18
priority: high
feasibility: hard
reasoning_effort: max
task_type: bug
area: standalone
language_feature: string
goal: standalone-mode
related: [40, 1588]
discovered_by: sdev-json3
---

# #2191 — standalone `__str_equals` intransitivity for ≥0x80 strings from a fresh helper

## Problem

Under `--target standalone`, a `$NativeString` produced by the #40 case-conversion
helper (`__str_to{Upper,Lower}Case` in `src/codegen/case-convert-native.ts`)
compares **UNEQUAL to a string LITERAL** under `===` (`__str_equals`) when the
string contains a code unit **≥ 0x80**, even though the two strings are
byte-for-byte identical. Strings with only ASCII (< 0x80) chars compare equal
correctly. The comparison is **INTRANSITIVE**, which is impossible for a correct
content-equality function — so this is a representation/equality bug, not a
mapping bug.

## Repro (all standalone, runtime param to defeat const-fold)

```ts
function f(s: string): number { return s.toUpperCase() === "À" ? 1 : 0; }
// f("à")  →  0   (WRONG — "à".toUpperCase() === "À" should be true)
```

Verified about the helper's output `a = "à".toUpperCase()`:
- `a.length === 1`, `a.charCodeAt(0) === 192`, `a.codePointAt(0) === 192` — all CORRECT.
- A manual `for`-loop char-by-char compare of `a` vs `"À"` returns **EQUAL**.
- `a === a` ✓, `a === fromCharCode(192)` ✓, `a === a.substring(0,1)` ✓,
  `a === (otherHelperCall)` ✓ — all TRUE.
- `a === "À"(literal)` ✗, `a.charAt(0) === "À"` ✗, `a.slice(0,1) === "À"` ✗,
  `(a + "") === "À"` ✗ — all FALSE.
- ASCII through the SAME helper (`"x".toUpperCase() === "X"`) ✓ — only ≥0x80 fails.
- Pre-existing methods producing ≥0x80 from a param (`substring`/`trim`/`padStart`/
  `concat`/`charAt`) `=== literal` ALL ✓.

So the failure is **uniquely** triggered by the case-conversion helper's output
struct (`struct.new $NativeString(len, 0, array.new_default(n)+array.set per char)`)
on the LHS with a string-literal RHS, for chars ≥ 0x80.

## What was ruled out (sdev-json3, ~75 min)

- NOT the case mapping — the bytes are provably correct (charCodeAt/codePointAt/
  manual-compare all agree).
- NOT the `off` field (charCodeAt reads `data[off+i]` correctly = 192).
- NOT the `len` field (`.length` = 1; `__str_equals` len-check would early-return
  but the byte loop is what mismatches).
- NOT array overallocation — `__str_equals` uses the struct `len` FIELD, not
  `array.len` (confirmed in the WAT).
- NOT signedness/masking — 192 is a clean positive i16.
- NOT `utf8Storage` (reproduces with it off), NOT the optimizer (reproduces
  with `optimize:false`), NOT helper-routing (the ASCII `__str_toUpperCase`
  body was rewritten to the Unicode one; still fails).
- NOT simply `array.new_default`+`array.set` — `padEnd`/`repeat` rebuild via
  the same idiom and their output `=== literal` works for ≥0x80.
- Routing the helper output through `__str_substring(out,0,len)` BEFORE return
  did NOT fix it — yet a TS-level `.substring()` on the SAME output DOES compare
  equal. (This internal inconsistency is the core mystery.)

The comparison genuinely reaches `__str_equals` (call to `__str_equals` in the
WAT, not `ref.eq`), and `__str_equals` flattens both operands via `__str_flatten`
(which fast-paths a `$NativeString` through unchanged) then byte-compares via
`array.get_u`. Two byte-identical 1-element i16 arrays at off 0 should compare
equal — but don't, for the helper's output specifically.

## Hypotheses for whoever picks this up

1. A Binaryen/WasmGC packed-i16 representation subtlety where a struct built by
   one instruction sequence vs another yields arrays that `array.get_u` reads
   identically but `__str_equals` (or `__str_flatten`'s `ref.test`/`ref.cast`)
   treats differently.
2. A static-type interaction: the case helper returns a concrete
   `(ref $NativeString)`; the comparison codegen may pick a different `===`
   lowering for a concrete-ref LHS + string-literal RHS than for a
   `(ref $AnyString)` LHS (substring/concat). Worth dumping the exact
   comparison codegen for `helperResult === literal` vs `substring === literal`
   and diffing the called functions / casts.
3. closest adjacent expertise: sdev-proxy3 (did the $Array/$ObjVec externref-rep
   + string-element work, #2190/#35).

## BREAKTHROUGH datum (sdev-json3, follow-up)

The trigger is a **bare string-LITERAL RHS**, not the helper output per se:
- `helperOut === "À"` (bare literal RHS) → **FALSE** (bug)
- `helperOut === String("À")` (String()-wrapped literal RHS) → **TRUE** (correct!)
- `helperOut === ("\u00C" + "0")` (runtime concat building À) → also routes oddly

So a comparison whose RHS is a **bare string literal** takes an EARLIER/different
codegen branch than `=== String(lit)` / `=== substring` / `=== fromCharCode`.
The FAIL WAT is a DIRECT 2-operand `call __str_equals` (helper result pushed RAW
— NOT flattened — then the literal built + `ref.cast null (ref null 6)`, then the
call), whereas the WORK cases go through `emitNullableStringEquals`
(string-ops.ts ~1554: flattens BOTH via `__str_flatten` + null-checks before the
call). The bug is therefore in the **bare-literal-RHS string-=== fast path**:
it passes the LHS to `__str_equals` WITHOUT flattening, and `__str_equals`'s
internal `__str_flatten` of my helper's `(ref 7)` output produces a value that
mismatches the literal for ≥0x80 — while the explicit pre-flatten in the nullable
path (or the String()/substring copy) yields a value that matches.

**Likely fix:** make the bare-literal-RHS string-=== path ALSO route through
`emitNullableStringEquals` (or explicitly `__str_flatten` both operands before
`__str_equals`), OR find why `__str_flatten` of a directly-built `$NativeString`
(array.new_default+set) vs a copy diverges for ≥0x80 inside `__str_equals` but
not when pre-flattened. Whoever fixes this should diff the codegen branch taken
for `x === "lit"` vs `x === String("lit")` — the former is the buggy fast path.

## IR-path datum (sdev-json3, final)

The FAIL `helper === "lit"` comparison is lowered by the **IR backend**
(`src/ir/`) — the `$f` body uses `$$irN` locals and emits a DIRECT 2-operand
`call __str_equals` with the LHS (helper result) passed RAW (no `__str_flatten`,
no null-checks), then the literal built + `ref.cast null (ref null 6)`, then the
call — even with `optimize:false`. By contrast `=== String(lit)` / `=== substr`
go through the direct-codegen `emitNullableStringEquals` which pre-flattens both.
`__str_equals` (func 4) DOES `call __str_flatten` on each arg internally, and
flatten fast-paths a `$NativeString` (`ref.test (ref 7)`) through unchanged — so
in principle the raw-LHS path should still compare correctly. It does for <0x80
and for non-helper builders; it fails only for the case-helper's ≥0x80 output.

Net: the bug sits at the intersection of (a) the IR-path bare `__str_equals(left,
right)` lowering for `str === literal`, and (b) `__str_equals`/`__str_flatten`'s
handling of a `$NativeString` built by `array.new_default` + per-char `array.set`
with a ≥0x80 i16 element. Needs someone with the native-string-rep + IR-lowering
knowledge (sdev-proxy3). A candidate quick fix worth trying: have the IR `===`
lowering for two string operands route through the same flatten-both-then-equals
shape `emitNullableStringEquals` uses, instead of a bare `__str_equals`.

## Impact

Blocks #40 (case conversion) from shipping — `assert.sameValue` / `===` against a
literal is how test262 String/case tests assert, so the case methods would report
failures despite producing correct output. Also a latent correctness risk for any
future codec that builds `$NativeString` structs directly.

## Acceptance criteria

- `"à".toUpperCase() === "À"` (runtime param) returns `true` standalone, and the
  intransitivity is gone for ≥0x80 strings from any builder.
- #40 case-conversion tests pass via `===` (not just charCodeAt readback).

## RESOLVED 2026-06-18 (sdev-proxy3) — it was a #40 helper-routing bug, NOT __str_equals

All prior theories (IR `string.eq` operand bug; inside `__str_equals`/
`__str_flatten`; array-rep ≥0x80) were **disproved**. Decisive disproof:
`"à".toUpperCase() === "à"` (compared to the LOWERCASE input) returns **TRUE** —
i.e. `"à".toUpperCase()` via the `===` call site is still **"à" (0xE0)**, not
"À" (0xC0). `__str_equals` is correctly comparing 0xE0 ≠ 0xC0. Meanwhile
`"à".toUpperCase().charCodeAt(0)` is 0xC0. Two call sites → two different
`toUpperCase` functions.

The module emits TWO functions: `$__str_toUpperCase` (ASCII-only — à=0xE0 ∉
[a-z], left unchanged) and `$__str_toUpperCase_uni` (Unicode — à→À). The #40
ascii→uni re-point (`case-convert-native.ts`) copied `uniFn.body` into the ascii
fn via `ctx.mod.functions[asciiIdx - ctx.numImportFuncs]`, where `asciiIdx` was
captured in `nativeStrHelpers` BEFORE the re-point. A late import added between
the ascii registration (`native-strings.ts`) and the re-point grew
`ctx.numImportFuncs`, so `asciiIdx - numImportFuncs` indexed the WRONG function —
patching some other fn and leaving the real ascii `$__str_toUpperCase`
un-patched. The `===` path resolved to the un-patched ascii body; `charCodeAt`
resolved to the uni body. (Same funcIdx-shift class as the #2190 round-3 bug.)

**Fix:** re-point the PUBLIC `__str_toUpperCase`/`__str_toLowerCase` NAMES (in
BOTH `nativeStrHelpers` and `funcMap`) directly at the `_uni` funcIdx, so every
resolver dispatches to the Unicode body. The ascii body becomes dead code
(wasm-opt drops it). Re-pointing the name is immune to the funcIdx shift.

Files:
- `src/codegen/case-convert-native.ts` — replace the shift-sensitive body-copy
  with a name re-point in both maps.
- `tests/issue-2191-case-equals.test.ts` — 6 tests (toUpper/toLower ≥0x80 ===
  literal, ASCII control, transitivity); all green, optimize on+off.
