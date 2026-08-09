// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #3903 — the host-call lane's per-crossing shims were rewritten for speed
// (hoisted per-call closures, pre-sized argument loops, arity-dispatched
// invocation instead of spread, a null-prototype fast reject in
// `_isWasmStruct`, and a prototype-lookup instead of `Object(first)` in the
// Symbol-dispatch reroute). None of that is allowed to move an observable.
//
// These tests pin the specific semantics each rewrite could plausibly have
// broken. They deliberately run in the DEFAULT (host-call) mode — the mode the
// rewrites live in — not `standalone`.
import { describe, expect, it } from "vitest";
import { compile } from "../src/index.js";
import { buildImports } from "../src/runtime.js";

async function run(source: string, fn = "test", deps?: Record<string, unknown>): Promise<unknown> {
  const result = await compile(source);
  if (!result.success) {
    throw new Error(`Compile failed:\n${result.errors.map((e) => `  L${e.line}: ${e.message}`).join("\n")}`);
  }
  const imports = buildImports(result.imports, deps, result.stringPool);
  const { instance } = await WebAssembly.instantiate(result.binary, imports);
  imports.setExports?.(instance.exports as Record<string, Function>);
  return (instance.exports as Record<string, (...a: unknown[]) => unknown>)[fn]!();
}

describe("#3903 host-call shim rewrite keeps string-method semantics", () => {
  it("keeps dynamic string receivers on the live prototype path", async () => {
    const original = String.prototype.indexOf;
    let receiver: unknown;
    String.prototype.indexOf = function (this: string, search: string): number {
      receiver = this;
      return search === "b" ? 42 : original.call(this, search);
    };
    try {
      expect(
        await run(`export function test(): number {
          const s: any = "abc";
          return s.indexOf("b");
        }`),
      ).toBe(42);
      expect(receiver).toBe("abc");
    } finally {
      String.prototype.indexOf = original;
    }
  });

  it("falls back to WasmGC argument coercion", async () => {
    expect(
      await run(`export function test(): number {
        const key = { toString(): string { return "b"; } };
        const s: any = "abc";
        return s.indexOf(key);
      }`),
    ).toBe(1);
  });

  // The arity switch replaced `recvStr[method](...args)`. Each arm has to stay
  // a *member call* on the receiver, so a real `this` still reaches the method.
  it("passes the receiver as `this` for a zero-arg method", async () => {
    expect(
      await run(`export function test(): string {
        const s = "   padded   ";
        return s.trim();
      }`),
    ).toBe("padded");
  });

  it("passes both immediates for a two-arg method", async () => {
    expect(
      await run(`export function test(): string {
        const s = "abcdefghijklmnopqrstuvwxyz";
        return s.substring(5, 20);
      }`),
    ).toBe("fghijklmnopqrst");
  });

  it("passes three arguments (the arity-switch arm past the common cases)", async () => {
    expect(
      await run(`export function test(): string {
        const s = "a-b-c-d";
        return s.replace("-", "+");
      }`),
    ).toBe("a+b-c-d");
  });

  // The NaN / -1 "argument was omitted" sentinels are stripped by the shim.
  // Precomputing `isSplit` / `usesNaNOmitSentinel` per import must not change
  // which methods strip and which do not.
  it("treats an omitted `position` on startsWith as 0, not ToInteger(NaN)", async () => {
    expect(
      await run(`export function test(): number {
        const s = "hello world";
        return s.startsWith("hello") ? 1 : 0;
      }`),
    ).toBe(1);
  });

  it("honours an EXPLICIT position on startsWith", async () => {
    expect(
      await run(`export function test(): number {
        const s = "hello world";
        return s.startsWith("world", 6) ? 1 : 0;
      }`),
    ).toBe(1);
  });

  it("keeps live prototype dispatch in the fixed-arity predicate adapter", async () => {
    const result = await compile(`export function test(s: string): number {
      return s.startsWith("world", 6) ? 1 : 0;
    }`);
    expect(result.success, result.errors.map((error) => error.message).join("; ")).toBe(true);

    const original = String.prototype.startsWith;
    let receiver: unknown;
    let argsLength = -1;
    String.prototype.startsWith = function (this: string, ...args: [search: string, position?: number]): boolean {
      receiver = this;
      argsLength = args.length;
      return args[0] === "world" && args[1] === 6;
    };
    try {
      const imports = buildImports(result.imports, undefined, result.stringPool);
      const { instance } = await WebAssembly.instantiate(result.binary, imports);
      imports.setExports?.(instance.exports as Record<string, Function>);
      expect((instance.exports.test as (value: string) => number)("hello world")).toBe(1);
      expect(receiver).toBe("hello world");
      expect(argsLength).toBe(2);
    } finally {
      String.prototype.startsWith = original;
    }
  });

  it("treats an omitted `endPosition` on endsWith as the length", async () => {
    expect(
      await run(`export function test(): number {
        const s = "hello world";
        return s.endsWith("world") ? 1 : 0;
      }`),
    ).toBe(1);
  });

  it("honours an EXPLICIT endPosition on endsWith", async () => {
    expect(
      await run(`export function test(): number {
        const s = "hello world";
        return s.endsWith("hello", 5) ? 1 : 0;
      }`),
    ).toBe(1);
  });

  it("treats an omitted `limit` on split as unlimited", async () => {
    expect(
      await run(`export function test(): number {
        const parts = "a,b,c,d".split(",");
        return parts.length;
      }`),
    ).toBe(4);
  });

  it("honours an EXPLICIT limit on split", async () => {
    expect(
      await run(`export function test(): number {
        const parts = "a,b,c,d".split(",", 2);
        return parts.length;
      }`),
    ).toBe(2);
  });

  it("does not strip a trailing NaN for a method with no omission sentinel", async () => {
    // `indexOf` is not in the sentinel set: ToInteger(NaN) = 0, so the search
    // starts at 0 and finds the first occurrence.
    expect(
      await run(`export function test(): number {
        const s = "abcabc";
        return s.indexOf("abc", NaN);
      }`),
    ).toBe(0);
  });

  // The pre-sized loop replaced `[wrapped, ...a.slice(1).map(...)]` on the
  // Symbol-dispatch branch. Arguments after the first must still be coerced.
  it("keeps later arguments on the Symbol-dispatch branch", async () => {
    expect(
      await run(`export function test(): number {
        const parts = "x1y1z1w".split("1", 3);
        return parts.length;
      }`),
    ).toBe(3);
  });

  it("still routes replace/split through the receiver's own method", async () => {
    expect(
      await run(`export function test(): string {
        return "one two three".replace("two", "2");
      }`),
    ).toBe("one 2 three");
  });
});

describe("#3903 _rerouteStringSymbolMethodPrimitive prototype lookup", () => {
  // The `Object(first)` wrapper allocation was replaced by a lookup on the
  // primitive's wrapper PROTOTYPE. Equivalent for a Symbol key, because a fresh
  // wrapper's own properties are only integer indices and `length`. Both the
  // "no override installed" and "override installed" branches must be
  // unchanged; #3095 covers the latter, and it is the one the rewrite touched.
  it("leaves a primitive separator alone when no Symbol.split override exists", async () => {
    expect(
      await run(`export function test(): number {
        return "a1b1c".split(1).length;
      }`),
    ).toBe(3);
  });

  it("suppresses the observable Symbol lookup when an override IS installed", async () => {
    // Per ECMA-262 the primitive search value's `Symbol.split` must NOT be
    // observably accessed — the reroute pre-builds the RegExp the spec's
    // not-an-Object branch would create, so the user's override never runs.
    const before = (Number.prototype as unknown as Record<symbol, unknown>)[Symbol.split];
    (Number.prototype as unknown as Record<symbol, unknown>)[Symbol.split] = () => ["OVERRIDE"];
    try {
      expect(
        await run(`export function test(): number {
          return "a1b1c".split(1).length;
        }`),
      ).toBe(3);
    } finally {
      if (before === undefined) delete (Number.prototype as unknown as Record<symbol, unknown>)[Symbol.split];
      else (Number.prototype as unknown as Record<symbol, unknown>)[Symbol.split] = before;
    }
  });
});

describe("#3903 _isWasmStruct null-prototype fast reject", () => {
  // The fast reject returns false for anything with a non-null [[Prototype]]
  // BEFORE consulting the verdict memo. A compiled object reaching a string
  // method still has to be ToPrimitive-coerced, which is what the predicate
  // gates.
  it("still ToPrimitive-coerces a compiled object argument", async () => {
    expect(
      await run(`export function test(): number {
        const key = { toString(): string { return "b"; } };
        return "abc".indexOf(key as any);
      }`),
    ).toBe(1);
  });

  it("still ToPrimitive-coerces a compiled object receiver", async () => {
    expect(
      await run(`export function test(): string {
        const o: any = { toString(): string { return "  spaced  "; } };
        return String.prototype.trim.call(o);
      }`),
    ).toBe("spaced");
  });

  it("does not misclassify a host array reaching __extern_length", async () => {
    expect(
      await run(`export function test(): number {
        const parts = "a,b,c".split(",");
        let n = 0;
        for (let i = 0; i < parts.length; i = i + 1) n = n + parts[i].length;
        return n;
      }`),
    ).toBe(3);
  });

  it("keeps a null-prototype host object classified as a plain object", async () => {
    expect(
      await run(`export function test(): number {
        const o: any = Object.create(null);
        o.length = 7;
        return o.length;
      }`),
    ).toBe(7);
  });
});

describe("#3903 extern_class method shim rewrite", () => {
  // The DOM lane's generic shim lost its per-call `args.some(closure)` and its
  // spread call. Argument order, count and struct-wrapping must be unchanged.
  class MockElement {
    tagName: string;
    attributes: Record<string, string> = {};
    children: MockElement[] = [];
    constructor(tag: string) {
      this.tagName = tag;
    }
    setAttribute(name: string, value: string): void {
      this.attributes[name] = value;
    }
    getAttribute(name: string): string {
      return this.attributes[name] ?? "";
    }
    appendChild(child: MockElement): void {
      this.children.push(child);
    }
    countChildren(): number {
      return this.children.length;
    }
  }
  class MockDocument {
    createElement(tag: string): MockElement {
      return new MockElement(tag);
    }
  }
  const DECL = `
declare class Document {
  createElement(tag: string): Element;
}
declare class Element {
  appendChild(child: Element): void;
  setAttribute(name: string, value: string): void;
  getAttribute(name: string): string;
  countChildren(): number;
}
declare const document: Document;
`;
  const deps = () => {
    const doc = new MockDocument();
    return { Document: MockDocument, Element: MockElement, document: doc };
  };

  it("passes a one-argument method through", async () => {
    expect(
      await run(
        `${DECL}
export function test(): number {
  const parent = document.createElement("div");
  parent.appendChild(document.createElement("span"));
  parent.appendChild(document.createElement("span"));
  return parent.countChildren();
}`,
        "test",
        deps(),
      ),
    ).toBe(2);
  });

  it("passes a two-argument method in the right order", async () => {
    expect(
      await run(
        `${DECL}
export function test(): string {
  const el = document.createElement("div");
  el.setAttribute("data-value", "kept");
  return el.getAttribute("data-value");
}`,
        "test",
        deps(),
      ),
    ).toBe("kept");
  });

  it("passes a zero-argument method through", async () => {
    expect(
      await run(
        `${DECL}
export function test(): number {
  return document.createElement("div").countChildren();
}`,
        "test",
        deps(),
      ),
    ).toBe(0);
  });
});
