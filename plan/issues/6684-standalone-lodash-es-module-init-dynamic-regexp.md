---
id: 6684
title: "standalone: lodash-es module-init hits a runtime-built RegExp outside the dynamic grammar (`Unsupported dynamic regular expression pattern`)"
status: ready
sprint: Backlog
created: 2026-09-26
updated: 2026-09-26
priority: high
horizon: m
feasibility: medium
reasoning_effort: high
task_type: bug
area: compiler
language_feature: RegExp
goal: standalone
requested_by: ttraenkler/sendev-standalone
related: [6681, 4439]
---

# #6684 — standalone: lodash-es module-init throws on a runtime-built RegExp

## Problem

After #6681 (`Date.now` as a value), the lodash-es npm-compat
`standalone-dynamic` lane compiles with 0 imports and fails at module-init with
(verbatim):

```
TypeError: Unsupported dynamic regular expression pattern
```

That is the #4439 poisoned-`$NativeRegExp` refusal: `__regex_compile_dynamic_simple`
accepts only a narrow runtime grammar and a pattern outside it throws on first
use.

Likely site (unverified — confirm with a scoped probe before implementing):
`_baseIsNative.js` builds

```js
var reIsNative = RegExp('^' +
  funcToString.call(hasOwnProperty).replace(reRegExpChar, '\\$&')
  .replace(/hasOwnProperty|(function).*?(?=\\\()| for .+?(?=\\\])/g, '$1.*?') + '$');
```

and module-init runs it through `getNative(Object, 'create')` →
`baseIsNative` → `reIsNative.test(...)`. The pattern carries lazy quantifiers
(`.*?`) and escaped metacharacters produced at run time. The other module-init
RegExp constructions (`_hasUnicode`, `_unicodeToArray`, `_unicodeWords`) build
large character-class patterns the same way and are the next candidates.

## Acceptance

- The lodash-es `standaloneDynamic` lane gets past module-init with 0 imports.
- Standalone `built-ins/RegExp` test262 rows do not regress.
