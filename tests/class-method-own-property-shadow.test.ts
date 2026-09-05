// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// An own property installed over a prototype method of the same name must win
// the method call.
//
// `call-receiver-method.ts` already declines the closed method dispatcher for
// this collision — "a closed method dispatcher cannot represent that
// per-instance choice: its method arm would win before the field closure is
// read" — but its `hasUserClassField` test looks only for a DECLARED struct
// field of externref type. A shadow installed at runtime declares nothing, so
// the gate never fired for it:
//
//     class H { pre(x) { return x; } }
//     const h = new H();
//     h.pre = (x) => "W" + x;
//     h.pre("a");               // → "a"   the prototype method wins   ✗
//     const f = h.pre; f("a");  // → "Wa"  the own property IS there
//
// The assignment stores correctly; only method-call DISPATCH ignores it, which
// is why reading the member into a local first works — that is the tell.
//
// marked's `use()` is this shape through a computed key:
//     for (const o in n.hooks) { r[o] = c => u.call(r, c); }
// so its registered hooks were installed and never called, and an identity
// hook is indistinguishable from no hook — only an OBSERVING hook exposes it.
//
// The fixtures are plain untyped `.js`, matching how the upstream npm suites
// feed package code in. A typed member access resolves to a direct call and
// never reaches this dispatch decision at all.

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { compileProject } from "../src/index.js";
import { instantiateWithRuntime } from "./equivalence/helpers.js";

const roots: string[] = [];
afterAll(() => {
  while (roots.length > 0) rmSync(roots.pop()!, { recursive: true, force: true });
});

const ENTRY = `import { run } from "./mod.js";\nexport function test(): string { return (run as unknown as () => string)(); }`;

async function runModule(moduleSource: string): Promise<unknown> {
  const root = mkdtempSync(join(tmpdir(), "js2-method-shadow-"));
  roots.push(root);
  mkdirSync(root, { recursive: true });
  writeFileSync(join(root, "mod.js"), moduleSource);
  writeFileSync(join(root, "entry.ts"), ENTRY);
  const result = await compileProject(join(root, "entry.ts"), {
    allowJs: true,
    skipSemanticDiagnostics: true,
    target: "gc",
    platform: "node",
  });
  expect(result.success, result.errors.map((error) => error.message).join("\n")).toBe(true);
  const instance = await instantiateWithRuntime(result);
  return (instance.exports as Record<string, () => unknown>).test();
}

describe("own property shadowing a prototype method", () => {
  it("calls the own property, not the prototype method", async () => {
    expect(
      await runModule(`class H { pre(x) { return x; } }
export function run() {
  const h = new H();
  h.pre = (x) => "W" + x;
  return h.pre("a");
}`),
    ).toBe("Wa");
  });

  it("calls the own property installed through a computed key", async () => {
    expect(
      await runModule(`class H { pre(x) { return x; } }
export function run() {
  const h = new H();
  const src = { pre(x) { return "C" + x; } };
  for (const k in src) { h[k] = src[k]; }
  return h.pre("a");
}`),
    ).toBe("Ca");
  });

  it("lets the shadow observe the argument (marked's hook shape)", async () => {
    // An identity shadow is indistinguishable from no shadow; only a hook that
    // records what it saw proves it was actually invoked.
    expect(
      await runModule(`class H { pre(x) { return x; } }
export function run() {
  const h = new H();
  let seen = "NONE";
  h.pre = (x) => { seen = x; return x; };
  h.pre("md");
  return seen;
}`),
    ).toBe("md");
  });

  it("keeps the prototype method when nothing shadows it", async () => {
    expect(
      await runModule(`class H { pre(x) { return "P" + x; } }
export function run() {
  const h = new H();
  return h.pre("a");
}`),
    ).toBe("Pa");
  });

  it("keeps a shadow on one instance off another instance", async () => {
    expect(
      await runModule(`class H { pre(x) { return "P" + x; } }
export function run() {
  const a = new H();
  const b = new H();
  a.pre = (x) => "W" + x;
  return a.pre("1") + "|" + b.pre("2");
}`),
    ).toBe("W1|P2");
  });

  it("invokes a hook installed through marked's `use()` shape", async () => {
    // The reduction of marked 18's `Marked#use()`: the hook is installed on a
    // `_Hooks` INSTANCE through a computed key drawn from a `for…in`, and the
    // call site's receiver is a property access (`i.hooks`), not the binding
    // that was written. TypeScript types the write's receiver `any`, so no
    // receiver-precise scan can see the collision — only the runtime can.
    expect(
      await runModule(`class Hooks {
  preprocess(e) { return e; }
  postprocess(e) { return e; }
}
class Marked {
  defaults = { hooks: null };
  use(n) {
    const s = { ...n };
    if (n.hooks) {
      const r = this.defaults.hooks || new Hooks();
      for (const i in n.hooks) {
        const o = i;
        const u = n.hooks[o];
        const a = r[o];
        r[o] = (c) => { const p = u.call(r, c); return a.call(r, p); };
      }
      s.hooks = r;
    }
    this.defaults = { ...this.defaults, ...s };
    return this;
  }
  parse(md) {
    const i = { ...this.defaults };
    let out = md;
    if (i.hooks) out = i.hooks.preprocess(out);
    return out;
  }
}
export function run() {
  let seen = "NONE";
  const m = new Marked();
  m.use({ hooks: { preprocess(md) { seen = md; return md; } } });
  m.parse("*text*");
  return seen;
}`),
    ).toBe("*text*");
  });

  it("reads the shadow through a local, which already worked", async () => {
    expect(
      await runModule(`class H { pre(x) { return x; } }
export function run() {
  const h = new H();
  h.pre = (x) => "W" + x;
  const f = h.pre;
  return f("a");
}`),
    ).toBe("Wa");
  });
});
