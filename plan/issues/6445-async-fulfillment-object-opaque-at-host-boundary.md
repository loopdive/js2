---
id: 6445
title: "An object literal awaited out of an async function reaches the JS host as an EMPTY object — the Promise fulfillment boundary never converts the WasmGC struct"
status: ready
sprint: current
created: 2026-09-13
updated: 2026-09-13
priority: medium
horizon: m
feasibility: medium
task_type: bug
area: codegen
goal: correctness
---

## Problem

An engine-activated async function that returns an object literal settles its
Promise with the raw WasmGC struct. On the JS host that struct arrives as an
object with **no own properties** — `typeof` says `"object"`,
`Object.prototype.toString` says `[object Object]`, and `Object.keys` is empty.
Every field is silently `undefined`.

```js
// mod.js (untyped, two-file project)
export async function outer(key) {
  const jwk = await inner(key);
  return jwk;                        // ← the object crosses to the host
}
async function inner(k) {
  return { kty: "RSA", alg: "RS256", key_ops: ["verify"] };
}
```

```ts
// entry.ts
const value = await (outer as unknown as (k: unknown) => Promise<any>)("k");
value.kty;                 // undefined   (expected "RSA")
Object.keys(value);        // []          (expected ["kty","alg","key_ops"])
```

Reading the same fields **inside wasm** works — `return jwk.kty + "/" +
jwk.key_ops[0]` hands the host `"RSA/verify"` correctly. So the lowering and the
struct are fine; only the value that crosses the Promise fulfillment boundary is
unconverted.

## Not a declaration-order effect

Measured both ways on unmodified `upstream/main` at `e8a778638f` (2026-09-12):
caller-declared-first and callee-declared-first produce the **same** empty
object. That control matters because this was found while fixing
[#6412](https://js2wasm.loopdive.com/dashboard/issue.html?slug=6412-hono-jwt-async-resume-extern-convert-any),
which *is* a declaration-order bug in the same area — the two are independent,
and #6412's fix does not move this at all.

## Why it matters

This is a silent wrong-answer, not a crash. Any package whose public async API
resolves to a plain object (a parsed JWK, a config bag, a `{ data, status }`
response) hands its JS caller an object that looks right and reads `undefined`
everywhere. It also caps what an async regression test can assert: #6412's
runtime case had to read the fields in wasm and return a string, because
asserting on the host-side object is vacuous today.

## Reproduce

```bash
node --import tsx - <<'EOF'
# two-file project as above; compileProject(entry, {allowJs:true, target:"gc"})
# then instantiateWithRuntime + await the export
EOF
```

Or run `tests/issue-6412-async-forward-ref-result-abi.test.ts` Case C with the
in-wasm field read replaced by `return jwk;` and a host-side
`expect(value.kty).toBe("RSA")` — it fails on main with `undefined`.

## Acceptance criteria

1. An async function fulfilling with an object literal hands the JS host an
   object whose own properties match — `value.kty === "RSA"`,
   `Object.keys(value)` non-empty.
2. Both declaration orders behave identically (they already do; keep it so).
3. A regression test that fails on the parent commit and passes with the fix,
   including the nested-array field (`key_ops`).
4. No movement in the 17 dogfood upstream suites.

## Notes

Likely the same family as
[#2784](https://js2wasm.loopdive.com/dashboard/issue.html?slug=2784-s3-array-host-boundary-struct-identity)
and
[#3060](https://js2wasm.loopdive.com/dashboard/issue.html?slug=3060-object-hasown-wasmstruct-host)
— a WasmGC struct handed to the host without the boundary conversion — reached
through the async settle path rather than a direct return.
