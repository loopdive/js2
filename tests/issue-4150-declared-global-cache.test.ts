// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #4150 P4 — ambient globals such as `document` are resolved by a zero-arg
// host import. The runtime binds that import to one value for the lifetime of
// the instance, so repeated reads must reuse a module-global cache instead of
// crossing the Wasm/JS boundary on every loop iteration.

import { describe, expect, it } from "vitest";
import { buildImports, compile, compileMulti, instantiateWasm } from "../src/index.js";

const SOURCE = `
declare class Document {
  createElement(tag: string): Element;
}
declare class Element {
  setAttribute(name: string, value: string): void;
}
declare const document: Document;

export function create(count: number): number {
  for (let i = 0; i < count; i++) {
    const el = document.createElement("div");
    el.setAttribute("id", "test");
  }
  return count;
}

export function identity(): Document {
  return document;
}
`;

class MockElement {
  setAttribute(_name: string, _value: string): void {}
}

class MockDocument {
  createElement(_tag: string): MockElement {
    return new MockElement();
  }
}

async function instanceWithResolver(
  experimentalIR: boolean,
  value: MockDocument | null,
  resolve: (value: MockDocument | null) => MockDocument | null,
  multi = false,
) {
  const result = multi
    ? await compileMulti({ "t.ts": SOURCE }, "t.ts", { experimentalIR, emitWat: true, optimize: 0 })
    : await compile(SOURCE, { fileName: "t.ts", experimentalIR, emitWat: true, optimize: 0 });
  expect(result.success, result.success ? undefined : result.errors[0]?.message).toBe(true);
  const imports = buildImports(
    result.imports,
    { document: value, Document: MockDocument, Element: MockElement },
    result.stringPool,
  );
  let resolutions = 0;
  imports.env.global_document = () => {
    resolutions++;
    return resolve(value);
  };
  const { instance } = await instantiateWasm(result.binary, imports.env, imports.string_constants);
  imports.setInstance?.(instance);
  return {
    exports: instance.exports as unknown as {
      create(count: number): number;
      identity(): MockDocument | null;
    },
    result,
    resolutions: () => resolutions,
  };
}

describe("#4150 — declared-global module cache", () => {
  it.each([false, true])("resolves document once across loops and exports (IR=%s)", async (experimentalIR) => {
    const document = new MockDocument();
    const probe = await instanceWithResolver(experimentalIR, document, (value) => value);

    expect(probe.exports.create(8)).toBe(8);
    expect(probe.exports.identity()).toBe(document);
    expect(probe.exports.create(3)).toBe(3);
    expect(probe.resolutions()).toBe(1);
    expect(probe.result.wat).toContain("$__declared_global_document");
    expect(probe.result.wat).toContain("$__declared_global_document_ready");
  });

  it("caches null using the ready bit instead of treating it as a miss", async () => {
    const probe = await instanceWithResolver(true, null, (value) => value);

    expect(probe.exports.identity()).toBeNull();
    expect(probe.exports.identity()).toBeNull();
    expect(probe.resolutions()).toBe(1);
  });

  it("applies the same module-wide cache to compileMulti", async () => {
    const document = new MockDocument();
    const probe = await instanceWithResolver(true, document, (value) => value, true);

    expect(probe.exports.create(5)).toBe(5);
    expect(probe.exports.identity()).toBe(document);
    expect(probe.resolutions()).toBe(1);
  });

  it("retries after a resolver exception and caches only a successful result", async () => {
    const document = new MockDocument();
    let fail = true;
    const probe = await instanceWithResolver(true, document, (value) => {
      if (fail) {
        fail = false;
        throw new Error("resolver probe");
      }
      return value;
    });

    expect(() => probe.exports.identity()).toThrow("resolver probe");
    expect(probe.resolutions()).toBe(1);
    expect(probe.exports.identity()).toBe(document);
    expect(probe.exports.identity()).toBe(document);
    expect(probe.resolutions()).toBe(2);
  });
});
