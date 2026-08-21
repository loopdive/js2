import { describe, expect, it } from "vitest";
import { compile } from "../../src/index";
import { wrapExports } from "../../src/runtime";

// @ts-expect-error — .mjs dogfood environment has no declaration file
import { installReactTestEnvironment } from "./react-test-environment.mjs";
// @ts-expect-error — .mjs dogfood infrastructure has no declaration file
import { installReactUpstreamInfrastructure } from "./react-upstream-infrastructure.mjs";
// @ts-expect-error — .mjs dogfood shim has no declaration file
import { REACT_EXPECT_SHIM } from "./react-upstream-shim.mjs";

describe("React upstream test infrastructure", () => {
  it("provides every cross-package host dependency used by the suites", async () => {
    const previous = globalThis.__js2ReactUpstreamInfrastructure;
    const previousNodeEnv = process.env.NODE_ENV;
    process.env.NODE_ENV = "production";
    const dom = installReactTestEnvironment();
    const installed = installReactUpstreamInfrastructure();
    try {
      const { infrastructure } = installed;
      expect(infrastructure.react).toBeDefined();
      expect(infrastructure.reactDomClient?.createRoot).toBeTypeOf("function");
      expect(infrastructure.reactDom?.flushSync).toBeTypeOf("function");
      expect(infrastructure.reactDomServer?.renderToString).toBeTypeOf("function");
      expect(infrastructure.reactTestRenderer?.create).toBeTypeOf("function");
      expect(infrastructure.propTypes?.string).toBeTypeOf("function");
      expect(infrastructure.createReactClass).toBeTypeOf("function");
      expect(infrastructure.createReactClassFactory).toBeTypeOf("function");
      expect(infrastructure.webStreams?.ReadableStream).toBeTypeOf("function");
      expect(infrastructure.reactNoop?.render).toBeTypeOf("function");
      expect(infrastructure.reactNoop?.createRoot).toBeTypeOf("function");
      expect(infrastructure.internalTestUtils?.act).toBeTypeOf("function");
      expect(infrastructure.reactNativeRenderer?.version).toBe(infrastructure.react?.version);
      expect(infrastructure.reactJsxRuntime?.jsx).toBeTypeOf("function");
      expect(infrastructure.require("scheduler").unstable_now).toBeTypeOf("function");
      expect(globalThis.HTMLAnchorElement).toBeTypeOf("function");
      expect(globalThis.HTMLFieldSetElement).toBeTypeOf("function");
      expect(globalThis.HTMLLinkElement).toBeTypeOf("function");
      expect(globalThis.HTMLImageElement).toBeTypeOf("function");
      expect(globalThis.HTMLSourceElement).toBeTypeOf("function");
      expect(globalThis.HTMLTableColElement).toBeTypeOf("function");
      expect(globalThis.HTMLTableElement).toBeTypeOf("function");
      expect(globalThis.HTMLLabelElement).toBeTypeOf("function");
      expect(globalThis.HTMLSpanElement).toBeTypeOf("function");
      expect(globalThis.Document).toBeTypeOf("function");
      expect(globalThis.ElementInternals).toBeTypeOf("function");
      expect(globalThis.CSSStyleDeclaration).toBeTypeOf("function");
      expect(globalThis.ErrorEvent).toBeTypeOf("function");
      expect(globalThis.ProgressEvent).toBeTypeOf("function");
      expect(globalThis.PointerEvent).toBeTypeOf("function");
      expect(globalThis.TouchEvent).toBeTypeOf("function");
      expect(globalThis.TextEncoder).toBeTypeOf("function");
      expect(globalThis.ReadableStream).toBeTypeOf("function");
      expect(globalThis.FormData).toBeTypeOf("function");
      console.error("warning from %s", "React");
      expect(infrastructure.consumeConsole("error")).toEqual(["warning from React"]);
      infrastructure.errors.push("render component at stack");
      expect(() => infrastructure.internalTestUtils.assertConsoleErrorDev("render **")).not.toThrow();
      const passThrough = infrastructure.createPassThrough();
      expect(passThrough).toBeDefined();
      expect(passThrough.setEncoding).toBeTypeOf("function");
      passThrough.destroy();
      const root = infrastructure.reactNoop.createRoot();
      root.render(infrastructure.react.createElement("div", null, "ok"));
      expect(root.getChildren()).toHaveLength(1);
      root.unmount();
      expect(globalThis.__js2ReactUpstreamInfrastructure).toBe(infrastructure);

      // ReactDOM's Fizz tests import these private monorepo helpers. They are
      // host DOM infrastructure, so exercise the same facade used by the
      // generated native/Wasm test source instead of leaving the extractor
      // special case untested.
      // eslint-disable-next-line no-new-func
      const fizzUtils = new Function(`${REACT_EXPECT_SHIM}\nreturn __js2FizzTestUtils;`)();
      expect(fizzUtils.mergeOptions({ a: 2 }, { a: 1, b: 3 })).toEqual({ a: 2, b: 3 });
      const source = document.createElement("div");
      source.innerHTML = '<span id="fizz">ok</span>';
      const target = document.createElement("div");
      await fizzUtils.insertNodesAndExecuteScripts(source, target, null);
      expect(source.firstChild).toBeNull();
      expect(fizzUtils.getVisibleChildren(target).props.children).toBe("ok");
      expect(fizzUtils.stripExternalRuntimeInNodes([target.firstChild], "missing.js")).toHaveLength(1);

      const intersection = infrastructure.intersectionMocks;
      const observerState = intersection.mockIntersectionObserver();
      let intersectionCount = 0;
      const observer = new globalThis.IntersectionObserver((entries: unknown[]) => {
        intersectionCount = entries.length;
      });
      const observed = document.createElement("div");
      observer.observe(observed);
      intersection.simulateIntersection([observed, { x: 1, y: 2, width: 3, height: 4 }, 1]);
      expect(observerState.observedTargets).toHaveLength(1);
      expect(intersectionCount).toBe(1);
      const rectTarget = document.createElement("div");
      intersection.setClientRects(rectTarget, [{ x: 2, y: 3, width: 4, height: 5 }]);
      expect(rectTarget.getClientRects()[0].left).toBe(2);
    } finally {
      installed.cleanup();
      dom.cleanup();
      if (previousNodeEnv === undefined) Reflect.deleteProperty(process.env, "NODE_ENV");
      else process.env.NODE_ENV = previousNodeEnv;
    }
    expect(globalThis.__js2ReactUpstreamInfrastructure).toBe(previous);
  });

  it("can pair the development React artifact with development peer renderers", () => {
    const previousNodeEnv = process.env.NODE_ENV;
    process.env.NODE_ENV = "development";
    const installed = installReactUpstreamInfrastructure({ build: "development" });
    try {
      expect(installed.infrastructure.reactDomClient?.createRoot).toBeTypeOf("function");
      expect(installed.infrastructure.reactTestRenderer?.version).toBe(installed.infrastructure.react?.version);
      expect(installed.infrastructure.require("scheduler/unstable_mock").unstable_flushAll).toBeTypeOf("function");
    } finally {
      installed.cleanup();
      if (previousNodeEnv === undefined) Reflect.deleteProperty(process.env, "NODE_ENV");
      else process.env.NODE_ENV = previousNodeEnv;
    }
  });

  it("provides scoped Jest module isolation to Node and compiled Wasm", async () => {
    const previousNodeEnv = process.env.NODE_ENV;
    process.env.NODE_ENV = "production";
    const dom = installReactTestEnvironment();
    const installed = installReactUpstreamInfrastructure();
    const body = `
function checkIsolatedModules() {
  var first;
  var second;
  var stable;
  var mocks = require("./utils/IntersectionMocks");
  var nodeTypes = require("react-dom-bindings/src/client/HTMLNodeType");
  var target = document.createElement("div");
  var observerState = mocks.mockIntersectionObserver();
  var observer = new window.IntersectionObserver(function () {});
  observer.observe(target);
  jest.isolateModules(function () { first = require("react-dom/client"); });
  jest.isolateModules(function () { second = require("react-dom/client"); });
  stable = require("react-dom/client");
  return first !== second && first !== stable && second !== stable && stable === require("react-dom/client") &&
    observerState.observedTargets.length === 1 && nodeTypes.COMMENT_NODE === 8 &&
    __VARIANT__ === false && __EXPERIMENTAL__ === false ? 1 : 0;
}`;
    try {
      // The native oracle uses the same shim source as the compiled test.
      // eslint-disable-next-line no-new-func
      const native = new Function(`${REACT_EXPECT_SHIM}\n${body}\nreturn checkIsolatedModules;`)();
      expect(native()).toBe(1);

      const result = await compile(`${REACT_EXPECT_SHIM}\n${body}\nexport { checkIsolatedModules };`, {
        fileName: "react-upstream-isolation.js",
        skipSemanticDiagnostics: true,
      });
      expect(result.success).toBe(true);
      if (!result.success || !result.binary) return;
      const imports = result.importObject ?? {};
      const { instance } = await WebAssembly.instantiate(result.binary, imports);
      imports.__setExports?.(instance.exports);
      imports.__setInstance?.(instance);
      const compiled = wrapExports(instance.exports, { signatures: result.exportSignatures });
      expect(compiled.checkIsolatedModules()).toBe(1);
    } finally {
      installed.cleanup();
      dom.cleanup();
      if (previousNodeEnv === undefined) Reflect.deleteProperty(process.env, "NODE_ENV");
      else process.env.NODE_ENV = previousNodeEnv;
    }
  }, 90_000);
});
