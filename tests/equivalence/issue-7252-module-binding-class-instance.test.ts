// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #7252 — a script `var` whose every write is `new X(...)` of one top-level
// class binds to the `(ref null $X)` slot legacy allocates for it, so the
// `<module-init>` that declares and uses it lowers through the IR.
//
// Each script throws on a wrong value. On all three lanes the verdict must
// agree with node and with the legacy compile (`experimentalIR: false`); the
// IR cases must also take the IR body for `<module-init>`, and the refused
// cases must keep it legacy.
import { describe, expect, it } from "vitest";
import { compile, type CompileOptions, type CompileResult } from "../../src/index.js";
import { buildImports } from "../../src/runtime.js";

const LANES: { readonly name: string; readonly options: CompileOptions }[] = [
  { name: "gc (default)", options: {} },
  { name: "standalone", options: { target: "standalone" } },
  { name: "wasi", options: { target: "wasi" } },
];

const wasiImports = {
  wasi_snapshot_preview1: new Proxy(
    {},
    {
      get: (_target, key) =>
        key === "proc_exit"
          ? (code: number) => {
              throw new Error(`proc_exit ${code}`);
            }
          : () => 0,
    },
  ),
};

type Verdict = "ok" | "threw";

async function run(source: string, options: CompileOptions, legacy: boolean) {
  const result: CompileResult = await compile(source, {
    fileName: "issue-7252.ts",
    scriptGoal: true,
    trackIrOutcomes: true,
    ...options,
    ...(legacy ? { experimentalIR: false } : {}),
  } as CompileOptions);
  expect(result.success, result.errors.map((error) => error.message).join("\n")).toBe(true);
  const imports =
    options.target === "standalone"
      ? {}
      : options.target === "wasi"
        ? wasiImports
        : buildImports(result.imports, {}, result.stringPool);
  let verdict: Verdict = "ok";
  try {
    const { instance } = await WebAssembly.instantiate(result.binary, imports as WebAssembly.Imports);
    const exports = instance.exports as Record<string, (() => void) | undefined>;
    (exports.__module_init ?? exports._start)?.();
  } catch {
    verdict = "threw";
  }
  const moduleInit = (result.irOutcomes ?? []).find((row) => row.displayName === "<module-init>");
  return { verdict, ir: moduleInit?.irBodyEmitted === true };
}

function node(source: string): Verdict {
  const js = source.replace(/: (number|string|C)\b/g, "");
  try {
    new Function(js)();
    return "ok";
  } catch {
    return "threw";
  }
}

const C = `class C { x: number = 3; m(): number { return 1; } }`;
const CD = `${C} class D extends C { m(): number { return 2; } }`;

const IR_CASES: Record<string, string> = {
  "method call": `${C} var c = new C(); var r = c.m(); if (r !== 1) throw "r";`,
  "field read and write": `${C} var c = new C(); if (c.x !== 3) throw "x"; c.x = 4; if (c.x !== 4) throw "y";`,
  "subclass instance, overriding method": `${CD} var c = new D(); if (c.m() !== 2) throw "m";`,
  "instanceof base and subclass": `${CD} var c = new D(); if (!(c instanceof C) || !(c instanceof D)) throw "i";`,
  "two bindings of two classes": `${C} class B { b(): number { return 2; } } var a = new C(); var b = new B(); if (a.m() + b.b() !== 3) throw "s";`,
  "redeclared var": `${C} var c = new C(); var c = new C(); if (c.m() !== 1) throw "m";`,
  "reassigned to a new instance": `${C} var c = new C(); c.x = 9; c = new C(); if (c.x !== 3) throw "x";`,
  accessors: `class C { _v: number = 0; get v(): number { return this._v; } set v(x: number) { this._v = x; } } var c = new C(); c.v = 4; if (c.v !== 4) throw "v";`,
  "method returning this": `class C { n: number = 0; inc(): C { this.n++; return this; } } var c = new C(); c.inc().inc(); if (c.n !== 2) throw "n";`,
  "argument to a typed function": `${C} function h(o: C): number { return o.m(); } var c = new C(); if (h(c) !== 1) throw "h";`,
  "thrown from a method": `class C { m(): number { throw new Error("boom"); } } var c = new C(); var ok = false; try { c.m(); } catch (e) { ok = true; } if (!ok) throw "o";`,
};

// Each stays legacy for `<module-init>`, and must still agree with legacy.
const REFUSED_CASES: Record<string, string> = {
  "read in a function": `${C} var c = new C(); function f(): number { return c.m(); } if (f() !== 1) throw "f";`,
  "written with a subclass in a function": `${CD} var c = new C(); function f() { c = new D(); } f(); if (c.m() !== 2) throw "m";`,
  "declared as the base class": `${CD} var c: C = new D(); if (c.m() !== 2) throw "m";`,
  "read before the declaration": `${C} var ok = false; try { c.m(); } catch (e) { ok = true; } var c = new C(); if (!ok) throw "o";`,
  "typeof the binding": `${C} var c = new C(); if (typeof c !== "object") throw "t";`,
};

describe("#7252 — a script var holding one class's instances binds to its class-struct slot", () => {
  for (const lane of LANES) {
    for (const [name, source] of Object.entries(IR_CASES)) {
      it(`${lane.name}: ${name} — IR, agrees with node and legacy`, async () => {
        const head = await run(source, lane.options, false);
        const base = await run(source, lane.options, true);
        expect(head.ir).toBe(true);
        expect(head.verdict).toBe(node(source));
        expect(head.verdict).toBe(base.verdict);
      });
    }
    for (const [name, source] of Object.entries(REFUSED_CASES)) {
      it(`${lane.name}: ${name} — stays legacy, agrees with legacy`, async () => {
        const head = await run(source, lane.options, false);
        const base = await run(source, lane.options, true);
        expect(head.ir).toBe(false);
        expect(head.verdict).toBe(base.verdict);
      });
    }
  }
});
