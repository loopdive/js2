---
id: 4136
title: "REGRESSION (#4013): defineProperty/defineProperties write null values and wrong writable attrs — 41 standalone + 5 host files that were passing"
status: ready
sprint: current
created: 2026-08-03
updated: 2026-08-03
priority: high
horizon: m
feasibility: medium
reasoning_effort: high
task_type: bugfix
area: codegen
language_feature: property-descriptors
goal: standalone-mode
related: [1781, 2042, 2371, 1906, 4010, 4013]
origin: "2026-08-03 delta /harvest-errors, baselines 2090e7bfd342 (gitHash b65d2f5a) vs 8dac2d708782 (gitHash c480fb66); oracle v12/honest both sides"
---

# #4136 — silent wrong property values/attributes after #4013

## TL;DR

Previously-passing `Object.defineProperty` / `Object.defineProperties` tests now
observe **`null` where a value was written** and **`writable: false` where
`writable: true` was requested**. These are silent wrong answers: no throw, no
diagnostic — the property simply holds the wrong thing.

Attributed to PR **#4013** (`codex/2929-direct-eval-capture`) by the same
single-promotion bisect as #4135: the buckets are flat across seven intermediate
baseline promotions and move only at `b65d2f5a`.

| signature | prev (`c480fb66`) | cur (`b65d2f5a`) | of which were passing |
| --- | ---: | ---: | ---: |
| `Expected obj[foo] to equal N, actually null` (+ `obj[N]`, `obj[foo2]` variants) | 25 | 61 | 28 |
| `Expected obj[foo] to be writable, but was not.` | 59 | 73 | 13 |
| `dereferencing a null pointer [in __module_init()]` (proto-from-ctor-realm) | 151 | 213 | 10 |

Total previously-passing standalone files now failing in this family: **41**
(28 + 13). Plus the 10 `__module_init` null-derefs, which are loud but in the
same window.

## Not the interpreter arm

Of the 234 official standalone regressions in this window, **209 are on files
that contain no `eval`, no `Function(`, and no `with`**. Every file in the
descriptor family above is dynamic-code-free. The `__module_init` null-deref
group (10 files, `*/proto-from-ctor-realm.js`) is the one arm that *does* touch
dynamic code — treat it separately.

## Host lane arm — 5 files

The host lane's real regressions in this window are 53 records, but **48 of them
are timeouts** (30 `strict rerun: timeout (30s)`, 18 `timeout (30s)`) which also
move in the *fixing* direction (25 + 18 recovered), i.e. signed baseline noise.
The 5 non-timeout host regressions are all the same shape and belong here:

- `test/language/statements/for-await-of/async-func-decl-dstr-array-elem-init-fn-name-fn.js`
- `…-fn-name-class.js`, `…-fn-name-arrow.js`, `…-fn-name-gen.js`, `…-fn-name-cover.js`

failing with `name descriptor value should be <X>; name value should be <X>;
name descriptor should not be writable; …` — the anonymous-function-name
inference now produces a descriptor with the wrong value **and** the wrong
attributes. Same defect class, host lane.

## Samples (standalone, `pass` → `fail`)

- `test/built-ins/Object/defineProperties/15.2.3.7-6-a-104.js`
- `test/built-ins/Object/defineProperty/15.2.3.6-4-109.js`
- `test/built-ins/Object/defineProperty/15.2.3.6-4-98.js`
- `test/built-ins/Object/defineProperties/15.2.3.7-6-a-93.js`
- `test/built-ins/Object/defineProperty/15.2.3.6-4-78.js`
- `test/built-ins/Object/freeze/15.2.3.9-2-c-4.js`

Adjacent, same window, same likely cause (3 records):
`TypeError: Cannot redefine property: configurable attribute of a non-configurable property`
on `15.2.3.7-6-a-208.js`, `15.2.3.6-4-212.js`, `15.2.3.7-6-a-40.js`.

## Explicitly NOT the #4010 own-property work

The obvious hypothesis was collateral from the in-flight unified own-property
table (#4058) / S2 tombstones (#4063). **The bisect rules that out**: the
baseline promoted immediately after #4058 (`28604516`) and the one after #4063
(`73ee7169`) both hold these buckets at exactly 25 / 59 / 151. Do not route this
to the #4010 lane on the assumption that descriptors ⇒ #4010.

## Acceptance criteria

- [ ] The 41 standalone files pass again; the 5 host `fn-name` files pass again.
- [ ] A regression test asserting **both** the written value and the full
      descriptor attribute set (not just "does not throw") — a value-only
      assertion cannot catch the `writable` half of this.
- [ ] Root cause named against a specific #4013 change.
- [ ] The 10 `proto-from-ctor-realm` `__module_init` null-derefs triaged: same
      cause or separate (they are the only dynamic-code-touching arm).

## Reproduction

```bash
curl -sLO https://raw.githubusercontent.com/loopdive/js2wasm-baselines/main/test262-standalone-current.jsonl
grep -c 'actually null' test262-standalone-current.jsonl              # 61
grep -c 'to be writable, but was not' test262-standalone-current.jsonl # 73
```
