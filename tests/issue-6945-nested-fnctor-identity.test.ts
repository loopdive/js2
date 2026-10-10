// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
// #6945 — a nested function declaration is a FRESH function object on every
// activation of its enclosing body (§10.2.11 step 36), so a per-call
// `Inheriter.prototype = p; new Inheriter()` (Octane deltablue's inheritance
// helper) must not alias one shared prototype slot across calls. Host lane:
// a capture-free nested declaration whose body-level `.prototype` is written is
// bound to a per-activation closure. The standalone lane keeps a per-NAME
// prototype global and is a documented residual (see the issue file), so its
// positive cases are `todo` here. Expectations are node's output.
import { describe, expect, it } from "vitest";
import { buildImports, compile, instantiateWasm } from "../src/index.js";

// The `inheritsFrom` cases add `configurable: true` to the minimized repros: the
// host lane installs the property on the REAL `Object.prototype`, and the next
// case in this process must be able to redefine it.
const CASES: Record<string, { src: string; expected: string }> = {
  // .tmp/db30.js
  perCallPrototype: {
    src: `function mk(p) {
  function Inheriter() { }
  Inheriter.prototype = p;
  return new Inheriter();
}
export function main() {
  var a = mk({ tag: "A" });
  var b = mk({ tag: "B" });
  return a.tag + "," + b.tag + "," + (Object.getPrototypeOf(a) === Object.getPrototypeOf(b));
}`,
    expected: "A,B,false",
  },
  constructorIdentity: {
    src: `function mk(p) {
  function F() { }
  F.prototype = p;
  return F;
}
export function main() {
  var f1 = mk({ t: 1 });
  var f2 = mk({ t: 2 });
  return (f1 !== f2) + "," + f1.prototype.t + "," + f2.prototype.t + "," + (f1.prototype !== f2.prototype);
}`,
    expected: "true,1,2,true",
  },
  // .tmp/db19.js — deltablue's `inheritsFrom`, two levels, call inside the ctor
  inheritsFromInCtor: {
    src: `Object.defineProperty(Object.prototype, "inheritsFrom", {
  configurable: true,
  value: function (shuper) {
    function Inheriter() { }
    Inheriter.prototype = shuper.prototype;
    this.prototype = new Inheriter();
    this.superConstructor = shuper;
  }
});
function Constraint(strength) { this.strength = strength; }
Constraint.prototype.addConstraint = function () { this.added = true; };
function UnaryConstraint(v, strength) {
  UnaryConstraint.superConstructor.call(this, strength);
  this.myOutput = v;
  this.addConstraint();
}
UnaryConstraint.inheritsFrom(Constraint);
function StayConstraint(v, str) { StayConstraint.superConstructor.call(this, v, str); }
StayConstraint.inheritsFrom(UnaryConstraint);
export function main() { var s = new StayConstraint(1, 2); return s.added + "," + s.strength + "," + s.myOutput; }`,
    expected: "true,2,1",
  },
  // .tmp/db27.js — a plain `inherits(ctor, shuper)` helper
  inheritsHelper: {
    src: `function inherits(ctor, shuper) {
  function Inheriter() { }
  Inheriter.prototype = shuper.prototype;
  ctor.prototype = new Inheriter();
  ctor.superConstructor = shuper;
}
function Constraint(strength) { this.strength = strength; }
Constraint.prototype.addConstraint = function () { this.added = true; };
function UnaryConstraint(v, strength) {
  UnaryConstraint.superConstructor.call(this, strength);
  this.myOutput = v;
  this.addConstraint();
}
inherits(UnaryConstraint, Constraint);
function StayConstraint(v, str) { StayConstraint.superConstructor.call(this, v, str); }
inherits(StayConstraint, UnaryConstraint);
export function main() { var s = new StayConstraint(1, 2); return s.added + "," + s.strength + "," + s.myOutput; }`,
    expected: "true,2,1",
  },
  // .tmp/db28.js — method called after construction
  inheritsFromAfter: {
    src: `Object.defineProperty(Object.prototype, "inheritsFrom", {
  configurable: true,
  value: function (shuper) {
    function Inheriter() { }
    Inheriter.prototype = shuper.prototype;
    this.prototype = new Inheriter();
    this.superConstructor = shuper;
  }
});
function Constraint(strength) { this.strength = strength; }
Constraint.prototype.addConstraint = function () { this.added = true; };
function UnaryConstraint(v, strength) {
  UnaryConstraint.superConstructor.call(this, strength);
  this.myOutput = v;
}
UnaryConstraint.inheritsFrom(Constraint);
function StayConstraint(v, str) { StayConstraint.superConstructor.call(this, v, str); }
StayConstraint.inheritsFrom(UnaryConstraint);
export function main() { var s = new StayConstraint(1, 2); s.addConstraint(); return s.added + "," + s.strength + "," + s.myOutput; }`,
    expected: "true,2,1",
  },
};

// Controls that hold on BOTH lanes: a top-level declaration keeps one identity.
const CONTROLS: Record<string, { src: string; expected: string }> = {
  topLevelSingleIdentity: {
    src: `function F() { }
F.prototype.k = 7;
function get() { return F; }
export function main() {
  return (get() === F) + "," + (get().prototype === F.prototype) + "," + new F().k;
}`,
    expected: "true,true,7",
  },
};

// A nested declaration that is only CALLED keeps the cached singleton: the
// enclosing function allocates no closure for it.
const CALL_ONLY = `function outer(x) {
  function helper(y) { return y + 1; }
  return helper(x);
}
export function main() { return outer(1) + outer(2); }`;

async function compileLane(src: string, lane: "gc" | "standalone", emitWat = false) {
  const result = await compile(src, {
    fileName: "case.js",
    allowJs: true,
    skipSemanticDiagnostics: true,
    emitWat,
    ...(lane === "standalone" ? { target: "standalone" as const } : {}),
  });
  expect(result.success, result.errors.map((e) => e.message).join("; ")).toBe(true);
  return result;
}

async function runLane(src: string, lane: "gc" | "standalone"): Promise<string> {
  const result = await compileLane(src, lane);
  if (lane === "standalone") {
    const { instance } = await WebAssembly.instantiate(result.binary, {});
    return renderStandalone(instance, (instance.exports.main as () => unknown)());
  }
  const imports = buildImports(result.imports, {}, result.stringPool);
  const { instance } = await instantiateWasm(result.binary, imports.env, imports.string_constants);
  imports.setInstance?.(instance);
  return String((instance.exports.main as () => unknown)());
}

/** A standalone module returns a native string; decode it with the module's own renderer. */
function renderStandalone(instance: WebAssembly.Instance, value: unknown): string {
  if (value === null || typeof value !== "object") return String(value);
  const prep = instance.exports.__exn_render_prepare as (v: unknown) => number;
  const chr = instance.exports.__exn_render_char as (i: number) => number;
  const len = prep(value);
  let out = "";
  for (let i = 0; i < len; i++) out += String.fromCharCode(chr(i));
  return out;
}

describe("#6945 nested function declarations are per-activation function objects", () => {
  for (const [name, { src, expected }] of Object.entries(CASES)) {
    it(`gc: ${name}`, async () => {
      expect(await runLane(src, "gc")).toBe(expected);
    });
    // Standalone residual: `.prototype` is a per-NAME module global there.
    it.todo(`standalone: ${name}`);
  }
  for (const lane of ["gc", "standalone"] as const) {
    for (const [name, { src, expected }] of Object.entries(CONTROLS)) {
      it(`${lane}: ${name}`, async () => {
        expect(await runLane(src, lane)).toBe(expected);
      });
    }
  }
  it("gc: a call-only nested declaration allocates no per-activation closure", async () => {
    const result = await compileLane(CALL_ONLY, "gc", true);
    const wat = result.wat ?? "";
    const start = wat.indexOf("(func $outer ");
    expect(start).toBeGreaterThanOrEqual(0);
    const body = wat.slice(start, wat.indexOf("\n  (func ", start + 5));
    expect(body).not.toContain("ref.func");
    expect(await runLane(CALL_ONLY, "gc")).toBe("5");
  });
});
