// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #3522 Builtins externref-ABI retirement acceptance coverage.
//
// The four-function DOM component must seal once through IR, preserve the
// direct backend's observable behavior and typed-host ABI, retain the literal
// optimizations that used to live only in direct codegen, and never enter the
// ordinary direct function-body emitter.

import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import { buildImports } from "../src/runtime.js";
import { compile, type CompileResult, type ImportDescriptor, type IrObservedOutcome } from "../src/index.js";
import { pinPerfFlags } from "./helpers/pin-perf-flags.js";

// (#4157) "avoids generic dispatch and direct-body machinery" is asserted as an
// exact set of emitted function names. The IR inliner (default ON since the
// tuned-set flip) removes call edges and therefore members of that set, which
// this file would read as the retirement having failed. Pin it off — the
// retirement is a property of IR preparation, not of a later inline pass.
pinPerfFlags({ JS2WASM_IR_INLINE: "0" });

const SOURCE = readFileSync(new URL("../website/playground/examples/js/builtins.ts", import.meta.url), "utf8");

const TERMINALS = ["el", "crd", "rw", "main"] as const;

const BODY_CSS = "margin:0;background:#111;color:#ddd;font-family:system-ui,sans-serif;overflow-y:auto";
const WRAP_CSS = "padding:0.75rem";
const CARD_CSS =
  "padding:0.5rem 0.75rem;background:#1a1a35;border-radius:6px;border:1px solid #2a2a4a;margin-bottom:0.5rem";
const TITLE_CSS = "font-size:0.8rem;color:#7c3aed;font-weight:bold;margin-bottom:4px";
const ROW_CSS = "display:flex;justify-content:space-between;font-size:0.7rem;padding:1px 0";
const LABEL_CSS = "color:#888";
const VALUE_CSS = "color:#ddd;font-family:monospace";

const EXPECTED_CARDS = [
  [
    "Math",
    [
      ["Math.pow(2, 10)", "1024"],
      ["Math.sqrt(144)", "12"],
      ["Math.log2(1024)", "10.0"],
      ["Math.sin(3.14159/2)", "1.000000"],
      ["Math.cos(0)", "1"],
      ["Math.atan2(1, 1)", "0.785398"],
      ["Math.exp(1)", "2.718282"],
      ["Math.log(Math.exp(1))", "1.000000"],
    ],
  ],
  [
    "Strings",
    [
      ["length", "19"],
      ["toUpperCase()", "HELLO, WEBASSEMBLY!"],
      ["toLowerCase()", "hello, webassembly!"],
      ["slice(0, 5)", "Hello"],
      ["indexOf('Wasm')", "-1"],
      ["includes('Assembly')", "true"],
      ["replace('Hello','Hi')", "Hi, WebAssembly!"],
      ["trim('  hi  ')", "hi"],
    ],
  ],
  [
    "Arrays",
    [
      ["arr", "[10,20,30,40,50]"],
      ["arr.length", "5"],
      ["sum(arr)", "150"],
    ],
  ],
  [
    "Bitwise",
    [
      ["0xFF << 8", "65280"],
      ["0xABCD & 0xFF", "205"],
      ["0x55 | 0xAA", "255"],
      ["0xFF ^ 0x0F", "240"],
      ["~0", "-1"],
    ],
  ],
] as const;

const EXPECTED_DOM_IMPORTS = [
  ["global_document", 0],
  ["Document_createElement", 3],
  ["Document_get_body", 1],
  ["Element_set_innerHTML", 2],
  ["CSSStyleDeclaration_set_cssText", 2],
  ["HTMLElement_get_style", 1],
  ["Node_appendChild", 2],
  ["Element_set_textContent", 2],
] as const;

class FakeStyle {
  cssText = "";
}

class FakeElement {
  readonly style = new FakeStyle();
  readonly children: FakeElement[] = [];
  textContent = "";
  private html = "";

  constructor(readonly tagName: string) {}

  get innerHTML(): string {
    return this.html;
  }

  set innerHTML(value: string) {
    this.html = value;
    if (value === "") this.children.length = 0;
  }

  appendChild(child: FakeElement): FakeElement {
    this.children.push(child);
    return child;
  }
}

class FakeDocument {
  readonly body = new FakeElement("body");

  createElement(tagName: string): FakeElement {
    return new FakeElement(String(tagName));
  }
}

let irCompile: Promise<CompileResult> | undefined;
let directCompile: Promise<CompileResult> | undefined;

function compileBuiltins(experimentalIR: boolean): Promise<CompileResult> {
  const existing = experimentalIR ? irCompile : directCompile;
  if (existing) return existing;
  const started = compile(SOURCE, {
    fileName: "website/playground/examples/js/builtins.ts",
    experimentalIR,
    trackFallbacks: true,
    trackIrOutcomes: true,
    emitWat: true,
    target: "gc",
  });
  if (experimentalIR) irCompile = started;
  else directCompile = started;
  return started;
}

function outcome(result: CompileResult, name: string): IrObservedOutcome {
  const observed = (result.irOutcomes ?? []).filter(
    (candidate) => candidate.unitKind === "function" && candidate.displayName === name,
  );
  expect(observed, `terminal outcome count for ${name}`).toHaveLength(1);
  return observed[0]!;
}

async function render(result: CompileResult): Promise<FakeDocument> {
  expect(result.success, result.errors.map((error) => error.message).join("\n")).toBe(true);
  expect(WebAssembly.validate(result.binary)).toBe(true);

  const document = new FakeDocument();
  document.body.innerHTML = "<stale>";
  document.body.appendChild(new FakeElement("stale"));
  const imports = buildImports(result.imports, { document }, result.stringPool);
  const { instance } = await WebAssembly.instantiate(result.binary, {
    env: imports.env,
    "wasm:js-string": imports["wasm:js-string"],
    string_constants: imports.string_constants,
    string_constants16: imports.string_constants16,
  });
  imports.setInstance?.(instance);
  imports.setExports?.(instance.exports as Record<string, Function>);
  (instance.exports.main as () => void)();
  return document;
}

function expectElement(element: FakeElement, tagName: string, cssText: string, textContent: string): void {
  expect(element.tagName).toBe(tagName);
  expect(element.style.cssText).toBe(cssText);
  expect(element.textContent).toBe(textContent);
  expect(element.innerHTML).toBe("");
}

function expectRenderedOracle(document: FakeDocument): void {
  const body = document.body;
  expectElement(body, "body", BODY_CSS, "");
  expect(body.children).toHaveLength(1);

  const wrap = body.children[0]!;
  expectElement(wrap, "div", WRAP_CSS, "");
  expect(wrap.children).toHaveLength(EXPECTED_CARDS.length);

  for (const [cardIndex, [title, rows]] of EXPECTED_CARDS.entries()) {
    const card = wrap.children[cardIndex]!;
    expectElement(card, "div", CARD_CSS, "");
    expect(card.children).toHaveLength(rows.length + 1);

    const titleElement = card.children[0]!;
    expectElement(titleElement, "div", TITLE_CSS, title);
    expect(titleElement.children).toEqual([]);

    for (const [rowIndex, [label, value]] of rows.entries()) {
      const row = card.children[rowIndex + 1]!;
      expectElement(row, "div", ROW_CSS, "");
      expect(row.children).toHaveLength(2);

      const labelElement = row.children[0]!;
      expectElement(labelElement, "span", LABEL_CSS, label);
      expect(labelElement.children).toEqual([]);

      const valueElement = row.children[1]!;
      expectElement(valueElement, "span", VALUE_CSS, value);
      expect(valueElement.children).toEqual([]);
    }
  }
}

function typedDomImports(result: CompileResult): ImportDescriptor[] {
  const expectedNames = new Set(EXPECTED_DOM_IMPORTS.map(([name]) => name));
  return result.imports
    .filter((entry) => expectedNames.has(entry.name as (typeof EXPECTED_DOM_IMPORTS)[number][0]))
    .sort((left, right) => left.name.localeCompare(right.name));
}

function watFunctionBody(wat: string, name: string): string {
  const start = wat.indexOf(`  (func $${name}`);
  expect(start, `missing $${name}`).toBeGreaterThanOrEqual(0);
  const next = wat.indexOf("\n  (func $", start + 1);
  return wat.slice(start, next < 0 ? wat.length : next);
}

function watCallTargets(wat: string, body: string): string[] {
  const imports = [...wat.matchAll(/^\s*\(import .+ \(func(?: \$([^\s(]+))?/gm)].map(
    (match) => match[1] ?? "<anonymous-import>",
  );
  const definitions = [...wat.matchAll(/^\s*\(func \$([^\s(]+)/gm)].map((match) => match[1]!);
  const names = [...imports, ...definitions];
  return [...body.matchAll(/\b(?:return_)?call (\d+)/g)].map((match) => names[Number(match[1])] ?? "<missing>");
}

function watGlobalIndex(wat: string, name: string): number | undefined {
  const imports = [...wat.matchAll(/^\s*\(import .+ \(global(?: \$([^\s(]+))?/gm)].map(
    (match) => match[1] ?? "<anonymous-import>",
  );
  const globals = [...wat.matchAll(/^\s*\(global \$([^\s(]+)/gm)].map((match) => match[1]!);
  const index = [...imports, ...globals].indexOf(name);
  return index < 0 ? undefined : index;
}

describe("#3522 Builtins externref-ABI retirement", () => {
  it("renders the complete Builtins value tree identically through the IR and direct lanes", async () => {
    const ir = await compileBuiltins(true);
    const direct = await compileBuiltins(false);
    const irDocument = await render(ir);
    const directDocument = await render(direct);

    expectRenderedOracle(irDocument);
    expectRenderedOracle(directDocument);
    expect(irDocument).toEqual(directDocument);
    expect(ir.irPostClaimErrors ?? []).toEqual([]);
  });

  it("keeps the typed-DOM ABI while avoiding generic dispatch and direct-body machinery", async () => {
    const ir = await compileBuiltins(true);
    const direct = await compileBuiltins(false);
    const irDomImports = typedDomImports(ir);
    const directDomImports = typedDomImports(direct);

    expect(irDomImports).toEqual(directDomImports);
    expect(irDomImports.map(({ name, paramCount }) => [name, paramCount]).sort()).toEqual(
      [...EXPECTED_DOM_IMPORTS].sort(),
    );
    for (const { name } of irDomImports) {
      expect(ir.wat).toContain(`(import "env" "${name}"`);
      expect(direct.wat).toContain(`(import "env" "${name}"`);
    }

    const elTargets = watCallTargets(ir.wat, watFunctionBody(ir.wat, "el"));
    expect(elTargets).toEqual(
      expect.arrayContaining([
        "global_document_import",
        "Document_createElement_import",
        "HTMLElement_get_style_import",
        "CSSStyleDeclaration_set_cssText_import",
      ]),
    );
    const mainTargets = watCallTargets(ir.wat, watFunctionBody(ir.wat, "main"));
    expect(mainTargets).toEqual(
      expect.arrayContaining([
        "global_document_import",
        "Document_get_body_import",
        "Element_set_innerHTML_import",
        "HTMLElement_get_style_import",
        "CSSStyleDeclaration_set_cssText_import",
        "el",
        "crd",
        "rw",
        "Node_appendChild_import",
      ]),
    );

    for (const name of TERMINALS) {
      const body = watFunctionBody(ir.wat, name);
      const targets = watCallTargets(ir.wat, body);
      expect(body).not.toMatch(/\b(?:call_ref|call_indirect)\b/);
      expect(body).not.toMatch(/__current_this|__argc|__arguments/);
      for (const globalName of ["__current_this", "__argc", "__arguments"] as const) {
        const globalIndex = watGlobalIndex(ir.wat, globalName);
        if (globalIndex !== undefined) {
          expect(body).not.toMatch(new RegExp(`\\bglobal\\.(?:get|set) ${globalIndex}\\b`));
        }
      }
      expect(targets).not.toEqual(
        expect.arrayContaining([expect.stringMatching(/__extern_(?:get|set|call|method_call|new)/)]),
      );
      expect(targets).not.toEqual(
        expect.arrayContaining([expect.stringMatching(/(?:^|_)(?:box|unbox|argc|arguments)(?:_|$)/)]),
      );
    }
  });

  it("seals el/crd/rw/main as one IR-only component with no legacy bodies", async () => {
    const result = await compileBuiltins(true);
    expect(result.irCompiledFuncs ?? []).toEqual(expect.arrayContaining([...TERMINALS]));
    const componentIds = new Set<string>();
    for (const name of TERMINALS) {
      const terminal = outcome(result, name);
      expect(terminal).toMatchObject({
        kind: "emitted",
        legacyBodyEmitted: false,
        irBodyEmitted: true,
        preparedComponentId: expect.stringMatching(/^prepared-component:/),
      });
      componentIds.add(terminal.preparedComponentId!);
    }
    expect(componentIds.size).toBe(1);
    expect(result.irPostClaimErrors ?? []).toEqual([]);
  });

  it("proves the sealed component never enters the ordinary direct function-body emitter", async () => {
    const previous = process.env.JS2WASM_TEST_POISON_DIRECT_FUNCTION_BODY;
    const controlName = "issue3522OrdinaryDirectPoisonControl";
    try {
      process.env.JS2WASM_TEST_POISON_DIRECT_FUNCTION_BODY = TERMINALS.join(",");
      // Deliberately bypass compileBuiltins(): this must execute a fresh compile
      // while the poison is live, not reuse the cached acceptance artifact.
      const retired = await compile(SOURCE, {
        fileName: "website/playground/examples/js/builtins-poisoned.ts",
        experimentalIR: true,
        trackFallbacks: true,
        trackIrOutcomes: true,
        target: "gc",
      });
      expect(retired.success, retired.errors.map((error) => error.message).join("\n")).toBe(true);
      for (const name of TERMINALS) {
        expect(outcome(retired, name)).toMatchObject({
          kind: "emitted",
          legacyBodyEmitted: false,
          irBodyEmitted: true,
          preparedComponentId: expect.stringMatching(/^prepared-component:/),
        });
      }

      process.env.JS2WASM_TEST_POISON_DIRECT_FUNCTION_BODY = controlName;
      const direct = await compile(`export function ${controlName}(): number { return 7; }`, {
        fileName: "issue-3522-ordinary-direct-poison-control.ts",
        experimentalIR: false,
        target: "gc",
      });
      expect(direct.success).toBe(false);
      expect(direct.errors.map((error) => error.message)).toContain(
        `Internal error compiling function '${controlName}': injected direct function-body poison: ${controlName}`,
      );
    } finally {
      if (previous === undefined) Reflect.deleteProperty(process.env, "JS2WASM_TEST_POISON_DIRECT_FUNCTION_BODY");
      else process.env.JS2WASM_TEST_POISON_DIRECT_FUNCTION_BODY = previous;
    }
  });

  it("fully folds fixed CSS literals and preserves direct-backend batching for the dynamic array string", async () => {
    const ir = await compileBuiltins(true);
    const direct = await compileBuiltins(false);
    const concatTargets = (result: CompileResult, name: string): string[] =>
      watCallTargets(result.wat, watFunctionBody(result.wat, name)).filter((target) =>
        /(?:^|_)concat(?:_|$)/.test(target),
      );

    for (const name of ["el", "crd", "rw"] as const) {
      expect(concatTargets(ir, name), `${name} must not retain a fixed CSS concat`).toEqual([]);
    }
    // The two loop-carried updates stay pairwise. The final
    // "[" + arrStr + "]" chain must use the same one-call batching shape as
    // the direct backend, while the fixed body CSS concat stays folded away.
    const expected = ["concat_import", "concat_import", "__concat_3_import"];
    expect(concatTargets(ir, "main")).toEqual(expected);
    expect(concatTargets(direct, "main")).toEqual(expected);
  });

  it("folds immutable literal includes without an import while retaining a dynamic near-miss", async () => {
    const literalName = "issue3522LiteralIncludes";
    const literal = await compile(
      `export function ${literalName}(): boolean { return "Hello, WebAssembly!".includes("Assembly"); }`,
      {
        fileName: "issue-3522-literal-includes.ts",
        experimentalIR: true,
        trackIrOutcomes: true,
        emitWat: true,
        target: "gc",
      },
    );
    expect(literal.success, literal.errors.map((error) => error.message).join("\n")).toBe(true);
    const literalBody = watFunctionBody(literal.wat, literalName);
    expect(literalBody).toMatch(/\bi32\.const 1\b/);
    expect(watCallTargets(literal.wat, literalBody)).not.toEqual(
      expect.arrayContaining([expect.stringMatching(/includes/i)]),
    );
    expect(literal.imports.map((entry) => entry.name)).not.toEqual(
      expect.arrayContaining([expect.stringMatching(/includes/i)]),
    );

    const dynamicName = "issue3522DynamicIncludes";
    const dynamic = await compile(
      `export function ${dynamicName}(value: string): boolean { return value.includes("Assembly"); }`,
      {
        fileName: "issue-3522-dynamic-includes.ts",
        experimentalIR: true,
        trackIrOutcomes: true,
        emitWat: true,
        target: "gc",
      },
    );
    expect(dynamic.success, dynamic.errors.map((error) => error.message).join("\n")).toBe(true);
    expect(watCallTargets(dynamic.wat, watFunctionBody(dynamic.wat, dynamicName))).toEqual(
      expect.arrayContaining([expect.stringMatching(/includes/i)]),
    );
    expect(dynamic.imports.map((entry) => entry.name)).toEqual(
      expect.arrayContaining([expect.stringMatching(/includes/i)]),
    );
  });

  it("materializes exact constant bitwise values without runtime bitwise work and retains dynamic near-misses", async () => {
    const constants = await compile(
      `
        export function issue3522ConstantShl(): number { return 0xff << 8; }
        export function issue3522ConstantAnd(): number { return 0xabcd & 0xff; }
        export function issue3522ConstantOr(): number { return 0x55 | 0xaa; }
        export function issue3522ConstantXor(): number { return 0xff ^ 0x0f; }
        export function issue3522ConstantNot(): number { return ~0; }
      `,
      {
        fileName: "issue-3522-constant-bitwise.ts",
        experimentalIR: true,
        trackIrOutcomes: true,
        emitWat: true,
        target: "gc",
      },
    );
    expect(constants.success, constants.errors.map((error) => error.message).join("\n")).toBe(true);
    const expected = [
      ["issue3522ConstantShl", "65280"],
      ["issue3522ConstantAnd", "205"],
      ["issue3522ConstantOr", "255"],
      ["issue3522ConstantXor", "240"],
      ["issue3522ConstantNot", "-1"],
    ] as const;
    for (const [name, value] of expected) {
      const body = watFunctionBody(constants.wat, name);
      expect(body).toContain(`f64.const ${value}`);
      expect(body).not.toMatch(/i32\.(?:shl|shr_s|shr_u|and|or|xor)/);
      expect(watCallTargets(constants.wat, body)).not.toEqual(
        expect.arrayContaining([expect.stringMatching(/bit|shift/i)]),
      );
    }
    expect(constants.imports.map((entry) => entry.name)).not.toEqual(
      expect.arrayContaining([expect.stringMatching(/bit|shift/i)]),
    );

    const dynamic = await compile(
      `
        export function issue3522DynamicShl(value: number): number { return value << 8; }
        export function issue3522DynamicAnd(value: number): number { return value & 0xff; }
      `,
      {
        fileName: "issue-3522-dynamic-bitwise.ts",
        experimentalIR: true,
        trackIrOutcomes: true,
        emitWat: true,
        target: "gc",
      },
    );
    expect(dynamic.success, dynamic.errors.map((error) => error.message).join("\n")).toBe(true);
    expect(watFunctionBody(dynamic.wat, "issue3522DynamicShl")).toContain("i32.shl");
    expect(watFunctionBody(dynamic.wat, "issue3522DynamicAnd")).toContain("i32.and");
  });
});
