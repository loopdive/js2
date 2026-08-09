// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #2660 PART-1 — unit tests for the INERT receiver-struct flow map + the
// `resolveReceiverStruct` provider (the analysis layer the PART-2 dynamic
// read/write/compound dispatch consumes). Pure analysis: builds an in-memory
// TS program + checker (allowJs, matching how acorn `.mjs` is compiled so the
// `this.method()` expando-symbol resolution is active) and asserts the
// per-binding `receiverStruct` map + the 3-case resolution order. No codegen.
//
// Conservative-closed contract: a receiver the flow can't prove resolves to a
// SINGLE `__fnctor_<Name>` is OMITTED ⇒ resolveReceiverStruct returns undefined
// ⇒ the consumer stays on the dynamic path. A miss NEVER yields a wrong struct.

import { describe, it, expect } from "vitest";
import * as ts from "typescript";
import { analyzeFnctorEscapeGate, resolveReceiverStruct } from "../src/codegen/fnctor-escape-gate.js";
import type { CodegenContext, FunctionContext } from "../src/codegen/context/types.js";

/** Build an in-memory single-file JS program + checker (allowJs → expando + this-type inference). */
function checkerForJs(source: string): { sf: ts.SourceFile; checker: ts.TypeChecker } {
  const fileName = "input.js";
  const sf = ts.createSourceFile(fileName, source, ts.ScriptTarget.ES2020, /*setParentNodes*/ true);
  const host: ts.CompilerHost = {
    getSourceFile: (name) => (name === fileName ? sf : undefined),
    getDefaultLibFileName: () => "lib.d.ts",
    writeFile: () => {},
    getCurrentDirectory: () => "",
    getCanonicalFileName: (n) => n,
    useCaseSensitiveFileNames: () => true,
    getNewLine: () => "\n",
    fileExists: (name) => name === fileName,
    readFile: (name) => (name === fileName ? source : undefined),
  };
  const program = ts.createProgram([fileName], { noLib: true, allowJs: true, checkJs: false, strict: false }, host);
  return { sf: program.getSourceFile(fileName)!, checker: program.getTypeChecker() };
}

/** Find the receiver expression of the first `<recvName>.<member>` access in `sf`. */
function findReceiver(sf: ts.SourceFile, recvName: string): ts.Expression | undefined {
  let found: ts.Expression | undefined;
  const walk = (n: ts.Node): void => {
    if (!found && ts.isPropertyAccessExpression(n) && ts.isIdentifier(n.expression) && n.expression.text === recvName) {
      found = n.expression;
    }
    ts.forEachChild(n, walk);
  };
  walk(sf);
  return found;
}

/** A minimal CodegenContext carrying only what resolveReceiverStruct reads. */
function mockCtx(result: ReturnType<typeof analyzeFnctorEscapeGate>, registeredStructs: string[]): CodegenContext {
  return {
    fnctorEscapeGate: result,
    structMap: new Map(registeredStructs.map((s, i) => [s, i + 1])),
  } as unknown as CodegenContext;
}

function mockFctx(thisStructName?: string): FunctionContext {
  return { thisStructName } as unknown as FunctionContext;
}

describe("#2660 PART-1 — receiver-struct flow map (inert analysis)", () => {
  it("maps a local bound from `this.m()` returning `new X()` → __fnctor_X", () => {
    // Aliased-prototype methods (acorn's pattern). `startNode` returns `new Node()`;
    // `node` (bound from `this.startNode()`) must resolve to __fnctor_Node even
    // though TS infers the call's return type as `any`.
    const src = `
      function Node() { this.foo = 1; }
      function Parser() {}
      var pp = Parser.prototype;
      pp.startNode = function () { return new Node(); };
      pp.run = function () {
        var node = this.startNode();
        return node.foo;
      };
    `;
    const { sf, checker } = checkerForJs(src);
    const result = analyzeFnctorEscapeGate(checker, [sf]);
    const recv = findReceiver(sf, "node")!;
    expect(recv).toBeDefined();
    expect(result.receiverStruct.get(recv)).toBe("__fnctor_Node");
  });

  it("follows a single-return CALL chain (depth-capped) `m()->return this.n()->new X()`", () => {
    const src = `
      function Scope() { this.flags = 0; }
      function Parser() {}
      var pp = Parser.prototype;
      pp.makeScope = function () { return new Scope(); };
      pp.currentScope = function () { return this.makeScope(); };
      pp.run = function () {
        var scope = this.currentScope();
        return scope.flags;
      };
    `;
    const { sf, checker } = checkerForJs(src);
    const result = analyzeFnctorEscapeGate(checker, [sf]);
    const recv = findReceiver(sf, "scope")!;
    expect(result.receiverStruct.get(recv)).toBe("__fnctor_Scope");
  });

  it("does NOT map a multi-return method (ambiguous) → conservative omit", () => {
    const src = `
      function A() { this.x = 1; }
      function B() { this.y = 2; }
      function Parser() {}
      var pp = Parser.prototype;
      pp.pick = function (c) { if (c) { return new A(); } return new B(); };
      pp.run = function () {
        var v = this.pick(1);
        return v.x;
      };
    `;
    const { sf, checker } = checkerForJs(src);
    const result = analyzeFnctorEscapeGate(checker, [sf]);
    const recv = findReceiver(sf, "v");
    // recv may be undefined if no `v.` access — but here `v.x` exists.
    expect(recv).toBeDefined();
    expect(result.receiverStruct.get(recv!)).toBeUndefined();
  });

  it("does NOT map a return whose value is not `new X()` / a call → omit", () => {
    const src = `
      function Parser() { this.opts = {}; }
      var pp = Parser.prototype;
      pp.getOpts = function () { return this.opts; };
      pp.run = function () {
        var o = this.getOpts();
        return o.x;
      };
    `;
    const { sf, checker } = checkerForJs(src);
    const result = analyzeFnctorEscapeGate(checker, [sf]);
    const recv = findReceiver(sf, "o")!;
    expect(result.receiverStruct.get(recv)).toBeUndefined();
  });

  it("terminates on a self-recursive single-return chain (no hang) → omit", () => {
    const src = `
      function Parser() {}
      var pp = Parser.prototype;
      pp.loop = function () { return this.loop(); };
      pp.run = function () {
        var v = this.loop();
        return v.x;
      };
    `;
    const { sf, checker } = checkerForJs(src);
    const result = analyzeFnctorEscapeGate(checker, [sf]);
    const recv = findReceiver(sf, "v")!;
    expect(result.receiverStruct.get(recv)).toBeUndefined();
  });

  it("is empty for fnctor-free code", () => {
    const { sf, checker } = checkerForJs(`function f() { return 1; } f();`);
    const result = analyzeFnctorEscapeGate(checker, [sf]);
    expect(result.receiverStruct.size).toBe(0);
  });
});

describe("#2660 PART-1 — resolveReceiverStruct (3-case resolution)", () => {
  const src = `
    function Node() { this.foo = 1; }
    function Parser() {}
    var pp = Parser.prototype;
    pp.startNode = function () { return new Node(); };
    pp.run = function () {
      var node = this.startNode();
      var other = 5;
      return node.foo + other;
    };
  `;

  it("case 1: `this` receiver → fctx.thisStructName (when registered)", () => {
    const { sf, checker } = checkerForJs(src);
    const result = analyzeFnctorEscapeGate(checker, [sf]);
    const ctx = mockCtx(result, ["__fnctor_Parser", "__fnctor_Node"]);
    const fctx = mockFctx("__fnctor_Parser");
    // Synthesize a `this` expression.
    const thisExpr = ts.factory.createThis();
    expect(resolveReceiverStruct(ctx, fctx, thisExpr)).toBe("__fnctor_Parser");
  });

  it("case 1: `this` receiver but thisStructName unset → undefined", () => {
    const { sf, checker } = checkerForJs(src);
    const result = analyzeFnctorEscapeGate(checker, [sf]);
    const ctx = mockCtx(result, ["__fnctor_Parser"]);
    const fctx = mockFctx(undefined);
    expect(resolveReceiverStruct(ctx, fctx, ts.factory.createThis())).toBeUndefined();
  });

  it("case 2: local in the flow map AND struct registered → the struct name", () => {
    const { sf, checker } = checkerForJs(src);
    const result = analyzeFnctorEscapeGate(checker, [sf]);
    const ctx = mockCtx(result, ["__fnctor_Node"]);
    const fctx = mockFctx("__fnctor_Parser");
    const recv = findReceiver(sf, "node")!;
    expect(resolveReceiverStruct(ctx, fctx, recv)).toBe("__fnctor_Node");
  });

  it("case 2 (conservative): flow-map hit but struct NOT registered → undefined", () => {
    const { sf, checker } = checkerForJs(src);
    const result = analyzeFnctorEscapeGate(checker, [sf]);
    const ctx = mockCtx(result, []); // structMap empty → __fnctor_Node not registered yet
    const fctx = mockFctx("__fnctor_Parser");
    const recv = findReceiver(sf, "node")!;
    expect(resolveReceiverStruct(ctx, fctx, recv)).toBeUndefined();
  });

  it("case 3: an unrelated local receiver → undefined (dynamic path)", () => {
    const { sf, checker } = checkerForJs(src);
    const result = analyzeFnctorEscapeGate(checker, [sf]);
    const ctx = mockCtx(result, ["__fnctor_Node"]);
    const fctx = mockFctx("__fnctor_Parser");
    // `other` is a number, never in the flow map.
    const otherUse = findReceiver(sf, "other");
    // `other` has no member access (`other` is used bare in `+ other`), so build a
    // throwaway identifier that is definitely not a flow-map key.
    const synthetic = ts.factory.createIdentifier("other");
    expect(resolveReceiverStruct(ctx, fctx, otherUse ?? synthetic)).toBeUndefined();
  });
});
