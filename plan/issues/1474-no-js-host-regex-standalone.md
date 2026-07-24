---
id: 1474
title: "host-independence: eliminate JS host RegExp for standalone Wasm"
status: done
done_cited_ok: true # #3474 exempt: scope = eliminate HOST RegExp (done); standalone-native RegExp is #1539's job
created: 2026-05-20
updated: 2026-05-24
completed: 2026-05-24
priority: high
feasibility: medium
reasoning_effort: high
task_type: bugfix
area: codegen, runtime
language_feature: regular expressions
goal: host-independence
sprint: 60
required_by: [1539]
related: []
note: "Line numbers verified against main 2026-05-21: typeof-delete.ts:301-308, builtin-tags.ts:180, string-ops.ts:1680/1746 all confirmed. No regex-compile.ts file exists; suggested module name."
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
- [x] `--standalone` build with a regex literal or `new RegExp(…)`
      fails at compile time with: "RegExp is not supported in
      standalone mode (#1474). Recompile without --standalone, or
      avoid regex."
- [x] Source line / column reported in the error.
- [x] `--js-host` default mode unchanged — all existing regex tests
      still pass.

## Phase 1 implementation notes (landed)

Refuse-and-document gates added on `ctx.standalone` at every codegen
site that produces or host-routes a RegExp value. All use the
`Codegen error:` prefix so `compiler.ts` fails the build (matching the
WASI DOM/timer refusal pattern at `index.ts:8362/8439`):

- `src/codegen/typeof-delete.ts` `compileRegExpLiteral` — regex literals.
- `src/codegen/expressions/new-super.ts` — `new RegExp(...)`.
- `src/codegen/expressions/calls.ts` — `RegExp(...)` (no `new`), plus the
  `eval("/"+X+"/")` peephole (returns `undefined` so the host import is
  never registered).
- `src/codegen/string-ops.ts` — host fall-through for
  `match`/`matchAll`/`search` (always regex) and
  `replace`/`replaceAll`/`split` when the first arg is statically a RegExp.

Tests: `tests/issue-1474-standalone-regex-refuse.test.ts` (14 cases —
9 refusal + location asserts, 4 default-mode-unchanged, 1 no-import
assert). Default-mode `tests/regexp.test.ts` and standalone
`tests/issue-1470-standalone-string-imports.test.ts` both still green.

Verification on 2026-06-01:

- Spec checked from TC39 ECMA-262 anchors:
  [`RegularExpressionLiteral`](https://tc39.es/ecma262/#sec-regular-expression-literals),
  [`RegExp` constructor](https://tc39.es/ecma262/#sec-regexp-constructor),
  [`RegExpInitialize`](https://tc39.es/ecma262/#sec-regexpinitialize) /
  [`[[RegExpMatcher]]` instance state](https://tc39.es/ecma262/#sec-properties-of-regexp-instances),
  and the string dispatch points
  [`match`](https://tc39.es/ecma262/#sec-string.prototype.match),
  [`matchAll`](https://tc39.es/ecma262/#sec-string.prototype.matchall),
  [`search`](https://tc39.es/ecma262/#sec-string.prototype.search),
  [`replace`](https://tc39.es/ecma262/#sec-string.prototype.replace),
  [`replaceAll`](https://tc39.es/ecma262/#sec-string.prototype.replaceall),
  [`split`](https://tc39.es/ecma262/#sec-string.prototype.split).
  These all require a real RegExp object/matcher path, so Phase 1 keeps
  standalone honest by refusing instead of importing the JS host engine.
- `pnpm exec vitest run tests/issue-1474-standalone-regex-refuse.test.ts`
  -> 14 passed.
- `pnpm exec vitest run tests/equivalence/regexp-methods.test.ts tests/issue-1470-standalone-string-imports.test.ts`
  -> 28 passed.
- `pnpm exec vitest run tests/regexp.test.ts` -> 10 passed.

Phase 2 (NFA engine) remains a separate follow-up issue.

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

## Implementation Plan

### Root cause
The compiler has no Wasm-native regex engine. Every regex literal
(`/foo/g`), every `new RegExp(...)` call, and every
`String.prototype.{replace, replaceAll, split, match, matchAll}`
with a RegExp first argument routes through the JS `RegExp` engine
via the `RegExp_new` host import (`typeof-delete.ts:301-308`) and
follow-up `__extern_method_call` invocations
(`string-ops.ts:1680-1746`). In `--target standalone` mode, every
such call fails at `wasmtime instantiate` with
`unknown import env::RegExp_new`.

This issue is **Phase 1 only — refuse-and-document**. Phase 2 (NFA
engine) is left as a follow-up issue once the rest of the
host-independence sprint lands and we know which regex features the
example/test262 surface actually needs.

### Prerequisite (depends on #1470)
- `ctx.standalone` flag (from #1470). #1474 does NOT depend on
  #1471, #1472, or #1473 — Phase 1 is purely a compile-time
  refusal.

### Changes

**(1) Regex literal — `src/codegen/typeof-delete.ts:287-311`
(`compileRegExpLiteral`)**

Gate the entire body at the top:

```ts
export function compileRegExpLiteral(
  ctx: CodegenContext, fctx: FunctionContext, expr: ts.Expression
): ValType | null {
  if (ctx.standalone) {
    reportError(ctx, expr,
      "RegExp literals are not supported in --target standalone " +
      "(#1474). Recompile without --target standalone, or replace " +
      "the regex with String.prototype.{indexOf, startsWith, slice}.");
    return null;
  }
  const { pattern, flags } = parseRegExpLiteral(expr.getText());
  // ... existing body unchanged ...
}
```

**(2) `new RegExp(...)` constructor — `src/codegen/builtin-tags.ts`
line ~65 (`BUILTIN_TYPE_TAGS["RegExp"]`) and line ~180 (allowed-
constructors list)**

Two surgery points:

```ts
// builtin-tags.ts ~180 (allowed builtin constructor list)
function isAllowedBuiltinCtor(
  ctx: CodegenContext, name: string
): boolean {
  if (ctx.standalone && name === "RegExp") return false;
  // ... existing list check ...
}
```

And in `src/codegen/expressions/new-super.ts` at the dispatch site
for `RegExp` (search `case "RegExp":` or the allowed-ctor branch):

```ts
if (className === "RegExp" && ctx.standalone) {
  reportError(ctx, expr,
    "new RegExp(...) is not supported in --target standalone " +
    "(#1474). Recompile without --target standalone.");
  return null;
}
```

**(3) String methods with regex first arg —
`src/codegen/string-ops.ts:1680, 1690, 1718, 1746`**

The existing structure at line 1680:

```ts
const firstArgIsRegExp = … symName === "RegExp";
if (method === "replace" && !firstArgIsRegExp) { … native path … }
// else fall through to __extern_method_call (JS host)
```

Add an explicit refusal branch BEFORE the fallback:

```ts
if (firstArgIsRegExp && ctx.standalone) {
  reportError(ctx, expr,
    `String.prototype.${method}(RegExp, …) is not supported in ` +
    `--target standalone (#1474). Pass a string pattern instead, ` +
    `or recompile without --target standalone.`);
  return null;
}
```

Apply at all four sites: 1680 (`replace`), 1690 (`replaceAll`),
1718 (`split`), 1746 (`match` / `matchAll`).

**(4) `regexpArgMethods` — `src/codegen/index.ts` line ~3451**

Search for the variable `regexpArgMethods` (per the issue body).
At the import-registration site, gate:

```ts
if (ctx.standalone) {
  // do not register the regex-arg host imports; the per-method
  // gates above will report a compile error at each use site.
  return;
}
// ... existing import registration ...
```

This ensures that even if a use site is missed by (3), the import
won't appear in the standalone output (and the use-site fallback
will still error at codegen).

**(5) `src/codegen/declarations.ts` lines 200, 288**

The issue body cites these as additional regex-related sites.
Audit each: if they register a regex-related host import, gate on
`ctx.standalone` and skip. If they emit a regex call directly,
add the same `reportError` pattern.

### Error message style

All five refuse-points use the same shape:

```
<Feature> is not supported in --target standalone (#1474).
<Workaround 1>, or recompile without --target standalone.
```

Source line/col come for free from `reportError(ctx, expr, msg)`
because `expr` carries the original `ts.Node` with position info.

### Wasm IR patterns

None — Phase 1 emits no Wasm for regex. Phase 2 (follow-up) will
emit a full NFA engine; spec defers to that issue.

### Test approach

- **New**: `tests/standalone-regex-refuse.test.ts`:
  ```ts
  it("rejects regex literal in standalone mode", () => {
    const result = compile(
      `export function f(s: string) { return /\\d+/.test(s); }`,
      { target: "standalone" });
    expect(result.success).toBe(false);
    expect(result.errors[0].message).toMatch(/#1474/);
    expect(result.errors[0].line).toBe(1);
  });

  it("rejects new RegExp in standalone mode", () => { … });
  it("rejects s.replace(regex, ...) in standalone mode", () => { … });
  it("rejects s.match(regex) in standalone mode", () => { … });
  it("rejects s.split(regex) in standalone mode", () => { … });
  ```
- **Default-mode regression**: rerun
  `tests/equivalence.test.ts` (no `target` override) — all
  existing regex tests must remain green.
- **Import-section assertion** (shared helper from #1470): for a
  test program that uses NO regex, assert zero
  `env::RegExp_new`, `env::regexp_*` imports in standalone mode.

### Dependency ordering

Within #1474: Phase 1 is one PR. ~80 LOC across 5 files; can land
in a single session.

Cross-issue ordering: #1474 only requires #1470 (the
`ctx.standalone` flag). Can land in parallel with #1471, #1472,
#1473. **Suggest landing #1474 last** so the other four issues
don't inadvertently introduce new regex paths that bypass the
refusal gate.

### Follow-up issue scope (Phase 2 — NFA engine)

To be filed as a new issue once #1470-1473 land:

- Pattern → NFA compiler (`src/codegen/regex-compile.ts`) — Thompson's
  construction over the regex AST.
- WasmGC NFA executor (`src/codegen/wasm-helpers/regex-runtime.ts`):
  ```
  $RegExp     (struct $nfa $flags $lastIndex)
  $NfaStates  (array (mut $NfaState))
  $NfaState   (struct $kind $char $next1 $next2)
  $MatchArray (struct $input $idx $captures)
  ```
- Subset: char classes, anchors, alternation, `*`/`+`/`?`/`{n,m}`,
  capturing groups, non-greedy variants, flags `g`/`i`/`m`/`s`.
- Excludes: backreferences, lookahead/lookbehind, Unicode property
  escapes, sticky semantics with state.
- Bench target: 5× JS-host on `/\w+/g.exec(longText)`.
