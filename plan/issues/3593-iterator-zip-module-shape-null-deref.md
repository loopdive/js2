---
id: 3593
title: "codegen: Iterator.zip over object-literal iterators null-derefs in __module_init (shape-sensitive, pre-existing) — uncatchable trap"
status: in-progress
sprint: current
assignee: ttraenkler/L-regexp
created: 2026-07-25
updated: 2026-08-02
priority: high
horizon: l
feasibility: hard
reasoning_effort: max
task_type: bugfix
area: codegen
language_feature: iterator-helpers
goal: correctness
related: [3024, 3189]
---

# #3593 — `Iterator.zip` over object-literal iterators traps (`dereferencing a null pointer` in `__module_init`)

**Routing: senior-dev.** This is a shape-sensitive module-lowering defect, not a
one-liner. Hand-written snippets do **not** reproduce it — it needs the real
test262 harness module shape.

Surfaced while landing the #3024 iterator-dispatcher slice (PR #3563). The trap
**pre-dates that PR**; #3563 only made the affected file compile far enough to
reach it. See "Attribution" — that is measured, not assumed.

## Symptom

`test/built-ins/Iterator/zip/iterables-iteration.js` (default gc lane):

```
RuntimeError: dereferencing a null pointer in __module_init()
```

Classified `null_deref` by the #3189 uncatchable-trap ratchet. This is an
**uncatchable trap**, the worst failure class — the module aborts rather than
throwing a catchable `TypeError`.

## Minimized repro (verbatim — keep the `includes:` line, it is load-bearing)

```js
/*---
esid: sec-iterator.zip
description: minimized repro
includes: [proxyTrapsHelper.js, compareArray.js]
features: [joint-iteration]
---*/
var throwingIterator = {
  next() {},
  return() {},
};
var iterableReturningThrowingIterator = {
  [Symbol.iterator]() {},
};
assert.throws(TypeError, function () {
  Iterator.zip(Object.create(null));
});
Iterator.zip([throwingIterator, iterableReturningThrowingIterator]);
```

Obtained by greedy line-deletion minimization of the real file, run through the
real runner (`runTest262File`). Note the method bodies are **empty** after
minimization — the original `throw new Test262Error()` bodies are not needed.

## Attribution — PROVEN pre-existing (the important part)

The identical minimized file was run **twice**, changing only one thing:

| `src/codegen/index.ts`      | result                                                         |
| --------------------------- | -------------------------------------------------------------- |
| PR #3563's version          | `TRAP=true :: dereferencing a null pointer in __module_init()` |
| restored from `origin/main` | `TRAP=true :: dereferencing a null pointer in __module_init()` |

Byte-identical trap with the dispatcher change **absent** ⇒ the defect is not
caused by #3563.

**Stated precisely** (so this can't be poked at): the trap reproduced _from that
file by deletion-minimization_ occurs on `main` with the dispatcher change
absent. The **real** file cannot itself be A/B'd, because on `main` it is a
`compile_error` (invalid Wasm) and never instantiates — which is exactly why the
#3189 ratchet's baseline could not testify about it, and why the
`compile_error` baseline-unknown exclusion (#3594-era work) is the correct
unblock for #3563.

## Shape sensitivity — 8 variants, only the full combination traps

Every **simpler** shape yields a clean, **catchable** `TypeError`, never the trap:

| #    | shape                                                                     | result                                                 |
| ---- | ------------------------------------------------------------------------- | ------------------------------------------------------ |
| min1 | full minimized repro above                                                | **TRAP**                                               |
| min2 | `Iterator.zip([{[Symbol.iterator](){}}])`                                 | `TypeError: Iterator helper: argument is not iterable` |
| min3 | `Iterator.zip([{next(){}, return(){}}])`                                  | `TypeError: ... not iterable` (see "second defect")    |
| min4 | min3 but `next()` returns `{done:true, value:undefined}`                  | `TypeError: ... not iterable`                          |
| min5 | min3 plus draining `z.next()`                                             | `TypeError: ... not iterable`                          |
| min6 | `assert.throws(TypeError, () => Iterator.zip(Object.create(null)))` alone | **passes**                                             |
| min7 | `try { Iterator.zip(Object.create(null)); } catch (e) {}` alone           | **passes**                                             |
| min8 | min6 + `Iterator.zip([{[Symbol.iterator](){}}])`                          | `TypeError: ... not iterable`                          |

So the trap needs **both** object-literal iterators **and** the preceding
`assert.throws` **and** the `includes:` harness injection. That combination
changes the module's struct/closure shape — which is why standalone
`compile()` snippets (tried, 4 variants) never reproduce it.

## Ruled out — do not re-chase

The obvious suspect is `_getFlattenable` in `src/runtime/iterator-polyfills.ts`
(~L577): `it = sym.call(obj)` can yield `undefined`, and per ES2025
GetIteratorFlattenable step 5 a non-Object must throw a `TypeError`. **It is
already guarded** — `_getIteratorDirect` (~L547) starts with
`if (!_isObject(iter)) throw new TypeError(...)`. The JS-host polyfill is
spec-correct here.

The trap is in **compiled Wasm** (`__module_init`), not in the polyfill.

## 2026-08-02 — re-confirmed live on main, plus a NEW datum the report lacked

Re-run through the real runner on `upstream/main` @ `5f2070245` (so this is not
stale): **both** still trap.

| target | result |
| --- | --- |
| `test/built-ins/Iterator/zip/iterables-iteration.js` | `RuntimeError: dereferencing a null pointer in __module_init()` **at source L76** |
| the `min1` repro above | `RuntimeError: dereferencing a null pointer in __module_init()` **at source L16** |

**The new datum is the source-line attribution, and it points somewhere the
report did not.** For `min1`, source **L16 is `});`** — the *close of the
`assert.throws(...)` call* on L14–16 — **not** L17's
`Iterator.zip([throwingIterator, iterableReturningThrowingIterator])`:

```
14  assert.throws(TypeError, function () {
15    Iterator.zip(Object.create(null));
16  });                                      <-- trap attributed HERE
17  Iterator.zip([throwingIterator, iterableReturningThrowingIterator]);
```

Put beside the existing shape table this sharpens the question considerably.
`min6`/`min7` — the `assert.throws` **alone** — *pass*. So the statement the
trap is attributed to is fine on its own, and **adding L17 changes how L14–16
is compiled**. That is the signature of a module-level layout effect (the
struct/closure shape of `__module_init` changing when the second `Iterator.zip`
call is added), not of a defect inside either statement.

Two consequences for whoever continues:

- Chasing `Iterator.zip([...])` — the statement that *looks* guilty — is
  probably chasing the wrong line. The trap fires at the earlier call.
- The WAT dump named below should be diffed **min1 vs min7** (trap vs pass,
  differing by one statement), which is a far smaller diff than min1 vs the
  real file and isolates exactly the layout change that introduces the null.

## Suggested next step (WAT dump — still the right move)

Source-level minimization stopped converging. The file **compiles on the #3563
branch**, so the direct move is to dump its **WAT** (`compile(src, { emitWat:
true })`, or the `/analyze-wat` skill), locate `__module_init`, and find the
`ref.as_non_null` / `ref.cast` / `struct.get`-on-null site. Reconstruct the
assembled source using the runner's harness-prelude builder
(`tests/test262-runner.ts` ~L2405-2450 for the `allowProxyTraps` shim).

Worth also diffing the real file's WAT against min1's, to confirm they are the
**same** trap site — both report `dereferencing a null pointer in
__module_init()`, which alone does not distinguish them.

## Second defect found alongside (record, distinct)

`min3` — `Iterator.zip([{ next(){}, return(){} }])` — reports
`TypeError: Iterator helper: argument is not iterable`. Per
GetIteratorFlattenable that is **wrong**: with no `@@iterator`, step 3a sets
`iterator = obj`, and GetIteratorDirect then succeeds because `.next` **is** a
function. So a compiled object literal's `.next` is not visible as a function to
the host polyfill. That is evidence about the mechanism (host↔Wasm objlit method
visibility) and may share a root cause with the trap.

## Accepted risk (recorded deliberately, not glossed)

PR #3563 is being unblocked via the trap-ratchet `compile_error`
baseline-unknown exclusion rather than by fixing this defect. That means **the
corpus gains one genuinely-trapping test** (`iterables-iteration.js`) until this
issue is fixed. This trade was made knowingly: the defect predates #3563, and
blocking a +33-net / 8-CE-elimination PR on an unrelated deep defect is bad
economics. Whoever picks this up should expect a live trap in the corpus
pointing at this issue — it is not a new regression.

## Acceptance criteria

- `test/built-ins/Iterator/zip/iterables-iteration.js` no longer produces an
  uncatchable trap; any failure is a catchable `TypeError`/`Test262Error`.
- The minimized repro above runs without `dereferencing a null pointer`.
- The `null_deref` trap-category count does not increase.
- Ideally: `min3` reports the spec-correct behaviour (objlit `.next` visible to
  GetIteratorFlattenable), or that is split into its own issue.
