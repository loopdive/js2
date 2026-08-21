// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #3523 Calendar retirement acceptance.
//
// The independent browser/clock oracle, exact terminal census, compile-once
// poison controls, atomic preflight failures, and direct-relative Wasm shape
// ceilings prove the ten-body component as one transaction. Seven statically
// emitted callback artifacts are not the same thing as the 1,120 callback
// objects created by the scripted runtime exercise.

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { gzipSync } from "node:zlib";

import { describe, expect, it } from "vitest";

import { compile, type CompileResult, type IrObservedOutcome } from "../src/index.js";
import { evaluateIrOutcomePolicy } from "../src/ir/outcomes.js";
import { buildImports } from "../src/runtime.js";

const SOURCE_URL = new URL("../website/playground/examples/dom/calendar.ts", import.meta.url);
const SOURCE = readFileSync(SOURCE_URL, "utf8");

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
const COMPILED_ARTIFACT_NAMES = [...FUNCTION_TERMINALS, "<module-init>", ...STATIC_DERIVED_CALLBACK_NAMES] as const;

const CLOCK_EPOCH_MS = 1_734_220_800_000; // 2024-12-15T00:00:00.000Z
const BODY_CSS = "margin:0;background:#111;color:#ddd;font-family:system-ui,sans-serif;overflow:hidden";
const WEEKDAYS = ["MON", "TUE", "WED", "THU", "FRI", "SAT", "SUN"] as const;

class FakeStyle {
  cssText = "";
  background = "";
}

class FakeElement {
  readonly style = new FakeStyle();
  readonly children: FakeElement[] = [];
  readonly listeners = new Map<string, Function[]>();
  textContent = "";
  private html = "";

  constructor(
    readonly tagName: string,
    private readonly registrations: { type: string; target: FakeElement }[],
  ) {}

  get innerHTML(): string {
    return this.html;
  }

  set innerHTML(value: string) {
    this.html = String(value);
    if (value === "") this.children.length = 0;
  }

  appendChild(child: FakeElement): FakeElement {
    this.children.push(child);
    return child;
  }

  addEventListener(type: string, listener: Function): void {
    const listeners = this.listeners.get(type) ?? [];
    listeners.push(listener);
    this.listeners.set(type, listeners);
    this.registrations.push({ type: String(type), target: this });
  }

  dispatch(type: string): void {
    const listeners = this.listeners.get(type) ?? [];
    expect(listeners, `${this.tagName} ${type} listener count`).toHaveLength(1);
    expect(listeners[0]!({ type, target: this }), `${type} callback return`).toBeUndefined();
  }
}

class FakeDocument {
  readonly registrations: { type: string; target: FakeElement }[] = [];
  readonly body = new FakeElement("body", this.registrations);

  createElement(tagName: string): FakeElement {
    return new FakeElement(String(tagName), this.registrations);
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
  readonly document: FakeDocument;
  readonly logs: string[];
  readonly callbackCreations: number;
  readonly clockSnapshots: number;
  readonly clockEvents: readonly string[];
}

interface WatFunction {
  readonly name: string;
  readonly body: string;
}

let irCompile: Promise<CompileResult> | undefined;
let directCompile: Promise<CompileResult> | undefined;

function compileCalendar(experimentalIR: boolean): Promise<CompileResult> {
  const cached = experimentalIR ? irCompile : directCompile;
  if (cached) return cached;
  const started = compile(SOURCE, {
    fileName: "website/playground/examples/dom/calendar.ts",
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

function compileCalendarFresh(source: string, experimentalIR: boolean, fileName: string): Promise<CompileResult> {
  return compile(source, {
    fileName,
    experimentalIR,
    trackFallbacks: true,
    trackIrOutcomes: true,
    emitWat: true,
    target: "gc",
  });
}

function expectSuccess(result: CompileResult): void {
  expect(result.success, result.errors.map((error) => error.message).join("\n")).toBe(true);
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
  const matches = parseWatFunctions(result.wat).filter((fn) => fn.name === name);
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
  const globals = [...wat.matchAll(/^\s*\(global \$([^\s(]+)/gm)].map((match) => match[1]!);
  const index = [...imports, ...globals].indexOf(name);
  return index < 0 ? undefined : index;
}

function expectExactMultiset(actual: readonly string[], expected: readonly string[], label: string): void {
  expect([...actual].sort(), label).toEqual([...expected].sort());
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

function countMatches(value: string, pattern: RegExp): number {
  return value.match(pattern)?.length ?? 0;
}

function targetCount(result: CompileResult, name: string, target: string): number {
  return watCallTargets(result.wat, watFunction(result, name).body).filter((candidate) => candidate === target).length;
}

function expectNoGenericBodyMachinery(result: CompileResult, name: string): void {
  const body = watFunction(result, name).body;
  const targets = watCallTargets(result.wat, body);
  expect(body).not.toMatch(/\b(?:call_ref|call_indirect)\b/);
  for (const globalName of ["__current_this", "__argc", "__arguments"] as const) {
    const globalIndex = watGlobalIndex(result.wat, globalName);
    if (globalIndex !== undefined) {
      expect(body, `${name} must not access $${globalName}`).not.toMatch(
        new RegExp(`\\bglobal\\.(?:get|set) ${globalIndex}\\b`),
      );
    }
  }
  expect(targets).not.toEqual(
    expect.arrayContaining([expect.stringMatching(/(?:^|_)(?:box|unbox|argc|arguments)(?:_|$)/)]),
  );
  expect(targets).not.toEqual(
    expect.arrayContaining([expect.stringMatching(/__extern_(?:get|set|call|method_call|new)/)]),
  );
}

function calendarDom(document: FakeDocument): CalendarDom {
  expect(document.body.children, "body child count").toHaveLength(1);
  const wrap = document.body.children[0]!;
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

async function exerciseCalendar(
  result: CompileResult,
  lane: "direct" | "ir",
  clockMode: "import" | "source" = "import",
): Promise<RuntimeEvidence> {
  expectSuccess(result);
  const document = new FakeDocument();
  document.body.innerHTML = "<stale>";
  document.body.appendChild(new FakeElement("stale", document.registrations));

  const built = buildImports(result.imports, { document }, result.stringPool);
  const env = built.env as Record<string, (...args: unknown[]) => unknown>;
  const logs: string[] = [];
  const clockEvents: string[] = [];
  let clockSnapshots = 0;
  let callbackCreations = 0;

  const originalCallbackMaker = env.__make_callback;
  expect(originalCallbackMaker, `${lane} callback maker`).toBeTypeOf("function");
  env.__make_callback = (...args: unknown[]) => {
    callbackCreations++;
    return originalCallbackMaker!(...args);
  };
  env.console_log_string = (value: unknown) => void logs.push(String(value));

  if (clockMode === "import") {
    expect(env.__date_now, `${lane} Date clock import`).toBeTypeOf("function");
    env.__date_now = () => {
      clockSnapshots++;
      clockEvents.push(`now:${clockSnapshots - 1}`);
      return CLOCK_EPOCH_MS;
    };
  } else {
    expect(env.__date_now, `${lane} source-owned Date clock`).toBeUndefined();
  }

  const importObject: WebAssembly.Imports = {
    env: built.env,
    "wasm:js-string": built["wasm:js-string"],
    string_constants: built.string_constants,
    string_constants16: built.string_constants16,
  };
  const { instance } = await WebAssembly.instantiate(result.binary, importObject);
  built.setInstance?.(instance);
  built.setExports?.(instance.exports as Record<string, Function>);
  (instance.exports.main as () => void)();

  let dom = calendarDom(document);
  expect(document.body.innerHTML).toBe("");
  expect(document.body.style.cssText).toBe(BODY_CSS);
  expectWeekdays(dom.weekdayHeader);
  expectWeekdays(dom.weekdayFooter);
  expectMonth(dom, "Dec", "2024", 42);
  expect(dayCell(dom, 15).style.cssText).toContain("background:#7c3aed");

  dom.next.dispatch("click");
  dom = calendarDom(document);
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
  dom = calendarDom(document);
  expectMonth(dom, "Jan", "2025", 35);
  dayCell(dom, 9).dispatch("click");
  dom = calendarDom(document);
  expect(dom.nights.textContent).toBe("4 nights");
  expect(dom.total.textContent).toBe("2300 \u20ac");

  dayCell(dom, 20).dispatch("click");
  dom = calendarDom(document);
  expectMonth(dom, "Jan", "2025", 35);
  dayCell(dom, 15).dispatch("click");
  dom = calendarDom(document);
  expect(dom.nights.textContent).toBe("5 nights");
  expect(dom.total.textContent).toBe("2800 \u20ac");

  dayCell(dom, 10).dispatch("click");
  dom = calendarDom(document);
  expectMonth(dom, "Jan", "2025", 35);
  dayCell(dom, 10).dispatch("click");
  dom = calendarDom(document);
  expectMonth(dom, "Jan", "2025", 35);

  dayCell(dom, 4).dispatch("click");
  dom = calendarDom(document);
  expectMonth(dom, "Jan", "2025", 35);
  dayCell(dom, 10).dispatch("click");
  dom = calendarDom(document);
  expect(dom.nights.textContent).toBe("6 nights");
  expect(dom.total.textContent).toBe("2550 \u20ac");
  dom.save.dispatch("click");
  expect(logs).toEqual(["saved 4-10"]);

  dom.clear.dispatch("click");
  dom = calendarDom(document);
  expectMonth(dom, "Jan", "2025", 35);
  dom.previous.dispatch("click");
  dom = calendarDom(document);
  expectMonth(dom, "Dec", "2024", 42);

  expect(document.registrations, "4 fixed + 12 renders × 31 days × 3 listeners").toHaveLength(1_120);
  expect(callbackCreations, "one runtime callback object per registration").toBe(1_120);
  if (clockMode === "import") {
    expect(clockSnapshots, "two module snapshots plus one per render").toBe(14);
    expect(clockEvents).toEqual(Array.from({ length: 14 }, (_, id) => `now:${id}`));
  } else {
    expect(clockSnapshots).toBe(0);
    expect(clockEvents).toEqual([]);
  }

  return { document, logs, callbackCreations, clockSnapshots, clockEvents };
}

function semanticDomSnapshot(element: FakeElement): unknown {
  return {
    tagName: element.tagName,
    cssText: element.style.cssText,
    background: element.style.background,
    textContent: element.textContent,
    innerHTML: element.innerHTML,
    listenerTypes: [...element.listeners.keys()].sort(),
    children: element.children.map(semanticDomSnapshot),
  };
}

function expectDirectOptimizationReference(result: CompileResult, lane: "direct" | "ir" = "direct"): void {
  expect(targetCount(result, "dimOf", "__fmod")).toBe(3);

  const fdow = watFunction(result, "fdow").body;
  expect(targetCount(result, "fdow", "__fmod")).toBe(2);
  expect(countMatches(fdow, /\bf64\.div\b/g)).toBe(3);
  expect(countMatches(fdow, /\bf64\.trunc\b/g)).toBe(2);
  expect(countMatches(fdow, /\bi64\.rem_s\b/g)).toBe(2);
  expect(countMatches(fdow, /\barray\.get(?:_[su])?\b/g)).toBe(1);
  expect(countMatches(fdow, /\bi32\.and\b/g)).toBe(7);

  expect(targetCount(result, "renderCal", "number_toString")).toBe(7);
  expect(targetCount(result, "renderCal", "Element_set_textContent")).toBe(8);
  expect(targetCount(result, "renderCal", "__concat_7")).toBe(1);
  expect(targetCount(result, "renderCal", "__concat_8")).toBe(0);

  expect(targetCount(result, "updFoot", "number_toString")).toBe(2);
  expect(targetCount(result, "updFoot", "concat")).toBe(2);
  expect(targetCount(result, "updFoot", "Element_set_textContent")).toBe(4);

  const main = watFunction(result, "main").body;
  expect(countMatches(main, /\barray\.new_fixed\b/g)).toBe(1);
  expect(countMatches(main, /\bi32\.lt_s\b/g)).toBe(2);
  expect(countMatches(main, /\bi32\.lt_u\b/g)).toBe(lane === "ir" ? 0 : 2);
  expect(countMatches(main, /\barray\.get(?:_[su])?\b/g)).toBe(2);
  for (const name of FUNCTION_TERMINALS) expectNoGenericBodyMachinery(result, name);
  expect(targetCount(result, "dimOf", "__new_ReferenceError")).toBe(0);
}

function expectFinalIrOptimizationParity(result: CompileResult): void {
  expectDirectOptimizationReference(result, "ir");
  expect(targetCount(result, "renderCal", "__date_now")).toBe(1);
  expect(targetCount(result, "renderCal", "__date_civil_from_days")).toBe(3);
  expect(targetCount(result, "__module_init", "__date_now")).toBe(2);
  expect(targetCount(result, "__module_init", "__date_civil_from_days")).toBe(2);
  expect(parseWatFunctions(result.wat).some(({ name }) => name === "__ir_date_snapshot_get")).toBe(false);
  for (const legacyTarget of ["Date_new", "Date_getDate", "Date_getMonth", "Date_getFullYear"] as const) {
    expect(targetCount(result, "renderCal", legacyTarget)).toBe(0);
    expect(targetCount(result, "__module_init", legacyTarget)).toBe(0);
  }
  for (const name of ["renderCal", "onDay", "updFoot", "main"] as const) {
    expect(targetCount(result, name, "__new_ReferenceError"), `${name} redundant module TDZ guards`).toBe(0);
  }
}

describe("#3523 Calendar retirement oracle and current baseline", () => {
  it("runs an independent 12-render DOM/Date oracle in both lanes", async () => {
    const [direct, ir] = await Promise.all([compileCalendar(false), compileCalendar(true)]);
    const directEvidence = await exerciseCalendar(direct, "direct");
    const irEvidence = await exerciseCalendar(ir, "ir");
    expect(semanticDomSnapshot(irEvidence.document.body)).toEqual(semanticDomSnapshot(directEvidence.document.body));
    expect(irEvidence.logs).toEqual(directEvidence.logs);
  });

  it("records zero legacy bodies and seven exact derived callback artifacts", async () => {
    const result = await compileCalendar(true);
    expectSuccess(result);
    const observedKeys = (result.irOutcomes ?? [])
      .map(({ unitKind, displayName }) => `${unitKind}:${displayName}`)
      .sort();
    expect(observedKeys).toEqual(ALL_TERMINALS.map(({ unitKind, displayName }) => `${unitKind}:${displayName}`).sort());

    const terminals = ALL_TERMINALS.map(({ unitKind, displayName }) => outcome(result, unitKind, displayName));
    expect(terminals.filter(({ kind }) => kind === "unsupported" || kind === "invariant")).toEqual([]);
    expect(terminals.filter(({ irBodyEmitted }) => irBodyEmitted)).toHaveLength(10);
    expect(terminals.filter(({ legacyBodyEmitted }) => legacyBodyEmitted)).toHaveLength(0);

    const compiled = new Set(result.irCompiledFuncs ?? []);
    for (const { owner, name } of STATIC_DERIVED_CALLBACKS) {
      expect(name.startsWith(`${owner}__closure_`), `${name} terminal owner`).toBe(true);
      expect(compiled.has(name), `${name} genuinely IR emitted`).toBe(true);
      expect(
        parseWatFunctions(result.wat).filter((fn) => fn.name === name),
        `unique static artifact ${name}`,
      ).toHaveLength(1);
    }
    expect([...compiled].filter((name) => /__closure_\d+$/.test(name)).sort()).toEqual(
      STATIC_DERIVED_CALLBACKS.map(({ name }) => name).sort(),
    );
  });

  it("pins the direct backend's optimization shapes as a deterministic retirement reference", async () => {
    const [direct, repeat] = await Promise.all([
      compileCalendar(false),
      compileCalendarFresh(SOURCE, false, "website/playground/examples/dom/calendar.ts"),
    ]);
    expectSuccess(direct);
    expectSuccess(repeat);
    expectDirectOptimizationReference(direct);
    expect([...repeat.binary], "repeat direct build bytes").toEqual([...direct.binary]);
    for (const name of ["renderCal", "onDay", "updFoot", "main"] as const) {
      expect(targetCount(direct, name, "__new_ReferenceError"), `${name} direct TDZ helper count`).toBe(0);
    }
    const importNames = direct.imports.map(({ name }) => name);
    expect(importNames).toContain("__date_now");
    expect(importNames).not.toEqual(
      expect.arrayContaining(["Date_new", "Date_getDate", "Date_getMonth", "Date_getFullYear"]),
    );
    expectExactMultiset(
      parseWatFunctions(direct.wat)
        .map(({ name }) => name)
        .filter((name) => /^__cb_\d+$/.test(name)),
      DIRECT_CALLBACK_NAMES,
      "direct callback body multiset",
    );
  });

  it("prepares unique string support through an ordinary for-loop before direct emission", async () => {
    const functionName = "issue3523PreparedDeepStringLoop";
    const literal = "__calendar_deep_loop_literal__";
    const previous = process.env.JS2WASM_TEST_POISON_DIRECT_FUNCTION_BODY;
    try {
      process.env.JS2WASM_TEST_POISON_DIRECT_FUNCTION_BODY = functionName;
      const result = await compile(
        `export function ${functionName}(count: number): string {
          let output = "";
          for (let index = 0; index < count; index++) output = output + "${literal}";
          return output;
        }`,
        {
          fileName: "issue-3523-prepared-deep-string-loop.ts",
          experimentalIR: true,
          trackFallbacks: true,
          trackIrOutcomes: true,
          target: "gc",
        },
      );
      expectSuccess(result);
      expect(outcome(result, "function", functionName)).toMatchObject({
        kind: "emitted",
        legacyBodyEmitted: false,
        irBodyEmitted: true,
        preparedComponentId: expect.stringMatching(/^prepared-component:/),
      });
      expect(result.stringPool).toContain(literal);
      const imports = buildImports(result.imports, undefined, result.stringPool);
      const { instance } = await WebAssembly.instantiate(result.binary, imports);
      imports.setExports?.(instance.exports as Record<string, Function>);
      expect((instance.exports[functionName] as (count: number) => string)(2)).toBe(literal + literal);
    } finally {
      if (previous === undefined) Reflect.deleteProperty(process.env, "JS2WASM_TEST_POISON_DIRECT_FUNCTION_BODY");
      else process.env.JS2WASM_TEST_POISON_DIRECT_FUNCTION_BODY = previous;
    }
  });

  it("removes TDZ helpers while preserving the direct arithmetic and host-call shapes", async () => {
    const [direct, ir] = await Promise.all([compileCalendar(false), compileCalendar(true)]);
    expectSuccess(direct);
    expectSuccess(ir);

    const directFdow = watFunction(direct, "fdow").body;
    const irFdow = watFunction(ir, "fdow").body;
    expect({
      fmod: targetCount(ir, "fdow", "__fmod"),
      div: countMatches(irFdow, /\bf64\.div\b/g),
      trunc: countMatches(irFdow, /\bf64\.trunc\b/g),
      remainder: countMatches(irFdow, /\bi64\.rem_s\b/g),
      arrayGet: countMatches(irFdow, /\barray\.get(?:_[su])?\b/g),
      i32And: countMatches(irFdow, /\bi32\.and\b/g),
    }).toEqual({ fmod: 2, div: 3, trunc: 2, remainder: 2, arrayGet: 1, i32And: 7 });
    expect(countMatches(directFdow, /\bf64\.div\b/g)).toBe(3);

    expectFinalIrOptimizationParity(ir);
    expectDirectOptimizationReference(direct);
  });
});

describe("#3523 Calendar final ten-body retirement gate", () => {
  it("seals the exact ten terminals as one prepared IR component with zero legacy bodies", async () => {
    const result = await compileCalendar(true);
    expectSuccess(result);
    const outcomes = result.irOutcomes ?? [];
    expectExactMultiset(
      outcomes.map(({ unitKind, displayName }) => `${unitKind}:${displayName}`),
      ALL_TERMINALS.map(({ unitKind, displayName }) => `${unitKind}:${displayName}`),
      "exact ten-row terminal outcome universe",
    );
    const componentIds = new Set<string>();
    for (const terminal of ALL_TERMINALS) {
      const observed = outcome(result, terminal.unitKind, terminal.displayName);
      expect(observed).toMatchObject({
        kind: "emitted",
        legacyBodyEmitted: false,
        irBodyEmitted: true,
        preparedComponentId: expect.stringMatching(/^prepared-component:/),
      });
      componentIds.add(observed.preparedComponentId!);
    }
    expect(componentIds.size).toBe(1);
    expect(evaluateIrOutcomePolicy(outcomes, "ir-only")).toEqual({
      policy: "ir-only",
      ready: true,
      blockers: [],
    });
    expectExactMultiset(
      result.irCompiledFuncs ?? [],
      COMPILED_ARTIFACT_NAMES,
      "ten terminals + seven derived artifacts",
    );
    expectExactMultiset(result.irFirstSkipped ?? [], FUNCTION_TERMINALS, "exact nine compile-once function skips");
    for (const artifact of COMPILED_ARTIFACT_NAMES) {
      const watName = artifact === "<module-init>" ? "__module_init" : artifact;
      expect(
        parseWatFunctions(result.wat).filter(({ name }) => name === watName),
        `unique compiled artifact $${watName}`,
      ).toHaveLength(1);
    }
    expect(result.irPostClaimErrors ?? []).toEqual([]);
  });

  it("retains all direct optimizations and removes legacy callback artifacts", async () => {
    const [result, direct] = await Promise.all([
      compileCalendar(true),
      compileCalendarFresh(SOURCE, false, "website/playground/examples/dom/calendar-direct-parity.ts"),
    ]);
    expectSuccess(result);
    expectSuccess(direct);
    expectFinalIrOptimizationParity(result);
    const names = parseWatFunctions(result.wat).map(({ name }) => name);
    expect(names.filter((name) => /^__cb_\d+$/.test(name))).toEqual([]);
    expectExactMultiset(
      names.filter((name) => /__closure_\d+$/.test(name) || /^__cb_\d+$/.test(name)),
      STATIC_DERIVED_CALLBACK_NAMES,
      "exact final callback body multiset",
    );
    for (const name of ["el", "__module_init", ...STATIC_DERIVED_CALLBACK_NAMES]) {
      expectNoGenericBodyMachinery(result, name);
    }

    const directCallbackNames = parseWatFunctions(direct.wat)
      .map(({ name }) => name)
      .filter((name) => /^__cb_\d+$/.test(name));
    expectExactMultiset(directCallbackNames, DIRECT_CALLBACK_NAMES, "fresh direct callback body multiset");

    const repeat = await compileCalendarFresh(SOURCE, true, "website/playground/examples/dom/calendar.ts");
    expectSuccess(repeat);
    expect([...repeat.binary], "repeat IR build bytes").toEqual([...result.binary]);
    expect(createHash("sha256").update(repeat.binary).digest("hex")).toBe(
      createHash("sha256").update(result.binary).digest("hex"),
    );

    const irRenderCal = bodySizeMetrics(result, ["renderCal"]);
    const directRenderCal = bodySizeMetrics(direct, ["renderCal"]);
    const directRenderCalWat = watFunction(direct, "renderCal").body;
    expect(directRenderCal.locals, "direct renderCal local-count reference").toBe(66);
    expect(targetCount(direct, "renderCal", "mname"), "default user inlining reference").toBe(0);
    expect(countMatches(directRenderCalWat, /\bf64\.trunc\b/g), "two guarded remainder sites").toBe(2);
    expect(countMatches(directRenderCalWat, /\bi64\.rem_s\b/g), "inlined integer remainder paths").toBe(6);
    expect(irRenderCal.locals, "IR renderCal local-pressure no-regression ceiling").toBeLessThanOrEqual(72);
    expect(irRenderCal.bytes, "renderCal body-size parity ceiling").toBeLessThanOrEqual(directRenderCal.bytes);

    const irMain = bodySizeMetrics(result, ["main"]);
    const directMain = bodySizeMetrics(direct, ["main"]);
    expect(irMain.bytes, "main body-size parity ceiling").toBeLessThanOrEqual(directMain.bytes);

    const irAggregate = bodySizeMetrics(result, [
      ...FUNCTION_TERMINALS,
      "__module_init",
      ...STATIC_DERIVED_CALLBACK_NAMES,
    ]);
    const directAggregate = bodySizeMetrics(direct, [...FUNCTION_TERMINALS, "__module_init", ...DIRECT_CALLBACK_NAMES]);
    expect(directAggregate.locals, "direct Calendar aggregate local-count reference").toBe(151);
    expect(irAggregate.locals, "IR Calendar aggregate local-pressure no-regression ceiling").toBeLessThanOrEqual(137);
    expect(irAggregate.locals, "IR Calendar aggregate local-pressure direct parity").toBeLessThanOrEqual(
      directAggregate.locals,
    );
    expect(irAggregate.bytes, "aggregate Calendar body-size parity ceiling").toBeLessThanOrEqual(directAggregate.bytes);
    expect(result.binary.length, "whole Calendar binary-size parity ceiling").toBeLessThanOrEqual(direct.binary.length);
    expect(gzipSync(result.binary).length, "gzipped Calendar binary-size parity ceiling").toBeLessThanOrEqual(
      gzipSync(direct.binary).length,
    );
    expect(result.wat.length, "whole Calendar WAT-size parity ceiling").toBeLessThanOrEqual(direct.wat.length);

    const irModule = new WebAssembly.Module(result.binary);
    const directModule = new WebAssembly.Module(direct.binary);
    expect(WebAssembly.Module.imports(irModule).length).toBeLessThanOrEqual(
      WebAssembly.Module.imports(directModule).length + 4,
    );
    expect(parseWatFunctions(result.wat).length).toBeLessThanOrEqual(parseWatFunctions(direct.wat).length + 3);
  });

  it("never enters any of the nine direct function bodies", async () => {
    const previous = process.env.JS2WASM_TEST_POISON_DIRECT_FUNCTION_BODY;
    const controlName = "issue3523CalendarOrdinaryDirectPoisonControl";
    try {
      process.env.JS2WASM_TEST_POISON_DIRECT_FUNCTION_BODY = FUNCTION_TERMINALS.join(",");
      const result = await compile(SOURCE, {
        fileName: "website/playground/examples/dom/calendar-function-poisoned.ts",
        experimentalIR: true,
        trackFallbacks: true,
        trackIrOutcomes: true,
        target: "gc",
      });
      expectSuccess(result);
      for (const name of FUNCTION_TERMINALS) {
        expect(outcome(result, "function", name)).toMatchObject({
          kind: "emitted",
          legacyBodyEmitted: false,
          irBodyEmitted: true,
          preparedComponentId: expect.stringMatching(/^prepared-component:/),
        });
      }

      process.env.JS2WASM_TEST_POISON_DIRECT_FUNCTION_BODY = controlName;
      const control = await compile(`export function ${controlName}(): number { return 7; }`, {
        fileName: "issue-3523-calendar-ordinary-direct-poison-control.ts",
        experimentalIR: false,
        target: "gc",
      });
      expect(control.success).toBe(false);
      expect(control.errors.map(({ message }) => message)).toContain(
        `Internal error compiling function '${controlName}': injected direct function-body poison: ${controlName}`,
      );
    } finally {
      if (previous === undefined) Reflect.deleteProperty(process.env, "JS2WASM_TEST_POISON_DIRECT_FUNCTION_BODY");
      else process.env.JS2WASM_TEST_POISON_DIRECT_FUNCTION_BODY = previous;
    }
  });

  it("never enters the direct module initializer while an unsupported control still reaches it", async () => {
    const previous = process.env.JS2WASM_TEST_POISON_DIRECT_MODULE_INIT_BODY;
    try {
      process.env.JS2WASM_TEST_POISON_DIRECT_MODULE_INIT_BODY = "1";
      const retired = await compile(SOURCE, {
        fileName: "website/playground/examples/dom/calendar-module-init-poisoned.ts",
        experimentalIR: true,
        trackFallbacks: true,
        trackIrOutcomes: true,
        target: "gc",
      });
      expectSuccess(retired);
      expect(outcome(retired, "module-init", "<module-init>")).toMatchObject({
        kind: "emitted",
        legacyBodyEmitted: false,
        irBodyEmitted: true,
        preparedComponentId: expect.stringMatching(/^prepared-component:/),
      });

      const control = await compile(`let value = new Date(0); export function read(): number { return 1; }`, {
        fileName: "issue-3523-calendar-unsupported-module-init-poison-control.ts",
        experimentalIR: true,
        target: "gc",
      });
      expect(control.success).toBe(false);
      expect(control.errors.map(({ message }) => message).join("\n")).toContain(
        "injected direct module-init body poison",
      );
    } finally {
      if (previous === undefined) Reflect.deleteProperty(process.env, "JS2WASM_TEST_POISON_DIRECT_MODULE_INIT_BODY");
      else process.env.JS2WASM_TEST_POISON_DIRECT_MODULE_INIT_BODY = previous;
    }
  });

  it.each([
    {
      label: "Date import",
      prefix: `function __date_now(): number { return ${CLOCK_EPOCH_MS}; }`,
      injection: undefined,
    },
    { label: "callback maker", prefix: "", injection: "callback" },
    { label: "typed DOM ABI", prefix: "", injection: "dom" },
  ])(
    "rejects the whole prepared component before mutation on a $label collision",
    async ({ label, prefix, injection }) => {
      const previous = process.env.JS2WASM_TEST_INJECT_IR_PREPARED_IMPORT_COLLISION;
      const collisionSource = `${prefix}\n${SOURCE}`;
      const collisionFileName = `website/playground/examples/dom/calendar-${label.replaceAll(" ", "-")}-collision.ts`;
      try {
        if (injection === undefined)
          Reflect.deleteProperty(process.env, "JS2WASM_TEST_INJECT_IR_PREPARED_IMPORT_COLLISION");
        else process.env.JS2WASM_TEST_INJECT_IR_PREPARED_IMPORT_COLLISION = injection;
        const [result, direct] = await Promise.all([
          compileCalendarFresh(collisionSource, true, collisionFileName),
          compileCalendarFresh(collisionSource, false, collisionFileName),
        ]);
        expectSuccess(result);
        expectSuccess(direct);
        const collisionOutcomes: IrObservedOutcome[] = [];
        for (const terminal of ALL_TERMINALS) {
          const observed = outcome(result, terminal.unitKind, terminal.displayName);
          collisionOutcomes.push(observed);
          expect(observed).toMatchObject({
            kind: "unsupported",
            code: "late-preparation-unsupported",
            stage: "resolve",
            legacyBodyEmitted: true,
            irBodyEmitted: false,
          });
          expect(observed.preparedComponentId).toBeUndefined();
        }
        expectExactMultiset(
          collisionOutcomes.map(({ unitKind, displayName }) => `${unitKind}:${displayName}`),
          ALL_TERMINALS.map(({ unitKind, displayName }) => `${unitKind}:${displayName}`),
          "exact rejected Calendar terminal universe",
        );
        expect(
          (result.irOutcomes ?? []).filter(({ preparedComponentId }) => preparedComponentId !== undefined),
        ).toEqual([]);

        const calendarArtifacts = new Set<string>(COMPILED_ARTIFACT_NAMES);
        expect((result.irCompiledFuncs ?? []).filter((name) => calendarArtifacts.has(name))).toEqual([]);
        expect((result.irFirstSkipped ?? []).filter((name) => calendarArtifacts.has(name))).toEqual([]);
        const resultNames = parseWatFunctions(result.wat).map(({ name }) => name);
        const derivedArtifactNames = new Set<string>(STATIC_DERIVED_CALLBACK_NAMES);
        expect(resultNames.filter((name) => derivedArtifactNames.has(name))).toEqual([]);

        expect(result.imports, "no imports leaked by failed IR preparation").toEqual(direct.imports);
        expect([...result.binary], "all-direct collision binary").toEqual([...direct.binary]);

        const clockMode = label === "Date import" ? "source" : "import";
        const fallbackEvidence = await exerciseCalendar(result, "direct", clockMode);
        const directEvidence = await exerciseCalendar(direct, "direct", clockMode);
        expect(semanticDomSnapshot(fallbackEvidence.document.body)).toEqual(
          semanticDomSnapshot(directEvidence.document.body),
        );
        expect(fallbackEvidence.logs).toEqual(directEvidence.logs);
      } finally {
        if (previous === undefined) {
          Reflect.deleteProperty(process.env, "JS2WASM_TEST_INJECT_IR_PREPARED_IMPORT_COLLISION");
        } else {
          process.env.JS2WASM_TEST_INJECT_IR_PREPARED_IMPORT_COLLISION = previous;
        }
      }
    },
  );

  it.each([
    [
      "callback maker",
      `type i32 = number; function __make_callback(_id: i32, capture: object): object { return capture; }`,
    ],
    ["typed DOM ABI", `function Document_createElement(): number { return 1; }`],
  ])("rejects a real source-level %s import occupant before prepared routing", async (label, prefix) => {
    const result = await compileCalendarFresh(
      `${prefix}\n${SOURCE}`,
      true,
      `website/playground/examples/dom/calendar-real-${label.replaceAll(" ", "-")}-collision.ts`,
    );
    expectSuccess(result);
    for (const terminal of ALL_TERMINALS) {
      expect(outcome(result, terminal.unitKind, terminal.displayName)).toMatchObject({
        kind: "unsupported",
        code: "late-preparation-unsupported",
        stage: "resolve",
        legacyBodyEmitted: true,
        irBodyEmitted: false,
      });
    }
    const terminalNames = new Set<string>(FUNCTION_TERMINALS);
    expect((result.irFirstSkipped ?? []).filter((name) => terminalNames.has(name))).toEqual([]);
    const derivedNames = new Set<string>(STATIC_DERIVED_CALLBACK_NAMES);
    expect(
      parseWatFunctions(result.wat)
        .map(({ name }) => name)
        .filter((name) => derivedNames.has(name)),
    ).toEqual([]);
  });
});
