---
name: project_proxy_no_ts_type_brand
description: A JS Proxy carries NO TS-type brand — never static-classify a possibly-proxy receiver; defer to host
metadata: 
  node_type: memory
  type: project
  originSessionId: 75ffdde9-6b72-447e-992f-f6b025616c19
---

A JavaScript `Proxy` carries **no TypeScript-type brand**: `new Proxy(t, h)`
types **identically to its target `t`**, and `Proxy.revocable([], {}).proxy`
types as `never[]` (i.e. an array). So any codegen path that statically
classifies a receiver from its TS type (e.g. the #2501
`Object.prototype.toString.call` tag classifier, `resolveObjectToStringTag` in
`src/codegen/expressions/calls.ts`) will silently mis-handle a proxy — it sees
the *target's* type, not "proxy".

**Why it bites:** `Object.prototype.toString`'s §20.1.3.6 step 4 runs `IsArray`,
which unwraps the proxy to its target and **throws TypeError on a revoked proxy**
(§7.2.2 step 3a). A static constant tag (`[object Array]`) can never throw → the
test262 `proxy-revoked.js` assertion `assert.throws(TypeError, …)` fails. This
was the single-file regression that blocked PR #1742 / #1711's regression gate.

**How to apply:** when adding/modifying any type-driven static classification of
a *receiver*, gate it on a **syntactic** proxy detector (the TS type can't tell
you), then defer to the host. The established helper is `receiverMayBeProxy()` in
`calls.ts`: matches `new Proxy(...)`, `Proxy.revocable(...).proxy`, and
identifiers bound transitively to either. Standalone mode has no proxy runtime,
so it refuses-loud there. Related: [[feedback_spec_first_fixes]],
[[feedback_compile_away]].
