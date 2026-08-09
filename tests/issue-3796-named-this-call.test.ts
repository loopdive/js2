// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import { afterEach, describe, expect, it, vi } from "vitest";

import { compile } from "../src/index.js";

async function compileStandalone(source: string, fileName: string) {
  const result = await compile(source, {
    fileName,
    target: "standalone",
    skipSemanticDiagnostics: true,
  });
  expect(result.success, result.errors.map((error) => error.message).join("\n")).toBe(true);
  const module = await WebAssembly.compile(result.binary);
  expect(WebAssembly.Module.imports(module)).toEqual([]);
  return { result, instance: await WebAssembly.instantiate(module, {}) };
}

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("#3796 receiver-correct stable named FunctionDeclaration.call", () => {
  it("preserves receiver identity, exact target arity, and operand evaluation order", async () => {
    const { instance } = await compileStandalone(
      `
      var order = 0;
      function receiver() {
        order = order * 10 + 1;
        return { value: 7 };
      }
      function argument(value) {
        order = order * 10 + value;
        return value;
      }
      function target(a, b, c, d) {
        return this.value * 1000000 + arguments.length * 100000 +
          a * 10000 + b * 1000 + c * 100 + d * 10 + order;
      }
      export function run() {
        return target.call(receiver(), argument(2), argument(3), argument(4), argument(5));
      }
      `,
      "issue-3796-order-and-arity.mjs",
    );

    // receiver → arg2 → arg3 → arg4 → arg5; target sees all four user args.
    expect((instance.exports.run as () => number)()).toBe(7_435_795);
  });

  it("restores the outer receiver after nested and re-entrant named calls", async () => {
    const { instance } = await compileStandalone(
      `
      function recurse(depth) {
        var own = this.value;
        if (depth === 0) return own;
        var inner = recurse.call({ value: own + 1 }, depth - 1);
        return inner + this.value;
      }
      export function run() {
        return recurse.call({ value: 10 }, 2);
      }
      `,
      "issue-3796-reentrant.mjs",
    );

    expect((instance.exports.run as () => number)()).toBe(33);
  });

  it("restores the outer receiver when the exact target throws", async () => {
    const { result, instance } = await compileStandalone(
      `
      function throwFromReceiver() {
        if (this.fail) throw 7;
        return 0;
      }
      function outer() {
        try {
          throwFromReceiver.call({ fail: true });
        } catch (error) {
          return this.value;
        }
        return -1;
      }
      export function run() {
        return outer.call({ value: 42 });
      }
      `,
      "issue-3796-throw-restore.mjs",
    );

    expect((instance.exports.run as () => number)()).toBe(42);
    expect(result.wat).toContain("$__named_this_call_throwFromReceiver_");
    expect(result.wat).toContain("catch_all");
    expect(result.wat).toContain("rethrow 0");
  });

  it("executes Acorn's finishNodeAt locations/ranges wrapper shape", async () => {
    const { result, instance } = await compileStandalone(
      `
      function finishNodeAt(node, type, pos, loc) {
        node.type = type;
        node.end = pos;
        if (this.options.locations) node.loc.end = loc;
        if (this.options.ranges) node.range[1] = pos;
        return node;
      }
      function wrapper(node, type, pos, loc) {
        return finishNodeAt.call(this, node, type, pos, loc);
      }
      export function run() {
        var parser = { options: { locations: true, ranges: true } };
        var node = { type: 0, end: 0, loc: { end: 0 }, range: [1, 0] };
        var out = wrapper.call(parser, node, 9, 17, 23);
        return out.type * 1000000 + out.end * 10000 + out.loc.end * 100 + out.range[1];
      }
      `,
      "issue-3796-acorn-finish-node-at.mjs",
    );

    expect((instance.exports.run as () => number)()).toBe(9_172_317);
    expect(result.wat).toContain("$__named_this_call_finishNodeAt_");
    expect(result.wat).toContain("$__named_this_call_wrapper_");
  });

  it("keeps unstable identity, over-arity, and unsupported call shapes off the trampoline", async () => {
    const source = `
      function readsThis(value) { return this.value + value; }
      function ignoresThis(value) { return value; }
      var alias = readsThis;
      var closure = function closure(value) { return this.value + value; };
      function mutableTarget(value) {
        if (value < 0) return this.value;
        return value + 1;
      }
      function shadowedTarget(value) {
        return this.value + 1000;
      }
      var extraOrder = 0;
      function extraArgument() {
        extraOrder = 5;
        return 7;
      }
      function overArityTarget(value) {
        if (value < 0) return this.value;
        return arguments.length * 1000 + arguments[1] * 10 + value + extraOrder;
      }
      export function nullReceiver() { return readsThis.call(null, 1); }
      export function applyReceiver() { return readsThis.apply({ value: 2 }, [1]); }
      export function aliasReceiver() { return alias.call({ value: 3 }, 1); }
      export function closureReceiver() { return closure.call({ value: 4 }, 1); }
      export function ignoredReceiver() { return ignoresThis.call({ value: 5 }, 1); }
      export function reassignedBeforeWrite() {
        var result = mutableTarget.call({ value: 99 }, 41);
        mutableTarget = function replacement(value) { return value + 100; };
        return result;
      }
      export function nestedDeclaration() {
        function nestedTarget(value) {
          if (value < 0) return this.value;
          return value + 1;
        }
        return nestedTarget.call({ value: 99 }, 41);
      }
      export function sameNameShadow() {
        function shadowedTarget(value) {
          if (value < 0) return this.value;
          return value + 1;
        }
        shadowedTarget.call({ value: 99 }, 41);
        return 42;
      }
      export function overArity() {
        return overArityTarget.call({ value: 99 }, 41, extraArgument());
      }
    `;
    const { result, instance } = await compileStandalone(source, "issue-3796-negatives.mjs");

    expect(result.wat).not.toContain("$__named_this_call_readsThis_");
    expect(result.wat).not.toContain("$__named_this_call_ignoresThis_");
    expect(result.wat).not.toContain("$__named_this_call_closure_");
    expect(result.wat).not.toContain("$__named_this_call_mutableTarget_");
    expect(result.wat).not.toContain("$__named_this_call_nestedTarget_");
    expect(result.wat).not.toContain("$__named_this_call_shadowedTarget_");
    expect(result.wat).not.toContain("$__named_this_call_overArityTarget_");
    expect((instance.exports.reassignedBeforeWrite as () => number)()).toBe(42);
    expect((instance.exports.nestedDeclaration as () => number)()).toBe(42);
    expect((instance.exports.sameNameShadow as () => number)()).toBe(42);
    expect((instance.exports.overArity as () => number)()).toBe(2116);
  });

  it("has the same runtime behavior with IR-first enabled and disabled", async () => {
    const source = `
      function target(a, b) {
        return this.base + a * 10 + b;
      }
      export function run() {
        return target.call({ base: 100 }, 2, 3);
      }
    `;
    const observed: number[] = [];
    for (const irFirst of ["0", "1"]) {
      vi.stubEnv("JS2WASM_IR_FIRST", irFirst);
      const { instance } = await compileStandalone(source, `issue-3796-ir-${irFirst}.mjs`);
      observed.push((instance.exports.run as () => number)());
      vi.unstubAllEnvs();
    }
    expect(observed).toEqual([123, 123]);
  });
});
