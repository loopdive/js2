---
id: 6672
title: "standalone: RegExp exec reached through an untyped property chain returns null — marked's lexer throws `Infinite loop on byte: 35`"
status: done
sprint: current
created: 2026-09-24
updated: 2026-09-24
completed: 2026-09-24
priority: medium
horizon: m
feasibility: medium
reasoning_effort: high
task_type: bug
area: compiler
goal: standalone
related: [1539, 3507, 4042, 6662, 6665, 6677]
assignee: ttraenkler/sendev-standalone
loc-budget-allow:
  # 2026-09-24 (#6672): the helper body lives in the NEW module
  #   src/codegen/regexp-exec-carrier.ts. What grows in the god-files is the
  #   wiring that cannot move out of them:
  #   closed-method-dispatch.ts  +4  the existing #3507 `$NativeRegExp` brand arm
  #     of `__call_m_<m>_1` now also serves `exec` (selects the exec carrier and
  #     skips the boolean box), plus the note saying so.
  #   call-receiver-method.ts    +3  reserve `__regexp_exec_carrier` next to the
  #     test carrier, while function indices are still append-safe (the
  #     dispatcher fill only READS funcMap, #1719).
  - src/codegen/closed-method-dispatch.ts
  - src/codegen/expressions/call-receiver-method.ts
func-budget-allow:
  # 2026-09-24 (#6672): same two edits, inside the two functions that own them.
  - src/codegen/closed-method-dispatch.ts::fillClosedMethodDispatch
  - src/codegen/expressions/call-receiver-method.ts::compileReceiverMethodCall
---

# #6672 — `rules.block.heading.exec(src)` answers null in `--target standalone`

## Problem

Found by [#6665](https://js2wasm.loopdive.com/dashboard/issue.html?slug=6665-standalone-string-methods-dynamic-regexp-value),
which moved marked's npm-compat **standalone-dynamic** lane past its last
compile-time refusal. marked now compiles, instantiates and throws at the
checksum call:

```
Error: Infinite loop on byte: 35
```

(the lane itself prints `[object WebAssembly.Exception]` — see the harness note
below). marked's block lexer found no tokenizer rule matching the `#` of
`"# npm-compat\n\nA short paragraph."`: its `heading` rule
`/^ {0,3}(#{1,6})(?=\s|$)(.*)(?:\n+|$)/` is read from the rules table as
`this.rules.block.heading.exec(src)`, and that exec answers `null`.

Minimal repro (untyped `.js`, `target: "standalone"`):

```js
var ye = /^ {0,3}(#{1,6})(?=\s|$)(.*)(?:\n+|$)/;
var rules = { block: { heading: ye } };
function head(r, s) { var t = r.block.heading.exec(s); return t ? t[2].length : -1; }
export function test() { return head(rules, "# npm-compat\n\nA short"); } // standalone: -1, Node: 11
```

The same regex called directly (`ye.exec(s)`) answers 11 — only the
receiver-through-`any` path is wrong. A second, related symptom from the same
probe: marked's `k()` pattern builder
(`new RegExp(src.replace(name, re.source), flags)`) throws an unrendered Wasm
exception for `k(/^a(b)c/).replace("b", "x").getRegex().exec("axc")`.

## Harness note

`scripts/generate-npm-compat-report.mjs` renders a checksum-phase throw with
`renderHarnessThrownText(error, compiled.exports)` — it passes the EXPORTS
where the renderer expects the INSTANCE (`instance.exports.__exn_tag`), so the
payload is never decoded and every checksum throw reads
`[object WebAssembly.Exception]`. Rendering with the instance gives the real
text above.

## Acceptance criteria

- The repro answers 11 under `--target standalone`.
- marked's standalone-dynamic lane moves past `Infinite loop on byte: 35`.

## Implementation Plan

(What was executed.)

1. Reduce: `r.block.heading.exec(s)` and even a bare untyped parameter
   `function ex(re, s) { return re.exec(s); }` return `undefined` (not null) in
   standalone; the same regex through `.test` works. `--inspect`/WAT shows the
   call lowers to `__call_m_exec_1`, whose body is only the open-`$Object` arm
   `__extern_method_call(recv, "exec", [s])`: `[[Get]]` finds no `exec` on a
   `$__StandaloneRegExp` struct, answers undefined, and the call answers
   undefined. `__call_m_test_1` has the #3507 `$NativeRegExp` brand arm into
   `__regexp_test_carrier`; `exec` never got the twin.
2. New module `src/codegen/regexp-exec-carrier.ts`:
   `__regexp_exec_carrier(recv, subject) -> externref` — runtime ToString of the
   subject, then the shared engine body `emitRegExpBuiltinExecFromLocal` (brand
   recovery + RegExpBuiltinExec, the one the reflective `RegExp.prototype.exec`
   closure and the `@@match`/`@@search`/`@@split` protocol bodies use), so g/y
   `lastIndex`, `index`/`input`/`groups` come from the same code. Standalone
   only; no host import.
3. `closed-method-dispatch.ts`: the #3507 brand arm is parameterised — for
   `exec/1` it calls the exec carrier and returns its externref directly (no
   `__box_boolean`). Outermost placement is unchanged, so a user object with its
   own `exec` method still reaches its own arm (the brand test is disjoint).
4. `call-receiver-method.ts`: reserve the exec carrier beside the test carrier.
5. Harness: `compileNpmCompatPerfLane` now also returns `instance`, and the four
   standalone checksum/measure catches render with it
   (`renderHarnessThrownText(error, compiled.instance)`).

## Resolution

- Repro answers 11 (parent: -1). Regression test
  `tests/issue-6672-exec-untyped-chain.test.ts`: 8 cases (nested object chain,
  untyped param, miss → null, index/input, global lastIndex walk, array
  element, non-string subject, user `exec` method still wins), each checked
  against Node as oracle — **0/8 on parent, 8/8 with the fix**.
- Scoped standalone test262 (424 rows: `built-ins/RegExp/prototype/{exec,test}`
  plus every `built-ins/RegExp`, `annexB/built-ins/RegExp` and
  `language/literals/regexp` file calling `.exec(`), via
  `scripts/run-test262-paths.mts --standalone`: parent **408 pass / 12 fail / 4
  CE** → fix **409 / 11 / 4**; +1 `RegExp/prototype/exec/regexp-builtin-exec-v-u-flag.js`,
  no row lost.
- JS host byte-identical (sha256 of three probe modules unchanged, `gc`
  target); marked JS-host dogfood suite 16/30 before and after.
- marked standalone-dynamic lane: parent `Error: Infinite loop on byte: 35`
  (printed as `[object WebAssembly.Exception]` before the harness fix) → now
  past it; the next blocker is
  `TypeError: Unsupported dynamic regular expression pattern` (checksum phase)
  — marked's `k()` rule builder (`new RegExp(src.replace(name, re.source), flags)`)
  produces full-grammar patterns (lookahead, `\p{…}` with `u`, lazy
  quantifiers, classes) that the runtime compiler `__regex_compile_dynamic_simple`
  refuses. Filed as
  [#6677](https://js2wasm.loopdive.com/dashboard/issue.html?slug=6677-standalone-runtime-regexp-compiler-full-grammar).
- Residual, not fixed here: a plain property READ of `exec`/`test` on an erased
  RegExp (`var f = re.exec; typeof f`) still answers `undefined` — the
  standalone `[[Get]]` on a `$__StandaloneRegExp` does not walk to the
  `RegExp.prototype` method closures. Only the call form is fixed.
