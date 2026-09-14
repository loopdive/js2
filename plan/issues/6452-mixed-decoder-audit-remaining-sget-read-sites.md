---
id: 6452
title: "Mixed-decoder audit: 27 more host helpers read `__sget_` with the READER's exports"
status: ready
sprint: current
created: 2026-09-13
updated: 2026-09-13
priority: medium
horizon: l
feasibility: medium
reasoning_effort: high
task_type: bug
area: compiler
goal: correctness
---

## Problem

Three issues have now fixed the same one-line defect at different sites:
[#5225](https://js2wasm.loopdive.com/dashboard/issue.html?slug=5225-consumer-minted-struct-opaque-in-linked-provider)
(`__extern_get` and one more),
[#5365](https://js2wasm.loopdive.com/dashboard/issue.html?slug=5365-compiled-closure-length-reads-vec-getter-miss)
(closure `.length` ahead of the probe), and
[#6426](https://js2wasm.loopdive.com/dashboard/issue.html?slug=6426-object-assign-option-bag-across-linked-package)
(`__extern_rest_object`, `__object_values`, `__object_entries`, the
`__extern_slice` tuple arm).

The shape is always identical. A host helper binds

```ts
const exports = callbackState?.getExports();   // the READER's exports
```

and then reads a struct field through `exports["__sget_<key>"]`. A `__sget_`
getter is module-global by field **name** and does **not** trap on a struct type
it does not own: it `ref.test`-misses and returns that getter's default — `null`
for references, `0` for numbers. So across a linked package boundary the read
silently yields a wrong value instead of failing. `_decoderExportsFor(obj,
callbackState?.getExports())` is the fix, and it has been applied one site at a
time, each time after a user-visible bug was reported.

**A mechanical scan of `src/runtime.ts` at `3e92241ecc` finds 27 more sites with
that exact shape** (`const <x> = callbackState?.getExports();` followed within 45
lines by a `__sget_` read, with no `_decoderExportsFor`):

| import | lines |
| --- | --- |
| `__iterator_next` | 17359, 17365, 17371, 17380, 17388 |
| `__extern_length` | 12890\*, 12929 |
| `__defineProperties` | 14229\*, 14272 |
| `__for_in_has` | 16616, 16638 |
| `__gen_result_value` / `_f64` / `_done` | 17191, 17198, 17207 |
| `__extern_get_idx`, `__extern_has_idx` | 12978, 13050 |
| `__make_iterable`\*, `__array_values`, `__array_concat_any` | 17483, 17619, 17637 |
| `__async_iterator`, `__iterator_return` | 17314, 17424 |
| `preventExtensions` | 9833 |
| unnamed helpers | 3454, 5513, 5527, 5641\*, 5678 |

\* = also reads the field **names** (`_getStructFieldNames` /
`__struct_field_names`) from the same reader exports, which is the strictly worse
variant: names and values then disagree about which module owns the struct.

## Why this is worth doing as one pass

Three separate user-visible bugs have now been paid for one site at a time, and
the remaining list includes the iterator protocol and `for-in` — paths that a
linked package hits constantly. The per-site cost is one line; the cost of
finding each one the current way is a reported bug plus a reduction.

**But it is explicitly NOT a blind sed.** Some of these sites may be reached only
with structs the reader does own, in which case `_decoderExportsFor` is a no-op
and the change is noise; others may pass `exports` on to a helper that already
applies the decoder. Each site needs its own two-module probe before it is
touched.

## Acceptance criteria

1. Every one of the 27 sites is classified: **fix** (a linked-lane probe shows a
   wrong value), **already-covered** (the decoder is applied downstream), or
   **unreachable-cross-module** (with the argument for why).
2. Each `fix` site gets a row in one regression test built on the
   `tests/issue-6426-linked-object-rest-source.test.ts` three-lane pattern
   (single / one-unit multi / `compileProject` separate, one shared `EXPECTED`
   table, `linkPlan.mode === "separate"` asserted).
3. A lint or gate that makes the next instance fail at author time rather than at
   bug-report time — the recurring-defect part of this issue, and the part that
   stops a fourth round.
4. `src/runtime.ts` is **at** the #4401 ceiling (19735 lines), so the pass must
   be line-neutral or move the helpers into `src/runtime/<module>.ts`.
5. A/B over the 17 dogfood suites, per test file.

## Reproduction of the scan

```bash
python3 - <<'PY'
import io, re
lines = io.open("src/runtime.ts", encoding="utf-8").read().split("\n")
for i, l in enumerate(lines):
    if re.search(r"const \w+ = callbackState\?\.getExports\(\);", l) and "_decoderExportsFor" not in l:
        w = "\n".join(lines[i:i+45])
        if "__sget_" in w:
            print(i+1, "names_too=" + str("_getStructFieldNames" in w or "__struct_field_names" in w))
PY
```
