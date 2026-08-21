// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #4577 — final standalone Calendar-family retirement acceptance.
//
// Calendar is the exact six-row remainder after #4576: el, renderCal, onDay,
// updFoot, main, and <module-init>. The suite keeps that migration atomic: all
// ten source terminals must share one prepared component, the six-row corpus
// delta must move 31 -> 37 IR bodies and 6 -> 0 legacy/Unsupported rows, and
// the browser-shaped source may receive only the explicit DOM, interaction,
// and clock authorities declared below. console.log remains host-free stdout.

import { readFileSync } from "node:fs";
import { gzipSync } from "node:zlib";

import { describe, expect, it } from "vitest";

import { observeStandaloneLane } from "../scripts/check-ir-only.js";
import { DOM_STRING_BINDINGS_EXPORT } from "../src/dom-capability-contract.js";
import {
  compile,
  compileMulti,
  type CompileOptions,
  type CompileResult,
  type IrObservedOutcome,
} from "../src/index.js";
import { evaluateIrOutcomePolicy } from "../src/ir/outcomes.js";
import { buildCompiledAdapterImports, buildCompiledImports } from "../src/runtime.js";
import { pinPerfFlags } from "./helpers/pin-perf-flags.js";

// Ownership and call-shape assertions must observe the pre-inline component.
// The tuned artifact comparison opts its fresh pair back into shipped defaults.
pinPerfFlags({ JS2WASM_IR_INLINE: "0" });

const SOURCE_URL = new URL("../website/playground/examples/dom/calendar.ts", import.meta.url);
const SOURCE = readFileSync(SOURCE_URL, "utf8");
const FILE_NAME = "website/playground/examples/dom/calendar.ts";

const FUNCTION_TERMINALS = [
  "el",
  "mname",
  "dimOf",
  "fdow",
  "priceOf",
  "renderCal",
  "onDay",
  "updFoot",
  "main",
] as const;
const ALL_TERMINALS = [
  ...FUNCTION_TERMINALS.map((displayName) => ({ unitKind: "function" as const, displayName })),
  { unitKind: "module-init" as const, displayName: "<module-init>" },
] as const;
const SIX_RESIDUAL_TERMINALS = [
  { unitKind: "function" as const, displayName: "el" },
  { unitKind: "function" as const, displayName: "renderCal" },
  { unitKind: "function" as const, displayName: "onDay" },
  { unitKind: "function" as const, displayName: "updFoot" },
  { unitKind: "function" as const, displayName: "main" },
  { unitKind: "module-init" as const, displayName: "<module-init>" },
] as const;
const STATIC_DERIVED_CALLBACKS = [
  { owner: "renderCal", name: "renderCal__closure_0" },
  { owner: "renderCal", name: "renderCal__closure_1" },
  { owner: "renderCal", name: "renderCal__closure_2" },
  { owner: "main", name: "main__closure_0" },
  { owner: "main", name: "main__closure_1" },
  { owner: "main", name: "main__closure_2" },
  { owner: "main", name: "main__closure_3" },
] as const;
const STATIC_DERIVED_CALLBACK_NAMES = STATIC_DERIVED_CALLBACKS.map(({ name }) => name);
const DIRECT_CALLBACK_NAMES = Array.from({ length: 7 }, (_, ordinal) => `__cb_${ordinal}`);
const COMPILED_ARTIFACT_NAMES = [
  ...ALL_TERMINALS.map(({ displayName }) => displayName),
  ...STATIC_DERIVED_CALLBACK_NAMES,
];

interface ExactCapabilityImport {
  readonly name: string;
  readonly params: readonly string[];
  readonly results: readonly string[];
}

// Keep the already-published dom@1 contract byte-for-byte stable. Calendar's
// two extra powers deliberately live in the separately reviewable interaction
// capability below rather than silently widening the Builtins authority.
const DOM_CAPABILITY_IMPORTS: readonly ExactCapabilityImport[] = [
  { name: "global_document", params: [], results: ["externref"] },
  { name: "Document_createElement", params: ["externref", "externref", "externref"], results: ["externref"] },
  { name: "Document_get_body", params: ["externref"], results: ["externref"] },
  { name: "Element_set_innerHTML", params: ["externref", "externref"], results: [] },
  { name: "Element_set_textContent", params: ["externref", "externref"], results: [] },
  { name: "CSSStyleDeclaration_set_cssText", params: ["externref", "externref"], results: [] },
  { name: "HTMLElement_get_style", params: ["externref"], results: ["externref"] },
  { name: "Node_appendChild", params: ["externref", "externref"], results: ["externref"] },
] as const;

// Centralize the provisional capability spelling so an architecture review can
// rename it without weakening or scattering the exact ABI assertions.
const DOM_INTERACTION_CAPABILITY_ID = "dom-interaction";
const DOM_INTERACTION_PERMISSIONS = ["dom:event-listen", "dom:style-write"] as const;
const DOM_INTERACTION_IMPORTS: readonly ExactCapabilityImport[] = [
  {
    name: "HTMLElement_addEventListener",
    params: ["externref", "externref", "externref", "externref"],
    results: [],
  },
  { name: "CSSStyleDeclaration_set_background", params: ["externref", "externref"], results: [] },
] as const;
const CLOCK_CAPABILITY_IMPORTS: readonly ExactCapabilityImport[] = [
  { name: "__date_now", params: [], results: ["f64"] },
] as const;
const EXACT_IMPORT_NAMES = [...DOM_CAPABILITY_IMPORTS, ...DOM_INTERACTION_IMPORTS, ...CLOCK_CAPABILITY_IMPORTS].map(
  ({ name }) => `env.${name}`,
);

const CLOCK_EPOCH_MS = 1_734_220_800_000; // 2024-12-15T00:00:00.000Z
const BODY_CSS = "margin:0;background:#111;color:#ddd;font-family:system-ui,sans-serif;overflow:hidden";
const WEEKDAYS = ["MON", "TUE", "WED", "THU", "FRI", "SAT", "SUN"] as const;

interface BoundaryObservation {
  readonly site: string;
  readonly value: string;
}

function boundaryString(value: unknown, site: string, observations: BoundaryObservation[]): string {
  if (typeof value !== "string") {
    throw new TypeError(`${site} crossed the explicit DOM boundary as ${typeof value}, not a JavaScript string`);
  }
  observations.push({ site, value });
  return value;
}

class FakeStyle {
  private css = "";
  private bg = "";

  constructor(private readonly observations: BoundaryObservation[]) {}

  get cssText(): string {
    return this.css;
  }

  set cssText(value: unknown) {
    this.css = boundaryString(value, "CSSStyleDeclaration.cssText", this.observations);
  }

  get background(): string {
    return this.bg;
  }

  set background(value: unknown) {
    this.bg = boundaryString(value, "CSSStyleDeclaration.background", this.observations);
  }
}

interface ListenerRegistration {
  readonly type: string;
  readonly target: FakeElement;
  readonly listener: Function;
}

class FakeElement {
  readonly nodeType = 1;
  readonly style: FakeStyle;
  readonly children: FakeElement[] = [];
  readonly listeners = new Map<string, Function[]>();
  parentElement: FakeElement | null = null;
  private text = "";
  private html = "";

  constructor(
    readonly tagName: string,
    readonly authority: object,
    private readonly observations: BoundaryObservation[],
    private readonly registrations: ListenerRegistration[],
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
    if (child.authority !== this.authority) throw new TypeError("Node.appendChild crossed fake provider authority");
    child.parentElement = this;
    this.children.push(child);
    return child;
  }

  addEventListener(type: unknown, listener: unknown): void {
    const eventType = boundaryString(type, "HTMLElement.addEventListener type", this.observations);
    if (typeof listener !== "function") {
      throw new TypeError("HTMLElement.addEventListener received a non-callable listener");
    }
    const listeners = this.listeners.get(eventType) ?? [];
    listeners.push(listener);
    this.listeners.set(eventType, listeners);
    this.registrations.push({ type: eventType, target: this, listener });
  }

  dispatch(type: string): void {
    const listeners = this.listeners.get(type) ?? [];
    expect(listeners, `${this.tagName} ${type} listener count`).toHaveLength(1);
    expect(listeners[0]!({ type, target: this }), `${type} callback return`).toBeUndefined();
  }

  contains(candidate: unknown): boolean {
    if (candidate === this) return true;
    return this.children.some((child) => child.contains(candidate));
  }
}

/** One explicit subtree root doubles as Calendar's narrow Document facade. */
class FakeDomRoot extends FakeElement {
  readonly body = this;
  readonly registrations: ListenerRegistration[];

  constructor(readonly observations: BoundaryObservation[]) {
    const authority = Object.freeze({ capability: "calendar-dom" });
    const registrations: ListenerRegistration[] = [];
    super("body", authority, observations, registrations);
    this.registrations = registrations;
  }

  createElement(tagName: unknown): FakeElement {
    return new FakeElement(
      boundaryString(tagName, "Document.createElement", this.observations),
      this.authority,
      this.observations,
      this.registrations,
    );
  }
}

interface CalendarDom {
  readonly wrap: FakeElement;
  readonly month: FakeElement;
  readonly year: FakeElement;
  readonly weekdayHeader: FakeElement;
  readonly grid: FakeElement;
  readonly weekdayFooter: FakeElement;
  readonly previous: FakeElement;
  readonly next: FakeElement;
  readonly clear: FakeElement;
  readonly nights: FakeElement;
  readonly total: FakeElement;
  readonly save: FakeElement;
}

interface RuntimeEvidence {
  readonly root: FakeDomRoot;
  readonly stdout: string;
  readonly callbackCreations: number;
  readonly clockSnapshots: number;
  readonly clockEvents: readonly string[];
  readonly boundaryCount: number;
}

interface ElementSnapshot {
  readonly tagName: string;
  readonly cssText: string;
  readonly background: string;
  readonly textContent: string;
  readonly innerHTML: string;
  readonly listenerTypes: readonly string[];
  readonly children: readonly ElementSnapshot[];
}

function snapshot(element: FakeElement): ElementSnapshot {
  return {
    tagName: element.tagName,
    cssText: element.style.cssText,
    background: element.style.background,
    textContent: element.textContent,
    innerHTML: element.innerHTML,
    listenerTypes: [...element.listeners.keys()].sort(),
    children: element.children.map(snapshot),
  };
}

function calendarDom(root: FakeDomRoot): CalendarDom {
  expect(root.children, "body child count").toHaveLength(1);
  const wrap = root.children[0]!;
  expect(wrap.children, "calendar section count").toHaveLength(7);
  const header = wrap.children[0]!;
  const weekdayHeader = wrap.children[1]!;
  const grid = wrap.children[2]!;
  const weekdayFooter = wrap.children[3]!;
  const nav = wrap.children[4]!;
  const foot1 = wrap.children[5]!;
  const foot2 = wrap.children[6]!;
  expect(header.children).toHaveLength(2);
  expect(nav.children).toHaveLength(2);
  expect(foot1.children).toHaveLength(2);
  expect(foot2.children).toHaveLength(2);
  return {
    wrap,
    month: header.children[0]!,
    year: header.children[1]!,
    weekdayHeader,
    grid,
    weekdayFooter,
    previous: nav.children[0]!,
    next: nav.children[1]!,
    clear: foot1.children[0]!,
    nights: foot1.children[1]!,
    total: foot2.children[0]!,
    save: foot2.children[1]!,
  };
}

function dayCell(dom: CalendarDom, day: number): FakeElement {
  const matches = dom.grid.children.filter(
    (cell) => cell.listeners.has("click") && cell.children[0]?.textContent === String(day),
  );
  expect(matches, `unique live day cell ${day}`).toHaveLength(1);
  return matches[0]!;
}

function expectWeekdays(container: FakeElement): void {
  expect(container.children.map((child) => child.textContent)).toEqual(WEEKDAYS);
}

function expectMonth(dom: CalendarDom, month: string, year: string, cells: number): void {
  expect(dom.month.textContent).toBe(month);
  expect(dom.year.textContent).toBe(year);
  expect(dom.grid.children).toHaveLength(cells);
  expect(dom.nights.textContent).toBe("0 nights");
  expect(dom.total.textContent).toBe("");
}

let irCompilation: Promise<CompileResult> | undefined;
let directCompilation: Promise<CompileResult> | undefined;
let irRuntimeCompilation: Promise<CompileResult> | undefined;
let directRuntimeCompilation: Promise<CompileResult> | undefined;

function compileCalendar(
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

function compileExact(experimentalIR: boolean): Promise<CompileResult> {
  if (experimentalIR) return (irCompilation ??= compileCalendar(true));
  // Both lanes compile the identical source identity so capability selection,
  // Date snapshots, and the direct-relative artifact comparison are honest.
  return (directCompilation ??= compileCalendar(false));
}

function compileRuntimeExact(experimentalIR: boolean): Promise<CompileResult> {
  const compileRuntime = () =>
    compile(SOURCE, {
      fileName: FILE_NAME,
      target: "standalone",
      experimentalIR,
      trackFallbacks: true,
      trackIrOutcomes: true,
      emitWat: true,
      hostBridge: "always",
    });
  if (experimentalIR) return (irRuntimeCompilation ??= compileRuntime());
  return (directRuntimeCompilation ??= compileRuntime());
}

function compileCalendarFresh(
  source: string,
  experimentalIR: boolean,
  fileName: string,
  optimize?: CompileOptions["optimize"],
): Promise<CompileResult> {
  return compile(source, {
    fileName,
    target: "standalone",
    experimentalIR,
    trackFallbacks: true,
    trackIrOutcomes: true,
    emitWat: true,
    optimize,
  });
}

function expectSuccess(result: CompileResult): void {
  expect(result.success, result.errors.map(({ message }) => message).join("\n")).toBe(true);
  expect(WebAssembly.validate(result.binary)).toBe(true);
  expect(result.irPostClaimErrors ?? []).toEqual([]);
}

function outcome(
  result: CompileResult,
  unitKind: IrObservedOutcome["unitKind"],
  displayName: string,
): IrObservedOutcome {
  const matches = (result.irOutcomes ?? []).filter(
    (candidate) => candidate.unitKind === unitKind && candidate.displayName === displayName,
  );
  expect(matches, `terminal outcome count for ${unitKind}:${displayName}`).toHaveLength(1);
  return matches[0]!;
}

function expectExactMultiset(actual: readonly string[], expected: readonly string[], label: string): void {
  expect([...actual].sort(), label).toEqual([...expected].sort());
}

interface WatFunction {
  readonly name: string;
  readonly body: string;
}

function parseWatFunctions(wat: string): readonly WatFunction[] {
  const starts = [...wat.matchAll(/^ {2}\(func \$([^\s(]+)/gm)].map((match) => ({
    name: match[1]!,
    index: match.index,
  }));
  const names = starts.map(({ name }) => name);
  expect(new Set(names).size, "WAT function names must be unique before shape attribution").toBe(names.length);
  return starts.map(({ name, index }, position) => ({
    name,
    body: wat.slice(index, starts[position + 1]?.index ?? wat.length),
  }));
}

function watFunction(result: CompileResult, name: string): WatFunction {
  const matches = parseWatFunctions(result.wat).filter((candidate) => candidate.name === name);
  expect(matches, `unique WAT function $${name}`).toHaveLength(1);
  return matches[0]!;
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

function targetCount(result: CompileResult, name: string, target: string): number {
  return watCallTargets(result.wat, watFunction(result, name).body).filter((candidate) => candidate === target).length;
}

function bodySizeMetrics(
  result: CompileResult,
  names: readonly string[],
): { readonly locals: number; readonly bytes: number } {
  let locals = 0;
  let bytes = 0;
  for (const name of names) {
    const body = watFunction(result, name).body.trimEnd();
    locals += countMatches(body, /\(local /g);
    bytes += body.length;
  }
  return { locals, bytes };
}

function actualImportNames(result: CompileResult): string[] {
  return WebAssembly.Module.imports(new WebAssembly.Module(result.binary))
    .map(({ module, name }) => `${module}.${name}`)
    .sort();
}

function normalizedCapabilityImports(imports: readonly ExactCapabilityImport[]): unknown[] {
  return imports
    .map(({ name, params, results }) => ({
      module: "env",
      name,
      kind: "func",
      params: [...params],
      results: [...results],
    }))
    .sort((left, right) => left.name.localeCompare(right.name));
}

function expectExactCapabilityContracts(result: CompileResult, lane: "IR" | "direct"): void {
  expectSuccess(result);
  const requirements = result.capabilityRequirements ?? [];
  expect(requirements.map(({ id }) => id).sort(), `${lane} exact capability owner set`).toEqual(
    ["clock", "dom", DOM_INTERACTION_CAPABILITY_ID].sort(),
  );

  const dom = requirements.find(({ id }) => id === "dom");
  expect(dom, `${lane} stable dom@1 capability`).toMatchObject({
    id: "dom",
    abiNamespace: "js2wasm:capability/dom",
    abiVersion: 1,
    permissions: ["dom:subtree-read", "dom:subtree-write", "dom:create-element"],
    selectedProviders: ["embedder"],
    compatibleProviders: ["embedder"],
  });
  expect(
    dom?.imports.map(({ module, name, kind, params, results }) => ({ module, name, kind, params, results })),
    `${lane} stable dom@1 eight-import contract`,
  ).toEqual(normalizedCapabilityImports(DOM_CAPABILITY_IMPORTS));

  const interaction = requirements.find(({ id }) => id === DOM_INTERACTION_CAPABILITY_ID);
  expect(interaction, `${lane} exact ${DOM_INTERACTION_CAPABILITY_ID}@1 capability`).toMatchObject({
    id: DOM_INTERACTION_CAPABILITY_ID,
    abiNamespace: `js2wasm:capability/${DOM_INTERACTION_CAPABILITY_ID}`,
    abiVersion: 1,
    permissions: DOM_INTERACTION_PERMISSIONS,
    selectedProviders: ["embedder"],
    compatibleProviders: ["embedder"],
  });
  expect(
    interaction?.imports.map(({ module, name, kind, params, results }) => ({ module, name, kind, params, results })),
    `${lane} exact event/style interaction contract`,
  ).toEqual(normalizedCapabilityImports(DOM_INTERACTION_IMPORTS));

  const clock = requirements.find(({ id }) => id === "clock");
  expect(clock, `${lane} exact clock@1 capability`).toMatchObject({
    id: "clock",
    abiNamespace: "js2wasm:capability/clock",
    abiVersion: 1,
    permissions: ["clock:read"],
    selectedProviders: ["embedder"],
    compatibleProviders: ["js-host", "wasi-preview1", "embedder"],
  });
  expect(
    clock?.imports.map(({ module, name, kind, params, results }) => ({ module, name, kind, params, results })),
    `${lane} exact wall-clock contract`,
  ).toEqual(normalizedCapabilityImports(CLOCK_CAPABILITY_IMPORTS));

  expect(result.capabilityProviderDiagnostics, `${lane} provider diagnostics`).toEqual([]);
  expect(actualImportNames(result), `${lane} exact explicit provider ABI`).toEqual([...EXACT_IMPORT_NAMES].sort());
  expect(result.errors.map(({ message }) => message)).not.toEqual(
    expect.arrayContaining([expect.stringContaining("Host import leak")]),
  );
  expect(result.explanation).toMatchObject({
    status: "declared-host-capability",
    target: { target: "standalone", environment: "none", capabilityPolicy: "explicit-only" },
    hostImports: {
      total: EXACT_IMPORT_NAMES.length,
      byClassification: {
        "platform-capability": EXACT_IMPORT_NAMES.length,
        "value-adapter": 0,
        "instance-lifecycle": 0,
        "host-accelerator": 0,
        "legacy-semantic": 0,
        unknown: 0,
      },
      byFamily: { clock: 1, dom: 8, [DOM_INTERACTION_CAPABILITY_ID]: 2 },
    },
    capabilityDiagnostics: [],
  });
  expect(
    requirements.some(({ id }) => id === "console"),
    `${lane} must keep console host-free`,
  ).toBe(false);
  expect(actualImportNames(result)).not.toEqual(
    expect.arrayContaining([
      "env.console_log_string",
      "env.__make_callback",
      "env.Date_new",
      "env.Date_getDate",
      "env.Date_getMonth",
      "env.Date_getFullYear",
    ]),
  );
}

function expectExactCalendarIrOwnership(result: CompileResult): readonly IrObservedOutcome[] {
  expectSuccess(result);
  expectExactMultiset(
    (result.irOutcomes ?? []).map(({ unitKind, displayName }) => `${unitKind}:${displayName}`),
    ALL_TERMINALS.map(({ unitKind, displayName }) => `${unitKind}:${displayName}`),
    "exact Calendar terminal universe",
  );

  const terminalOutcomes = ALL_TERMINALS.map(({ unitKind, displayName }) => outcome(result, unitKind, displayName));
  const componentIds = new Set<string>();
  for (const [index, terminal] of ALL_TERMINALS.entries()) {
    const observed = terminalOutcomes[index]!;
    expect(
      observed,
      `missing production: ${terminal.unitKind}:${terminal.displayName} must emit once through IR`,
    ).toMatchObject({
      kind: "emitted",
      legacyBodyEmitted: false,
      irBodyEmitted: true,
      preparedComponentId: expect.stringMatching(/^prepared-component:/),
    });
    componentIds.add(observed.preparedComponentId!);
  }
  expect(componentIds.size, "all ten Calendar terminals must share one prepared component").toBe(1);
  for (const terminal of SIX_RESIDUAL_TERMINALS) {
    expect(
      terminalOutcomes.filter(
        ({ unitKind, displayName, kind, legacyBodyEmitted, irBodyEmitted }) =>
          unitKind === terminal.unitKind &&
          displayName === terminal.displayName &&
          kind === "emitted" &&
          !legacyBodyEmitted &&
          irBodyEmitted,
      ),
      `exact retired residual ${terminal.unitKind}:${terminal.displayName}`,
    ).toHaveLength(1);
  }

  expect(evaluateIrOutcomePolicy(terminalOutcomes, "ir-only")).toEqual({
    policy: "ir-only",
    ready: true,
    blockers: [],
  });
  expectExactMultiset(result.irCompiledFuncs ?? [], COMPILED_ARTIFACT_NAMES, "ten terminals + seven callbacks");
  expectExactMultiset(result.irFirstSkipped ?? [], FUNCTION_TERMINALS, "exact nine direct function-body skips");
  for (const artifact of COMPILED_ARTIFACT_NAMES) {
    const watName = artifact === "<module-init>" ? "__module_init" : artifact;
    expect(
      parseWatFunctions(result.wat).filter(({ name }) => name === watName),
      `unique compiled artifact $${watName}`,
    ).toHaveLength(1);
  }
  expect(result.irFallbackCounts ?? {}).toEqual({});
  return terminalOutcomes;
}

function expectNoGenericBodyMachinery(result: CompileResult, name: string): void {
  const body = watFunction(result, name).body;
  const targets = watCallTargets(result.wat, body);
  expect(body, `${name} indirect dispatch`).not.toMatch(/\b(?:call_ref|call_indirect)\b/);
  for (const globalName of ["__current_this", "__argc", "__arguments", "__extras_argv"] as const) {
    const globalIndex = watGlobalIndex(result.wat, globalName);
    if (globalIndex !== undefined) {
      expect(body, `${name} must not access generic $${globalName}`).not.toMatch(
        new RegExp(`\\bglobal\\.(?:get|set) ${globalIndex}\\b`),
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

function expectCalendarOptimizationReference(result: CompileResult, lane: "IR" | "direct"): void {
  expect(targetCount(result, "dimOf", "__fmod")).toBe(3);

  const fdow = watFunction(result, "fdow").body;
  expect(targetCount(result, "fdow", "__fmod")).toBe(2);
  expect(countMatches(fdow, /\bf64\.div\b/g)).toBe(3);
  expect(countMatches(fdow, /\barray\.get(?:_[su])?\b/g)).toBe(1);

  const numberToStringTarget = lane === "IR" ? "__ir_number_toString_native" : "number_toString";
  expect(targetCount(result, "renderCal", numberToStringTarget)).toBe(7);
  expect(targetCount(result, "renderCal", lane === "IR" ? "number_toString" : "__ir_number_toString_native")).toBe(0);
  expect(targetCount(result, "renderCal", "Element_set_textContent")).toBe(8);
  expect(targetCount(result, "renderCal", "Node_appendChild")).toBe(9);
  expect(targetCount(result, "renderCal", "HTMLElement_addEventListener")).toBe(3);
  expect(targetCount(result, "renderCal", "__date_now")).toBe(1);
  expect(targetCount(result, "renderCal", "__date_civil_from_days")).toBe(3);

  expect(targetCount(result, "updFoot", numberToStringTarget)).toBe(2);
  expect(targetCount(result, "updFoot", "Element_set_textContent")).toBe(4);

  const main = watFunction(result, "main").body;
  expect(countMatches(main, /\barray\.new_fixed\b/g)).toBe(1);
  expect(countMatches(main, /\bi32\.lt_s\b/g)).toBe(2);
  expect(countMatches(main, /\bi32\.lt_u\b/g)).toBe(lane === "IR" ? 0 : 2);
  expect(countMatches(main, /\barray\.get(?:_[su])?\b/g)).toBe(2);
  expect(targetCount(result, "main", "HTMLElement_addEventListener")).toBe(4);
  expect(targetCount(result, "main", "Node_appendChild")).toBe(18);
  expect(targetCount(result, "main", "renderCal")).toBe(1);

  expect(targetCount(result, "__module_init", "__date_now")).toBe(2);
  expect(targetCount(result, "__module_init", "__date_civil_from_days")).toBe(2);
  for (const legacyTarget of ["Date_new", "Date_getDate", "Date_getMonth", "Date_getFullYear"] as const) {
    expect(targetCount(result, "renderCal", legacyTarget)).toBe(0);
    expect(targetCount(result, "__module_init", legacyTarget)).toBe(0);
  }
  for (const name of ["renderCal", "onDay", "updFoot", "main"] as const) {
    expect(targetCount(result, name, "__new_ReferenceError"), `${name} redundant module TDZ guards`).toBe(0);
  }
  for (const name of FUNCTION_TERMINALS) expectNoGenericBodyMachinery(result, name);
}

function readStdout(exports: WebAssembly.Exports): string {
  const prepare = exports.__stdout_prepare as (() => number) | undefined;
  const charAt = exports.__stdout_char as ((index: number) => number) | undefined;
  expect(prepare, "standalone stdout readout").toBeTypeOf("function");
  expect(charAt, "standalone stdout character readout").toBeTypeOf("function");
  const length = prepare!();
  let output = "";
  for (let index = 0; index < length; index++) output += String.fromCharCode(charAt!(index));
  return output;
}

async function exerciseCalendar(result: CompileResult, lane: "IR" | "direct"): Promise<RuntimeEvidence> {
  expectSuccess(result);
  expectExactCapabilityContracts(result, lane);
  const observations: BoundaryObservation[] = [];
  const root = new FakeDomRoot(observations);
  root.innerHTML = "<stale>";
  root.appendChild(root.createElement("stale"));
  observations.length = 0;

  const clockEvents: string[] = [];
  let clockSnapshots = 0;
  const fakeNow = () => {
    const ordinal = clockSnapshots++;
    clockEvents.push(`now:${ordinal}`);
    if (ordinal >= 14) throw new Error(`${lane} requested an unexpected fifteenth Calendar clock snapshot`);
    return CLOCK_EPOCH_MS;
  };
  // The exact embedder binding spelling is deliberately supplied in the same
  // closed dependency record as other standard host APIs. The assertion above
  // still requires the single manifest/import owner, and the explicit override
  // below guarantees this oracle controls the actual clock function invoked.
  const clockProvider = Object.assign(fakeNow, { now: fakeNow });
  const imports = buildCompiledImports(
    result,
    { __date_now: fakeNow, dateNow: fakeNow, now: fakeNow, clock: clockProvider, Date: clockProvider },
    { domRoot: root },
  );
  expect(imports.env.__date_now, `${lane} explicit clock import`).toBeTypeOf("function");
  imports.env.__date_now = fakeNow;

  const { instance } = await WebAssembly.instantiate(result.binary, imports);
  imports.setInstance?.(instance);
  const domBindings = instance.exports[DOM_STRING_BINDINGS_EXPORT] as WebAssembly.Table | undefined;
  expect(domBindings, `${lane} authenticated DOM binding table`).toBeInstanceOf(WebAssembly.Table);
  expect(domBindings?.length, `${lane} DOM binding table includes callback-dispatch slot 3`).toBe(4);
  expect(domBindings?.get(3), `${lane} DOM binding-table callback dispatcher`).toBeTypeOf("function");
  const main = instance.exports.main as (() => void) | undefined;
  expect(main, `${lane} Calendar main export`).toBeTypeOf("function");
  main!();

  let dom = calendarDom(root);
  expect(root.innerHTML).toBe("");
  expect(root.style.cssText).toBe(BODY_CSS);
  expectWeekdays(dom.weekdayHeader);
  expectWeekdays(dom.weekdayFooter);
  expectMonth(dom, "Dec", "2024", 42);
  expect(dayCell(dom, 15).style.cssText).toContain("background:#7c3aed");

  dom.next.dispatch("click");
  dom = calendarDom(root);
  expectMonth(dom, "Jan", "2025", 35);

  const hoverFive = dayCell(dom, 5);
  const hoverSix = dayCell(dom, 6);
  expect(hoverFive.style.background).toBe("");
  expect(hoverSix.style.background).toBe("");
  hoverFive.dispatch("mouseenter");
  expect(hoverFive.style.background).toBe("#222");
  expect(hoverSix.style.background).toBe("");
  hoverFive.dispatch("mouseleave");
  expect(hoverFive.style.background).toBe("transparent");
  expect(hoverSix.style.background).toBe("");

  dayCell(dom, 5).dispatch("click");
  dom = calendarDom(root);
  dayCell(dom, 9).dispatch("click");
  dom = calendarDom(root);
  expect(dom.nights.textContent).toBe("4 nights");
  expect(dom.total.textContent).toBe("2300 \u20ac");

  dayCell(dom, 20).dispatch("click");
  dom = calendarDom(root);
  dayCell(dom, 15).dispatch("click");
  dom = calendarDom(root);
  expect(dom.nights.textContent).toBe("5 nights");
  expect(dom.total.textContent).toBe("2800 \u20ac");

  dayCell(dom, 10).dispatch("click");
  dom = calendarDom(root);
  dayCell(dom, 10).dispatch("click");
  dom = calendarDom(root);
  dayCell(dom, 4).dispatch("click");
  dom = calendarDom(root);
  dayCell(dom, 10).dispatch("click");
  dom = calendarDom(root);
  expect(dom.nights.textContent).toBe("6 nights");
  expect(dom.total.textContent).toBe("2550 \u20ac");
  expect(readStdout(instance.exports)).toBe("");
  dom.save.dispatch("click");
  expect(readStdout(instance.exports)).toBe("saved 4-10\n");

  dom.clear.dispatch("click");
  dom = calendarDom(root);
  expectMonth(dom, "Jan", "2025", 35);
  dom.previous.dispatch("click");
  dom = calendarDom(root);
  expectMonth(dom, "Dec", "2024", 42);

  expect(root.registrations, "4 fixed + 12 renders x 31 days x 3 listeners").toHaveLength(1_120);
  expect(root.registrations.every(({ listener }) => typeof listener === "function")).toBe(true);
  expect(clockSnapshots, "two module snapshots plus one snapshot per render").toBe(14);
  expect(clockEvents).toEqual(Array.from({ length: 14 }, (_, ordinal) => `now:${ordinal}`));
  expect(observations.length, `${lane} native strings crossing explicit DOM capabilities`).toBeGreaterThan(1_000);

  return {
    root,
    stdout: readStdout(instance.exports),
    callbackCreations: root.registrations.length,
    clockSnapshots,
    clockEvents,
    boundaryCount: observations.length,
  };
}

function artifactMetrics(result: CompileResult, bodyNames: readonly string[]): Record<string, number> {
  const bodies = bodyNames.map((name) => watFunction(result, name).body).join("\n");
  const module = new WebAssembly.Module(result.binary);
  const functionImports = WebAssembly.Module.imports(module).filter(({ kind }) => kind === "function").length;
  return {
    raw: result.binary.byteLength,
    gzip: gzipSync(result.binary).byteLength,
    wat: result.wat.length,
    body: bodies.length,
    locals: countMatches(bodies, /\(local /g),
    calls: countMatches(bodies, /\b(?:return_)?call(?:_ref|_indirect)?\b/g),
    functions: functionImports + parseWatFunctions(result.wat).length,
    imports: WebAssembly.Module.imports(module).length,
  };
}

function unsupportedCounts(outcomes: readonly IrObservedOutcome[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const candidate of outcomes) {
    if (candidate.kind !== "unsupported") continue;
    const key = `${candidate.stage}/${candidate.code}`;
    counts[key] = (counts[key] ?? 0) + 1;
  }
  return counts;
}

describe("#4577 standalone Calendar ownership and corpus retirement", () => {
  it("keeps the post-timer exact 38-terminal census at 38/0 with no Invariant", async () => {
    const lane = await observeStandaloneLane();
    expect(lane.entries).toHaveLength(5);
    expect(lane.entries.flatMap(({ failures }) => failures)).toEqual([]);
    const outcomes = lane.entries.flatMap(({ outcomes }) => outcomes);

    expect.soft(outcomes, "exact standalone terminal population").toHaveLength(38);
    expect
      .soft(
        outcomes.filter(({ kind }) => kind === "emitted"),
        "IR-emitted terminal population",
      )
      .toHaveLength(38);
    expect
      .soft(
        outcomes.filter(({ irBodyEmitted }) => irBodyEmitted),
        "IR body population",
      )
      .toHaveLength(38);
    expect
      .soft(
        outcomes.filter(({ legacyBodyEmitted }) => legacyBodyEmitted),
        "legacy body population",
      )
      .toEqual([]);
    expect
      .soft(
        outcomes.filter(({ kind }) => kind === "unsupported"),
        "Unsupported population",
      )
      .toEqual([]);
    expect
      .soft(
        outcomes.filter(({ kind }) => kind === "invariant"),
        "Invariant population",
      )
      .toEqual([]);
    expect.soft(unsupportedCounts(outcomes), "all typed Unsupported buckets retired").toEqual({});

    const calendarOutcomes = outcomes.filter(({ file }) =>
      file.endsWith("website/playground/examples/dom/calendar.ts"),
    );
    expectExactMultiset(
      calendarOutcomes.map(({ unitKind, displayName }) => `${unitKind}:${displayName}`),
      ALL_TERMINALS.map(({ unitKind, displayName }) => `${unitKind}:${displayName}`),
      "exact Calendar ledger rows",
    );
    for (const terminal of SIX_RESIDUAL_TERMINALS) {
      const matches = calendarOutcomes.filter(
        ({ unitKind, displayName }) => unitKind === terminal.unitKind && displayName === terminal.displayName,
      );
      expect(matches, `retired ledger residual ${terminal.unitKind}:${terminal.displayName}`).toHaveLength(1);
      expect(matches[0]).toMatchObject({ kind: "emitted", legacyBodyEmitted: false, irBodyEmitted: true });
    }
  });

  it("seals all ten terminals and seven callbacks through one compile-once IR component", async () => {
    const result = await compileExact(true);
    expectExactCalendarIrOwnership(result);
  });

  it("reserves the exact seven-callback dispatcher before linked-component sealing", async () => {
    const result = await compileMulti(
      {
        [FILE_NAME]: SOURCE,
        "harmless.ts": "export function harmless(value: number): number { return value + 1; }",
      },
      FILE_NAME,
      {
        target: "standalone",
        experimentalIR: true,
        trackIrOutcomes: true,
        emitWat: true,
      },
    );
    expectSuccess(result);
    const dispatcher = watFunction(result, "__js2_standalone_dom_callback_dispatch_impl");
    expect(countMatches(dispatcher.body, /\bref\.test\b/g), "one exact carrier arm per Calendar callback").toBe(7);
  });

  it("declares only stable dom@1, exact interaction@1, and embedder clock@1 authority", async () => {
    const [ir, direct] = await Promise.all([compileExact(true), compileExact(false)]);
    expectExactCalendarIrOwnership(ir);
    expectExactCapabilityContracts(ir, "IR");
    expectExactCapabilityContracts(direct, "direct");
  });
});

describe("#4577 standalone Calendar behavior and authority", () => {
  it("runs the deterministic 12-render DOM/callback/Date oracle in IR and direct lanes", async () => {
    const [ir, direct] = await Promise.all([compileRuntimeExact(true), compileRuntimeExact(false)]);
    expectExactCalendarIrOwnership(ir);
    expectExactCapabilityContracts(ir, "IR");
    expectExactCapabilityContracts(direct, "direct");
    const [irEvidence, directEvidence] = await Promise.all([
      exerciseCalendar(ir, "IR"),
      exerciseCalendar(direct, "direct"),
    ]);

    expect(snapshot(irEvidence.root)).toEqual(snapshot(directEvidence.root));
    expect(irEvidence.stdout).toBe("saved 4-10\n");
    expect(irEvidence.stdout).toBe(directEvidence.stdout);
    expect(irEvidence.callbackCreations).toBe(1_120);
    expect(irEvidence.callbackCreations).toBe(directEvidence.callbackCreations);
    expect(irEvidence.clockSnapshots).toBe(14);
    expect(irEvidence.clockEvents).toEqual(directEvidence.clockEvents);
    expect(irEvidence.boundaryCount).toBe(directEvidence.boundaryCount);
  });

  it("fails closed without the DOM root and after interaction or clock metadata tampering", async () => {
    const result = await compileExact(true);
    expectExactCalendarIrOwnership(result);
    expectExactCapabilityContracts(result, "IR");

    expect(() => buildCompiledImports(result)).toThrow(/dom.+root|root.+dom/i);
    const root = new FakeDomRoot([]);
    const manifest = result.adapterManifest!;
    const interaction = manifest.capabilities.find(({ id }) => id === DOM_INTERACTION_CAPABILITY_ID)!;
    const relabelledInteraction = {
      ...manifest,
      capabilities: manifest.capabilities.map((capability) =>
        capability === interaction ? { ...capability, id: "not-dom-interaction" } : capability,
      ),
    } as unknown as NonNullable<CompileResult["adapterManifest"]>;
    expect(() =>
      buildCompiledAdapterImports(relabelledInteraction, { dateNow: () => CLOCK_EPOCH_MS }, { domRoot: root }),
    ).toThrow(/belongs|interaction|capability/i);

    const clockTampered = {
      ...manifest,
      capabilities: manifest.capabilities.map((capability) =>
        capability.id === "clock" ? { ...capability, abiVersion: 2 } : capability,
      ),
    } as unknown as NonNullable<CompileResult["adapterManifest"]>;
    expect(() =>
      buildCompiledAdapterImports(clockTampered, { dateNow: () => CLOCK_EPOCH_MS }, { domRoot: root }),
    ).toThrow(/version|clock|capability/i);
  });
});

describe("#4577 standalone Calendar direct retirement", () => {
  it("bypasses all nine direct function bodies while the poison seam remains live", async () => {
    const previous = process.env.JS2WASM_TEST_POISON_DIRECT_FUNCTION_BODY;
    try {
      process.env.JS2WASM_TEST_POISON_DIRECT_FUNCTION_BODY = FUNCTION_TERMINALS.join(",");
      const result = await compileCalendarFresh(SOURCE, true, "issue-4577-calendar-function-poisoned.ts");
      expectExactCalendarIrOwnership(result);
      expectExactCapabilityContracts(result, "IR");
    } finally {
      if (previous === undefined) Reflect.deleteProperty(process.env, "JS2WASM_TEST_POISON_DIRECT_FUNCTION_BODY");
      else process.env.JS2WASM_TEST_POISON_DIRECT_FUNCTION_BODY = previous;
    }
  });

  it("keeps an unregistered DOM near miss direct/Unsupported and proves function poison can fire", async () => {
    const previous = process.env.JS2WASM_TEST_POISON_DIRECT_FUNCTION_BODY;
    try {
      process.env.JS2WASM_TEST_POISON_DIRECT_FUNCTION_BODY = "main";
      const nearMissSource = SOURCE.replace(
        "const host = document.body;",
        'const host = document.querySelector("body") as HTMLElement;',
      );
      expect(nearMissSource).not.toBe(SOURCE);
      const result = await compileCalendarFresh(nearMissSource, true, "issue-4577-calendar-dom-near-miss.ts");
      expect(result.success).toBe(false);
      expect(result.errors.map(({ message }) => message).join("\n")).toContain(
        "injected direct function-body poison: main",
      );
      expect(outcome(result, "function", "main")).toMatchObject({
        kind: "unsupported",
        legacyBodyEmitted: true,
        irBodyEmitted: false,
      });
      expect(evaluateIrOutcomePolicy([outcome(result, "function", "main")], "ir-only").ready).toBe(false);
    } finally {
      if (previous === undefined) Reflect.deleteProperty(process.env, "JS2WASM_TEST_POISON_DIRECT_FUNCTION_BODY");
      else process.env.JS2WASM_TEST_POISON_DIRECT_FUNCTION_BODY = previous;
    }
  });

  it("bypasses direct module-init while an explicit-Date near miss still reaches the poison", async () => {
    const previous = process.env.JS2WASM_TEST_POISON_DIRECT_MODULE_INIT_BODY;
    try {
      const retired = await compileCalendarFresh(SOURCE, true, "issue-4577-calendar-module-init-poisoned.ts");
      expectExactCalendarIrOwnership(retired);
      expectExactCapabilityContracts(retired, "IR");

      const controlSource = `let value = new Date(1); export function read(): number { return value.getTime(); }`;
      const unsupported = await compile(controlSource, {
        fileName: "issue-4577-calendar-explicit-date-module-init-control.ts",
        target: "standalone",
        experimentalIR: true,
        trackFallbacks: true,
        trackIrOutcomes: true,
      });
      expectSuccess(unsupported);
      expect(outcome(unsupported, "module-init", "<module-init>")).toMatchObject({
        kind: "unsupported",
        legacyBodyEmitted: true,
        irBodyEmitted: false,
      });

      process.env.JS2WASM_TEST_POISON_DIRECT_MODULE_INIT_BODY = "1";
      const poisoned = await compile(controlSource, {
        fileName: "issue-4577-calendar-explicit-date-module-init-poison-control.ts",
        target: "standalone",
        experimentalIR: true,
        trackFallbacks: true,
        trackIrOutcomes: true,
      });
      expect(poisoned.success).toBe(false);
      expect(poisoned.errors.map(({ message }) => message).join("\n")).toContain(
        "injected direct module-init body poison",
      );
    } finally {
      if (previous === undefined) Reflect.deleteProperty(process.env, "JS2WASM_TEST_POISON_DIRECT_MODULE_INIT_BODY");
      else process.env.JS2WASM_TEST_POISON_DIRECT_MODULE_INIT_BODY = previous;
    }
  });
});

describe("#4577 standalone Calendar optimization and artifact parity", () => {
  it("retains direct arithmetic/DOM shapes and seven static callback bodies", async () => {
    const [ir, direct] = await Promise.all([compileExact(true), compileExact(false)]);
    expectExactCalendarIrOwnership(ir);
    expectExactCapabilityContracts(ir, "IR");
    expectExactCapabilityContracts(direct, "direct");
    expectCalendarOptimizationReference(ir, "IR");
    expectCalendarOptimizationReference(direct, "direct");

    const irNames = parseWatFunctions(ir.wat).map(({ name }) => name);
    expect(irNames.filter((name) => /^__cb_\d+$/.test(name))).toEqual([]);
    expectExactMultiset(
      irNames.filter((name) => /__closure_\d+$/.test(name) || /^__cb_\d+$/.test(name)),
      STATIC_DERIVED_CALLBACK_NAMES,
      "exact final static callback body multiset",
    );
    for (const { owner, name } of STATIC_DERIVED_CALLBACKS) {
      expect(name.startsWith(`${owner}__closure_`), `${name} callback owner`).toBe(true);
      expectNoGenericBodyMachinery(ir, name);
    }
    expect(targetCount(ir, "renderCal__closure_0", "onDay")).toBe(1);
    expect(targetCount(ir, "renderCal__closure_1", "CSSStyleDeclaration_set_background")).toBe(1);
    expect(targetCount(ir, "renderCal__closure_2", "CSSStyleDeclaration_set_background")).toBe(1);
    for (const name of ["main__closure_0", "main__closure_1", "main__closure_2"] as const) {
      expect(targetCount(ir, name, "updFoot")).toBe(1);
      expect(targetCount(ir, name, "renderCal")).toBe(1);
    }
    expect(targetCount(ir, "main__closure_3", "__stdout_append")).toBe(1);

    expectExactMultiset(
      parseWatFunctions(direct.wat)
        .map(({ name }) => name)
        .filter((name) => /^__cb_\d+$/.test(name)),
      DIRECT_CALLBACK_NAMES,
      "direct callback body multiset",
    );
    const directExportNames = WebAssembly.Module.exports(new WebAssembly.Module(direct.binary)).map(({ name }) => name);
    expect(directExportNames).not.toContain("__\0js2_closure_host_bridge");

    const irConcatTargets = watCallTargets(ir.wat, watFunction(ir, "renderCal").body).filter((target) =>
      /concat/i.test(target),
    );
    const directConcatTargets = watCallTargets(direct.wat, watFunction(direct, "renderCal").body).filter((target) =>
      /concat/i.test(target),
    );
    expect(irConcatTargets).toEqual(directConcatTargets);
  });

  it("keeps tuned Calendar artifacts at or below the direct-relative ceilings", async () => {
    const previous = process.env.JS2WASM_IR_INLINE;
    Reflect.deleteProperty(process.env, "JS2WASM_IR_INLINE");
    try {
      const [ir, direct] = await Promise.all([
        compileCalendar(true, FILE_NAME, 4),
        compileCalendar(false, FILE_NAME, 4),
      ]);
      expectExactCalendarIrOwnership(ir);
      expectExactCapabilityContracts(ir, "IR");
      expectExactCapabilityContracts(direct, "direct");

      const irBodyNames = [...FUNCTION_TERMINALS, "__module_init", ...STATIC_DERIVED_CALLBACK_NAMES];
      const directBodyNames = [...FUNCTION_TERMINALS, "__module_init", ...DIRECT_CALLBACK_NAMES];
      const irMetrics = artifactMetrics(ir, irBodyNames);
      const directMetrics = artifactMetrics(direct, directBodyNames);
      expect(Object.keys(irMetrics)).toEqual(Object.keys(directMetrics));
      for (const metric of ["raw", "gzip", "wat", "body", "locals", "calls", "imports"] as const) {
        expect
          .soft(irMetrics[metric], `${metric}: IR ${irMetrics[metric]} <= direct ${directMetrics[metric]}`)
          .toBeLessThanOrEqual(directMetrics[metric]!);
      }
      expect
        .soft(irMetrics.functions, `functions: IR ${irMetrics.functions} <= direct ${directMetrics.functions} + 3`)
        .toBeLessThanOrEqual(directMetrics.functions! + 3);

      const repeat = await compileCalendarFresh(SOURCE, true, FILE_NAME, 4);
      expectExactCalendarIrOwnership(repeat);
      expect(repeat.binary, "repeat tuned IR build bytes").toEqual(ir.binary);
      expect(repeat.wat, "repeat tuned IR WAT").toBe(ir.wat);

      const irRenderCal = bodySizeMetrics(ir, ["renderCal"]);
      const directRenderCal = bodySizeMetrics(direct, ["renderCal"]);
      expect(irRenderCal.locals).toBeLessThanOrEqual(directRenderCal.locals);
      expect(irRenderCal.bytes).toBeLessThanOrEqual(directRenderCal.bytes);
      expect(bodySizeMetrics(ir, ["main"]).bytes).toBeLessThanOrEqual(bodySizeMetrics(direct, ["main"]).bytes);
    } finally {
      if (previous === undefined) Reflect.deleteProperty(process.env, "JS2WASM_IR_INLINE");
      else process.env.JS2WASM_IR_INLINE = previous;
    }
  });
});
