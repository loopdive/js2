// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// Two npm-compat regressions caught by the dashboard, not by any unit test:
//
// 1. acorn's official suite fell from 3518/3518 to 3/3518 ("curPosition is not
//    a function"). `Parser.parse = function (input) { return new this(input) }`
//    is dispatched through the host once `Parser` (a closure with user static
//    props) crosses the boundary as its callable mirror; `new this(...)` then
//    registered the MIRROR as the instance's constructor, so the prototype
//    lookup never found `Parser.prototype.m`.
//
// 2. React's upstream shim stopped validating ("type error in fallthru[0]"):
//    a lift-time transitive-capture promotion run by an earlier sibling moved
//    `initModules` to a module global, so the later real lift of
//    `testMarkupMatch` dropped it from its signature while the already-compiled
//    `expectMarkupMatch` call site still prepended the pre-registered capture.

import { describe, expect, it } from "vitest";
import { compile } from "../src/index.js";
import { wrapExports } from "../src/runtime.js";

async function compileAndInstantiate(source: string) {
  const result = await compile(source, { fileName: "m.js", skipSemanticDiagnostics: true });
  expect(result.success, result.errors?.map((e) => e.message).join("\n")).toBe(true);
  await WebAssembly.compile(result.binary!);
  const importObject = result.importObject ?? {};
  const { instance } = await WebAssembly.instantiate(result.binary!, importObject);
  importObject.__setInstance?.(instance);
  return wrapExports(instance, { signatures: result.exportSignatures }) as Record<string, (...a: unknown[]) => unknown>;
}

describe("npm-compat regressions — acorn `new this` prototype link, React lift ABI", () => {
  it("`new this(...)` in a host-dispatched static keeps `F.prototype` methods (acorn Parser.parse)", async () => {
    const exp = await compileAndInstantiate(`
      var Parser = function Parser(input) { this.input = input; this.x = this.curPosition(); };
      Parser.prototype.curPosition = function () { return 1 };
      Parser.parse = function parse(input) { return new this(input).x };
      Parser.check = function check(input) {
        var p = new this(input);
        return Object.getPrototypeOf(p) === Parser.prototype && typeof p.curPosition === "function";
      };
      export function parse(input) { return Parser.parse(input) }
      export function check(input) { return Parser.check(input) }
    `);
    expect(exp.parse!("abc")).toBe(1);
    expect(exp.check!("abc")).toBeTruthy();
  });

  it("a re-lifted sibling keeps its pre-registered capture ABI after a transitive promotion", async () => {
    // Shape of React's ReactDOMServerIntegrationTestUtils shim: `itRenders`
    // reifies sibling function VALUES and promotes `initModules`; the later
    // `expectMarkupMatch` → `testMarkupMatch` call must still type-check.
    const exp = await compileAndInstantiate(`
      function makeUtils(initModules) {
        var A;
        var B;
        function resetModules() {
          var modules = initModules();
          A = modules.A;
          B = modules.B;
        }
        function renderIntoDom(element, flag) {
          return A(element) + (flag ? 1 : 0);
        }
        async function serverRender(element) {
          resetModules();
          return B(element);
        }
        async function clientCleanRender(element) {
          resetModules();
          return renderIntoDom(element, false);
        }
        function itRenders(desc, testFn) {
          return testFn(serverRender) + testFn(clientCleanRender) + desc.length;
        }
        function expectMarkupMatch(serverElement, clientElement) {
          return testMarkupMatch(serverElement, clientElement, true);
        }
        async function testMarkupMatch(serverElement, clientElement, shouldMatch) {
          var domElement = await serverRender(serverElement);
          resetModules();
          return renderIntoDom(clientElement, shouldMatch) + domElement;
        }
        return { itRenders: itRenders, expectMarkupMatch: expectMarkupMatch };
      }
      export function run() {
        var utils = makeUtils(function () {
          return { A: function (x) { return x * 2; }, B: function (x) { return x + 1; } };
        });
        return utils.expectMarkupMatch(3, 4);
      }
    `);
    // renderIntoDom(4, true) + await serverRender(3) = (8 + 1) + 4
    await expect(exp.run!()).resolves.toBe(13);
  });
});
