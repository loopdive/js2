import { describe, expect, it } from "vitest";
import { buildImports, compile, instantiateWasm } from "../src/index.js";

/**
 * The import guard uses fixed-arity wrappers for compiler-produced manifests.
 * Keep a host method whose result depends on its receiver so the wrapper cannot
 * accidentally replace the explicit `self` argument with the wrapper's JS
 * `this` value.
 */
class StatefulElement {
  readonly base = 41;

  read(): number {
    return this.base + 1;
  }
}

class StatefulDocument {
  createElement(_tag: string): StatefulElement {
    return new StatefulElement();
  }
}

describe("fixed-arity host import wrappers", () => {
  it("preserves extern-class method receiver binding", async () => {
    const result = await compile(`
      declare class Document {
        createElement(tag: string): Element;
      }
      declare class Element {
        read(): number;
      }
      declare const document: Document;

      export function test(): number {
        return document.createElement("div").read();
      }
    `);

    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(WebAssembly.validate(result.binary)).toBe(true);

    const doc = new StatefulDocument();
    const imports = buildImports(
      result.imports,
      { Document: StatefulDocument, Element: StatefulElement, document: doc },
      result.stringPool,
    );
    const { instance } = await instantiateWasm(result.binary, imports.env, imports.string_constants);
    imports.setInstance?.(instance);
    expect((instance.exports as { test: () => number }).test()).toBe(42);
  });
});
