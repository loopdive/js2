---
id: 3750
title: "Object property assigned dynamically inside a loop/switch (a shape NOT present in the object's initial literal) is silently dropped — compiles clean, runs clean, property just never appears"
status: ready
sprint: current
created: 2026-07-28
updated: 2026-07-28
priority: high
horizon: m
feasibility: hard
reasoning_effort: high
task_type: bugfix
area: codegen
language_feature: dynamic-property-assignment
goal: core-semantics
origin: "tests/dogfood/cookie-harness.mjs (#3751) — cookie@2.0.1's parseSetCookie('foo=bar; HttpOnly') returns {name:'foo',value:'bar'} instead of {name:'foo',value:'bar',httpOnly:true}; reduced to a minimal repro fully independent of cookie"
related: [3751, 3747, 3749, 1710, 3716, 3748]
---

# #3750 — dynamically-added object property silently dropped

## Severity

Same class as #3747 and #3749: a **silent runtime correctness bug**, not
a diagnostic gap or a thrown error. `compile()` reports `success: true`,
the binary validates and instantiates fine, the call doesn't throw — the
property write is just silently no-op'd. Nothing in the pipeline flags
it.

## Repro (reduced from real cookie source, fully independent of cookie)

```js
function endIndex(str, min, len) {
  const index = str.indexOf(";", min);
  return index === -1 ? len : index;
}
function eqIndex(str, min, len) {
  const index = str.indexOf("=", min);
  return index === -1 ? len : index;
}
function valueSlice(str, min, max) {
  if (min === max) return "";
  return str.slice(min, max);
}

export function parseSetCookie(str) {
  const len = str.length;
  const endIdx = endIndex(str, 0, len);
  let eqIdx = eqIndex(str, 0, len);
  const setCookie =
    eqIdx < endIdx
      ? { name: valueSlice(str, 0, eqIdx), value: valueSlice(str, eqIdx + 1, endIdx) }
      : { name: "", value: valueSlice(str, 0, endIdx) };
  let index = endIdx + 1;
  while (index < len) {
    const endIdx2 = endIndex(str, index, len);
    if (eqIdx < index) eqIdx = eqIndex(str, index, len);
    const attr = eqIdx < endIdx2 ? valueSlice(str, index, eqIdx) : valueSlice(str, index, endIdx2);
    switch (attr.toLowerCase()) {
      case "httponly":
        setCookie.httpOnly = true;
        break;
      case "path":
        setCookie.path = "/x";
        break;
    }
    index = endIdx2 + 1;
  }
  return setCookie;
}
```

```ts
const result = await compile(src, { fileName: "min.js", skipSemanticDiagnostics: true });
// result.success === true, binary validates, instantiates fine
exp.parseSetCookie("foo=bar; HttpOnly");
// returns {"name":"foo","value":"bar"} — WRONG, real JS gives
// {"name":"foo","value":"bar","httpOnly":true}
```

Full real-world confirmation via the actual pinned cookie package
(`tests/dogfood/cookie-harness.mjs`, #3751):

| input | compiled | native |
| --- | --- | --- |
| `"foo=bar"` (no attrs) | `{name:"foo",value:"bar"}` | `{name:"foo",value:"bar"}` — matches |
| `"foo=bar; HttpOnly"` | `{name:"foo",value:"bar"}` | `{name:"foo",value:"bar",httpOnly:true}` — **diverges** |
| `"foo=bar; Path=/"` | `{name:"foo",value:"bar"}` | `{name:"foo",value:"bar",path:"/"}` — **diverges** |
| `"foo=bar; HttpOnly; Secure; Path=/; Domain=example.com"` | `{name:"foo",value:"bar"}` | `{name:"foo",value:"bar",httpOnly:true,secure:true,path:"/",domain:"example.com"}` — **diverges** |

The base object (no attributes at all) round-trips correctly; the moment
ANY attribute-setting branch of the `switch` runs, that property is
simply absent from the result — not present with a wrong value, not
present as `undefined` — completely absent, as if the assignment never
executed.

## Relationship to #3747 and #3749

Same general area (object/array shape representation in codegen), three
distinct symptoms found via three different npm packages this session:

- **#3747** (dayjs): a property that EXISTS in the object literal at
  construction (seeded with a non-function value) reassigned to a
  **closure** loses callability (`typeof` wrong, call throws/returns
  null).
- **#3749** (clsx): an array literal containing object literals of
  DIFFERENT shapes crashes `for...in` with a null-pointer deref.
- **#3750** (this issue, cookie): a property that does NOT exist in the
  object literal at construction, added dynamically inside a
  loop/switch, is silently dropped from the result — no crash, no wrong
  type, the write itself just doesn't happen (or doesn't persist to the
  returned value).

All three point at the same underlying architectural gap — TypeScript's
static-shape inference for an object literal doesn't fully track
properties added/changed after construction (matches the project's
already-tracked "evolving type" issue class, #3715, for arrays) — but
each has a different concrete failure mode, so each needs its own
investigation and fix; don't assume fixing one fixes the others.

## Hypothesis (not verified against actual codegen — next step)

The object literal `{ name, value }` (or `{ name: "", value }`, unified
via ternary) most likely compiles to a concrete Wasm GC struct type with
exactly those two fields, inferred once at the literal's construction
site. A later `setCookie.httpOnly = true` — a property NOT in that
inferred shape — has nowhere to actually write on the struct; if the
compiler doesn't hard-error on this (unlike the near-identical case in
#3747's investigation where a bare, unconditional `obj.newProp =
<value>` right next to the object literal DID trip a hard `IR-FALLBACK`
"object has no field" compile error), the write is presumably falling
through some other, more permissive code path (possibly a legacy-AST
fallback specifically for property assignments inside more complex
control flow — switch/loop nesting — that doesn't itself have a target
struct field to write to and just silently continues rather than
erroring). Worth checking why the SAME class of "write a field the
object literal doesn't have" sometimes hard-errors (per the simpler
#3747-adjacent repro) and sometimes silently no-ops (this issue) —
that inconsistency in itself may be the real bug to fix first.

## Scope

- [ ] Trace the actual codegen path for the minimal repro above,
      specifically what happens when a switch/loop-nested
      `obj.newField = value` assignment target isn't a struct field
      that exists on `obj`'s inferred type.
- [ ] Reconcile why this case silently no-ops while a simpler/more
      direct instance of "assign an undeclared field" (see #3747's
      adjacent finding) hard-errors instead — same underlying condition,
      different observed behavior, worth understanding before choosing
      a fix.
- [ ] Fix so the object's inferred struct shape includes every property
      assigned anywhere in its lifetime within the same function (or, if
      that's infeasible for this case, fail loudly at compile time
      instead of silently dropping the write at runtime — silent data
      loss is strictly worse than a compile error here).
- [ ] Regression test pinning the minimal repro (all attribute
      combinations from the table above).
- [ ] Re-run `pnpm run dogfood:cookie` — the three `parseSetCookie_*`
      ops with attributes should flip from `divergent` to `equal`.

## Acceptance criteria

- [ ] The minimal repro's `parseSetCookie("foo=bar; HttpOnly")` returns
      `{name:"foo",value:"bar",httpOnly:true}` instead of dropping
      `httpOnly`.
- [ ] All 4 repro-table rows produce correct output.
- [ ] `tests/dogfood/cookie-harness.mjs`'s `parseSetCookie_httponly`,
      `parseSetCookie_path`, and `parseSetCookie_multiple_attrs` ops all
      diff `equal` against native cookie.
- [ ] Equivalence/regression test added and passing.
