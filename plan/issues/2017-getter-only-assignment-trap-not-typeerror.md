---
id: 2017
title: "assignment to a getter-only object-literal property traps 'illegal cast' instead of throwing strict-mode TypeError"
status: done
completed: 2026-06-16
assignee: ttraenkler/dev-a
sprint: 63
created: 2026-06-10
updated: 2026-06-16
priority: low
feasibility: medium
reasoning_effort: medium
task_type: bugfix
area: codegen
language_feature: objects
goal: core-semantics
related: [1092, 1932, 2024]
origin: "2026-06-10 spec-conformance sweep (objects agent): verified on main"
---

# #2017 — [[Set]] failure check missing on accessor-literal write path

## Problem

```ts
const o: any = { get x() { return 1; } };
o.x = 99;
// wasm: RuntimeError: illegal cast (uncatchable)
// node: TypeError: Cannot set property x ... which has only a getter
```

## Root cause

The accessor-literal path (`src/codegen/literals.ts:258+`) defines real
host accessors, but the compiled assignment path casts/writes without the
strict-mode [[Set]] failure check (§13.15.2 → §10.1.9). Same family as
#1092 (wrong error type, done) and the class-side #2024.

## Fix direction

When the static property model says get-only, emit a throw of TypeError
instead of the struct write.

## Acceptance criteria

- Repro throws catchable TypeError; getter+setter pairs unchanged

## Dupe check

#1092 done; #1932 is accessor double-get (different). New (borderline
low/wont-fix severity — filed for completeness).

## Resolution (2026-06-16, dev-a)

The "illegal cast" trap was already gone by the time of this verify-wave
(s62 accessor work). The residual divergence was that `o.x = 99` on a
getter-only accessor **silently no-op'd** instead of throwing a catchable
strict-mode TypeError (node: "Cannot set property x … which has only a
getter"). Root cause: object literals `{ get x(){…} }` install a real host
accessor on a `__new_plain_object` JS object; `o.x = …` lowers to
`__extern_set` → `_safeSet`, whose strict `obj[key] = val` correctly threw
V8's getter-only TypeError — but `_safeSet`'s catch swallowed it and
diverted to the sidecar.

Fix (`src/runtime.ts`): in `_safeSet`'s write catch, detect a getter-only
accessor via the new `_isGetterOnlyAccessor(obj, key)` helper (walks the
proto chain; data property anywhere shadows it) and re-throw a
spec-worded TypeError instead of falling through to the sidecar. Mirrors
the existing `_isRevokedProxyError` rethrow (#2180). get/set pairs and
plain dynamic writes are unaffected.

Regression net: `tests/issue-2017.test.ts` (4 cases). The pre-existing
`accessor-side-effects.test.ts` 3 failures are unchanged by this fix
(confirmed failing on unmodified main). **Out of scope, noted:** data
property in an `any`-typed object literal that is later overwritten
(`const o:any={a:1}; o.a=42` reads back `1`) is a separate pre-existing
bug in the literal/sidecar write path, unrelated to the getter-only
accessor semantics fixed here.
