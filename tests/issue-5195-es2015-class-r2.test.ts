// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #5195 — ES2015 class residual pass, round 2. One block per landed step of the
// plan in `plan/issues/5195-es2015-standalone-class-r2.md`: the exact Test262
// rows it flipped, plus source-level controls in BOTH lanes that keep the
// mechanism pinned where the rows cannot reach it. Every standalone
// control asserts an EMPTY import list — the standalone target must stay
// host-import-free (#5272: the path-runner probe does not apply CI's host-import
// leak check, so this file is where that invariant is actually enforced).

import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { compile } from "../src/index.js";
import { restoreHostBuiltins } from "./test262-restore-builtins.js";
import { runTest262File } from "./test262-runner.js";

/** Step 3 (cluster D1) — the `typeof caught` fold and the read off that binding. */
const STEP_3_ROWS = [
  "language/expressions/super/prop-dot-obj-null-proto.js",
  "language/expressions/super/prop-expr-obj-null-proto.js",
  "language/expressions/super/prop-expr-obj-unresolvable.js",
  "language/expressions/super/prop-expr-cls-unresolvable.js",
] as const;

/** Step 9 K — a computed key that folds to "constructor" is not the constructor. */
const STEP_9K_ROWS = [
  "language/computed-property-names/class/method/constructor-can-be-generator.js",
  "language/computed-property-names/class/method/constructor-can-be-getter.js",
  "language/computed-property-names/class/method/constructor-can-be-setter.js",
] as const;

async function runStandalone(source: string, exportName: string, fileName: string): Promise<unknown> {
  const result = await compile(source, {
    target: "standalone",
    allowJs: true,
    fileName,
    skipSemanticDiagnostics: true,
  });
  expect(result.success, result.errors.map((error) => `L${error.line}: ${error.message}`).join("\n")).toBe(true);
  expect(result.imports, "#5195 standalone controls must stay host-free").toEqual([]);
  const { instance } = await WebAssembly.instantiate(result.binary, {});
  return (instance.exports as Record<string, () => unknown>)[exportName]!();
}

function runHost(source: string, exportName: string): unknown {
  const hostSource = source.replace(/\bexport\s+/g, "");
  return (new Function(`${hostSource}\nreturn ${exportName};`)() as () => unknown)();
}

/**
 * Row pins. `lanes` says which targets the row is expected to pass on: the
 * `super` rows in Step 3 exercise the #4688 object-literal runtime super read,
 * which exists only in the standalone lowering — the JS-host lane still
 * resolves `super.x` statically and never throws, so `caught` is never written
 * and `typeof caught` is legitimately "undefined" there. Pinning host on those
 * rows would pin a gap that is not this issue's.
 *
 * The generous per-test timeout is load, not slack: each row compiles the whole
 * harness once per lane, and this box runs several agents at a time.
 */
function pinRows(step: string, rows: readonly string[], lanes: "standalone" | "both"): void {
  for (const relativePath of rows) {
    const file = resolve(process.cwd(), "test262", "test", relativePath);
    const label = lanes === "both" ? "host and standalone" : "standalone";
    it.skipIf(!existsSync(file))(
      `${step}: ${relativePath} passes in ${label}`,
      async () => {
        try {
          if (lanes === "both") {
            const host = await runTest262File(file, "issue-5195", 60_000);
            expect({ status: host.status, error: host.error }).toEqual({ status: "pass", error: undefined });
          }
          const standalone = await runTest262File(file, "issue-5195", 60_000, "standalone");
          expect({ status: standalone.status, error: standalone.error }).toEqual({ status: "pass", error: undefined });
        } finally {
          restoreHostBuiltins();
        }
      },
      300_000,
    );
  }
}

describe("#5195 Step 3 — closure-written module binding: typeof and member read", () => {
  pinRows("step 3", STEP_3_ROWS, "standalone");

  // The `caught` idiom: the ONLY write to the module `var` happens inside a
  // nested function, which TypeScript's flow analysis does not apply to the
  // outer binding — so its checker type stays `undefined`. Folding `typeof` (or
  // reading a member) off that type answers "undefined"/null while the runtime
  // slot holds a real object.
  const CAUGHT_SOURCE = `
    var caught;
    function thrower() {
      try {
        throw new TypeError("boom");
      } catch (err) {
        caught = err;
      }
    }
    thrower();
    export function probe() {
      return (typeof caught === "object") && (caught.constructor === TypeError) && caught.message === "boom";
    }
  `;

  it("standalone: typeof and .constructor see the closure-written value", async () => {
    expect(await runStandalone(CAUGHT_SOURCE, "probe", "issue-5195-caught.js")).toBe(1);
  });

  it("host lane agrees", () => {
    expect(runHost(CAUGHT_SOURCE, "probe")).toBe(true);
  });

  // Order-preservation control: a module binding the checker CAN resolve keeps
  // its static answer — the guard must not turn every `typeof` into a runtime
  // call, and the member read must not leave its resolvable lane.
  const RESOLVED_SOURCE = `
    var n = 41;
    var s = "hi";
    function bump() { n = n + 1; }
    bump();
    export function probe() {
      return (typeof n === "number") && (typeof s === "string") && s.length === 2 && n === 42;
    }
  `;

  it("standalone: resolvable bindings keep their static typeof", async () => {
    expect(await runStandalone(RESOLVED_SOURCE, "probe", "issue-5195-resolved.js")).toBe(1);
  });

  it("host lane agrees on resolvable bindings", () => {
    expect(runHost(RESOLVED_SOURCE, "probe")).toBe(true);
  });
});

describe("#5195 Step 9K — computed class keys are not the constructor", () => {
  pinRows("step 9K", STEP_9K_ROWS, "both");

  // §13.2.5.5: PropName of a ComputedPropertyName is EMPTY, so a computed key
  // that merely FOLDS to "constructor" carries none of the §15.7.1 restrictions
  // on a method literally named `constructor`.
  const COMPUTED_CTOR_SOURCE = `
    class C {
      get ['constructor']() { return 7; }
    }
    class D {
      set ['constructor'](v) { this.seen = v; }
    }
    export function probe() {
      const d = new D();
      d.constructor = 5;
      return new C().constructor === 7 && d.seen === 5;
    }
  `;

  it("standalone: computed 'constructor' accessors compile and dispatch", async () => {
    expect(await runStandalone(COMPUTED_CTOR_SOURCE, "probe", "issue-5195-computed-ctor.js")).toBe(1);
  });

  it("host lane agrees on computed 'constructor' accessors", () => {
    expect(runHost(COMPUTED_CTOR_SOURCE, "probe")).toBe(true);
  });

  // The real restriction must survive: a method literally named `constructor`
  // still may not be a getter/setter/generator/async.
  it("a literal `get constructor()` is still an early error", async () => {
    const result = await compile("class C { get constructor() { return 1; } }", {
      target: "standalone",
      allowJs: true,
      fileName: "issue-5195-literal-ctor-getter.js",
      skipSemanticDiagnostics: true,
    });
    const messages = result.errors.map((error) => error.message).join("\n");
    expect(messages).toContain("Class constructor may not be a getter");
  });
});

describe("#5195 Step 1 — runtime-computed class element keys", () => {
  // §15.7.14 / §13.2.5.5: the ComputedPropertyName of EVERY class element is
  // evaluated once, in source order, at ClassDefinitionEvaluation. Before this
  // step a METHOD's key expression was dropped on the floor entirely (only
  // accessors got a side-effect-only evaluation, and only for a class nested in
  // a function), so its assignments and calls never happened.
  const KEY_EFFECTS_SOURCE = `
    var log = "";
    function k(v) { log = log + v; return v; }
    class C {
      [k('m')]() { return 1; }
      get [k('g')]() { return 2; }
      set [k('s')](v) { this.got = v; }
      static [k('t')]() { return 3; }
    }
    export function probe() { return log === "mgst" ? 1 : 0; }
  `;

  it("standalone: every computed member key is evaluated once, in source order", async () => {
    expect(await runStandalone(KEY_EFFECTS_SOURCE, "probe", "issue-5195-key-effects.js")).toBe(1);
  });

  it("host lane agrees on key evaluation order", () => {
    expect(runHost(KEY_EFFECTS_SOURCE, "probe")).toBe(1);
  });

  // The key's VALUE reaches the prototype, as a real own property of the
  // prototype `$Object` — readable, and ordered after `constructor` (which
  // §15.7.14 creates before any element).
  const RUNTIME_KEY_SOURCE = `
    function ID(x) { return x; }
    class C {
      a() { return 'A'; }
      [ID('d')]() { return 'D'; }
      get [ID('g')]() { return 'G'; }
    }
    export function probe() {
      const names = Object.getOwnPropertyNames(C.prototype).join(",");
      return (typeof C.prototype.d === "function") && C.prototype.g === 'G'
        && names === "constructor,a,d,g" ? 1 : 0;
    }
  `;

  it("standalone: a runtime key installs on the prototype in spec order", async () => {
    expect(await runStandalone(RUNTIME_KEY_SOURCE, "probe", "issue-5195-runtime-key.js")).toBe(1);
  });

  it("host lane agrees on the runtime-key prototype surface", () => {
    expect(runHost(RUNTIME_KEY_SOURCE, "probe")).toBe(1);
  });

  // Order-preservation control: a class whose keys all FOLD keeps every static
  // lane — dot dispatch, `C.prototype.m` identity, own-key order — untouched.
  const FOLDED_KEYS_SOURCE = `
    class C {
      m() { return 1; }
      ['n']() { return 2; }
      get p() { return 3; }
    }
    export function probe() {
      const c = new C();
      const names = Object.getOwnPropertyNames(C.prototype).join(",");
      return c.m() === 1 && c.n() === 2 && c.p === 3
        && c.m === C.prototype.m && names === "constructor,m,n,p" ? 1 : 0;
    }
  `;

  // Step 1.7: the member has no source-spellable name, so the only route to it
  // is the dynamic one — an instance read/call with the key as data. Both the
  // static-key form (`c[2]`, which const-folds) and the runtime-key form
  // (`c[k]`) must reach the prototype `$Object`.
  const INSTANCE_DYNAMIC_SOURCE = `
    function ID(x) { return x; }
    class C {
      a() { return 'A'; }
      [ID('d')]() { return 'D'; }
      [ID(2)]() { return 'N'; }
    }
    export function probe() {
      const c = new C();
      const k = 'd';
      return c[k]() === 'D' && c['d']() === 'D' && c[2]() === 'N'
        && typeof c.a === 'function' && c.a() === 'A' ? 1 : 0;
    }
  `;

  it("standalone: a runtime-keyed member is reachable through a dynamic instance call", async () => {
    expect(await runStandalone(INSTANCE_DYNAMIC_SOURCE, "probe", "issue-5195-instance-dynamic.js")).toBe(1);
  });

  it("host lane agrees on the dynamic instance call", () => {
    expect(runHost(INSTANCE_DYNAMIC_SOURCE, "probe")).toBe(1);
  });

  it("standalone: folding keys keep their static lanes", async () => {
    expect(await runStandalone(FOLDED_KEYS_SOURCE, "probe", "issue-5195-folded-keys.js")).toBe(1);
  });

  it("host lane agrees on folding keys", () => {
    expect(runHost(FOLDED_KEYS_SOURCE, "probe")).toBe(1);
  });
});

describe("#5195 Step 1.3/1.4 — prototype `constructor` for every class", () => {
  // §15.7.14 creates `C.prototype.constructor` BEFORE the elements, so it is
  // the first own key — and it exists even when the class declares no element
  // at all.
  const CTOR_PROP_SOURCE = `
    class Empty {}
    class WithCtor { constructor() { this.x = 1; } }
    export function probe() {
      const d1 = Object.getOwnPropertyDescriptor(Empty.prototype, 'constructor');
      const d2 = Object.getOwnPropertyDescriptor(WithCtor.prototype, 'constructor');
      return d1.value === Empty && d1.writable === true && d1.enumerable === false
        && d1.configurable === true && d2.value === WithCtor ? 1 : 0;
    }
  `;

  it("standalone: a member-less class still has an own prototype `constructor`", async () => {
    expect(await runStandalone(CTOR_PROP_SOURCE, "probe", "issue-5195-ctor-prop.js")).toBe(1);
  });

  it("host lane agrees on the prototype `constructor` descriptor", () => {
    expect(runHost(CTOR_PROP_SOURCE, "probe")).toBe(1);
  });
});

describe("#5195 Step 1.6 — duplicate accessors are last-definition-wins", () => {
  // §15.7.14 installs the class elements in source order, so a second accessor
  // with the same key REPLACES the first. The funcMap guard kept the first
  // body, which is the opposite answer — and the guard cannot simply go, because
  // a static and an instance accessor of the same name share that one key.
  const DUPLICATE_ACCESSOR_SOURCE = `
    class C {
      get b() { return 'first'; }
      get ['b']() { return 'second'; }
      set c(v) { this.viaFirst = v; }
      set ['c'](v) { this.viaSecond = v; }
    }
    class D {
      get v() { return 'instance'; }
      static get v() { return 'static'; }
    }
    export function probe() {
      const c = new C();
      c.c = 1;
      return c.b === 'second' && c.viaFirst === undefined && c.viaSecond === 1
        && new D().v === 'instance' ? 1 : 0;
    }
  `;

  it("standalone: the last accessor of a kind wins, and static does not steal instance", async () => {
    expect(await runStandalone(DUPLICATE_ACCESSOR_SOURCE, "probe", "issue-5195-dup-accessor.js")).toBe(1);
  });

  it("host lane agrees on duplicate accessors", () => {
    expect(runHost(DUPLICATE_ACCESSOR_SOURCE, "probe")).toBe(1);
  });
});

describe("#5195 Step 9 H/I — accessor writes and the inner class binding", () => {
  // A top-level `C.staticX = v` / `new C().x = v` calls a SETTER, which is
  // observable work — but neither writes a named module global, so the whole
  // statement was dropped from `__module_init` and the setter never ran. The
  // same write inside a function body always worked.
  const ACCESSOR_WRITE_SOURCE = `
    var instanceSeen = 0, staticSeen = 0;
    class C {
      set x(v) { instanceSeen = v; }
      static set y(v) { staticSeen = v; }
    }
    new C().x = 5;
    C.y = 7;
    export function probe() { return instanceSeen === 5 && staticSeen === 7 ? 1 : 0; }
  `;

  it("standalone: top-level accessor writes run their setter", async () => {
    expect(await runStandalone(ACCESSOR_WRITE_SOURCE, "probe", "issue-5195-accessor-write.js")).toBe(1);
  });

  it("host lane agrees on top-level accessor writes", () => {
    expect(runHost(ACCESSOR_WRITE_SOURCE, "probe")).toBe(1);
  });

  // §15.7.14 step 3: the class body sees its own name through an IMMUTABLE
  // inner binding. The OUTER binding stays mutable, which is the control.
  const INNER_BINDING_SOURCE = `
    var thrown = 0;
    function attempt(f) { try { f(); } catch (e) { if (e instanceof TypeError) thrown++; } }
    attempt(function () { class A { constructor() { A = 42; } } new A(); });
    attempt(function () { class B { m() { B = 42; } } new B().m(); });
    attempt(function () { class C2 { get x() { C2 = 42; } } new C2().x; });
    attempt(function () { class D2 { set x(_) { D2 = 42; } } new D2().x = 1; });
    attempt(function () { class E2 { static s() { E2 = 42; } } E2.s(); });
    // Control: the OUTER binding is not const, so a write to it must not
    // throw. (Whether the write is then observable is a separate, pre-existing
    // standalone gap — a top-level class name reads back as the class object —
    // so this asserts only the half this change governs.)
    var outerOk = 0;
    class Outer {}
    try { Outer = 42; outerOk = 1; } catch (e) { outerOk = -1; }
    export function probe() { return thrown === 5 && outerOk === 1 ? 1 : 0; }
  `;

  it("standalone: writing the inner class binding is a TypeError, the outer one is not", async () => {
    expect(await runStandalone(INNER_BINDING_SOURCE, "probe", "issue-5195-inner-binding.js")).toBe(1);
  });

  it("host lane agrees on the inner class binding", () => {
    expect(runHost(INNER_BINDING_SOURCE, "probe")).toBe(1);
  });
});

describe("#5195 Step 11 E — derived-constructor return", () => {
  // §10.2.1.3 step 13: a derived ctor's bare `return;` / `return undefined`
  // yields `this`; `return null` is a TypeError (null has typeof "object" but
  // is not an Object). The struct-result derived lane had NO return arm at all,
  // so the statement fell to the generic value return, pushed `ref.null
  // <struct>`, and `new Derived()` trapped on a null dereference.
  const DERIVED_RETURN_SOURCE = `
    var baseCalls = 0;
    class Base { constructor() { this.prop = 1; baseCalls++; } }
    class Empty extends Base { constructor() { super(); return; } }
    class Undef extends Base { constructor() { super(); return undefined; } }
    class Nulled extends Base { constructor() { super(); return null; } }
    export function probe() {
      const a = new Empty();
      const b = new Undef();
      let threw = false;
      try { new Nulled(); } catch (e) { threw = e instanceof TypeError; }
      return a.prop === 1 && b.prop === 1 && threw && baseCalls === 3 ? 1 : 0;
    }
  `;

  it("standalone: bare and undefined returns yield `this`, null is a TypeError", async () => {
    expect(await runStandalone(DERIVED_RETURN_SOURCE, "probe", "issue-5195-derived-return.js")).toBe(1);
  });

  it("host lane agrees on derived-constructor returns", () => {
    expect(runHost(DERIVED_RETURN_SOURCE, "probe")).toBe(1);
  });

  // Order-preservation control: a BASE constructor's `return null` is still a
  // silent discard, not a TypeError.
  const BASE_RETURN_SOURCE = `
    class B { constructor() { this.prop = 2; return null; } }
    export function probe() { return new B().prop === 2 ? 1 : 0; }
  `;

  it("standalone: a base constructor's `return null` still discards", async () => {
    expect(await runStandalone(BASE_RETURN_SOURCE, "probe", "issue-5195-base-return.js")).toBe(1);
  });

  it("host lane agrees on the base-constructor control", () => {
    expect(runHost(BASE_RETURN_SOURCE, "probe")).toBe(1);
  });
});
