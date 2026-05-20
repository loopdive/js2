---
id: 1474
sprint: 52
title: "host-independence: eliminate JS host RegExp for standalone Wasm"
status: ready
created: 2026-05-20
priority: high
feasibility: medium
reasoning_effort: high
task_type: bugfix
area: codegen, runtime
language_feature: regular expressions
goal: host-independence
related: []
---

# #1474 — Eliminate JS host RegExp for standalone Wasm

## Problem

Every regex in user code currently delegates to the JS `RegExp`
engine. There is **no standalone fallback** — the compiled module
imports `env::RegExp_new` and every `RegExp.prototype.*` method as a
JS host call.

Concrete surface:

1. **`RegExp_new(pattern, flags)`** — host import added by
   `src/codegen/typeof-delete.ts:301-308`. Lowered from regex
   literals (`/\d+/g`) via `compileRegExpLiteral`, and from explicit
   `new RegExp(p, f)` constructor calls (`builtin-tags.ts:65`
   `RegExp = -31`, registered in
   `builtin-tags.ts:180` allowed-ctor list). The JS side calls
   `new RegExp(p, f)` from `runtime.ts:1852`.

2. **`RegExp.prototype.{test, exec, match, matchAll}`** — invoked
   as JS string methods on the host. `string-ops.ts:1680-1746`
   short-circuits `replace` / `replaceAll` / `split` to the JS
   regex path whenever the first arg is a `RegExp`:
   ```ts
   const firstArgIsRegExp = … symName === "RegExp";
   if (method === "replace" && !firstArgIsRegExp) { … native path … }
   ```
   Anything inside the `if (firstArgIsRegExp)` branches at lines
   1680, 1690, 1718, 1746 falls back to `__extern_method_call` →
   JS host.

3. **Match result objects** — JS regex returns a `RegExpMatchArray`
   with `.index`, `.input`, `.groups` properties. Compiled code
   reads these via `__extern_get`. No Wasm-side struct exists for
   match results.

4. **Sticky / unicode / unicodeSets flags** (`/y`, `/u`, `/v`) —
   semantics depend entirely on the JS engine's regex implementation
   (V8's Irregexp). Wasm side has no equivalent.

5. **Backreferences, lookbehind, named groups** — Irregexp
   features that test262 exercises heavily; the compiler simply
   passes the pattern string to JS and trusts the engine.

Why this blocks standalone: `s.match(/\d+/)`, `/foo/.test(s)`,
`s.replace(/a/g, "b")`, and every template-literal tag that builds
a regex (`new RegExp(`…${escape}…`)`) all fail under wasmtime —
"unknown import env::RegExp_new". The compiler currently has no
non-JS regex engine.

## Standalone alternative

Three plausible paths, from least-to-most invasive:

### Option A: refuse-and-document (smallest)

Emit a compile-time error in `--standalone` mode whenever a regex
literal or `RegExp` constructor appears. Document that regex is
JS-host only. Useful for users targeting pure WasmGC who don't need
regex (data processing, math kernels, simple text munging via
`String.prototype.{indexOf, slice}` already covered by #1470).

### Option B: NFA-based mini-regex (medium)

Ship a self-contained Wasm regex engine compiled from a small
NFA-based matcher (cf. Plan 9 `regexp`, Russ Cox's
"Regular Expression Matching Can Be Simple And Fast"). Supports:

- Character classes (`[a-z]`, `\d`, `\w`, `\s`)
- Anchors (`^`, `$`)
- Alternation (`a|b`)
- Repetition (`*`, `+`, `?`, `{n,m}`)
- Capturing groups
- Non-greedy variants
- Common flags: `g`, `i`, `m`, `s`

Excludes: backreferences (`\1` requires a backtracking engine —
exponential worst-case), lookahead/lookbehind, full Unicode
property escapes (`\p{L}`), Unicode case folding beyond ASCII,
sticky semantics with state.

WasmGC types:

```
struct $RegExp     { nfa: ref $NfaStates, flags: i32, lastIndex: i32 }
struct $NfaStates  { array (mut $NfaState) }
struct $NfaState   { kind: i32, char: i32, next1: i32, next2: i32 }
struct $MatchArray { input: ref $FlatString, idx: i32,
                     captures: ref $CaptureVec }
```

Compile pattern → NFA at module-load time (one helper per regex
literal, cached); `RegExp.prototype.test/exec` walk the NFA in a
loop. ~1500 LOC of Wasm helpers; ~3-5x slower than V8's Irregexp on
hot patterns, comparable to RE2 on typical inputs.

### Option C: full Irregexp port (largest)

Out of scope for this issue — would require porting V8's Irregexp
to WasmGC or compiling Rust's `regex` crate to Wasm and linking it
in. Track as future work (#TBD) when the user base needs it.

### Recommended: A → B incrementally

Land Option A first (refuse-and-document) so `--standalone` builds
fail fast with a clear message. Open follow-up issue for Option B
once the rest of the host-independence work (#1470-#1473) lands and
we know which regex features the example/test262 surface actually
uses.

## Acceptance criteria

### Phase 1 (this issue, Option A)
- [ ] `--standalone` build with a regex literal or `new RegExp(…)`
      fails at compile time with: "RegExp is not supported in
      standalone mode (#1474). Recompile without --standalone, or
      avoid regex."
- [ ] Source line / column reported in the error.
- [ ] `--js-host` default mode unchanged — all existing regex tests
      still pass.

### Phase 2 (follow-up, Option B — separate issue)
- [ ] `--standalone` builds with regex emit a pure-Wasm NFA engine.
- [ ] Test262 `built-ins/RegExp/prototype/{test,exec}` subset
      (excluding backreferences, lookbehind, `\p{}`) passes.
- [ ] `s.match(/\d+/g)` returns a vec of match strings in
      standalone mode.
- [ ] Bench: standalone regex within 5× of JS-host on a representative
      pattern (`/\w+/g.exec(longText)`).

## Files to modify

### Phase 1
- `src/codegen/typeof-delete.ts` (lines 287-311
  `compileRegExpLiteral`) — when `ctx.standalone`, call
  `reportError(ctx, expr, "RegExp not supported in --standalone mode
  (#1474)")` instead of registering the import.
- `src/codegen/builtin-tags.ts` (line 65 + line 180 allowed
  ctors) — refuse `new RegExp(…)` in standalone.
- `src/codegen/string-ops.ts` (lines 1680, 1690, 1718, 1746) —
  emit error when `firstArgIsRegExp` and `ctx.standalone`.
- `src/codegen/index.ts` (line ~3451 `regexpArgMethods`) — error
  rather than registering the host call.
- `src/codegen/declarations.ts` (lines 200, 288) — same.
- Tests: `tests/standalone.test.ts` — verify the compile error
  surfaces with the expected message.

### Phase 2 (separate follow-up)
- New: `src/codegen/wasm-helpers/regex-runtime.ts` — NFA engine.
- New: `src/codegen/regex-compile.ts` — pattern → NFA compiler.
- Update Phase 1 sites to dispatch to the new helpers.
