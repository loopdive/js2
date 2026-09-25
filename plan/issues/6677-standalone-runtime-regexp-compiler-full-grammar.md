---
id: 6677
title: "standalone: the runtime `new RegExp(dynamic)` compiler covers only a literal/alternation subset — marked's `k()` rule builder throws `Unsupported dynamic regular expression pattern`"
status: ready
sprint: Backlog
created: 2026-09-24
updated: 2026-09-24
priority: medium
horizon: l
feasibility: hard
reasoning_effort: high
task_type: feature
area: compiler
goal: standalone
related: [1539, 2161, 4042, 4065, 6665, 6672]
---

# #6677 — runtime RegExp compilation is a subset; marked needs the full grammar

## Problem

Found by [#6672](https://js2wasm.loopdive.com/dashboard/issue.html?slug=6672-standalone-exec-untyped-property-chain-null),
which moved marked's npm-compat **standalone-dynamic** lane past
`Infinite loop on byte: 35`. The lane now fails at the checksum call with:

```
TypeError: Unsupported dynamic regular expression pattern
```

marked builds ~25 of its rules at module init through a pattern builder:

```js
function k(l, e = "") {
  let t = typeof l == "string" ? l : l.source,
    n = { replace: (s, r) => { let i = typeof r == "string" ? r : r.source;
            return i = i.replace(m.caret, "$1"), t = t.replace(s, i), n; },
          getRegex: () => new RegExp(t, e) };
  return n;
}
// e.g. k(/^(bull)([ \t][^\n]+?)?(?:\n|$)/).replace(/bull/g, Q).getRegex()
```

The patterns reach `new RegExp` as run-time strings, so they go to the Wasm
runtime compiler `__regex_compile_dynamic_simple`
(`ensureDynamicStandaloneRegExpCompiler`, src/codegen/regexp-standalone.ts),
which only accepts literals, groups, alternation and a few escapes. Anything
else makes a poisoned struct that throws the TypeError above on first use.
Minimal repro (untyped `.js`, `target: "standalone"`):

```js
function mk(p) { return new RegExp(p); }
export function test() { return mk("^abc").test("abc") ? 1 : 0; } // standalone: throws; Node: 1
```

`"a+"` and `"[a]"` fail the same way. marked's rules also use lookahead,
`\p{…}` with the `u` flag, lazy quantifiers and character classes.

## Options

1. Extend the Wasm runtime compiler to the grammar the compile-time
   `compilePattern` (src/codegen/regex/compile.ts) already accepts, emitting
   the same bytecode for `__regex_run`. This is the general fix (#4042 tracks
   the test262 side of the same refusal).
2. Compile it away: when every `k()` input is a compile-time constant (true
   for marked: literal regexes and literal/constant `replace` arguments),
   fold the builder chain at compile time and emit a static `$NativeRegExp`.
   Narrower, and needs partial evaluation of a closure-returning builder.

## Acceptance criteria

- The repro answers 1 under `--target standalone`.
- marked's standalone-dynamic lane moves past
  `Unsupported dynamic regular expression pattern`.
