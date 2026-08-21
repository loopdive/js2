// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #4576 — final standalone Builtins-family retirement acceptance.
//
// The browser-shaped example remains a standalone/native-semantics module. Its
// only embedder authority is the exact, versioned DOM subtree capability; the
// four source owners compile once through IR and preserve the direct backend's
// value, security, and optimization envelope.

import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { gzipSync } from "node:zlib";

import { describe, expect, it } from "vitest";

import { observeStandaloneLane } from "../scripts/check-ir-only.js";
import { type CompileOptions, type CompileResult, type IrObservedOutcome, compile } from "../src/index.js";
import { evaluateIrOutcomePolicy } from "../src/ir/outcomes.js";
import { buildCompiledAdapterImports, buildCompiledImports } from "../src/runtime.js";
import { pinPerfFlags } from "./helpers/pin-perf-flags.js";

// Ownership and call-shape assertions must see the pre-inline component. The
// tuned-default artifact comparison below opts its fresh pair back in.
pinPerfFlags({ JS2WASM_IR_INLINE: "0" });

const SOURCE = readFileSync(new URL("../website/playground/examples/js/builtins.ts", import.meta.url), "utf8");
const FILE_NAME = "website/playground/examples/js/builtins.ts";
const TERMINALS = ["el", "crd", "rw", "main"] as const;

const TEST262_OBJECT_REST_BINDING_CASES = [
  {
    relative: "language/expressions/object/scope-meth-param-rest-elem-var-close.js",
    sha256: "0c1c9f35c1996f58af69f8e4ea587c210f7df6686dd4a12acb0cadd28488f167",
    expectedStatus: "pass",
    expectedError: undefined,
  },
  {
    relative: "language/expressions/object/scope-meth-param-rest-elem-var-open.js",
    sha256: "0fc352e5f3674c6e8add9928590777f3b62a4ea2e2270a254a73d6dad64e5e87",
    expectedStatus: "fail",
    expectedError:
      'Test262Error: Expected SameValue(«"outside"», «"inside"») to be true | at L28: assert.sameValue(probe1(), \'inside\');',
  },
] as const;

const DOM_IMPORTS = [
  "global_document",
  "Document_createElement",
  "Document_get_body",
  "Element_set_innerHTML",
  "Element_set_textContent",
  "CSSStyleDeclaration_set_cssText",
  "HTMLElement_get_style",
  "Node_appendChild",
] as const;

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

interface BoundaryObservation {
  readonly site: string;
  readonly value: string;
}

function boundaryString(value: unknown, site: string, observations: BoundaryObservation[]): string {
  if (typeof value !== "string") {
    throw new TypeError(`${site} crossed the DOM capability as ${typeof value}, not a JavaScript string`);
  }
  observations.push({ site, value });
  return value;
}

class FakeStyle {
  private value = "";

  constructor(private readonly observations: BoundaryObservation[]) {}

  get cssText(): string {
    return this.value;
  }

  set cssText(value: unknown) {
    this.value = boundaryString(value, "CSSStyleDeclaration.cssText", this.observations);
  }
}

class FakeElement {
  readonly nodeType = 1;
  readonly style: FakeStyle;
  readonly children: FakeElement[] = [];
  parentElement: FakeElement | null = null;
  private text = "";
  private html = "";

  constructor(
    readonly tagName: string,
    readonly authority: object,
    private readonly observations: BoundaryObservation[],
  ) {
    this.style = new FakeStyle(observations);
  }

  get textContent(): string {
    return this.text;
  }

  set textContent(value: unknown) {
    this.text = boundaryString(value, "Element.textContent", this.observations);
  }

  get innerHTML(): string {
    return this.html;
  }

  set innerHTML(value: unknown) {
    this.html = boundaryString(value, "Element.innerHTML", this.observations);
    if (this.html === "") {
      for (const child of this.children) child.parentElement = null;
      this.children.length = 0;
    }
  }

  appendChild(child: unknown): FakeElement {
    if (!(child instanceof FakeElement)) throw new TypeError("Node.appendChild received a non-element value");
    child.parentElement = this;
    this.children.push(child);
    return child;
  }

  contains(candidate: unknown): boolean {
    if (candidate === this) return true;
    return this.children.some((child) => child.contains(candidate));
  }
}

/**
 * One explicit subtree root doubles as the narrow Document facade exposed by
 * the eight-import capability. No ambient `document` object is supplied.
 */
class FakeDomRoot extends FakeElement {
  readonly body = this;

  constructor(readonly observations: BoundaryObservation[]) {
    super("body", Object.freeze({ capability: "dom@1" }), observations);
  }

  createElement(tagName: unknown): FakeElement {
    return new FakeElement(
      boundaryString(tagName, "Document.createElement", this.observations),
      this.authority,
      this.observations,
    );
  }
}

interface ElementSnapshot {
  readonly tagName: string;
  readonly cssText: string;
  readonly textContent: string;
  readonly innerHTML: string;
  readonly children: readonly ElementSnapshot[];
}

function snapshot(element: FakeElement): ElementSnapshot {
  return {
    tagName: element.tagName,
    cssText: element.style.cssText,
    textContent: element.textContent,
    innerHTML: element.innerHTML,
    children: element.children.map(snapshot),
  };
}

function descendants(element: FakeElement): FakeElement[] {
  return element.children.flatMap((child) => [child, ...descendants(child)]);
}

function expectElement(element: FakeElement, tagName: string, cssText: string, textContent: string): void {
  expect(element.tagName).toBe(tagName);
  expect(element.style.cssText).toBe(cssText);
  expect(element.textContent).toBe(textContent);
  expect(element.innerHTML).toBe("");
}

function expectRenderedOracle(root: FakeDomRoot): void {
  expectElement(root, "body", BODY_CSS, "");
  expect(descendants(root), "exact non-root element population").toHaveLength(81);
  expect(root.children).toHaveLength(1);

  const wrap = root.children[0]!;
  expectElement(wrap, "div", WRAP_CSS, "");
  expect(wrap.children).toHaveLength(EXPECTED_CARDS.length);

  const observedValues: string[] = [];
  for (const [cardIndex, [title, rows]] of EXPECTED_CARDS.entries()) {
    const card = wrap.children[cardIndex]!;
    expectElement(card, "div", CARD_CSS, "");
    expect(card.children).toHaveLength(rows.length + 1);
    expectElement(card.children[0]!, "div", TITLE_CSS, title);

    for (const [rowIndex, [label, value]] of rows.entries()) {
      const row = card.children[rowIndex + 1]!;
      expectElement(row, "div", ROW_CSS, "");
      expect(row.children).toHaveLength(2);
      expectElement(row.children[0]!, "span", LABEL_CSS, label);
      expectElement(row.children[1]!, "span", VALUE_CSS, value);
      observedValues.push(row.children[1]!.textContent);
    }
  }
  expect(observedValues, "exact computed value population").toHaveLength(24);
  expect(observedValues).toEqual(EXPECTED_CARDS.flatMap(([, rows]) => rows.map(([, value]) => value)));
}

function expectSuccess(result: CompileResult): void {
  expect(result.success, result.errors.map(({ message }) => message).join("\n")).toBe(true);
  expect(WebAssembly.validate(result.binary)).toBe(true);
  expect(result.irPostClaimErrors ?? []).toEqual([]);
}

function outcome(result: CompileResult, displayName: string): IrObservedOutcome {
  const matches = (result.irOutcomes ?? []).filter(
    (candidate) => candidate.unitKind === "function" && candidate.displayName === displayName,
  );
  expect(matches, `terminal outcome count for function:${displayName}`).toHaveLength(1);
  return matches[0]!;
}

/**
 * Any semantic, parity, artifact, performance, or WAT claim about Builtins is
 * meaningful only after this exact source is proven to be the IR artifact
 * under test. Keep this as the first assertion in every such test: otherwise
 * a healthy legacy body can make the migration suite look green.
 */
function expectExactBuiltinsIrOwnership(result: CompileResult): readonly IrObservedOutcome[] {
  expectSuccess(result);
  expect(
    (result.irOutcomes ?? []).map(({ unitKind, displayName }) => `${unitKind}:${displayName}`).sort(),
    "missing production: exact Builtins terminal universe must be tracked",
  ).toEqual(TERMINALS.map((name) => `function:${name}`).sort());

  const terminalOutcomes = TERMINALS.map((name) => outcome(result, name));
  const componentIds = new Set<string>();
  for (const [index, name] of TERMINALS.entries()) {
    const observed = terminalOutcomes[index]!;
    expect(observed, `missing production: ${name} must be emitted by IR with no legacy body`).toMatchObject({
      kind: "emitted",
      legacyBodyEmitted: false,
      irBodyEmitted: true,
      preparedComponentId: expect.stringMatching(/^prepared-component:/),
    });
    componentIds.add(observed.preparedComponentId!);
    expect(
      result.irCompiledFuncs?.filter((candidate) => candidate === name),
      `missing production: ${name} must have exactly one IR body`,
    ).toHaveLength(1);
    expect(
      result.irFirstSkipped?.filter((candidate) => candidate === name),
      `missing production: ${name} must bypass exactly one direct body`,
    ).toHaveLength(1);
  }
  expect(componentIds.size, "missing production: el/crd/rw/main must share one prepared component").toBe(1);
  expect(evaluateIrOutcomePolicy(terminalOutcomes, "ir-only")).toEqual({
    policy: "ir-only",
    ready: true,
    blockers: [],
  });
  return terminalOutcomes;
}

async function compileBuiltins(
  experimentalIR: boolean,
  fileName = FILE_NAME,
  optimize?: CompileOptions["optimize"],
): Promise<CompileResult> {
  return compile(SOURCE, {
    fileName,
    target: "standalone",
    experimentalIR,
    trackFallbacks: true,
    trackIrOutcomes: true,
    emitWat: true,
    optimize,
  });
}

let irCompilation: Promise<CompileResult> | undefined;
let directCompilation: Promise<CompileResult> | undefined;

function compileExact(experimentalIR: boolean): Promise<CompileResult> {
  if (experimentalIR) return (irCompilation ??= compileBuiltins(true));
  // The comparator must compile the identical source identity. Once the
  // production provider exists, both lanes therefore select the same dom@1
  // capability instead of letting the direct lane fall back to null stubs.
  return (directCompilation ??= compileBuiltins(false));
}

async function render(result: CompileResult): Promise<{ readonly root: FakeDomRoot; readonly boundaryCount: number }> {
  expectSuccess(result);
  const observations: BoundaryObservation[] = [];
  const root = new FakeDomRoot(observations);
  root.innerHTML = "<stale>";
  root.appendChild(root.createElement("stale"));
  observations.length = 0;

  const imports = buildCompiledImports(result, undefined, { domRoot: root as unknown as Element });
  const { instance } = await WebAssembly.instantiate(result.binary, imports);
  imports.setInstance?.(instance);
  (instance.exports.main as () => void)();
  return { root, boundaryCount: observations.length };
}

function parseWatFunctions(wat: string): readonly { readonly name: string; readonly body: string }[] {
  const starts = [...wat.matchAll(/^ {2}\(func \$([^\s(]+)/gm)].map((match) => ({
    name: match[1]!,
    index: match.index,
  }));
  return starts.map(({ name, index }, position) => ({
    name,
    body: wat.slice(index, starts[position + 1]?.index ?? wat.length),
  }));
}

function watFunction(result: CompileResult, name: string): string {
  const matches = parseWatFunctions(result.wat).filter((candidate) => candidate.name === name);
  expect(matches, `unique WAT function $${name}`).toHaveLength(1);
  return matches[0]!.body;
}

function watCallTargets(wat: string, body: string): string[] {
  const imports = [...wat.matchAll(/^\s*\(import .+ \(func(?: \$([^\s(]+))?/gm)].map(
    (match) => match[1] ?? "<anonymous-import>",
  );
  const definitions = [...wat.matchAll(/^\s*\(func \$([^\s(]+)/gm)].map((match) => match[1]!);
  const names = [...imports, ...definitions];
  return [...body.matchAll(/\b(?:return_)?call (\d+)/g)].map((match) => {
    const target = names[Number(match[1])] ?? "<missing>";
    return target.endsWith("_import") ? target.slice(0, -"_import".length) : target;
  });
}

function watFunctionIndex(wat: string, name: string): number {
  const imports = [...wat.matchAll(/^\s*\(import .+ \(func(?: \$([^\s(]+))?/gm)].map(
    (match) => match[1] ?? "<anonymous-import>",
  );
  const definitions = [...wat.matchAll(/^\s*\(func \$([^\s(]+)/gm)].map((match) => match[1]!);
  const index = [...imports, ...definitions].indexOf(name);
  expect(index, `WAT function index for $${name}`).toBeGreaterThanOrEqual(0);
  return index;
}

function watGlobalIndex(wat: string, name: string): number | undefined {
  const imports = [...wat.matchAll(/^\s*\(import .+ \(global(?: \$([^\s(]+))?/gm)].map(
    (match) => match[1] ?? "<anonymous-import>",
  );
  const definitions = [...wat.matchAll(/^\s*\(global \$([^\s(]+)/gm)].map((match) => match[1]!);
  const index = [...imports, ...definitions].indexOf(name);
  return index < 0 ? undefined : index;
}

function countMatches(value: string, pattern: RegExp): number {
  return value.match(pattern)?.length ?? 0;
}

function artifactMetrics(result: CompileResult): Record<string, number> {
  const bodies = TERMINALS.map((name) => watFunction(result, name)).join("\n");
  const funcImports = WebAssembly.Module.imports(new WebAssembly.Module(result.binary)).filter(
    ({ kind }) => kind === "function",
  ).length;
  return {
    raw: result.binary.byteLength,
    gzip: gzipSync(result.binary).byteLength,
    wat: result.wat.length,
    body: bodies.length,
    locals: countMatches(bodies, /\(local /g),
    calls: countMatches(bodies, /\b(?:return_)?call(?:_ref|_indirect)?\b/g),
    functions: funcImports + parseWatFunctions(result.wat).length,
    imports: WebAssembly.Module.imports(new WebAssembly.Module(result.binary)).length,
  };
}

function actualImportNames(result: CompileResult): string[] {
  return WebAssembly.Module.imports(new WebAssembly.Module(result.binary))
    .map(({ module, name }) => `${module}.${name}`)
    .sort();
}

function expectExactDomAbi(result: CompileResult, lane: "IR" | "direct"): void {
  expectSuccess(result);
  const dom = result.capabilityRequirements?.find(({ id }) => id === "dom");
  expect(dom, `missing production: ${lane} Builtins must select the authenticated dom@1 provider`).toMatchObject({
    id: "dom",
    abiNamespace: "js2wasm:capability/dom",
    abiVersion: 1,
    selectedProviders: ["embedder"],
    compatibleProviders: ["embedder"],
  });
  expect(dom?.permissions.length, `${lane} dom@1 permission inventory`).toBeGreaterThan(0);
  expect(dom?.permissions.every((permission) => permission.startsWith("dom:"))).toBe(true);
  expect(
    dom?.imports.map(({ module, name, kind }) => ({ module, name, kind })).sort((a, b) => a.name.localeCompare(b.name)),
    `${lane} dom@1 manifest imports`,
  ).toEqual(
    DOM_IMPORTS.map((name) => ({ module: "env", name, kind: "func" })).sort((a, b) => a.name.localeCompare(b.name)),
  );
  expect(dom?.imports.every(({ params, results }) => params !== undefined && results !== undefined)).toBe(true);
  expect(result.capabilityProviderDiagnostics, `${lane} capability provider diagnostics`).toEqual([]);
  expect(
    result.capabilityRequirements?.filter(({ id }) => id !== "dom"),
    `${lane} extra capabilities`,
  ).toEqual([]);
  expect(actualImportNames(result), `${lane} exact eight-import ABI`).toEqual(
    DOM_IMPORTS.map((name) => `env.${name}`).sort(),
  );
}

function expectNoGenericCallMachinery(result: CompileResult, name: (typeof TERMINALS)[number]): void {
  const body = watFunction(result, name);
  const targets = watCallTargets(result.wat, body);
  expect(body, `${name} indirect dispatch`).not.toMatch(/\b(?:call_ref|call_indirect)\b/);
  for (const globalName of ["__current_this", "__argc", "__arguments", "__extras_argv"] as const) {
    const index = watGlobalIndex(result.wat, globalName);
    if (index !== undefined) {
      expect(body, `${name} must not access generic ${globalName} state`).not.toMatch(
        new RegExp(`\\bglobal\\.(?:get|set) ${index}\\b`),
      );
    }
  }
  expect(targets, `${name} generic receiver dispatch`).not.toEqual(
    expect.arrayContaining([
      expect.stringMatching(/__extern_(?:get|set|call|method_call|new)|__(?:call_fn|call_method|receiver)/),
    ]),
  );
  expect(targets, `${name} generic receiver/argc/boxing ladder`).not.toEqual(
    expect.arrayContaining([expect.stringMatching(/(?:^|_)(?:box|unbox|argc|arguments|extras_argv)(?:_|$)/)]),
  );
}

function unsupportedCounts(outcomes: readonly IrObservedOutcome[]): Record<string, number> {
  const result: Record<string, number> = {};
  for (const candidate of outcomes) {
    if (candidate.kind !== "unsupported") continue;
    const key = `${candidate.stage}/${candidate.code}`;
    result[key] = (result[key] ?? 0) + 1;
  }
  return result;
}

async function runRestBindingFixtureAtShippedDefaults(filePath: string) {
  // Run the exact shipped configuration in an isolated process. Besides
  // avoiding mutation of this file's inline-off shape environment, the child
  // pins the exnref engine flag required by the assembled Test262 harness even
  // when an ordinary changed-root hook launches Vitest without that flag.
  const childEnv = { ...process.env };
  Reflect.deleteProperty(childEnv, "JS2WASM_IR_INLINE");
  childEnv.JS2WASM_TEST262_FIXTURE = filePath;
  childEnv.JS2WASM_TEST262_RUNNER = new URL("./test262-runner.ts", import.meta.url).href;
  const marker = "__JS2WASM_TEST262_RESULT__";
  const stdout = execFileSync(
    process.execPath,
    [
      "--experimental-wasm-exnref",
      "--import",
      "tsx",
      "--input-type=module",
      "--eval",
      `
        const { runTest262File } = await import(process.env.JS2WASM_TEST262_RUNNER);
        const result = await runTest262File(
          process.env.JS2WASM_TEST262_FIXTURE,
          "issue-4576-object-rest-binding",
          120_000,
          "standalone",
        );
        process.stdout.write(${JSON.stringify(marker)} + JSON.stringify(result));
      `,
    ],
    { cwd: process.cwd(), encoding: "utf8", env: childEnv, maxBuffer: 4 * 1024 * 1024 },
  );
  const markerIndex = stdout.lastIndexOf(marker);
  expect(markerIndex, "missing isolated Test262 verdict marker").toBeGreaterThanOrEqual(0);
  return JSON.parse(stdout.slice(markerIndex + marker.length)) as {
    status: string;
    error?: string;
    reason?: string;
  };
}

describe("#4576 standalone Test262 object-rest regression matrix", () => {
  for (const fixture of TEST262_OBJECT_REST_BINDING_CASES) {
    it(`runs the exact ${fixture.relative} source and preserves its pre-merge verdict`, async () => {
      const filePath = fileURLToPath(new URL(`../test262/test/${fixture.relative}`, import.meta.url));
      const source = readFileSync(filePath, "utf8");
      expect(
        createHash("sha256").update(source).digest("hex"),
        `${fixture.relative} exact Test262 source revision`,
      ).toBe(fixture.sha256);

      const result = await runRestBindingFixtureAtShippedDefaults(filePath);
      expect(result.status, result.error ?? result.reason ?? "missing Test262 verdict detail").toBe(
        fixture.expectedStatus,
      );
      expect(result.error).toBe(fixture.expectedError);
    }, 180_000);
  }

  it("keeps an ordinary identifier-rest object method on the direct-call path", async () => {
    const result = await compile(
      `
        export function ordinaryRestDirectCall(): number {
          const receiver = {
            total(head: number, ...tail: number[]): number {
              return head + tail[0] + tail.length;
            },
          };
          return receiver.total(40, 1);
        }
      `,
      {
        fileName: "issue-4576-ordinary-object-rest-direct-control.ts",
        target: "standalone",
        experimentalIR: false,
        emitWat: true,
      },
    );
    expectSuccess(result);
    expect(watCallTargets(result.wat, watFunction(result, "ordinaryRestDirectCall"))).toEqual(
      expect.arrayContaining([expect.stringMatching(/_total$/)]),
    );

    const imports = buildCompiledImports(result);
    const { instance } = await WebAssembly.instantiate(result.binary, imports);
    imports.setInstance?.(instance);
    expect((instance.exports.ordinaryRestDirectCall as () => number)()).toBe(42);
  });
});

describe("#4576 standalone DOM Builtins ownership", () => {
  it("keeps Builtins ownership inside the fully IR-owned standalone census", async () => {
    const lane = await observeStandaloneLane();
    expect(lane.entries).toHaveLength(5);
    expect(lane.entries.flatMap(({ failures }) => failures)).toEqual([]);
    const outcomes = lane.entries.flatMap(({ outcomes }) => outcomes);

    expect.soft(outcomes).toHaveLength(37);
    expect
      .soft(
        outcomes.filter(({ kind }) => kind === "emitted"),
        "missing production: IR-emitted terminals",
      )
      .toHaveLength(37);
    expect
      .soft(
        outcomes.filter(({ irBodyEmitted }) => irBodyEmitted),
        "missing production: IR body population",
      )
      .toHaveLength(37);
    expect
      .soft(
        outcomes.filter(({ legacyBodyEmitted }) => legacyBodyEmitted),
        "missing production: legacy body population",
      )
      .toEqual([]);
    expect
      .soft(
        outcomes.filter(({ kind }) => kind === "unsupported"),
        "missing production: typed Unsupported population",
      )
      .toEqual([]);
    expect
      .soft(
        outcomes.filter(({ kind }) => kind === "invariant"),
        "Invariant population",
      )
      .toEqual([]);

    const counts = unsupportedCounts(outcomes);
    expect.soft(counts).toEqual({});

    const remaining = outcomes
      .filter(({ kind }) => kind === "unsupported")
      .map(({ file, unitKind, displayName }) => `${file.replace(/^.*examples\//, "")}:${unitKind}:${displayName}`)
      .sort();
    expect(remaining).toEqual([]);
  });

  it("seals el/crd/rw/main once through IR and satisfies the IR-only shadow policy", async () => {
    const result = await compileExact(true);
    expectExactBuiltinsIrOwnership(result);
  });

  it("declares only the authenticated dom@1 embedder ABI and its exact eight imports", async () => {
    const result = await compileExact(true);
    expectExactBuiltinsIrOwnership(result);
    expectExactDomAbi(result, "IR");
    expect(result.explanation).toMatchObject({
      target: { target: "standalone", environment: "none", capabilityPolicy: "explicit-only" },
      capabilities: [expect.objectContaining({ id: "dom", selectedProviders: ["embedder"] })],
      capabilityDiagnostics: [],
    });
  });
});

describe("#4576 standalone DOM Builtins behavior and authority", () => {
  it("renders the exact 81-element/24-value oracle through both IR and direct artifacts", async () => {
    const [ir, direct] = await Promise.all([compileExact(true), compileExact(false)]);
    expectExactBuiltinsIrOwnership(ir);
    expectExactDomAbi(ir, "IR");
    expectExactDomAbi(direct, "direct");
    const [irRender, directRender] = await Promise.all([render(ir), render(direct)]);
    expectRenderedOracle(irRender.root);
    expectRenderedOracle(directRender.root);
    expect(snapshot(irRender.root)).toEqual(snapshot(directRender.root));
    expect(irRender.boundaryCount, "IR native-string to DOM projections").toBeGreaterThan(100);
    expect(directRender.boundaryCount, "direct native-string to DOM projections").toBeGreaterThan(100);
  });

  it("fails closed without an authenticating root or after capability metadata tampering", async () => {
    const result = await compileExact(true);
    expectExactBuiltinsIrOwnership(result);
    expectExactDomAbi(result, "IR");

    expect(() => buildCompiledImports(result)).toThrow(/dom.+root|root.+dom/i);
    const unauthenticated = {
      body: null,
      createElement: () => ({}),
    } as unknown as Element;
    expect(() => buildCompiledImports(result, undefined, { domRoot: unauthenticated })).toThrow(
      /authenticate|contain|dom.+root|root.+dom/i,
    );

    const manifest = result.adapterManifest!;
    const tampered = {
      ...manifest,
      capabilities: manifest.capabilities.map((capability) =>
        capability.id === "dom" ? { ...capability, abiVersion: 2 } : capability,
      ),
    } as unknown as NonNullable<CompileResult["adapterManifest"]>;
    const root = new FakeDomRoot([]);
    expect(() => buildCompiledAdapterImports(tampered, undefined, { domRoot: root as unknown as Element })).toThrow(
      /version|invalid|capability/i,
    );

    const domRequirement = manifest.capabilities.find(({ id }) => id === "dom")!;
    const relabelled = {
      ...manifest,
      capabilities: manifest.capabilities.map((capability) =>
        capability === domRequirement ? { ...capability, id: "not-dom" } : capability,
      ),
    } as unknown as NonNullable<CompileResult["adapterManifest"]>;
    expect(() => buildCompiledAdapterImports(relabelled, undefined, { domRoot: root as unknown as Element })).toThrow(
      /belongs|dom|capability/i,
    );

    const duplicateOwner = {
      ...manifest,
      capabilities: [...manifest.capabilities, { ...domRequirement, id: "not-dom" }],
    } as unknown as NonNullable<CompileResult["adapterManifest"]>;
    expect(() =>
      buildCompiledAdapterImports(duplicateOwner, undefined, { domRoot: root as unknown as Element }),
    ).toThrow(/belongs|dom|capability/i);

    const descriptorTampered = {
      ...manifest,
      imports: manifest.imports.map((descriptor) =>
        descriptor.name === "global_document" ? { ...descriptor, paramCount: 1 } : descriptor,
      ),
    } as unknown as NonNullable<CompileResult["adapterManifest"]>;
    expect(() =>
      buildCompiledAdapterImports(descriptorTampered, undefined, { domRoot: root as unknown as Element }),
    ).toThrow(/exact|dom@1|capability/i);

    const environmentTampered = {
      ...manifest,
      targetProfile: { ...manifest.targetProfile, environment: "unknown" },
    } as unknown as NonNullable<CompileResult["adapterManifest"]>;
    expect(() =>
      buildCompiledAdapterImports(environmentTampered, undefined, { domRoot: root as unknown as Element }),
    ).toThrow(/incoherent|environment|profile/i);

    const missingImport = "Node_appendChild";
    const incompleteContract = {
      ...manifest,
      imports: manifest.imports.filter(({ name }) => name !== missingImport),
      capabilities: manifest.capabilities.map((capability) =>
        capability.id === "dom"
          ? { ...capability, imports: capability.imports.filter(({ name }) => name !== missingImport) }
          : capability,
      ),
    } as unknown as NonNullable<CompileResult["adapterManifest"]>;
    expect(() =>
      buildCompiledAdapterImports(incompleteContract, undefined, { domRoot: root as unknown as Element }),
    ).toThrow(/complete|contract|capability/i);

    const underDeclaredAuthority = {
      ...manifest,
      capabilities: manifest.capabilities.map((capability) =>
        capability.id === "dom" ? { ...capability, permissions: [], compatibleProviders: [] } : capability,
      ),
    } as unknown as NonNullable<CompileResult["adapterManifest"]>;
    expect(() =>
      buildCompiledAdapterImports(underDeclaredAuthority, undefined, { domRoot: root as unknown as Element }),
    ).toThrow(/permission|compatible|provider|capability/i);

    const wrongKindDuplicate = {
      ...manifest,
      imports: [
        ...manifest.imports,
        {
          ...manifest.imports.find(({ name }) => name === "Element_set_textContent")!,
          kind: "global",
        },
      ],
    } as unknown as NonNullable<CompileResult["adapterManifest"]>;
    expect(() =>
      buildCompiledAdapterImports(wrongKindDuplicate, undefined, { domRoot: root as unknown as Element }),
    ).toThrow(/exact|dom@1|capability/i);
  });

  it("leaves ordinary JavaScript-host DOM imports on their existing js-host adapters", async () => {
    const result = await compile(`export function body(): HTMLElement { return document.body; }`, {
      fileName: "issue-4576-js-host-dom-control.ts",
    });
    expectSuccess(result);
    expect(result.targetProfile).toMatchObject({ environment: "javascript", capabilityPolicy: "ambient-js" });
    expect(result.capabilityRequirements?.some(({ id }) => id === "dom")).toBe(false);

    const body = { marker: "js-host-body" };
    const document = { body };
    const imports = buildCompiledImports(result, { document });
    const { instance } = await WebAssembly.instantiate(result.binary, imports);
    imports.setInstance?.(instance);
    expect((instance.exports.body as () => unknown)()).toBe(body);
  });

  it("rejects values outside the provider authority while accepting provider-minted detached nodes", async () => {
    const result = await compileExact(true);
    expectExactBuiltinsIrOwnership(result);
    expectExactDomAbi(result, "IR");
    const root = new FakeDomRoot([]);
    const imports = buildCompiledImports(result, undefined, { domRoot: root as unknown as Element });
    const create = imports.env.Document_createElement;
    const setText = imports.env.Element_set_textContent;
    const append = imports.env.Node_appendChild;
    expect(create).toBeTypeOf("function");
    expect(setText).toBeTypeOf("function");
    expect(append).toBeTypeOf("function");

    const documentAuthority = imports.env.global_document();
    const minted = create(documentAuthority, "div", undefined) as FakeElement;
    expect(() => setText(minted, "safe")).not.toThrow();
    expect(() => append(root, minted)).not.toThrow();
    expect(root.contains(minted)).toBe(true);

    const foreign = new FakeElement("div", Object.freeze({ capability: "foreign" }), []);
    expect(() => setText(foreign, "evil")).toThrow(/contain|authority|authenticate/i);
    expect(() => append(root, foreign)).toThrow(/contain|authority|authenticate/i);
  });

  it("survives export collisions and rejects donor or stale string-bridge authority", async () => {
    const collisionSource = `${SOURCE}
      function collision(): number { return 4576; }
      export function nativeCarrier(): string { return "native-carrier"; }
      export {
        collision as "$dp", collision as "$dp$",
        collision as "$dc", collision as "$dc$",
        collision as "$dx", collision as "$dx$",
        collision as "$dy", collision as "$dy$",
        collision as "$dz", collision as "$dz$",
        collision as "__\\0js2_dom_string_prepare",
        collision as "__\\0js2_dom_string_char",
        collision as "__\\0js2_dom_string_manifest",
        collision as "__\\0js2_dom_string_marker",
        collision as "__\\0js2_dom_string_bindings"
      };
    `;
    const result = await compile(collisionSource, {
      fileName: "issue-4576-dom-string-collisions.ts",
      target: "standalone",
      experimentalIR: true,
      trackFallbacks: true,
      trackIrOutcomes: true,
    });
    expectSuccess(result);
    expectExactDomAbi(result, "IR");

    const rendered = await render(result);
    expectRenderedOracle(rendered.root);

    const donorRoot = new FakeDomRoot([]);
    const victimRoot = new FakeDomRoot([]);
    const donorImports = buildCompiledImports(result, undefined, { domRoot: donorRoot as unknown as Element });
    const victimImports = buildCompiledImports(result, undefined, { domRoot: victimRoot as unknown as Element });
    const [{ instance: donor }, { instance: victim }] = await Promise.all([
      WebAssembly.instantiate(result.binary, donorImports),
      WebAssembly.instantiate(result.binary, victimImports),
    ]);
    donorImports.setInstance?.(donor);

    for (const name of ["$dp", "$dp$", "$dc", "$dc$", "$dx", "$dx$", "$dy", "$dy$", "$dz", "$dz$"]) {
      expect((victim.exports as Record<string, unknown>)[name], `source collision export ${name}`).toBeTypeOf(
        "function",
      );
    }

    const carrier = (donor.exports.nativeCarrier as () => unknown)();
    const minted = victimImports.env.Document_createElement(
      victimImports.env.global_document(),
      "div",
      undefined,
    ) as FakeElement;

    // A genuine but independently-linked instance cannot establish this
    // buildImports lifecycle's native-string authority.
    victimImports.setInstance?.(donor);
    expect(() => victimImports.env.Element_set_textContent(minted, carrier)).toThrow(/bridge.+authentic/i);

    victimImports.setInstance?.(victim);
    expect(() => victimImports.env.Element_set_textContent(minted, carrier)).not.toThrow();
    expect(minted.textContent).toBe("native-carrier");

    const originalWeakMapGet = WeakMap.prototype.get;
    let primordialTamperRejected = false;
    let primordialTamperBypassed = false;
    try {
      WeakMap.prototype.get = (() => () => "FORGED") as typeof WeakMap.prototype.get;
      try {
        victimImports.env.Element_set_textContent(minted, {});
      } catch {
        primordialTamperRejected = true;
      }
      primordialTamperBypassed = minted.textContent === "FORGED";
    } finally {
      WeakMap.prototype.get = originalWeakMapGet;
    }
    expect({ primordialTamperRejected, primordialTamperBypassed }).toEqual({
      primordialTamperRejected: true,
      primordialTamperBypassed: false,
    });

    // Sharing the same root does not make two independently wrapped import
    // functions interchangeable: the compiler metadata table binds the exact
    // global_document function for this buildImports lifecycle.
    const sameRootDonorImports = buildCompiledImports(result, undefined, {
      domRoot: victimRoot as unknown as Element,
    });
    const { instance: sameRootDonor } = await WebAssembly.instantiate(result.binary, sameRootDonorImports);
    sameRootDonorImports.setInstance?.(sameRootDonor);
    const sameRootCarrier = (sameRootDonor.exports.nativeCarrier as () => unknown)();
    victimImports.setInstance?.(sameRootDonor);
    expect(() => victimImports.env.Element_set_textContent(minted, sameRootCarrier)).toThrow(/bridge.+authentic/i);
    victimImports.setInstance?.(victim);

    // Authentication is checked before the carrier cache. A raw stale view
    // cannot reuse a value converted under the prior genuine instance.
    victimImports.setExports?.({});
    expect(() => victimImports.env.Element_set_textContent(minted, carrier)).toThrow(/bridge.+authentic/i);
    victimImports.setInstance?.(victim);
    expect(() => victimImports.env.Element_set_textContent(minted, carrier)).not.toThrow();
  });
});

describe("#4576 standalone DOM Builtins direct retirement", () => {
  it("bypasses the exact direct bodies while the poison seam remains live", async () => {
    const previous = process.env.JS2WASM_TEST_POISON_DIRECT_FUNCTION_BODY;
    try {
      process.env.JS2WASM_TEST_POISON_DIRECT_FUNCTION_BODY = TERMINALS.join(",");
      const result = await compileBuiltins(true, "issue-4576-builtins-exact-poison.ts");
      expectExactBuiltinsIrOwnership(result);
      expectExactDomAbi(result, "IR");
    } finally {
      if (previous === undefined) Reflect.deleteProperty(process.env, "JS2WASM_TEST_POISON_DIRECT_FUNCTION_BODY");
      else process.env.JS2WASM_TEST_POISON_DIRECT_FUNCTION_BODY = previous;
    }
  });

  it("keeps an unregistered DOM near miss direct/Unsupported and proves the poison can fire", async () => {
    const previous = process.env.JS2WASM_TEST_POISON_DIRECT_FUNCTION_BODY;
    try {
      process.env.JS2WASM_TEST_POISON_DIRECT_FUNCTION_BODY = "main";
      const nearMissSource = SOURCE.replace(
        "const host = document.body;",
        'const host = document.querySelector("body") as HTMLElement;',
      );
      const result = await compile(nearMissSource, {
        fileName: "issue-4576-builtins-dom-near-miss.ts",
        target: "standalone",
        experimentalIR: true,
        trackFallbacks: true,
        trackIrOutcomes: true,
      });
      expect(result.success).toBe(false);
      expect(result.errors.map(({ message }) => message).join("\n")).toContain(
        "injected direct function-body poison: main",
      );
      expect(outcome(result, "main")).toMatchObject({
        kind: "unsupported",
        legacyBodyEmitted: true,
        irBodyEmitted: false,
      });
      expect(evaluateIrOutcomePolicy([outcome(result, "main")], "ir-only").ready).toBe(false);
    } finally {
      if (previous === undefined) Reflect.deleteProperty(process.env, "JS2WASM_TEST_POISON_DIRECT_FUNCTION_BODY");
      else process.env.JS2WASM_TEST_POISON_DIRECT_FUNCTION_BODY = previous;
    }
  });
});

describe("#4576 standalone DOM Builtins optimization parity", () => {
  it("retains CSS/concat, native toFixed, exact direct calls, and generic-dispatch eliminations", async () => {
    const [ir, direct] = await Promise.all([compileExact(true), compileExact(false)]);
    expectExactBuiltinsIrOwnership(ir);
    expectExactDomAbi(ir, "IR");
    expectExactDomAbi(direct, "direct");

    const concatTargets = (result: CompileResult, name: string): string[] =>
      watCallTargets(result.wat, watFunction(result, name)).filter((target) => /(?:^|_)concat(?:_|$)/.test(target));
    for (const name of ["el", "crd", "rw"] as const) {
      expect(concatTargets(ir, name), `${name} fixed CSS concat`).toEqual([]);
      expect(concatTargets(ir, name)).toEqual(concatTargets(direct, name));
    }
    expect(concatTargets(ir, "main")).toEqual(concatTargets(direct, "main"));
    expect(concatTargets(ir, "main").filter((target) => /concat_3/.test(target))).toHaveLength(1);
    expect(concatTargets(ir, "main").filter((target) => !/concat_3/.test(target))).toHaveLength(2);

    const mainTargets = watCallTargets(ir.wat, watFunction(ir, "main"));
    const directMainTargets = watCallTargets(direct.wat, watFunction(direct, "main"));
    for (const [name, count] of [
      ["el", 1],
      ["crd", 4],
      ["rw", 24],
    ] as const) {
      expect(
        mainTargets.filter((target) => target === name),
        `IR main direct calls to ${name}`,
      ).toHaveLength(count);
      expect(
        directMainTargets.filter((target) => target === name),
        `direct main calls to ${name}`,
      ).toHaveLength(count);
    }
    // The ownership/call-shape build pins adapter inlining off, so it retains
    // the semantic carrier thunk. The tuned artifact test below separately
    // proves that the thunk fuses into the raw native formatter.
    expect(mainTargets.filter((target) => /number_to_?fixed/i.test(target))).toHaveLength(5);
    expect(parseWatFunctions(ir.wat).map(({ name }) => name)).toEqual(
      expect.arrayContaining(["__ir_number_toString_native", "__ir_number_to_fixed"]),
    );
    expect(mainTargets, "immutable Builtins indexOf must be a constant, not a call").not.toEqual(
      expect.arrayContaining([expect.stringMatching(/indexOf/i)]),
    );
    expect(actualImportNames(ir)).not.toEqual(
      expect.arrayContaining([expect.stringMatching(/toFixed|indexOf|concat|includes|box|unbox|extern/i)]),
    );

    for (const name of TERMINALS) {
      expectNoGenericCallMachinery(ir, name);
    }
  });

  it("folds literal string/bitwise work while preserving dynamic controls", async () => {
    const builtins = await compileExact(true);
    expectExactBuiltinsIrOwnership(builtins);
    expectExactDomAbi(builtins, "IR");

    // Keep literal folds in dedicated bodies. `main` also grows numeric-array
    // capacity with i32 shifts, so a whole-main opcode search cannot attribute
    // a shift to the source-level bitwise examples.
    const controls = await compile(
      `
        export function literalIncludes(): boolean {
          return "Hello, WebAssembly!".includes("Assembly");
        }
        export function runtimeIncludes(value: string): boolean {
          return value.includes("Assembly");
        }
        export function literalIndexOf(): number {
          return "Hello, WebAssembly!".indexOf("Wasm");
        }
        export function runtimeIndexOf(which: number): number {
          const needle = which === 0 ? "Wasm" : "Assembly";
          return "Hello, WebAssembly!".indexOf(needle);
        }
        export function literalShl(): number { return 0xff << 8; }
        export function literalAnd(): number { return 0xabcd & 0xff; }
        export function literalOr(): number { return 0x55 | 0xaa; }
        export function literalXor(): number { return 0xff ^ 0x0f; }
        export function literalNot(): number { return ~0; }
        export function runtimeShl(value: number): number { return value << 8; }
        export function runtimeAnd(value: number): number { return value & 0xff; }
      `,
      {
        fileName: "issue-4576-runtime-optimization-controls.ts",
        target: "standalone",
        experimentalIR: true,
        trackFallbacks: true,
        trackIrOutcomes: true,
        emitWat: true,
      },
    );
    expectSuccess(controls);
    const controlNames = [
      "literalIncludes",
      "runtimeIncludes",
      "literalIndexOf",
      "runtimeIndexOf",
      "literalShl",
      "literalAnd",
      "literalOr",
      "literalXor",
      "literalNot",
      "runtimeShl",
      "runtimeAnd",
    ] as const;
    for (const name of controlNames) {
      expect(outcome(controls, name), `${name} optimization-control ownership`).toMatchObject({
        kind: "emitted",
        legacyBodyEmitted: false,
        irBodyEmitted: true,
      });
    }

    const literalIncludes = watFunction(controls, "literalIncludes");
    expect(literalIncludes).toMatch(/\bi32\.const 1\b/);
    expect(watCallTargets(controls.wat, literalIncludes)).not.toEqual(
      expect.arrayContaining([expect.stringMatching(/includes/i)]),
    );
    expect(watCallTargets(controls.wat, watFunction(controls, "runtimeIncludes"))).toEqual(
      expect.arrayContaining([expect.stringMatching(/includes/i)]),
    );

    // Both the receiver and needle are immutable in Builtins, so the correct
    // IR result is the value itself. The parameter-selected needle proves the
    // dynamic search engine still exists and prevents a vacuous no-call check.
    const literalIndexOf = watFunction(controls, "literalIndexOf");
    expect(literalIndexOf).toMatch(/\bf64\.const -1\b/);
    expect(watCallTargets(controls.wat, literalIndexOf)).not.toEqual(
      expect.arrayContaining([expect.stringMatching(/indexOf/i)]),
    );
    expect(actualImportNames(controls)).not.toEqual(expect.arrayContaining([expect.stringMatching(/indexOf/i)]));
    expect(watCallTargets(controls.wat, watFunction(controls, "runtimeIndexOf"))).toEqual(
      expect.arrayContaining([expect.stringMatching(/str_indexOf/i)]),
    );
    const { instance: controlInstance } = await WebAssembly.instantiate(
      controls.binary,
      buildCompiledImports(controls),
    );
    expect((controlInstance.exports.runtimeIndexOf as (which: number) => number)(0)).toBe(-1);
    expect((controlInstance.exports.runtimeIndexOf as (which: number) => number)(1)).toBe(10);

    const literalBitwise = [
      ["literalShl", "65280"],
      ["literalAnd", "205"],
      ["literalOr", "255"],
      ["literalXor", "240"],
      ["literalNot", "-1"],
    ] as const;
    for (const [name, value] of literalBitwise) {
      const body = watFunction(controls, name);
      expect(body, `${name} folded value`).toMatch(new RegExp(`\\bf64\\.const ${value}\\b`));
      expect(body, `${name} residual bitwise work`).not.toMatch(/i32\.(?:shl|shr_s|shr_u|and|or|xor)/);
    }
    expect(watFunction(controls, "runtimeShl")).toContain("i32.shl");
    expect(watFunction(controls, "runtimeAnd")).toContain("i32.and");
  });

  it("keeps every optimized artifact metric at or below the standalone direct control", async () => {
    const previous = process.env.JS2WASM_IR_INLINE;
    Reflect.deleteProperty(process.env, "JS2WASM_IR_INLINE");
    try {
      const shape = await compileBuiltins(true, "issue-4576-builtins-tuned-shape.ts");
      const [ir, direct] = await Promise.all([
        compileBuiltins(true, "issue-4576-builtins-optimized.ts", 4),
        compileBuiltins(false, "issue-4576-builtins-optimized.ts", 4),
      ]);
      expectExactBuiltinsIrOwnership(shape);
      expectExactDomAbi(shape, "IR shape");
      expectExactBuiltinsIrOwnership(ir);
      expectExactDomAbi(ir, "IR");
      expectExactDomAbi(direct, "direct");
      const definitionNames = parseWatFunctions(shape.wat).map(({ name }) => name);
      expect(definitionNames).not.toEqual(
        expect.arrayContaining(["__ir_number_toString_native", "__ir_number_to_fixed"]),
      );
      const mainBody = watFunction(shape, "main");
      expect(watCallTargets(shape.wat, mainBody).filter((target) => target === "number_toFixed")).toHaveLength(5);
      const fixedIndex = watFunctionIndex(shape.wat, "number_toFixed");
      expect(
        [...mainBody.matchAll(new RegExp(`\\bcall ${fixedIndex}\\n\\s+any\\.convert_extern\\n\\s+ref\\.cast`, "g"))],
        "each fused native toFixed call must restore the AnyString carrier",
      ).toHaveLength(5);
      expectRenderedOracle((await render(ir)).root);
      const irMetrics = artifactMetrics(ir);
      const directMetrics = artifactMetrics(direct);
      expect(Object.keys(irMetrics)).toEqual(Object.keys(directMetrics));
      for (const metric of Object.keys(irMetrics)) {
        expect
          .soft(irMetrics[metric], `${metric}: IR ${irMetrics[metric]} <= direct ${directMetrics[metric]}`)
          .toBeLessThanOrEqual(directMetrics[metric]!);
      }
    } finally {
      if (previous === undefined) Reflect.deleteProperty(process.env, "JS2WASM_IR_INLINE");
      else process.env.JS2WASM_IR_INLINE = previous;
    }
  });

  it("keeps report mode byte-identical to inline-off carrier thunks", async () => {
    const previous = process.env.JS2WASM_IR_INLINE;
    try {
      process.env.JS2WASM_IR_INLINE = "0";
      const off = await compileBuiltins(true, "issue-4576-builtins-inline-control.ts");
      process.env.JS2WASM_IR_INLINE = "report";
      const report = await compileBuiltins(true, "issue-4576-builtins-inline-control.ts");
      expectExactBuiltinsIrOwnership(off);
      expectExactBuiltinsIrOwnership(report);
      expect(report.binary).toEqual(off.binary);
      expect(report.wat).toBe(off.wat);
      for (const result of [off, report]) {
        expect(parseWatFunctions(result.wat).map(({ name }) => name)).toEqual(
          expect.arrayContaining(["__ir_number_toString_native", "__ir_number_to_fixed"]),
        );
      }
    } finally {
      if (previous === undefined) Reflect.deleteProperty(process.env, "JS2WASM_IR_INLINE");
      else process.env.JS2WASM_IR_INLINE = previous;
    }
  });
});
