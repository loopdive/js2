---
id: 3069
title: "codegen: pure-Wasm Annex B §B.2.2 HTML string-wrapper methods — standalone/WASI lowering"
status: done
completed: 2026-07-06
sprint: current
priority: medium
horizon: m
feasibility: easy
reasoning_effort: low
task_type: feature
area: codegen
language_feature: annexb, string-builtins
goal: spec-completeness
related: [3064, 3063, 2500]
test262_bucket: annexb-string-html
assignee: ttraenkler/dev-annexb
origin: "2026-07-06 harvest (dev-cycleE). origin/main; standalone/WASI (host-free) lane. Sibling of #3064 (escape/unescape) — same Annex B dual-mode gap for the String.prototype HTML wrappers."
---

# #3069 — Annex B §B.2.2 HTML string-wrapper methods have no standalone (host-free) lowering

## Problem

The Annex B §B.2.2 legacy HTML string-wrapper methods —
`String.prototype.{anchor, big, blink, bold, fixed, fontcolor, fontsize,
italics, link, small, strike, sub, sup}` (13 methods) — work in **JS-host
mode** (they dispatch through `__extern_method_call`), but under `--target
standalone` / `--target wasi` there is no JS host, so the call site fell
through: `bold()` returned the wrong string and a raw read null-derefed.

```ts
// --target standalone, before this fix:
"foo".bold(); // → null-deref   (should be "<b>foo</b>")
"foo".anchor('a"b'); // → wrong        (should be '<a name="a&quot;b">foo</a>')
```

These are pure UTF-16 string-concatenation transforms (`CreateHTML`,
§B.2.2.2.1) — **no Unicode substrate**. The only non-trivial part is step 4.b:
each `"` (U+0022) in an attribute VALUE is replaced with `&quot;`.

## Fix

Mirror the dual-mode pattern that landed `escape`/`unescape` (#3064): a
`src/codegen/*-native.ts` emitter for the WasmGC-native helper, emitted inside
`ensureNativeStringHelpers` (avoids STRING_METHODS late-import shifts), with
call-site arms gated on `ctx.nativeStrings`. Host mode is left BYTE-IDENTICAL
(the methods are NOT added to `STRING_METHODS`; the host `__extern_method_call`
path is untouched).

- `src/codegen/html-wrapper-native.ts` (new) — `emitNativeHtmlWrapperHelpers`
  registers `__str_html_escape_quot(s: ref $AnyString) -> ref $NativeString`:
  a two-pass code-unit scan (pass 1 counts `"`, pass 2 fills an
  `outLen = len + 5·nq` array, expanding each `"` to the six units `&quot;`).
  Registered as a DEFINED func via `mintDefinedFunc`/`pushDefinedFunc`.
- `src/codegen/native-strings.ts` — `ensureNativeStringHelpers` calls the new
  emitter at its tail (after `__str_flatten`/`__str_concat` are registered).
- `src/codegen/string-ops.ts` — `compileNativeStringMethodCall` gets a
  data-driven arm (`HTML_WRAPPER_TAGS` table) placed before the host-marshal
  fallthrough. It builds `CreateHTML` inline via `__str_concat` + string
  literals: `<tag>` + S + `</tag>`, or `<tag attr="` + escapeQuot(ToString(value))
  - `">` + S + `</tag>` for the attribute methods (anchor/fontcolor/fontsize/
    link). The receiver is materialized into a local FIRST so ToString(this)
    (step 2) precedes ToString(value) (step 4.b) and normal call eval order holds.
    The checker already resolves these from `lib.es2015.core.d.ts` (in
    `ES_BASE_LIB_NAMES`), so results type as `string` — no checker change needed.

## Acceptance criteria

- All 13 §B.2.2 methods compile **host-free** (no `env` import) and match the
  `CreateHTML` transform, incl. `"`→`&quot;` value escaping, number-arg ToString
  (`fontsize(3)`), absent-arg → `"undefined"`, and empty receiver. ✓
  (`tests/issue-3069-annexb-html-wrappers-standalone.test.ts`, in-Wasm `===`
  assertions instantiated with empty imports)
- Host mode unchanged (methods NOT added to `STRING_METHODS`; `bold()` still
  compiles via the 2 host imports; all changes gated on `ctx.nativeStrings`). ✓
- Raises the standalone `host_free_pass` floor by the
  `annexB/built-ins/String/prototype/<method>` files that previously failed
  host-free.
