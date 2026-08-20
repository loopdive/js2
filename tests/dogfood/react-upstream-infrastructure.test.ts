import { describe, expect, it } from "vitest";

// @ts-expect-error — .mjs dogfood infrastructure has no declaration file
import { installReactUpstreamInfrastructure } from "./react-upstream-infrastructure.mjs";
// @ts-expect-error — .mjs dogfood environment has no declaration file
import { installReactTestEnvironment } from "./react-test-environment.mjs";

describe("React upstream test infrastructure", () => {
  it("provides every cross-package host dependency used by the suites", () => {
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
      expect(infrastructure.webStreams?.ReadableStream).toBeTypeOf("function");
      expect(infrastructure.reactNoop?.render).toBeTypeOf("function");
      expect(infrastructure.reactNoop?.createRoot).toBeTypeOf("function");
      expect(infrastructure.internalTestUtils?.act).toBeTypeOf("function");
      expect(infrastructure.reactNativeRenderer?.version).toBe(infrastructure.react?.version);
      expect(infrastructure.reactJsxRuntime?.jsx).toBeTypeOf("function");
      expect(globalThis.HTMLAnchorElement).toBeTypeOf("function");
      expect(globalThis.HTMLFieldSetElement).toBeTypeOf("function");
      expect(globalThis.HTMLLabelElement).toBeTypeOf("function");
      expect(globalThis.HTMLSpanElement).toBeTypeOf("function");
      expect(globalThis.ElementInternals).toBeTypeOf("function");
      expect(globalThis.ProgressEvent).toBeTypeOf("function");
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
    } finally {
      installed.cleanup();
      dom.cleanup();
      if (previousNodeEnv === undefined) Reflect.deleteProperty(process.env, "NODE_ENV");
      else process.env.NODE_ENV = previousNodeEnv;
    }
    expect(globalThis.__js2ReactUpstreamInfrastructure).toBe(previous);
  });
});
