// (#2859) IR: drive the `param-type-not-resolvable` fallback bucket to zero.
//
// A function-typed param annotation (`fn: () => number`) previously returned
// null from the selector's `resolveParamType` (no FunctionTypeNode arm), so
// any function taking a callback demoted to legacy with
// `param-type-not-resolvable` — the corpus instance was `addBenchCard` in
// `website/playground/examples/benchmarks/helpers.ts`.
//
// The fix routes expressible function types (params + return all primitive —
// the same surface slice-3 closure literals support) through
// `IrType.closure`:
//   - `select.ts` `resolveParamType` accepts FunctionTypeNode via the shared
//     `irClosureSignatureFromFunctionTypeNode` helper;
//   - `codegen/index.ts` `resolvePositionType` builds the SAME signature for
//     the override map, so the param's IrType compares `irTypeEquals`-equal
//     to a closure-literal argument's signature;
//   - `buildLocalCallGraph` treats calls through such params as intra-function
//     closure dispatch (previously misclassified `external-call`).
//
// NOTE on the issue's acceptance criterion 3 (STRICT_IR_REASONS promotion):
// deliberately NOT done — see the issue file's "STRICT promotion deferred"
// section. `param-type-not-resolvable` still legitimately fires for common
// user shapes (unannotated polymorphic params, union-typed params), and
// STRICT promotion hard-errors EVERY compilation, not just the corpus.

import { describe, it, expect } from "vitest";
import ts from "typescript";
import { compile } from "../src/index.js";
import { buildImports } from "../src/runtime.js";
import { buildTypeMap } from "../src/ir/propagate.js";
import { planIrCompilation, irClosureSignatureFromFunctionTypeNode } from "../src/ir/select.js";

function selectorReasons(src: string): Map<string, string> {
  const sf = ts.createSourceFile("t.ts", src, ts.ScriptTarget.ES2022, true);
  const sel = planIrCompilation(sf, { experimentalIR: true, trackFallbacks: true }, buildTypeMap(sf));
  const out = new Map<string, string>();
  for (const fb of sel.fallbacks ?? []) out.set(fb.name, fb.reason);
  return out;
}

function selectorClaims(src: string): Set<string> {
  const sf = ts.createSourceFile("t.ts", src, ts.ScriptTarget.ES2022, true);
  const sel = planIrCompilation(sf, { experimentalIR: true, trackFallbacks: true }, buildTypeMap(sf));
  return sel.funcs;
}

async function run(src: string): Promise<{ value: unknown; irWarnings: string[] }> {
  const r = await compile(src, { fileName: "t.ts" });
  expect(r.success, r.errors.map((e) => e.message).join("\n")).toBe(true);
  const imports = buildImports(r.imports, undefined, r.stringPool) as WebAssembly.Imports;
  const { instance } = await WebAssembly.instantiate(r.binary, imports);
  (imports as { setExports?: (e: unknown) => void }).setExports?.(instance.exports);
  const value = (instance.exports as Record<string, () => unknown>).test();
  return { value, irWarnings: [] };
}

const CALLBACK_PROG = `
function apply(fn: () => number): number {
  const v = fn();
  return v + 1;
}
function applyWith(x: number, f: (a: number) => number): number {
  return f(x) * 2;
}
export function test(): number {
  const g = (): number => 41;
  const h = (a: number): number => a + 3;
  return apply(g) + applyWith(10, h);
}
`;

describe("#2859 — function-typed params resolve through the IR (param-type-not-resolvable → 0)", () => {
  it("selector claims functions with expressible function-typed params", () => {
    const claims = selectorClaims(CALLBACK_PROG);
    expect([...claims].sort()).toEqual(["apply", "applyWith", "test"]);
    expect(selectorReasons(CALLBACK_PROG).size).toBe(0);
  });

  it("calls through the closure param execute correctly (zero-arg and one-arg)", async () => {
    const { value } = await run(CALLBACK_PROG);
    // apply(g)=42, applyWith(10,h)=(10+3)*2=26 → 68
    expect(value).toBe(68);
  });

  it("string/boolean signatures work through the param", async () => {
    const { value } = await run(`
function pick(cond: (n: number) => boolean, x: number): number {
  if (cond(x)) { return x; }
  return 0 - x;
}
export function test(): number {
  const pos = (n: number): boolean => n > 0;
  return pick(pos, 5) + pick(pos, -7);
}
`);
    // pick(pos,5)=5, pick(pos,-7)=-(-7)=7 → 12
    expect(value).toBe(12);
  });

  it("closure param forwards to another closure-param function", async () => {
    const { value } = await run(`
function inner(fn: (a: number) => number): number {
  return fn(20);
}
function outer(fn: (a: number) => number): number {
  return inner(fn) + 1;
}
export function test(): number {
  const dbl = (a: number): number => a * 2;
  return outer(dbl);
}
`);
    expect(value).toBe(41);
  });

  it("the helpers.ts addBenchCard SHAPE no longer rejects with param-type-not-resolvable", () => {
    // Mirrors the corpus function that owned the bucket's single instance:
    // a `fn: () => number` param alongside non-closure params. The body here
    // is Phase-1-claimable (unlike the real addBenchCard, whose DOM body is
    // #2856's body-shape scope) — proving the PARAM gate specifically.
    const reasons = selectorReasons(`
function addBenchCard(title: string, desc: string, fn: () => number): number {
  const v = fn();
  return v;
}
export function test(): number {
  const f = (): number => 9;
  return addBenchCard("t", "d", f);
}
`);
    expect(reasons.get("addBenchCard")).toBeUndefined();
    expect([...reasons.values()]).not.toContain("param-type-not-resolvable");
  });

  it("inexpressible function types keep the honest rejection", () => {
    // Non-primitive param type inside the signature → not expressible with
    // the slice-3 closure surface → the enclosing function stays rejected
    // with param-type-not-resolvable (NOT claimed, NOT crashed).
    const reasons = selectorReasons(`
function takesComplex(fn: (xs: number[]) => number): number {
  return fn([1]);
}
export function test(): number { return takesComplex((xs: number[]): number => xs[0]); }
`);
    expect(reasons.get("takesComplex")).toBe("param-type-not-resolvable");
  });

  it("keeps a void-returning callback call rejected after its signature becomes expressible", () => {
    const reasons = selectorReasons(`
function each(fn: (a: number) => void): number {
  fn(1);
  return 0;
}
export function test(): number { return each((a: number): void => {}); }
`);
    expect(reasons.get("each")).toBe("call-graph-closure");
  });

  it("signature helper: expressible and inexpressible shapes", () => {
    const parse = (t: string): ts.FunctionTypeNode => {
      const sf = ts.createSourceFile("x.ts", `type X = ${t};`, ts.ScriptTarget.ES2022, true);
      const alias = sf.statements[0] as ts.TypeAliasDeclaration;
      return alias.type as ts.FunctionTypeNode;
    };
    expect(irClosureSignatureFromFunctionTypeNode(parse("() => number"))).toEqual({
      params: [],
      returnType: { kind: "val", val: { kind: "f64" } },
    });
    expect(irClosureSignatureFromFunctionTypeNode(parse("(a: number, s: string) => boolean"))).toEqual({
      params: [{ kind: "val", val: { kind: "f64" } }, { kind: "string" }],
      returnType: { kind: "val", val: { kind: "i32" } },
    });
    expect(irClosureSignatureFromFunctionTypeNode(parse("() => void"))).toEqual({
      params: [],
      returnType: null,
    });
    // rest / optional / default / non-primitive / generics → null
    expect(irClosureSignatureFromFunctionTypeNode(parse("(...a: number[]) => number"))).toBeNull();
    expect(irClosureSignatureFromFunctionTypeNode(parse("(a?: number) => number"))).toBeNull();
    expect(irClosureSignatureFromFunctionTypeNode(parse("(a: number[]) => number"))).toBeNull();
    expect(irClosureSignatureFromFunctionTypeNode(parse("<T>(a: T) => number"))).toBeNull();
  });
});
