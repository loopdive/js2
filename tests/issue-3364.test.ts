// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #3364 — widened empty-object struct shape clobbered by a same-named variable
// in an unrelated function (a distinct, still-live cause of the #3343/#3308
// in-Wasm recursive-read runaway; #3343 itself was fixed separately in loops.ts
// for a for-loop-counter aliasing bug, which does NOT cover this one).
//
// Root cause: the empty-object shape-widening maps (`widenedTypeProperties` /
// `widenedVarStructMap`) were keyed by the BARE variable name. Acorn's parser
// reuses generic local names (`node`, `type`, …) across many functions, each
// building an object with a DIFFERENT field set; bare-name keying let the last
// widening clobber all the others, so every other same-named var built the
// WRONG (foreign) struct — its real field values were dropped at `struct.new`,
// and reads of the missing ref/string fields (`.callee`, `.type`, …) returned
// null. A full recursive in-Wasm walk over such objects then mis-descended and
// ran away past a 1e6 budget (#3308).
//
// Fix: key the maps per-declaration (name + declaration start offset) so each
// same-named-but-distinct-shape var keeps its own struct.
//
// These are pure-Wasm standalone builds (no host), exactly the #2928/#3308
// interpreter-ladder path. No acorn compile — the objects are hand-built.
import { describe, expect, it } from "vitest";
import { compile } from "../src/index.js";

async function runStandalone(src: string, arg?: number): Promise<unknown> {
  const r = await compile(src, { target: "standalone" });
  expect(r.success, r.errors.map((e) => e.message).join("\n")).toBe(true);
  expect(WebAssembly.validate(r.binary), "module failed WebAssembly.validate").toBe(true);
  const { instance } = await WebAssembly.instantiate(r.binary, {});
  const fn = (instance.exports as { test: (a?: number) => unknown }).test;
  return arg === undefined ? fn() : fn(arg);
}

describe("#3364 widened-object same-name cross-function shape collision", () => {
  it("a same-named local in an unrelated function does not clobber the read shape", async () => {
    // `call` and the UNUSED `foo` both name their local `node` but with
    // different shapes. Pre-fix, foo's 1-field shape clobbered call's 6-field
    // shape, so `cl.callee` read back null.
    const src = `
      function ident(k: number): any {
        const node: any = {};
        node.type = "Identifier"; node.start = k; node.end = k + 1; node.name = "v";
        return node;
      }
      function call(callee: any, args: any): any {
        const node: any = {};
        node.type = "CallExpression"; node.start = 0; node.end = 1;
        node.callee = callee; node.arguments = args; node.optional = false;
        return node;
      }
      // UNUSED, same local name 'node', different shape.
      function foo(e: any): any { const node: any = {}; node.expression = e; return node; }
      export function test(): number {
        const cl = call(ident(1), [ident(2), ident(3)]);
        const c = cl.callee;
        return (c !== null && c !== undefined && typeof c === "object") ? 1 : 0;
      }`;
    expect(await runStandalone(src)).toBe(1);
  });

  it("every field of a widened object survives when a same-named var exists elsewhere", async () => {
    const src = `
      function ident(k: number): any {
        const node: any = {};
        node.type = "Identifier"; node.start = k; node.end = k + 1; node.name = "v";
        return node;
      }
      function call(callee: any, args: any): any {
        const node: any = {};
        node.type = "CallExpression"; node.start = 0; node.end = 1;
        node.callee = callee; node.arguments = args; node.optional = false;
        return node;
      }
      function foo(e: any): any { const node: any = {}; node.expression = e; return node; }
      export function test(): number {
        const cl = call(ident(1), [ident(2), ident(3)]);
        const okType: number = (typeof cl.type === "string") ? 1 : 0;
        const okStart: number = (cl.start !== null && cl.start !== undefined) ? 1 : 0;
        const okEnd: number = (cl.end !== null && cl.end !== undefined) ? 1 : 0;
        const okCallee: number = (cl.callee !== null && cl.callee !== undefined) ? 1 : 0;
        const okArgs: number = (cl.arguments !== null && cl.arguments !== undefined) ? 1 : 0;
        const okOpt: number = (cl.optional !== null && cl.optional !== undefined) ? 1 : 0;
        return okType * 100000 + okStart * 10000 + okEnd * 1000 + okCallee * 100 + okArgs * 10 + okOpt;
      }`;
    expect(await runStandalone(src)).toBe(111111);
  });

  it("a full recursive in-Wasm walk of a heterogeneous AST-shaped tree terminates with the exact node count", async () => {
    // Build a Program with a body[] of ExpressionStatements, each wrapping a
    // CallExpression tree, then walk it recursively (no visited set — a spurious
    // back-edge would run away past the budget). All node builders reuse generic
    // local names across functions, the exact acorn-parser pattern.
    const src = `
      let e0Budget: number = 0;
      let e0Hit: number = 0;
      function walk(node: any): number {
        if (e0Budget <= 0) { e0Hit = 1; return 0; }
        e0Budget = e0Budget - 1;
        if (node === null || node === undefined) return 0;
        if (typeof node !== "object") return 0;
        if (Array.isArray(node)) {
          let m = 0;
          const len: number = (node as any).length;
          for (let i = 0; i < len; i++) { if (e0Budget <= 0) { e0Hit = 1; return m; } m = m + walk(node[i]); }
          return m;
        }
        const t = node.type;
        if (typeof t !== "string") return 0;
        let n = 1;
        if (t === "Program") { n = n + walk(node.body); return n; }
        if (t === "ExpressionStatement") { n = n + walk(node.expression); return n; }
        if (t === "BinaryExpression") { n = n + walk(node.left); n = n + walk(node.right); return n; }
        if (t === "CallExpression") { n = n + walk(node.callee); n = n + walk(node.arguments); return n; }
        if (t === "Identifier") { return n; }
        return n;
      }
      function ident(): any {
        const node: any = {};
        node.type = "Identifier"; node.start = 0; node.end = 1; node.name = "v";
        return node;
      }
      function binary(l: any, r: any): any {
        const node: any = {};
        node.type = "BinaryExpression"; node.start = 0; node.end = 1;
        node.left = l; node.right = r; node.operator = "+";
        return node;
      }
      function call(callee: any, args: any): any {
        const node: any = {};
        node.type = "CallExpression"; node.start = 0; node.end = 1;
        node.callee = callee; node.arguments = args; node.optional = false;
        return node;
      }
      function exprStmt(e: any): any {
        const node: any = {};
        node.type = "ExpressionStatement"; node.start = 0; node.end = 1;
        node.expression = e;
        return node;
      }
      function makeExpr(depth: number): any {
        if (depth <= 0) { return ident(); }
        const b = binary(makeExpr(depth - 1), makeExpr(depth - 1));
        const args: any[] = [b, ident(), ident()];
        return call(ident(), args);
      }
      export function test(nstmts: number): number {
        const body: any[] = [];
        let i: number = 0;
        while (i < nstmts) { body.push(exprStmt(makeExpr(3))); i = i + 1; }
        const prog: any = {};
        prog.type = "Program"; prog.start = 0; prog.end = 1; prog.body = body;
        e0Budget = 1000000;
        e0Hit = 0;
        const n = walk(prog);
        return e0Hit ? -99999 : n;
      }`;
    // Per-statement node count for depth-3 makeExpr walk:
    //   E(d) = 5 + 2*E(d-1), E(0)=1  =>  E(3)=43; stmt = 1(exprStmt)+43 = 44.
    // Program: 1 + nstmts*44.
    expect(await runStandalone(src, 6)).toBe(1 + 6 * 44);
    expect(await runStandalone(src, 10)).toBe(1 + 10 * 44);
  });
});
