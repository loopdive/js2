---
id: 4128
title: "JS-host lane: function-constructor prototype chain appears unsupported — `K.prototype.k = fn` reportedly fails for EVERY receiver shape, class methods fine"
status: ready
sprint: current
created: 2026-08-03
updated: 2026-08-03
priority: medium
horizon: m
feasibility: medium
reasoning_effort: high
task_type: bug
area: codegen
language_feature: prototype chain, JS host lane
goal: core-semantics
related: [4123, 4125]
origin: "reported while fixing #4123; NOT independently reproduced — see the verification note"
---

# #4128 — function-constructor prototype chain in the JS-host lane

## Verification status — read this first

**This issue is second-hand and is not independently reproduced.** It was
reported by the author of #4123's fix, who verified the behaviour is
byte-identical before and after that change (so it is at least pre-existing and
unrelated to it).

My own attempt to reproduce it failed for a mechanical reason, not a
substantive one: a JS-host-lane module needs the host import harness (9–10
imports), and a bare `WebAssembly.instantiate(mod, {})` cannot start it. So I
could not confirm or refute the claim.

**First step for whoever picks this up is to reproduce it through the real host
harness** and either confirm the shape below or close this issue. Do not build
on the description without that.

## Reported behaviour

In the **JS-host lane** (no `target: "standalone"`):

| program                                                    | reported          | JS |
| ---------------------------------------------------------- | ----------------- | -- |
| `function K(){} K.prototype.k = fn; let o = new K(); o.k()` | `TypeError: value is not callable` | 3 |
| `function K2(){} K2.prototype.k = 7; let o = new K2(); o.k` | `undefined`       | 7  |
| `class C { k(){…} }` (control)                              | works             | ✓  |
| object-literal method (control)                             | works             | ✓  |

If accurate, this is **broader than #4123**, which it would subsume: #4123 was
the standalone lane losing the prototype chain only for a *parameter* receiver,
whereas this reports the host lane failing for **every** receiver shape,
including a locally-bound one. It affects both method and data properties on
`F.prototype`.

## Why it matters if confirmed

`function F(){}; F.prototype.m = …` is the pre-class constructor idiom and is
pervasive in the older npm corpus. Class methods and object-literal methods
working while the `prototype` assignment form does not would be a large,
systematic gap in the host lane rather than an edge case.

It is also why #4123's regression test compiles standalone instead of using
`assertEquivalent` — the host lane would have failed it for this unrelated
reason.

## Acceptance criteria

- [ ] **Reproduce through the real host import harness** and record the actual
      failure, or close this issue as not-a-bug with that evidence.
- [ ] If confirmed: both the method form (`K.prototype.k = fn`) and the data
      form (`K.prototype.k = 7`) return the JS answer for a locally-bound
      receiver and for a parameter receiver.
- [ ] Equivalence coverage in the host lane, so #4123's test can drop its
      standalone-only workaround and use `assertEquivalent`.
- [ ] Determine whether this and #4123 share a root cause or are two
      independent prototype-chain gaps in the two lanes.
