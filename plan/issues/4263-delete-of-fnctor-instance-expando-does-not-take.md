---
id: 4263
title: "standalone: `delete` of an EXPANDO on a fnctor instance does not take — the property reads back after deletion (contradicts #4129's 'the delete operator is fine')"
status: ready
sprint: current
created: 2026-08-09
updated: 2026-08-09
priority: medium
horizon: s
feasibility: medium
task_type: bug
area: codegen
goal: core-semantics
related: [4129, 4165, 4194, 4098, 4241]
origin: "found 2026-08-09 while writing the #4241 step-1b pins. A/B'd identical on upstream/main at 4e90526dd — predates the carrier-bag slot work. Filed separately after checking the obvious owners: #4165 (reflective MOP over the own-property bags, incl. delete) is DONE, #4194 (instance expando substrate) is DONE, and #4129 explicitly scopes itself to the Reflect spelling ONLY."
---

# #4263 — `delete instance.expando` is a no-op on a fnctor receiver

## Problem

Under `--target standalone`, deleting an expando (a dynamically-added own
property) from a constructor-function instance does not remove it. The read
afterwards still answers the old value.

```js
function K() { this.a = 1; }
export function test() {
  var k = new K();
  k.p = 5;
  delete k.p;
  return k.p === undefined ? 1 : 0;   // expected 1, measured 0
}
```

Measured on upstream/main @ `4e90526dd` and identically on the #4241 step-1b
branch, so the carrier-intrinsic `$bag` slot neither causes nor fixes it — the
write and read both work; only the delete is inert.

## Why this is not already owned — checked, not assumed

- **#4165** "wire the reflective MOP (hasOwnProperty / gOPD / delete / in /
  keys) onto the #3468 + #3537 own-property bags" — `status: done`. It wired
  the closure (#3468) and vec (#3537) bags; the fnctor-instance receiver is the
  #4194 substrate, which landed later.
- **#4194** instance expando substrate — `status: done`, and its scope is
  write/read/enumeration, not delete.
- **#4098** class instance fields surviving delete — `in-progress`, but its
  subject is DECLARED fields and their tombstones, not bag entries. Its
  machinery (`instance-tombstones.ts`, `carrier-bag-delete.ts`) is the likely
  place a fix lands, which is why that issue is cross-referenced rather than
  duplicated.
- **#4129** — `status: ready`, and its title asserts **"the `delete` operator is
  fine, only the Reflect spelling"**. That premise is FALSE for a fnctor-instance
  expando; see the correction note below.

## Correction owed to #4129

#4129 scopes itself by claiming the `delete` operator works and only
`Reflect.deleteProperty` throws. On the receiver kind here the operator itself
silently fails. #4129's scope statement should be narrowed to the receivers it
actually measured (arrays/`$Object` expandos) so nobody reads it as clearing the
operator generally.

## Related pin already in the tree

`tests/issue-4241-instance-carrier-bag-slot.test.ts` pins this as CURRENT
behaviour — it asserts the deletion does **not** take (`expect(...).toBe(0)`) so
that a future fix trips the pin loudly instead of silently changing an unrelated
file's expectations. Flip that pin when this issue lands.

## Acceptance criteria

- [ ] The repro answers 1.
- [ ] `delete` then re-add round-trips (`k.p = 5; delete k.p; k.p = 7` reads 7).
- [ ] The reflective surfaces agree after deletion: `"p" in k` and
      `k.hasOwnProperty("p")` are both false, and `Object.keys(k)` omits it.
- [ ] The CURRENT-behaviour pin in `issue-4241-instance-carrier-bag-slot.test.ts`
      is flipped to expect success in the same PR.
- [ ] #4129's scope sentence corrected.
