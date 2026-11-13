// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #7091 — the IR claims and lowers host-extern (platform capability) calls
// under native strings in a JavaScript environment: the default `gc` build
// since the #6708 flip.
//
//   1. A DOM call with a string argument and a closure argument is IR-emitted
//      on the default profile and behaves exactly like the legacy body
//      against a stub `document` (the platform-arg marshal converts the
//      native-string / closure carriers).
//   2. A user `declare function` import with a string argument is IR-emitted
//      and crosses the same carrier legacy passes.
//   3. The lane stays narrow: `performance` (natively lowered in the regime)
//      and `console` keep their non-platform routes, and standalone / WASI
//      claim nothing new.

import { describe, expect, it } from "vitest";
import { compile, wrapCompiledExports } from "../src/index.js";
import { buildImports } from "../src/runtime.js";

interface StubElement {
  tag: unknown;
  textContent: unknown;
  style: Record<string, unknown>;
  children: StubElement[];
  handlers: Record<string, () => void>;
  appendChild(child: StubElement): StubElement;
  addEventListener(type: string, fn: () => void): void;
}

function stubElement(tag: unknown): StubElement {
  const el: StubElement = {
    tag,
    textContent: "",
    style: {},
    children: [],
    handlers: {},
    appendChild(child) {
      el.children.push(child);
      return child;
    },
    addEventListener(type, fn) {
      el.handlers[type] = fn;
    },
  };
  return el;
}

const DOM_SRC = `
export function mount(tag: string, label: string): void {
  const d = document.createElement(tag);
  d.textContent = label;
  d.addEventListener("click", () => {
    d.textContent = "clicked";
  });
  document.body.appendChild(d);
}
export function styled(tag: string, css: string): HTMLElement {
  const e = document.createElement(tag);
  e.style.cssText = css;
  return e;
}
`;

async function runDom(experimentalIR: boolean) {
  const result = await compile(DOM_SRC, { fileName: "t.ts", experimentalIR, trackIrOutcomes: true });
  expect(result.success, result.errors?.[0]?.message).toBe(true);
  const created: StubElement[] = [];
  const body = stubElement("body");
  const document = {
    body,
    createElement(tag: unknown) {
      const el = stubElement(tag);
      created.push(el);
      return el;
    },
  };
  const imports = buildImports(result.imports, { document }, result.stringPool);
  const { instance } = await WebAssembly.instantiate(result.binary, imports as WebAssembly.Imports);
  imports.setExports?.(instance.exports as Record<string, Function>);
  const exports = wrapCompiledExports(result as never, instance) as {
    mount(tag: string, label: string): void;
    styled(tag: string, css: string): unknown;
  };
  exports.mount("div", "hello");
  exports.styled("span", "color:red");
  for (const el of created) for (const handler of Object.values(el.handlers)) handler();
  return {
    result,
    observed: created.map((el) => ({
      tag: el.tag,
      text: el.textContent,
      css: el.style.cssText,
      events: Object.keys(el.handlers),
    })),
    bodyChildren: body.children.length,
  };
}

describe("#7091 IR platform externs under native strings", () => {
  it("IR-emits a DOM call with string + closure arguments and matches the legacy body", async () => {
    const ir = await runDom(true);
    const legacy = await runDom(false);
    expect(ir.result.irCompiledFuncs).toEqual(expect.arrayContaining(["mount", "styled"]));
    expect(ir.observed).toEqual([
      { tag: "div", text: "clicked", css: undefined, events: ["click"] },
      { tag: "span", text: "", css: "color:red", events: [] },
    ]);
    expect(ir.bodyChildren).toBe(1);
    expect(ir.observed).toEqual(legacy.observed);
    expect(ir.bodyChildren).toBe(legacy.bodyChildren);
    // Same platform-capability import surface as the legacy body.
    const names = ir.result.imports.map((descriptor) => descriptor.name);
    expect(names).toEqual(expect.arrayContaining(["global_document", "Document_createElement"]));
  });

  it("IR-emits a declared host function call with a string argument", async () => {
    const source = `
declare function hostTag(s: string): number;
export class Probe {
  tag(label: string): number {
    return hostTag(label + "!");
  }
}
export function run(): number {
  return new Probe().tag("a");
}
`;
    const outcomes: Record<string, string[]> = {};
    for (const experimentalIR of [true, false]) {
      const result = await compile(source, { fileName: "t.ts", experimentalIR, trackIrOutcomes: true });
      expect(result.success, result.errors?.[0]?.message).toBe(true);
      if (experimentalIR) {
        const row = result.irOutcomes?.find((outcome) => outcome.displayName === "Probe_tag");
        expect(row?.kind).toBe("emitted");
      }
      const seen: string[] = [];
      const imports = buildImports(
        result.imports,
        {
          hostTag(value: unknown) {
            seen.push(typeof value);
            return 7;
          },
        },
        result.stringPool,
      );
      const { instance } = await WebAssembly.instantiate(result.binary, imports as WebAssembly.Imports);
      imports.setExports?.(instance.exports as Record<string, Function>);
      const exports = wrapCompiledExports(result as never, instance) as { run(): number };
      expect(exports.run()).toBe(7);
      outcomes[String(experimentalIR)] = seen;
    }
    // The IR crosses exactly the carrier the legacy body passes.
    expect(outcomes.true).toEqual(outcomes.false);
  });

  it("keeps performance and console off the platform lane", async () => {
    const source = `
export function stamp(): number {
  return performance.now() >= 0 ? 1 : 0;
}
export function say(n: number): void {
  console.log("n=" + n.toString());
}
`;
    const result = await compile(source, { fileName: "t.ts", trackIrOutcomes: true });
    expect(result.success, result.errors?.[0]?.message).toBe(true);
    const stamp = result.irOutcomes?.find((outcome) => outcome.displayName === "stamp");
    expect(stamp?.kind).toBe("unsupported");
    expect(stamp && "code" in stamp ? stamp.code : undefined).toBe("host-surface-unavailable");
  });

  it("claims no DOM function on host-free targets", async () => {
    for (const target of ["standalone", "wasi"] as const) {
      const result = await compile(DOM_SRC, { fileName: "t.ts", target, trackIrOutcomes: true });
      expect(result.irCompiledFuncs ?? []).not.toContain("mount");
      expect(result.irCompiledFuncs ?? []).not.toContain("styled");
    }
  });
});
