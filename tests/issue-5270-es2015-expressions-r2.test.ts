// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * (#5270) ES2015 standalone expressions, r2 residual pass.
 *
 * One `describe` per implementation step. Every standalone pin asserts the
 * module emits ZERO host imports (`result.imports` empty — the same gate the
 * test262 runner applies, #2961) and reads its output back through the module's
 * own `__stdout_prepare` / `__stdout_char` exports (#3469), the only host-free
 * channel a standalone module has.
 *
 * Each pin was verified to FAIL on the pre-change tree (file-copy A/B).
 */
import { describe, expect, it } from "vitest";
import { compile } from "../src/index.js";

/**
 * Compile `body` as a standalone module and return the lines it printed.
 * `LOG(s)` is `console.log`; a module-level throw appends a `THREW` line so a
 * pin can assert on a refusal without decoding a Wasm-GC payload on the host.
 */
async function runStandaloneLines(body: string): Promise<string[]> {
  const source = `function LOG(s) { console.log(s); }\n${body}\n`;
  const result = await compile(source, {
    allowJs: true,
    fileName: "issue-5270-es2015-expressions-r2.js",
    skipSemanticDiagnostics: true,
    target: "standalone",
    nativeStrings: true,
    hostBridge: "always",
    deferTopLevelInit: true,
  });
  expect(result.success, result.errors.map((e) => `L${e.line}: ${e.message}`).join("\n")).toBe(true);
  expect(result.imports.map((i) => `${i.module}::${i.name}`)).toEqual([]);
  const { instance } = await WebAssembly.instantiate(result.binary, {});
  const exports = instance.exports as Record<string, (...args: number[]) => number>;
  let threw = false;
  try {
    exports.__module_init!();
  } catch {
    threw = true;
  }
  const length = exports.__stdout_prepare!() | 0;
  let sink = "";
  for (let i = 0; i < length; i++) sink += String.fromCharCode(exports.__stdout_char!(i) & 0xffff);
  const lines = sink.split("\n").filter((l) => l.length > 0);
  if (threw) lines.push("THREW");
  return lines;
}

/** Compile `body` for the JS-host lane and return the lines it printed. */
async function runHostLines(body: string): Promise<string[]> {
  const lines: string[] = [];
  const source = `function LOG(s) { console.log(s); }\n${body}\n`;
  const result = await compile(source, {
    allowJs: true,
    fileName: "issue-5270-es2015-expressions-r2-host.js",
    skipSemanticDiagnostics: true,
  });
  expect(result.success, result.errors.map((e) => `L${e.line}: ${e.message}`).join("\n")).toBe(true);
  const imports = (result.importObject ?? {}) as WebAssembly.Imports & {
    __setInstance?: (i: WebAssembly.Instance) => void;
  };
  const env = (imports as Record<string, Record<string, unknown>>).env;
  if (env && typeof env.console_log === "function") {
    const inner = env.console_log as (...a: unknown[]) => unknown;
    env.console_log = (...a: unknown[]) => {
      lines.push(String(a[0]));
      return inner(...a);
    };
  }
  const original = console.log;
  console.log = (...a: unknown[]) => void lines.push(String(a[0]));
  try {
    const { instance } = await WebAssembly.instantiate(result.binary, imports);
    imports.__setInstance?.(instance);
    const init = (instance.exports as Record<string, () => void>).__module_init;
    init?.();
  } finally {
    console.log = original;
  }
  return lines;
}

describe("#5270 step 1 — tail calls in return position", () => {
  // Cluster A: `canTailCall` refused every externref RESULT under standalone,
  // so no value-returning standalone JS function was ever tail-call optimised.
  // A `return undefined` also lowers to an externref result, which is why even
  // the void-looking probes overflowed.
  it("promotes a 100000-deep comma tail call in a named function expression", async () => {
    const lines = await runStandaloneLines(`
      var callCount = 0;
      (function f(n) { if (n === 0) { callCount += 1; return; } return 0, f(n - 1); }(100000));
      LOG("callCount=" + callCount);
    `);
    expect(lines).toEqual(["callCount=1"]);
  });

  it("promotes a 100000-deep tail call through a module-level function value", async () => {
    const lines = await runStandaloneLines(`
      var callCount = 0;
      var f = function (n) { if (n === 0) { callCount += 1; return; } return f(n - 1); };
      f(100000);
      LOG("callCount=" + callCount);
    `);
    expect(lines).toEqual(["callCount=1"]);
  });

  it("promotes a conditional tail call whose result is an object", async () => {
    const lines = await runStandaloneLines(`
      var callCount = 0;
      function f(n) { if (n === 0) { callCount += 1; return { done: true }; } return n > 0 ? f(n - 1) : null; }
      var r = f(100000);
      LOG("callCount=" + callCount + " done=" + r.done);
    `);
    expect(lines).toEqual(["callCount=1 done=true"]);
  });

  // (step 1.3) The `__fn_tramp_*` forwarder is a PURE forwarder — nothing runs
  // after its inner call — so its frame must not survive. With a plain `call`
  // the `f → __fn_tramp_f → f` cycle of a function reached through its own
  // closure VALUE grew TWO frames per iteration. Shape-pinned rather than
  // behaviour-pinned because the remaining half of that cycle (the bare-call
  // `__current_this` save/restore straddling `f`'s own tail call) still blocks
  // full elimination — see the step-1 note in the issue file.
  it("emits the funcref trampoline forwarder as return_call", async () => {
    const result = await compile(
      `var callCount = 0;
       (function () {
         var bump = 1;
         function f(n) { if (n === 0) { callCount += bump; return; } return f(n - 1); }
         var alias = f;
         alias(10);
       })();`,
      {
        allowJs: true,
        fileName: "issue-5270-tramp.js",
        skipSemanticDiagnostics: true,
        target: "standalone",
        nativeStrings: true,
      },
    );
    expect(result.success).toBe(true);
    const names = [...result.wat.matchAll(/\(func \$(__fn_tramp_\w+_\d+) /g)].map((m) => m[1]!);
    expect(names.length).toBeGreaterThan(0);
    for (const name of names) {
      const start = result.wat.indexOf(`(func $${name} `);
      const end = result.wat.indexOf("\n  (func $", start + 1);
      const body = result.wat.slice(start, end < 0 ? undefined : end);
      expect(body, `${name} forwards with a plain call`).toContain("return_call");
    }
  });

  // ── Controls for the COMMON case of the mechanism this step touches ──

  it("keeps a NON-tail call non-tail (the addition still needs the frame)", async () => {
    const lines = await runStandaloneLines(`
      function sumTo(n) { if (n === 0) return 0; return n + sumTo(n - 1); }
      LOG("sum=" + sumTo(10));
    `);
    expect(lines).toEqual(["sum=55"]);
  });

  it("keeps ordinary (non-recursive) calls and their return values intact", async () => {
    const body = `
      function twice(n) { return n * 2; }
      function apply(fn, n) { return fn(n); }
      var obj = { m: function (n) { return this.base + n; }, base: 10 };
      LOG("a=" + twice(21) + " b=" + apply(twice, 5) + " c=" + obj.m(7));
    `;
    expect(await runStandaloneLines(body)).toEqual(["a=42 b=10 c=17"]);
    // The host lane answers identically — this step changes no host semantics.
    expect(await runHostLines(body)).toEqual(["a=42 b=10 c=17"]);
  });

  it("still runs a try/catch around a tail-position call (#1972 stays refused)", async () => {
    const lines = await runStandaloneLines(`
      function boom() { throw new Error("x"); }
      function guarded() { try { return boom(); } catch (e) { return "caught"; } }
      LOG(guarded());
    `);
    expect(lines).toEqual(["caught"]);
  });
});

describe("#5270 step 2 — [[Prototype]] of ordinary literals and colon __proto__", () => {
  // Cluster I(a): `$Object.$proto === null` means BOTH "explicitly null" and
  // "ordinary object, implicit %Object.prototype% terminal". `__getPrototypeOf`
  // returned the raw field, so a NON-empty literal answered null while an empty
  // one answered Object.prototype (the latter folded statically).
  it("answers %Object.prototype% for an ordinary literal, through a runtime read", async () => {
    const lines = await runStandaloneLines(`
      var o; o = { a: 1 };
      var empty; empty = {};
      LOG("a=" + (Object.getPrototypeOf(o) === Object.prototype) +
          " b=" + (Object.getPrototypeOf(empty) === Object.prototype) +
          " c=" + (Object.getPrototypeOf(o) === Object.getPrototypeOf(empty)));
    `);
    expect(lines).toEqual(["a=true b=true c=true"]);
  });

  it("keeps an explicit null prototype null", async () => {
    const lines = await runStandaloneLines(`
      var o; o = Object.create(null);
      LOG("created=" + (Object.getPrototypeOf(o) === null));
    `);
    expect(lines).toEqual(["created=true"]);
  });

  // Cluster I(b), §B.3.1: a NON-computed `__proto__:` key sets [[Prototype]]
  // and creates NO own property.
  it("sets [[Prototype]] from a colon __proto__ and defines no own property", async () => {
    const lines = await runStandaloneLines(`
      var proto = {};
      var object = { __proto__: proto };
      LOG("proto=" + (Object.getPrototypeOf(object) === proto) +
          " notObjectProto=" + (Object.getPrototypeOf(object) !== Object.prototype) +
          " desc=" + (Object.getOwnPropertyDescriptor(object, "__proto__") === undefined));
    `);
    expect(lines).toEqual(["proto=true notObjectProto=true desc=true"]);
  });

  it("honours { __proto__: null } and ignores a non-object __proto__ value", async () => {
    const lines = await runStandaloneLines(`
      var nulled = { __proto__: null };
      var num = { __proto__: 1 };
      var str = { __proto__: "s" };
      var bool = { __proto__: true };
      LOG("null=" + (Object.getPrototypeOf(nulled) === null) +
          " nullDesc=" + (Object.getOwnPropertyDescriptor(nulled, "__proto__") === undefined) +
          " num=" + (Object.getPrototypeOf(num) === Object.prototype) +
          " str=" + (Object.getPrototypeOf(str) === Object.prototype) +
          " bool=" + (Object.getPrototypeOf(bool) === Object.prototype));
    `);
    expect(lines).toEqual(["null=true nullDesc=true num=true str=true bool=true"]);
  });

  // ── Controls for the COMMON case of the mechanisms this step touches ──

  it("keeps a COMPUTED ['__proto__'] key an ordinary own property", async () => {
    const lines = await runStandaloneLines(`
      var proto = {};
      var own = {};
      var obj = { __proto__: proto, ["__proto__"]: own };
      LOG("proto=" + (Object.getPrototypeOf(obj) === proto) +
          " hasOwn=" + Object.prototype.hasOwnProperty.call(obj, "__proto__") +
          " value=" + (obj.__proto__ === own));
    `);
    expect(lines).toEqual(["proto=true hasOwn=true value=true"]);
  });

  it("leaves an ordinary literal's own properties and prototype reads unchanged", async () => {
    const body = `
      var o = { a: 1, b: "two" };
      LOG("a=" + o.a + " b=" + o.b +
          " keys=" + Object.keys(o).join(",") +
          " hasA=" + o.hasOwnProperty("a") +
          " toString=" + (typeof o.toString));
    `;
    const expected = ["a=1 b=two keys=a,b hasA=true toString=function"];
    expect(await runStandaloneLines(body)).toEqual(expected);
    // The JS-host lane is untouched by this step and answers identically.
    expect(await runHostLines(body)).toEqual(expected);
  });

  // A runtime `Object.setPrototypeOf(o, null)` must still be visible to
  // `__getPrototypeOf` — the new arm reads OBJ_FLAG_NULL_PROTO, which is what
  // that write sets. (`var o;` rather than `var o = {}` on purpose: an
  // identifier whose INITIALIZER is a literal is folded statically by
  // `object-get-prototype-of.ts`, and that fold predates this step.)
  it("keeps Object.setPrototypeOf(o, null) answering null", async () => {
    const lines = await runStandaloneLines(`
      var o; o = { a: 1 };
      LOG("before=" + (Object.getPrototypeOf(o) === Object.prototype));
      Object.setPrototypeOf(o, null);
      LOG("nulled=" + (Object.getPrototypeOf(o) === null));
    `);
    expect(lines).toEqual(["before=true", "nulled=true"]);
  });
});

describe("#5270 step 3 — redeclared `var` with two literal shapes (cluster M)", () => {
  // `var obj = {a: 1}; var obj = {b: 2};` is ONE binding with two differently
  // shaped initializers. The shared slot took the first declaration's anonymous
  // struct, so the second literal's `b` landed in the field the first called
  // `a` — `obj.a` read `2`.
  it("keeps the two shapes distinct", async () => {
    const lines = await runStandaloneLines(`
      var obj = { a: 1 };
      var obj = { b: 2 };
      LOG("a=" + String(obj.a) + " b=" + String(obj.b));
    `);
    expect(lines).toEqual(["a=undefined b=2"]);
  });

  it("handles a non-literal first declaration followed by a method literal", async () => {
    const lines = await runStandaloneLines(`
      var obj = Object.defineProperty({}, "attr", { get: function () { return 1; } });
      var obj = { method: function () { return 7; } };
      LOG("m=" + obj.method());
    `);
    expect(lines).toEqual(["m=7"]);
  });

  // Control: a var redeclared with the SAME shape keeps its previous lowering.
  it("leaves same-shape redeclarations and single declarations alone", async () => {
    const body = `
      var same = { a: 1 };
      var same = { a: 2 };
      var once = { x: 1, y: 2 };
      LOG("same=" + same.a + " once=" + once.x + "," + once.y);
    `;
    expect(await runStandaloneLines(body)).toEqual(["same=2 once=1,2"]);
    expect(await runHostLines(body)).toEqual(["same=2 once=1,2"]);
  });
});

describe("#5270 step 8 — ToPrimitive hint and bare expression statements (cluster D)", () => {
  // §7.1.1.1 step 1/2.b: an absent PreferredType is the STRING "default", and
  // that string is what the user's @@toPrimitive method receives. The internal
  // hint slot encodes "default" as null, and that null was passed through.
  it("passes the string 'default' to a user @@toPrimitive", async () => {
    const lines = await runStandaloneLines(`
      var left = {}; var right = {}; var log = "";
      left[Symbol.toPrimitive] = function (h) { log += "L" + h; return 1; };
      right[Symbol.toPrimitive] = function (h) { log += "R" + h; return 2; };
      var r = left + right;
      LOG(log + " r=" + r);
    `);
    expect(lines).toEqual(["LdefaultRdefault r=3"]);
  });

  // A bare `left + right;` / `0 == y;` statement runs ToPrimitive on any object
  // operand, so it is observable — the top-level collector dropped it whole.
  it("runs ToPrimitive for a bare `+` expression statement", async () => {
    const lines = await runStandaloneLines(`
      var log = ""; var left = {}; var right = {};
      left[Symbol.toPrimitive] = function () { log += "L"; };
      right[Symbol.toPrimitive] = function () { log += "R"; };
      left + right;
      LOG("log=" + log);
    `);
    expect(lines).toEqual(["log=LR"]);
  });

  it("runs ToPrimitive for a bare `==` expression statement", async () => {
    const lines = await runStandaloneLines(`
      var n = 0; var y = {};
      y[Symbol.toPrimitive] = function () { n++; };
      0 == y;
      LOG("n=" + n);
    `);
    expect(lines).toEqual(["n=1"]);
  });

  // Controls: the COMMON case of both mechanisms must be unchanged.
  // NOT part of the control, because it is already wrong on HEAD in BOTH lanes
  // and this step does not touch it: `"x" + o` for an object with a `valueOf`
  // (or a `toString`) answers `x[object Object]` instead of running
  // OrdinaryToPrimitive. Recorded in the issue file as a separate defect.
  it("leaves ordinary arithmetic, comparison and valueOf coercion unchanged", async () => {
    const body = `
      var o = { valueOf: function () { return 4; } };
      LOG("a=" + (1 + 2) + " b=" + (o * 3) + " c=" + (o - 1) +
          " d=" + (o == 4) + " e=" + (o === 4) + " f=" + (2 < 3) + " g=" + ("a" + 1));
    `;
    const expected = ["a=3 b=12 c=3 d=true e=false f=true g=a1"];
    expect(await runStandaloneLines(body)).toEqual(expected);
    expect(await runHostLines(body)).toEqual(expected);
  });
});

describe("#5270 step 10 — arrow-function surface (cluster N)", () => {
  // `"prototype" in (() => {})` folded TRUE: `tsTypeHasProperty` reads the
  // checker's APPARENT type, and TypeScript's `Function` interface declares
  // `prototype: any` for every callable. An arrow is never a constructor.
  it('answers `"prototype" in <arrow>` false', async () => {
    const lines = await runStandaloneLines(`
      var af = () => {};
      LOG("literal=" + ("prototype" in (() => {})) +
          " binding=" + ("prototype" in af) +
          " typeofArrow=" + (typeof (() => {})));
    `);
    expect(lines).toEqual(["literal=false binding=false typeofArrow=function"]);
  });

  // §10.2.4 AddRestrictedFunctionProperties applies to every non-legacy
  // function, arrows included — reading `caller` / `arguments` must throw.
  it("poisons caller/arguments on an arrow", async () => {
    const lines = await runStandaloneLines(`
      var arrowFn = () => {};
      var threw = 0;
      try { arrowFn.caller; } catch (e) { if (e instanceof TypeError) threw++; }
      try { arrowFn.arguments; } catch (e) { if (e instanceof TypeError) threw++; }
      LOG("threw=" + threw +
          " ownCaller=" + arrowFn.hasOwnProperty("caller") +
          " ownArguments=" + arrowFn.hasOwnProperty("arguments"));
    `);
    expect(lines).toEqual(["threw=2 ownCaller=false ownArguments=false"]);
  });

  // Controls: an ORDINARY sloppy function keeps `prototype` and its legacy
  // (non-throwing) `caller` read, and `in` on ordinary receivers is unchanged.
  it("leaves ordinary functions and ordinary `in` unchanged", async () => {
    const body = `
      function ordinary() {}
      var o = { a: 1 };
      LOG("fnProto=" + ("prototype" in ordinary) +
          " protoIsObj=" + (typeof ordinary.prototype) +
          " inOwn=" + ("a" in o) +
          " inMissing=" + ("b" in o) +
          " inInherited=" + ("toString" in o));
    `;
    const expected = ["fnProto=true protoIsObj=object inOwn=true inMissing=false inInherited=true"];
    expect(await runStandaloneLines(body)).toEqual(expected);
    expect(await runHostLines(body)).toEqual(expected);
  });
});

describe("#5270 review F1 — an arrow that HAS been given a `prototype`", () => {
  // An arrow's MISSING `prototype` is a fact about its CREATION, not its
  // lifetime: it is an ordinary extensible object afterwards. The first cut of
  // the cluster-N route folded a hard `false` for any binding whose initializer
  // is an arrow — with no write check — and additionally suppressed the
  // `__extern_has` fallback, so all four write forms answered `false` where
  // node and the base compiler answer `true`. The cluster-N pins above only
  // exercise a FRESH arrow, which is why nothing in-tree caught it.
  const bothLanes = async (body: string, expected: string[]): Promise<void> => {
    expect(await runStandaloneLines(body)).toEqual(expected);
    expect(await runHostLines(body)).toEqual(expected);
  };

  it("member-assignment: arrow.prototype = 5", async () => {
    await bothLanes(
      `var arrow = () => 1;
       arrow.prototype = 5;
       LOG("in=" + ("prototype" in arrow) + " value=" + arrow.prototype);`,
      ["in=true value=5"],
    );
  });

  it('computed member-assignment: arrow["prototype"] = 9', async () => {
    await bothLanes(
      `var a2 = () => 1;
       a2["prototype"] = 9;
       LOG("in=" + ("prototype" in a2));`,
      ["in=true"],
    );
  });

  it('Object.defineProperty(arrow, "prototype", …)', async () => {
    await bothLanes(
      `var a1 = () => 1;
       Object.defineProperty(a1, "prototype", { value: 3, writable: true, enumerable: false, configurable: true });
       LOG("in=" + ("prototype" in a1));`,
      ["in=true"],
    );
  });

  // Standalone only: `Object.assign(a3, {prototype: 4})` answers false in the
  // JS-HOST lane on `origin/main` too (measured by file-copy A/B against the
  // base `binary-ops-in.ts`), so pinning both lanes here would pin a defect
  // this issue did not introduce and does not fix.
  it("Object.assign(arrow, { prototype: 4 }) — standalone", async () => {
    expect(
      await runStandaloneLines(
        `var a3 = () => 1;
         Object.assign(a3, { prototype: 4 });
         LOG("in=" + ("prototype" in a3));`,
      ),
    ).toEqual(["in=true"]);
  });

  // The fold must SURVIVE for the population it was added for: an arrow that
  // provably never gains a property still answers false on both lanes.
  it("still answers false for an arrow that is never written to", async () => {
    await bothLanes(
      `var fresh = () => 1;
       LOG("binding=" + ("prototype" in fresh) + " literal=" + ("prototype" in (() => {})));`,
      ["binding=false literal=false"],
    );
  });
});
