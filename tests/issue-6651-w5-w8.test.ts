// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #6651 slice W8 — OrdinaryHasInstance for generator functions (standalone).
// A sync generator FUNCTION value's run-time [[Prototype]] is
// %GeneratorFunction.prototype% (§27.3.3), so `g instanceof GeneratorFunction`
// (§7.3.19) and `GeneratorFunction.prototype.isPrototypeOf(g)` hold for a
// declaration and an expression, through a binding and through an array slot.
// Inline programs only, no eval engine (the `GeneratorFunction(…)` products of
// the test262 row need the runtime-eval provider).
//
// Every case but the guard fails on the pre-W8 tree (#6651 plan entry
// "2026-10-07 — Slices W5+W8"). Slice W5 landed no code (see that record).
import { describe, expect, it } from "vitest";
import { compile } from "../src/index.js";

async function runModule(source: string): Promise<number> {
  const r = await compile(source, {
    target: "standalone",
    fileName: "p.js",
    allowJs: true,
    skipSemanticDiagnostics: true,
    deferTopLevelInit: true,
  } as Parameters<typeof compile>[1]);
  expect(r.success, r.errors.map((e) => e.message).join("\n")).toBe(true);
  const mod = await WebAssembly.compile(r.binary);
  const imports: Record<string, Record<string, unknown>> = {};
  for (const imp of WebAssembly.Module.imports(mod)) {
    const ns = (imports[imp.module] ??= {});
    ns[imp.name] = () => {
      throw new Error(`unexpected import call ${imp.module}::${imp.name}`);
    };
  }
  const instance = await WebAssembly.instantiate(mod, imports as WebAssembly.Imports);
  const ex = instance.exports as { __module_init?: () => void; readResult: () => number };
  ex.__module_init?.();
  return ex.readResult();
}

const PRELUDE = `
var __r = 0;
var GeneratorFunction = Object.getPrototypeOf(function* () {}).constructor;
function* gDecl() {}
var gExpr = function* () {};
`;

describe("#6651 W8 — generator functions are GeneratorFunction instances (standalone)", () => {
  it("a generator declaration and expression are instanceof GeneratorFunction", async () => {
    const result = await runModule(`${PRELUDE}
if (gDecl instanceof GeneratorFunction) __r |= 1;
if (gExpr instanceof GeneratorFunction) __r |= 2;
export function readResult() { return __r; }
`);
    expect(result).toBe(3);
  }, 120_000);

  it("isPrototypeOf and instanceof walk a generator value read back from an array slot", async () => {
    const result = await runModule(`${PRELUDE}
var GP = GeneratorFunction.prototype;
var a = [gDecl, gExpr];
var x = a[0];
var y = a[1];
if (GP.isPrototypeOf(x)) __r |= 1;
if (GP.isPrototypeOf(y)) __r |= 2;
if (x instanceof GeneratorFunction) __r |= 4;
if (GP.isPrototypeOf(gDecl)) __r |= 8;
export function readResult() { return __r; }
`);
    expect(result).toBe(15);
  }, 120_000);

  it("guard: an ordinary function is not a GeneratorFunction instance", async () => {
    const result = await runModule(`${PRELUDE}
function plain() {}
var p = function () {};
if (!(plain instanceof GeneratorFunction)) __r |= 1;
if (!(p instanceof GeneratorFunction)) __r |= 2;
if (!GeneratorFunction.prototype.isPrototypeOf(plain)) __r |= 4;
if (gDecl instanceof Object) __r |= 8;
export function readResult() { return __r; }
`);
    expect(result).toBe(15);
  }, 120_000);
});
