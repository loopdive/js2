// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #3523 Calendar retirement acceptance scaffold.
//
// The runnable assertions pin the independent browser/clock oracle and the
// exact ten-body legacy baseline. The skipped retirement block is deliberately
// red on that baseline: enable it in the Calendar production transaction only
// after all ten terminals seal together and the IR shapes match the direct
// backend. Seven statically emitted callback artifacts are not the same thing
// as the 1,120 callback objects created by the scripted runtime exercise.
// Absolute fork byte/local snapshots below are scaffold diagnostics only:
// re-measure them after conflict resolution and delete them when enabling the
// final relational direct-vs-IR ceilings.

import { readFileSync } from "node:fs";

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

interface ClockSnapshot {
  readonly id: number;
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

function expectedIrClockEvents(): string[] {
  const events = ["new:0", "getFullYear:0", "new:1", "getMonth:1"];
  for (let id = 2; id < 14; id++) {
    events.push(`new:${id}`, `getDate:${id}`, `getMonth:${id}`, `getFullYear:${id}`);
  }
  return events;
}

async function exerciseCalendar(result: CompileResult, lane: "direct" | "ir"): Promise<RuntimeEvidence> {
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

  if (lane === "direct") {
    expect(env.__date_now, "direct Date clock import").toBeTypeOf("function");
    env.__date_now = () => {
      clockSnapshots++;
      clockEvents.push(`now:${clockSnapshots - 1}`);
      return CLOCK_EPOCH_MS;
    };
  } else {
    expect(env.Date_new, "IR Date constructor import").toBeTypeOf("function");
    const snapshots = new Set<ClockSnapshot>();
    env.Date_new = () => {
      const snapshot = { id: clockSnapshots++ };
      snapshots.add(snapshot);
      clockEvents.push(`new:${snapshot.id}`);
      return snapshot;
    };
    const getter = (name: "getDate" | "getMonth" | "getFullYear", value: unknown): number => {
      expect(snapshots.has(value as ClockSnapshot), `${name} receiver is a Date_new snapshot`).toBe(true);
      const snapshot = value as ClockSnapshot;
      clockEvents.push(`${name}:${snapshot.id}`);
      if (name === "getDate") return 15;
      if (name === "getMonth") return 11;
      return 2024;
    };
    env.Date_getDate = (value: unknown) => getter("getDate", value);
    env.Date_getMonth = (value: unknown) => getter("getMonth", value);
    env.Date_getFullYear = (value: unknown) => getter("getFullYear", value);
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
  expect(clockSnapshots, "two module snapshots plus one per render").toBe(14);
  if (lane === "direct") {
    expect(clockEvents).toEqual(Array.from({ length: 14 }, (_, id) => `now:${id}`));
  } else {
    expect(clockEvents).toEqual(expectedIrClockEvents());
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

function expectDirectOptimizationReference(result: CompileResult): void {
  expect(targetCount(result, "dimOf", "__fmod")).toBe(3);

  const fdow = watFunction(result, "fdow").body;
  expect(targetCount(result, "fdow", "__fmod")).toBe(2);
  expect(countMatches(fdow, /\bf64\.div\b/g)).toBe(3);
  expect(countMatches(fdow, /\barray\.get(?:_[su])?\b/g)).toBe(1);
  expect(countMatches(fdow, /\bi32\.and\b/g)).toBe(3);

  expect(targetCount(result, "renderCal", "number_toString")).toBe(7);
  expect(targetCount(result, "renderCal", "Element_set_textContent")).toBe(8);
  expect(targetCount(result, "renderCal", "__concat_7")).toBe(1);
  expect(targetCount(result, "renderCal", "__concat_8")).toBe(0);

  expect(targetCount(result, "updFoot", "number_toString")).toBe(2);
  expect(targetCount(result, "updFoot", "concat")).toBe(2);
  expect(targetCount(result, "updFoot", "Element_set_textContent")).toBe(4);

  const main = watFunction(result, "main").body;
  expect(countMatches(main, /\barray\.new_fixed\b/g)).toBe(1);
  expect(countMatches(main, /\bi32\.lt_u\b/g)).toBe(2);
  expect(countMatches(main, /\barray\.get(?:_[su])?\b/g)).toBe(2);
  for (const name of FUNCTION_TERMINALS) expectNoGenericBodyMachinery(result, name);
  expect(targetCount(result, "dimOf", "__new_ReferenceError")).toBe(0);
}

function expectFinalIrOptimizationParity(result: CompileResult): void {
  expectDirectOptimizationReference(result);
  expect(targetCount(result, "renderCal", "Date_new")).toBe(1);
  expect(targetCount(result, "renderCal", "Date_getDate")).toBe(1);
  expect(targetCount(result, "renderCal", "Date_getMonth")).toBe(1);
  expect(targetCount(result, "renderCal", "Date_getFullYear")).toBe(1);
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

  it("records the exact ten legacy bodies and seven static callback artifacts before retirement", async () => {
    const result = await compileCalendar(true);
    expectSuccess(result);
    const observedKeys = (result.irOutcomes ?? [])
      .map(({ unitKind, displayName }) => `${unitKind}:${displayName}`)
      .sort();
    expect(observedKeys).toEqual(ALL_TERMINALS.map(({ unitKind, displayName }) => `${unitKind}:${displayName}`).sort());

    const terminals = ALL_TERMINALS.map(({ unitKind, displayName }) => outcome(result, unitKind, displayName));
    expect(terminals.filter(({ kind }) => kind === "unsupported" || kind === "invariant")).toEqual([]);
    expect(terminals.filter(({ irBodyEmitted }) => irBodyEmitted)).toHaveLength(10);
    expect(terminals.filter(({ legacyBodyEmitted }) => legacyBodyEmitted)).toHaveLength(10);

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

  // Scaffold-only numeric snapshot: re-measure after the production branch is
  // rebased, then remove the absolute byte/local/WAT values when the final
  // relational parity gate below is enabled. The semantic/call-shape checks
  // remain durable acceptance evidence.
  it("pins the direct backend's optimization shapes as the retirement reference", async () => {
    const direct = await compileCalendar(false);
    expectSuccess(direct);
    expectDirectOptimizationReference(direct);
    const renderCal = watFunction(direct, "renderCal").body;
    expect({
      binaryBytes: direct.binary.length,
      renderCalLocals: countMatches(renderCal, /\(local /g),
      renderCalWatBytes: renderCal.trimEnd().length,
      mainLocals: countMatches(watFunction(direct, "main").body, /\(local /g),
    }).toEqual({ binaryBytes: 12_895, renderCalLocals: 63, renderCalWatBytes: 19_112, mainLocals: 35 });
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

  // Scaffold-only fork diagnostic. Both recognized snapshots must be deleted,
  // not promoted to acceptance ceilings, once conflict resolution chooses the
  // production base. The skipped final gate compares the chosen IR artifact
  // against a freshly compiled direct artifact instead.
  it("makes the current IR duplication and TDZ bloat explicit instead of treating emission as parity", async () => {
    const [direct, ir] = await Promise.all([compileCalendar(false), compileCalendar(true)]);
    expectSuccess(direct);
    expectSuccess(ir);

    const directFdow = watFunction(direct, "fdow").body;
    const irFdow = watFunction(ir, "fdow").body;
    expect({
      fmod: targetCount(ir, "fdow", "__fmod"),
      div: countMatches(irFdow, /\bf64\.div\b/g),
      arrayGet: countMatches(irFdow, /\barray\.get(?:_[su])?\b/g),
      i32And: countMatches(irFdow, /\bi32\.and\b/g),
    }).toEqual({ fmod: 4, div: 6, arrayGet: 2, i32And: 6 });
    expect(countMatches(directFdow, /\bf64\.div\b/g)).toBe(3);

    const renderCal = watFunction(ir, "renderCal").body;
    const currentRevision = {
      binaryBytes: ir.binary.length,
      renderCalLocals: countMatches(renderCal, /\(local /g),
      renderCalWatBytes: renderCal.trimEnd().length,
      renderCalReferenceErrors: targetCount(ir, "renderCal", "__new_ReferenceError"),
      onDayReferenceErrors: targetCount(ir, "onDay", "__new_ReferenceError"),
      updFootReferenceErrors: targetCount(ir, "updFoot", "__new_ReferenceError"),
      mainReferenceErrors: targetCount(ir, "main", "__new_ReferenceError"),
      mainLocals: countMatches(watFunction(ir, "main").body, /\(local /g),
    };
    expect(
      [
        // Frozen #4323 queue head before the landed class-accessor merge.
        {
          binaryBytes: 18_438,
          renderCalLocals: 301,
          renderCalWatBytes: 32_999,
          renderCalReferenceErrors: 0,
          onDayReferenceErrors: 0,
          updFootReferenceErrors: 0,
          mainReferenceErrors: 0,
          mainLocals: 55,
        },
        // Read-only #4323 + current-main merge audit. These guards are nested
        // in exceptional arms, but they are still real output/size work and
        // are not accepted as optimization parity.
        {
          binaryBytes: 19_437,
          renderCalLocals: 338,
          renderCalWatBytes: 35_851,
          renderCalReferenceErrors: 40,
          onDayReferenceErrors: 14,
          updFootReferenceErrors: 20,
          mainReferenceErrors: 12,
          mainLocals: 77,
        },
      ],
      "recognized exact pre-retirement revision",
    ).toContainEqual(currentRevision);

    expect({
      numberToString: targetCount(ir, "renderCal", "number_toString"),
      textSetters: targetCount(ir, "renderCal", "Element_set_textContent"),
      concat7: targetCount(ir, "renderCal", "__concat_7"),
      concat8: targetCount(ir, "renderCal", "__concat_8"),
    }).toEqual({ numberToString: 8, textSetters: 9, concat7: 0, concat8: 1 });
    expect({
      numberToString: targetCount(ir, "updFoot", "number_toString"),
      concat: targetCount(ir, "updFoot", "concat"),
      textSetters: targetCount(ir, "updFoot", "Element_set_textContent"),
    }).toEqual({ numberToString: 3, concat: 3, textSetters: 6 });
    expect(countMatches(watFunction(direct, "main").body, /\(local /g)).toBe(35);
    expect(ir.binary.length).toBeGreaterThan(direct.binary.length);
  });
});

describe.skip("#3523 Calendar final ten-body retirement gate — enable with the production transaction", () => {
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

    const irRenderCal = bodySizeMetrics(result, ["renderCal"]);
    const directRenderCal = bodySizeMetrics(direct, ["renderCal"]);
    expect(irRenderCal.locals, "renderCal local ceiling").toBeLessThanOrEqual(Math.ceil(directRenderCal.locals * 1.6));
    expect(irRenderCal.bytes, "renderCal body-size ceiling").toBeLessThanOrEqual(
      Math.ceil(directRenderCal.bytes * 1.3),
    );

    const irMain = bodySizeMetrics(result, ["main"]);
    const directMain = bodySizeMetrics(direct, ["main"]);
    expect(irMain.locals, "main local ceiling").toBeLessThanOrEqual(Math.ceil(directMain.locals * 1.5));
    expect(irMain.bytes, "main body-size ceiling").toBeLessThanOrEqual(Math.ceil(directMain.bytes * 1.3));

    const irAggregate = bodySizeMetrics(result, [
      ...FUNCTION_TERMINALS,
      "__module_init",
      ...STATIC_DERIVED_CALLBACK_NAMES,
    ]);
    const directAggregate = bodySizeMetrics(direct, [...FUNCTION_TERMINALS, "__module_init", ...DIRECT_CALLBACK_NAMES]);
    expect(irAggregate.locals, "aggregate Calendar local ceiling").toBeLessThanOrEqual(
      Math.ceil(directAggregate.locals * 1.5),
    );
    expect(irAggregate.bytes, "aggregate Calendar body-size ceiling").toBeLessThanOrEqual(
      Math.ceil(directAggregate.bytes * 1.35),
    );
    expect(result.binary.length, "whole Calendar binary-size ceiling").toBeLessThanOrEqual(
      Math.ceil(direct.binary.length * 1.36),
    );
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
    ["Date import", `function Date_new(): number { return 1; }`],
    [
      "callback maker",
      `type i32 = number; function __make_callback(_id: i32, capture: object): object { return capture; }`,
    ],
    // Known-red contract bank: the current selector does not reject this
    // typed-DOM occupant. The production transaction must certify this seam
    // (or replace it with the final typed-DOM collision proof) before enabling
    // the surrounding describe block.
    ["typed DOM ABI", `function Document_createElement(): number { return 1; }`],
  ])("rejects the whole prepared component before mutation on a %s collision", async (label, prefix) => {
    const collisionSource = `${prefix}\n${SOURCE}`;
    const collisionFileName = `website/playground/examples/dom/calendar-${label.replaceAll(" ", "-")}-collision.ts`;
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
    expect((result.irOutcomes ?? []).filter(({ preparedComponentId }) => preparedComponentId !== undefined)).toEqual(
      [],
    );

    const calendarArtifacts = new Set<string>(COMPILED_ARTIFACT_NAMES);
    expect((result.irCompiledFuncs ?? []).filter((name) => calendarArtifacts.has(name))).toEqual([]);
    expect((result.irFirstSkipped ?? []).filter((name) => calendarArtifacts.has(name))).toEqual([]);
    const resultNames = parseWatFunctions(result.wat).map(({ name }) => name);
    const derivedArtifactNames = new Set<string>(STATIC_DERIVED_CALLBACK_NAMES);
    expect(resultNames.filter((name) => derivedArtifactNames.has(name))).toEqual([]);

    expect(result.imports, "no imports leaked by failed IR preparation").toEqual(direct.imports);
    expect([...result.binary], "all-direct collision binary").toEqual([...direct.binary]);

    const fallbackEvidence = await exerciseCalendar(result, "direct");
    const directEvidence = await exerciseCalendar(direct, "direct");
    expect(semanticDomSnapshot(fallbackEvidence.document.body)).toEqual(
      semanticDomSnapshot(directEvidence.document.body),
    );
    expect(fallbackEvidence.logs).toEqual(directEvidence.logs);
  });
});
