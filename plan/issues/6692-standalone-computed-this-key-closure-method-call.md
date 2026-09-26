---
id: 6692
title: "standalone: closure installed via computed this[key] in a class constructor does not run when called as instance.key(...) (hono app.get)"
status: ready
sprint: current
created: 2026-09-26
updated: 2026-09-26
priority: high
horizon: m
feasibility: medium
reasoning_effort: high
task_type: bug
area: compiler
language_feature: classes
goal: standalone
requested_by: ttraenkler/sendev-standalone
related: [6691, 1244, 3981]
---

# #6692 — `this[key] = closure` in a constructor, then `instance.key(args)` does not call it (standalone)

## What you will see

hono's standalone-dynamic npm-compat lane, after
[#6691](https://js2wasm.loopdive.com/dashboard/issue.html?slug=6691-standalone-fetch-url-globals-host-imports)
removed its last host imports (measured 2026-09-26):

```
npx tsx scripts/generate-npm-compat-report.mjs --only hono --no-write --perf-only --lane standalone-dynamic
standaloneDynamic: result-mismatch — "checksum mismatch: Wasm 8, Node 9"
```

Sample op: `const app = new Hono(); app.get("/users/:id", () => "ok"); return app.routes.length + input.length;`
with input `"/users/1"`. Node: `1 + 8 = 9`; Wasm: `0 + 8 = 8`. Probing the real
package standalone: `typeof app.get === "function"`, `app.routes` is an array,
`app.get(...)` does not throw, but it returns something `!== app` and
`app.routes.length` stays 0 — the installed closure never ran.

hono-base.js installs every HTTP verb in the constructor:

```js
class HonoBase {
  get; post; /* … */ routes = [];
  constructor(options = {}) {
    const allMethods = [...METHODS, METHOD_NAME_ALL_LOWERCASE];
    allMethods.forEach((method) => {
      this[method] = (args1, ...args) => { /* … */ this.#addRoute(method, this.#path, h); return this; };
    });
  }
}
```

## Minimal repros (`compileProject`, `allowJs`, `target: "standalone"`, 0 imports)

| repro | Node | standalone |
| --- | --- | --- |
| `class K { constructor() { var m = "go"; this[m] = (a) => a + 1; } }` → `new K().go(5)` | 6 | `null` |
| same, `this[m] = () => 6` → `new K0().go()` | 6 | `null` |
| `["go"].forEach((m) => { this[m] = (a) => a + 1; })` → `new P().go(5)` | 6 | `null` |
| same → `o["go"](5)` | 6 | throws a `WebAssembly.Exception` |
| same → `var f = o.go; f(5)` | 6 | **6** (extracting then calling works) |
| `this.go = (a) => a + 1` (dot write) → `new K2().go(5)` | 6 | **6** |
| plain object `o[m] = (a) => a + 1; o.go(5)` | 6 | **6** |
| declared field `go;` + forEach `this[m] = (a1) => {…; return this}` → `app.go("/x")` | returns app, pushes | returns not-app, no push |

So the failure is the **method-call dispatch** on a class instance whose
callable own property was written through a COMPUTED key: the value is there
(`var f = o.go; f(5)` works), but `o.go(...)` / `o["go"](...)` do not reach it.
Probe files: `.tmp/hprobe/min*.js` in the #6691 worktree (not committed).

## Pointers

- `src/codegen/standalone-class-dyn-member.ts`, `standalone-class-construct.ts`
  — standalone class instance expando / dynamic member storage.
- The receiver-method call arm (`src/codegen/expressions/call-receiver-method.ts`)
  — how `instance.name(...)` resolves when `name` is not a declared method
  (or is a declared-but-uninitialised field) of the class struct.

## Acceptance

- Every row above matches Node under `--target standalone`.
- hono standalone-dynamic lane reaches `measured` (or names its next blocker).
