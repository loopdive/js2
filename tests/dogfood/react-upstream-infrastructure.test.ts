import { describe, expect, it } from "vitest";

// @ts-expect-error — .mjs dogfood infrastructure has no declaration file
import { installReactUpstreamInfrastructure } from "./react-upstream-infrastructure.mjs";

describe("React upstream test infrastructure", () => {
  it("provides every cross-package host dependency used by the suites", () => {
    const previous = globalThis.__js2ReactUpstreamInfrastructure;
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
      const passThrough = infrastructure.createPassThrough();
      expect(passThrough).toBeDefined();
      expect(passThrough.setEncoding).toBeTypeOf("function");
      passThrough.destroy();
      expect(globalThis.__js2ReactUpstreamInfrastructure).toBe(infrastructure);
    } finally {
      installed.cleanup();
    }
    expect(globalThis.__js2ReactUpstreamInfrastructure).toBe(previous);
  });
});
