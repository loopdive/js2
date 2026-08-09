---
id: 3564
title: "standalone/host: direct String `.indexOf/.startsWith/.endsWith(x, pos)` 2-arg lowering — standalone fixed by #680; host form is a narrow non-conformance edge"
status: wont-fix
completed: 2026-07-24
created: 2026-07-24
priority: low
feasibility: hard
model: opus
area: codegen, ir
language_feature: strings
goal: standalone
umbrella: 2860
related: [2875, 2002, 2955, 680]
horizon: m
origin: "surfaced 2026-07-24 (dev-std-4) while triaging #2875 slice-3 IR-fallback residuals"
---

# #3564 — direct String search methods with a position argument

Two defects were characterized, then **measured** on current `main`. Verdict:
**wont-fix** — the valuable half is already fixed (#680) and the remaining half
has ~0 test262 value with a net-negative "obvious" fix.

## Defect 2 (STANDALONE) — FIXED by #680 (#3542)
Direct `.indexOf/.startsWith/.endsWith(x, pos)` in `--target standalone`
previously hard-CE'd with `ir/from-ast: method call .X(...) on string not in
slice 4` (the native-mode `stringMethodPlan` returns null for these methods,
demoting to legacy — and pre-#680 the demote was FATAL). #680 retyped the
slice-4 rejection as `IrUnsupportedError` so it demotes to the existing native
`__str_*` cores. Measured post-#680: `indexOf('b',2)`→4, `startsWith('fu',7)`→0,
`endsWith('The',3)`→1, `indexOf('b')`→1 — all correct, host-free. This
standalone-String 2-arg restoration is part of what made #680's aggregate a
modest-positive standalone move (beyond its generator fix).

## Defect 1 (HOST) — narrow, ~0 test262 value, net-negative naive fix → wont-fix
`str.indexOf(x, pos)` emits INVALID Wasm (`call expected externref, found f64`)
**only** in the FUNCTION-WRAPPED, literal/omitted-position form (e.g.
`function f(){ return "abcabc".indexOf("b", 2); }`). A variable position, a
top-level statement, and the top-level-assert form (which is how every test262
`indexOf` file is written) all compile VALID. Measured:
`built-ins/String/prototype/indexOf` host lane = 34 pass / 13 fail on baseline;
the 13 fails are ToPrimitive/ToString coercion edges unrelated to this.

The "obvious" fix — declare `fromIndex` as `f64` in `STRING_METHOD_TABLE.indexOf`
(from-ast.ts) + the host-import table (index.ts:~6038) to match the arg
lowering — is WRONG and net-negative: the `externref` fromIndex is INTENTIONAL,
delegating full `ToInteger` coercion of string/object/boolean positions to the JS
host shim (`indexOf("aa","1.9")`, `indexOf("aa",{})`, `indexOf("aa",[0])`,
`indexOf("aa",true)` in `position-tointeger.js`). Forcing `f64` regressed
`position-tointeger.js` (34/13 → 33/14). A correct fix would box the literal
position to `externref` in the IR arg-lowering — a deep IR change with **0
measured conformance value** and real regression risk.

## Disposition
wont-fix. Standalone is done (#680). The host form is a narrow codegen edge
(playground/CLI `function`-wrapped literal-position `indexOf`) that no test262
row exercises; a correct fix is net-negative effort. Reopen only if a real
program surfaces the host form AND a boxing fix can be shown byte-neutral for
the coercion path.
