// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #4537 — `helper.call(this, …)` INSIDE a class method dropped the receiver.
//
// `receiverIsAdmitted` (named-this-call.ts) admitted a `this`-keyword receiver
// only when the enclosing function reads `__current_this`; a class method's
// `this` is its receiver PARAM (localMap carries "this"), so the admission
// refused it and the legacy lowering evaluated-and-dropped the receiver — the
// callee's `this.<field>` read undefined and every receiver-guarded write was
// silently skipped. This is acorn's exact `finishNode` → `finishNodeAt.call`
// shape (the range[1] writes behind `this.options.ranges` never ran).

import { describe, expect, it } from "vitest";
import { compile } from "../src/index.js";
import { buildImports, instantiateWasm, wrapExports } from "../src/runtime.js";

describe("issue #4537: .call(this) inside a class method", () => {
  it("threads the method's receiver into the callee", async () => {
    const SRC = `
      function helper() { return this && this.options ? 'HAS:' + this.options.ranges : 'MISSING'; }
      class Parser {
        constructor(options) { this.options = options; }
        viaMethod() { return helper.call(this); }
      }
      export function fromMethod(): string { return new Parser({ranges: true}).viaMethod(); }
      export function fromTop(): string { const p = new Parser({ranges: true}); return helper.call(p); }
    `;
    const result = await compile(SRC, { testRuntime: true, fileName: "issue-4537.ts", skipSemanticDiagnostics: true });
    expect(result.success, result.errors?.map((e) => e.message).join("; ")).toBe(true);
    const built = buildImports(
      result.imports,
      { console_log_number() {}, console_log_string() {}, console_log_bool() {} },
      result.stringPool,
    );
    const { instance } = await instantiateWasm(result.binary, built.env, built.string_constants);
    built.setInstance?.(instance);
    const wrapped = wrapExports(instance.exports as Record<string, Function>) as {
      fromMethod: () => string;
      fromTop: () => string;
    };
    expect(wrapped.fromMethod()).toBe("HAS:true");
    expect(wrapped.fromTop()).toBe("HAS:true");
  });

  it("acorn's finishNode shape mutates the receiver-guarded array element", async () => {
    const SRC = `
      class Node {
        constructor(parser, pos) {
          this.type = ""; this.start = pos; this.end = 0;
          if (parser.options.ranges) this.range = [pos, 0];
        }
      }
      function finishNodeAt(node, type, pos) {
        node.type = type; node.end = pos;
        if (this.options.ranges) node.range[1] = pos;
        return node;
      }
      class Parser {
        constructor(options) { this.options = options; }
        startNode(pos) { return new Node(this, pos); }
        finishNode(node, type, pos) { return finishNodeAt.call(this, node, type, pos); }
      }
      export function t(): string {
        const p = new Parser({ ranges: true });
        const n = p.startNode(4);
        p.finishNode(n, "X", 9);
        return JSON.stringify([n.end, n.range]);
      }
    `;
    const result = await compile(SRC, { testRuntime: true, fileName: "issue-4537b.ts", skipSemanticDiagnostics: true });
    expect(result.success, result.errors?.map((e) => e.message).join("; ")).toBe(true);
    const built = buildImports(
      result.imports,
      { console_log_number() {}, console_log_string() {}, console_log_bool() {} },
      result.stringPool,
    );
    const { instance } = await instantiateWasm(result.binary, built.env, built.string_constants);
    built.setInstance?.(instance);
    const wrapped = wrapExports(instance.exports as Record<string, Function>) as { t: () => string };
    expect(wrapped.t()).toBe("[9,[4,9]]");
  });
});
