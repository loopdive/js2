// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #6692 — a closure installed on a class instance through a COMPUTED key
// (`this[m] = (a) => …`, hono's HTTP-verb installer) must run when called as
// `o.m(…)` / `o["m"](…)` under `--target standalone`.
//
// Before the fix (measured by file-copy revert on the parent tree): the dot
// forms answered `null` (the call-dispatch tail's graceful fallback dropped the
// callee) and `o["go"](5)` threw ("not a function" — `__extern_method_call`'s
// non-`$Object` branch never consulted the instance expando bag). Extracting
// first (`var f = o.go; f(5)`), a dot write, and a plain object already worked
// on the parent and are kept as controls.
//
// Host-free: `hostBridge: "off"` and an empty import object; every probe
// answers a number so the comparison happens inside the module.
import { describe, expect, it } from "vitest";
import { compileMulti } from "../src/index.js";

const SOURCE = `
  class K { constructor() { var m = "go"; this[m] = (a) => a + 1; } }
  class K0 { constructor() { var m = "go"; this[m] = () => 6; } }
  class P { constructor() { ["go"].forEach((m) => { this[m] = (a) => a + 1; }); } }
  class K2 { constructor() { this.go = (a) => a + 1; } }
  class R { constructor() { var m = "go"; this[m] = (a, ...rest) => a + rest.length; } }
  class H {
    routes = [];
    constructor() {
      ["get", "post"].forEach((method) => {
        this[method] = (path, ...handlers) => { this.routes.push(method + " " + path + handlers.length); return this; };
      });
    }
  }
  class Sub extends H {}
  class Miss { constructor() { var m = "go"; this[m] = 1; } }
  let constructed = 0;
  class Once { constructor() { constructed++; var m = "go"; this[m] = () => 6; } }

  export function dotCall() { return new K().go(5); }
  export function dotCallNoArgs() { return new K0().go(); }
  export function forEachInstall() { return new P().go(5); }
  export function bracketCall() { try { var o = new P(); return o["go"](5); } catch (e) { return -1; } }
  export function bracketCallDynamic() { try { var o = new P(); var k = "go"; return o[k](5); } catch (e) { return -1; } }
  export function restArgs() { return new R().go(5, 1, 2, 3); }
  export function thisIsReceiver() {
    var app = new H();
    var r = app.get("/users/:id", () => "ok");
    var r2 = app.post("/x");
    return (r === app ? 100 : 0) + (r2 === app ? 10 : 0) + app.routes.length;
  }
  export function subclassReceiver() { var s = new Sub(); return (s.get("/a") === s ? 10 : 0) + s.routes.length; }
  export function receiverEvaluatedOnce() { constructed = 0; new Once().go(); return constructed; }
  // Node throws a TypeError here; standalone answered undefined before AND after
  // (the arm deliberately keeps the fallback's value on a miss). Asserted so a
  // later change to the miss is a visible, deliberate decision.
  export function absentMemberPreexistingGap() { try { var r = new Miss().nope(1); return r == undefined ? 1 : 0; } catch (e) { return -1; } }
  // Controls — answered correctly on the parent too.
  export function extractThenCall() { var o = new P(); var f = o.go; return f(5); }
  export function dotWrite() { return new K2().go(5); }
  export function plainObject() { var o = {}; var m = "go"; o[m] = (a) => a + 1; return o.go(5); }
`;

async function compileStandalone(): Promise<Record<string, () => number>> {
  const entry = "/__main.js";
  const result = await compileMulti({ [entry]: SOURCE }, entry, {
    allowJs: true,
    skipSemanticDiagnostics: true,
    target: "standalone",
    hostBridge: "off",
  } as never);
  expect(result.success, result.errors.map((item) => item.message).join("\n")).toBe(true);
  expect(WebAssembly.Module.imports(new WebAssembly.Module(result.binary))).toEqual([]);
  const imports = result.importObject ?? {};
  const { instance } = await WebAssembly.instantiate(result.binary, imports);
  (instance.exports as { __module_init?: () => void }).__module_init?.();
  return instance.exports as unknown as Record<string, () => number>;
}

describe("#6692 standalone: computed this[key] closure called as a method", () => {
  it("runs the installed closure with this = receiver and rest args preserved", async () => {
    const x = await compileStandalone();
    expect(x.dotCall()).toBe(6);
    expect(x.dotCallNoArgs()).toBe(6);
    expect(x.forEachInstall()).toBe(6);
    expect(x.bracketCall()).toBe(6);
    expect(x.bracketCallDynamic()).toBe(6);
    expect(x.restArgs()).toBe(8);
    expect(x.thisIsReceiver()).toBe(112);
    expect(x.subclassReceiver()).toBe(11);
    expect(x.receiverEvaluatedOnce()).toBe(1);
    expect(x.absentMemberPreexistingGap()).toBe(1);
  });

  it("keeps the already-working controls", async () => {
    const x = await compileStandalone();
    expect(x.extractThenCall()).toBe(6);
    expect(x.dotWrite()).toBe(6);
    expect(x.plainObject()).toBe(6);
  });
});
