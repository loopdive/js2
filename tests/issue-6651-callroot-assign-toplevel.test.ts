// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// (#6651) A top-level assignment whose target is rooted in an EXPRESSION —
// `f(o).p = v`, `g()[k] = v`, `new F().p = v`, `` tag`x`.p = v ``,
// `({ set a(v) {…} }).a = v`, `(a, b).p = v` — was silently DROPPED from
// `__module_init` on both targets: `getAssignmentRootIdentifier` finds no root
// name, so no keep arm matched, and the #3623/#4433 fall-through backstops never
// see assignments. The call never ran and the write never happened. The same
// statement inside a function body always worked. Base answered 0 on every
// shape below, on host AND standalone.
//
// The last block pins the host-runner half: once such a statement runs,
// `fnGlobalObject().Promise = fn` (dynamic-import/returns-promise.js) rebinds
// the sandbox's global, and `p.constructor` must still answer the realm's
// %Promise% — `normalizeSandboxValue` used to read the LIVE binding.
import { describe, expect, it } from "vitest";
import { compile } from "../src/index.js";
import { buildImports } from "../src/runtime.js";
import { normalizeSandboxValue, snapshotSandboxIntrinsics } from "../src/runtime/wasm-struct-host-semantics.js";

type Target = "host" | "standalone";

const PRELUDE = `
let calls = 0;
const o: any = { a: {}, n: 1 };
function f(x?: any): any { calls++; return x === undefined ? o : x; }
function tag(_s: any): any { calls++; return o; }
function F(this: any) { calls++; }
`;

async function run(statements: string, check: string, target: Target): Promise<number> {
  const source = `${PRELUDE}\n${statements}\nexport function test(): number { return (${check}) ? 1 : 0; }`;
  const options: Record<string, unknown> = { fileName: "test.ts", skipSemanticDiagnostics: true };
  if (target === "standalone") options.target = "standalone";
  const result = await compile(source, options as never);
  expect(result.success, `[${target}] ${result.errors.map((e) => e.message).join("\n")}`).toBe(true);
  const imports = target === "standalone" ? {} : buildImports(result.imports, undefined, result.stringPool);
  const { instance } = await WebAssembly.instantiate(result.binary, imports as unknown as WebAssembly.Imports);
  (imports as { setInstance?: (i: WebAssembly.Instance) => void }).setInstance?.(instance);
  return Number((instance.exports as { test: () => number }).test());
}

const SHAPES: ReadonlyArray<readonly [string, string, string]> = [
  ["member write on a call result", "f(o).p = 7;", "o.p === 7 && calls === 1"],
  ["element write on a call result", 'f(o)["k"] = 7;', "o.k === 7 && calls === 1"],
  ["chained write on a call result", "f(o).a.b = 7;", "o.a.b === 7 && calls === 1"],
  ["parenthesised call root", "(f(o)).p = 7;", "o.p === 7 && calls === 1"],
  ["compound `+=`", "f(o).n += 5;", "o.n === 6 && calls === 1"],
  ["logical `??=`", "f(o).q ??= 7;", "o.q === 7 && calls === 1"],
  ["`new` root runs the constructor", "(new (F as any)()).p = 7; calls += 10;", "calls === 11"],
  ["tagged-template root", "tag`x`.p = 7;", "o.p === 7 && calls === 1"],
  ["object-literal root invokes its setter", "({ set a(v: any) { calls = v; } } as any).a = 7;", "calls === 7"],
  ["comma-expression root", "(calls++, o).p = 7;", "o.p === 7 && calls === 1"],
  ["source order is kept", "calls = 5; f(o).p = calls; calls = 100;", "o.p === 6 && calls === 100"],
];

describe("#6651 — top-level assignment to an expression-rooted target runs", () => {
  for (const target of ["host", "standalone"] as const) {
    for (const [name, statements, check] of SHAPES) {
      it(`[${target}] ${name}`, async () => {
        expect(await run(statements, check, target)).toBe(1);
      });
    }
    it(`[${target}] identifier-rooted writes are unchanged`, async () => {
      expect(await run("o.p = 7; ++f(o).n;", "o.p === 7 && o.n === 2 && calls === 1", target)).toBe(1);
    });
  }
});

describe("#6651 — `x.constructor` maps to the sandbox's intrinsic, not its live binding", () => {
  it("a rebound sandbox global does not leak into `.constructor`", () => {
    const replacement = function replacement() {};
    const sandbox: Record<string, any> = { Promise, Array: class SandboxArray {} };
    snapshotSandboxIntrinsics(sandbox);
    sandbox.Promise = replacement;
    Reflect.deleteProperty(sandbox, "Array");
    const identity = (v: unknown) => v;
    expect(normalizeSandboxValue({}, Promise, "constructor", sandbox, undefined, identity)).toBe(Promise);
    const arrayCtor = normalizeSandboxValue([], Array, "constructor", sandbox, undefined, identity);
    expect(arrayCtor).not.toBe(Array);
    expect((arrayCtor as { name: string }).name).toBe("SandboxArray");
    // Not a `constructor` read: the live value passes through untouched.
    expect(normalizeSandboxValue({}, Promise, "other", sandbox, undefined, identity)).toBe(Promise);
  });
});
