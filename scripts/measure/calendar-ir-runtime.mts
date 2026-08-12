// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { compile, type CompileResult } from "../../src/index.js";
import { buildImports } from "../../src/runtime.js";

type Lane = "direct" | "ir";
type Scenario = "neutral" | "original";

interface WorkCounts {
  createElement: number;
  appendChild: number;
  addEventListener: number;
  dispatch: number;
  dateSnapshots: number;
  innerHTML: number;
  cssText: number;
  textContent: number;
  background: number;
  callbackCreations: number;
  consoleLogs: number;
}

interface CounterState {
  counts: WorkCounts;
  lastLog: string;
}

interface WorkerResult {
  lane: Lane;
  scenario: Scenario;
  samples: number[];
  medianMs: number;
  minMs: number;
  p90Ms: number;
  exercisesPerSample: number;
  binaryBytes: number;
  gzipBytes: number;
  watBytes: number;
  definedFunctions: number;
  sha256: string;
  irLegacyBodies: number;
  irEmittedBodies: number;
}

interface PairedWorkerResult {
  readonly first: WorkerResult;
  readonly second: WorkerResult;
}

const SOURCE_URL = new URL("../../website/playground/examples/dom/calendar.ts", import.meta.url);
const SOURCE = readFileSync(SOURCE_URL, "utf8");
const CLOCK_EPOCH_MS = 1_734_220_800_000;
const EXERCISES_PER_SAMPLE = 8;
const SAMPLE_COUNT = 15;
const EXPECTED_WORK: WorkCounts = {
  createElement: 1_332,
  appendChild: 1_332,
  addEventListener: 1_120,
  dispatch: 14,
  dateSnapshots: 12,
  innerHTML: 13,
  cssText: 1_333,
  textContent: 934,
  background: 2,
  callbackCreations: 1_120,
  consoleLogs: 1,
};

function emptyWork(): WorkCounts {
  return {
    createElement: 0,
    appendChild: 0,
    addEventListener: 0,
    dispatch: 0,
    dateSnapshots: 0,
    innerHTML: 0,
    cssText: 0,
    textContent: 0,
    background: 0,
    callbackCreations: 0,
    consoleLogs: 0,
  };
}

class FakeStyle {
  private css = "";
  private bg = "";

  constructor(private readonly state: CounterState) {}

  get cssText(): string {
    return this.css;
  }

  set cssText(value: string) {
    this.state.counts.cssText++;
    this.css = String(value);
  }

  get background(): string {
    return this.bg;
  }

  set background(value: string) {
    this.state.counts.background++;
    this.bg = String(value);
  }
}

class FakeElement {
  readonly style: FakeStyle;
  readonly children: FakeElement[] = [];
  readonly listeners = new Map<string, Function[]>();
  private text = "";
  private html = "";

  constructor(
    readonly tagName: string,
    private readonly state: CounterState,
  ) {
    this.style = new FakeStyle(state);
  }

  get textContent(): string {
    return this.text;
  }

  set textContent(value: string) {
    this.state.counts.textContent++;
    this.text = String(value);
  }

  get innerHTML(): string {
    return this.html;
  }

  set innerHTML(value: string) {
    this.state.counts.innerHTML++;
    this.html = String(value);
    if (value === "") this.children.length = 0;
  }

  appendChild(child: FakeElement): FakeElement {
    this.state.counts.appendChild++;
    this.children.push(child);
    return child;
  }

  addEventListener(type: string, listener: Function): void {
    this.state.counts.addEventListener++;
    const listeners = this.listeners.get(type) ?? [];
    listeners.push(listener);
    this.listeners.set(type, listeners);
  }

  dispatch(type: string): void {
    this.state.counts.dispatch++;
    const listeners = this.listeners.get(type);
    if (listeners?.length !== 1) throw new Error(`${this.tagName} ${type} listener count is not one`);
    listeners[0]!({ type, target: this });
  }
}

class FakeDocument {
  readonly body: FakeElement;

  constructor(private readonly state: CounterState) {
    this.body = new FakeElement("body", state);
  }

  createElement(tagName: string): FakeElement {
    this.state.counts.createElement++;
    return new FakeElement(String(tagName), this.state);
  }
}

interface CalendarDom {
  month: FakeElement;
  year: FakeElement;
  grid: FakeElement;
  previous: FakeElement;
  next: FakeElement;
  clear: FakeElement;
  nights: FakeElement;
  total: FakeElement;
  save: FakeElement;
}

function calendarDom(document: FakeDocument): CalendarDom {
  const wrap = document.body.children[0];
  if (!wrap || wrap.children.length !== 7) throw new Error("Calendar DOM shape mismatch");
  const header = wrap.children[0]!;
  const grid = wrap.children[2]!;
  const nav = wrap.children[4]!;
  const foot1 = wrap.children[5]!;
  const foot2 = wrap.children[6]!;
  return {
    month: header.children[0]!,
    year: header.children[1]!,
    grid,
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
  if (matches.length !== 1) throw new Error(`Calendar day ${day} is not unique`);
  return matches[0]!;
}

function exerciseCalendar(main: () => void, document: FakeDocument, state: CounterState): number {
  main();
  let dom = calendarDom(document);
  dom.next.dispatch("click");
  dom = calendarDom(document);

  const hoverFive = dayCell(dom, 5);
  hoverFive.dispatch("mouseenter");
  hoverFive.dispatch("mouseleave");

  dayCell(dom, 5).dispatch("click");
  dom = calendarDom(document);
  dayCell(dom, 9).dispatch("click");
  dom = calendarDom(document);
  dayCell(dom, 20).dispatch("click");
  dom = calendarDom(document);
  dayCell(dom, 15).dispatch("click");
  dom = calendarDom(document);
  dayCell(dom, 10).dispatch("click");
  dom = calendarDom(document);
  dayCell(dom, 10).dispatch("click");
  dom = calendarDom(document);
  dayCell(dom, 4).dispatch("click");
  dom = calendarDom(document);
  dayCell(dom, 10).dispatch("click");
  dom = calendarDom(document);
  dom.save.dispatch("click");
  dom.clear.dispatch("click");
  dom = calendarDom(document);
  dom.previous.dispatch("click");
  dom = calendarDom(document);

  if (
    dom.month.textContent !== "Dec" ||
    dom.year.textContent !== "2024" ||
    dom.grid.children.length !== 42 ||
    dom.nights.textContent !== "0 nights" ||
    dom.total.textContent !== "" ||
    state.lastLog !== "saved 4-10"
  ) {
    throw new Error("Calendar semantic checksum mismatch");
  }
  return dom.grid.children.length + state.lastLog.length;
}

function neutralizeClock(source: string): string {
  const replacements = [
    ["let curYear = new Date().getFullYear();", "let curYear = 2024;"],
    ["let curMonth = new Date().getMonth();", "let curMonth = 11;"],
    [
      "  const now = new Date();\n  const todayD = now.getDate();\n  const todayM = now.getMonth();\n  const todayY = now.getFullYear();",
      "  const todayD = 15;\n  const todayM = 11;\n  const todayY = 2024;",
    ],
  ] as const;
  let result = source;
  for (const [before, after] of replacements) {
    if (!result.includes(before)) throw new Error(`Clock-neutral source token is missing: ${before}`);
    result = result.replace(before, after);
  }
  return result;
}

function percentile(sorted: readonly number[], fraction: number): number {
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * fraction))]!;
}

function median(values: readonly number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[middle - 1]! + sorted[middle]!) / 2 : sorted[middle]!;
}

function scaledExpected(scenario: Scenario, exercises: number): WorkCounts {
  return Object.fromEntries(
    Object.entries(EXPECTED_WORK).map(([name, count]) => [
      name,
      count * exercises * (name === "dateSnapshots" && scenario === "neutral" ? 0 : 1),
    ]),
  ) as unknown as WorkCounts;
}

function assertWork(actual: WorkCounts, scenario: Scenario, exercises: number): void {
  const expected = scaledExpected(scenario, exercises);
  for (const name of Object.keys(expected) as (keyof WorkCounts)[]) {
    if (actual[name] !== expected[name]) {
      throw new Error(`${name}: observed ${actual[name]}, expected ${expected[name]} (${exercises} exercises)`);
    }
  }
}

async function compileCalendar(lane: Lane, scenario: Scenario): Promise<CompileResult> {
  const source = scenario === "neutral" ? neutralizeClock(SOURCE) : SOURCE;
  const result = await compile(source, {
    fileName: "website/playground/examples/dom/calendar.ts",
    experimentalIR: lane === "ir",
    trackFallbacks: true,
    trackIrOutcomes: true,
    emitWat: true,
    target: "gc",
  });
  if (!result.success || !WebAssembly.validate(result.binary)) {
    throw new Error(result.errors.map(({ message }) => message).join("\n") || "Calendar Wasm is invalid");
  }
  return result;
}

interface PreparedLane {
  readonly lane: Lane;
  readonly scenario: Scenario;
  readonly result: CompileResult;
  readonly state: CounterState;
  readonly document: FakeDocument;
  readonly main: () => void;
}

async function prepareLane(lane: Lane, scenario: Scenario): Promise<PreparedLane> {
  const result = await compileCalendar(lane, scenario);
  const state: CounterState = { counts: emptyWork(), lastLog: "" };
  const document = new FakeDocument(state);
  const built = buildImports(result.imports, { document }, result.stringPool);
  const env = built.env as Record<string, (...args: unknown[]) => unknown>;
  const originalCallbackMaker = env.__make_callback;
  if (typeof originalCallbackMaker !== "function") throw new Error("Calendar callback maker is missing");
  env.__make_callback = (...args: unknown[]) => {
    state.counts.callbackCreations++;
    return originalCallbackMaker(...args);
  };
  env.console_log_string = (value: unknown) => {
    state.counts.consoleLogs++;
    state.lastLog = String(value);
  };

  if (scenario === "original") {
    if (typeof env.__date_now !== "function") throw new Error(`${lane} Calendar Date clock import is missing`);
    env.__date_now = () => {
      state.counts.dateSnapshots++;
      return CLOCK_EPOCH_MS;
    };
  }

  const imports: WebAssembly.Imports = {
    env: built.env,
    "wasm:js-string": built["wasm:js-string"],
    string_constants: built.string_constants,
    string_constants16: built.string_constants16,
  };
  const { instance } = await WebAssembly.instantiate(result.binary, imports);
  built.setInstance?.(instance);
  built.setExports?.(instance.exports as Record<string, Function>);
  const main = instance.exports.main as () => void;
  if (typeof main !== "function") throw new Error("Calendar main export is missing");
  return { lane, scenario, result, state, document, main };
}

function runWarmup(prepared: PreparedLane): void {
  prepared.state.counts = emptyWork();
  prepared.state.lastLog = "";
  exerciseCalendar(prepared.main, prepared.document, prepared.state);
  assertWork(prepared.state.counts, prepared.scenario, 1);
}

function measureBatch(prepared: PreparedLane): number {
  prepared.state.counts = emptyWork();
  prepared.state.lastLog = "";
  const started = performance.now();
  let checksum = 0;
  for (let index = 0; index < EXERCISES_PER_SAMPLE; index++) {
    checksum += exerciseCalendar(prepared.main, prepared.document, prepared.state);
  }
  const elapsed = performance.now() - started;
  if (checksum !== EXERCISES_PER_SAMPLE * 52) throw new Error(`Calendar batch checksum mismatch: ${checksum}`);
  assertWork(prepared.state.counts, prepared.scenario, EXERCISES_PER_SAMPLE);
  return elapsed / EXERCISES_PER_SAMPLE;
}

async function workerResult(prepared: PreparedLane, samples: readonly number[]): Promise<WorkerResult> {
  const sorted = [...samples].sort((a, b) => a - b);
  const outcomes = prepared.result.irOutcomes ?? [];
  return {
    lane: prepared.lane,
    scenario: prepared.scenario,
    samples: [...samples],
    medianMs: median(samples),
    minMs: sorted[0]!,
    p90Ms: percentile(sorted, 0.9),
    exercisesPerSample: EXERCISES_PER_SAMPLE,
    binaryBytes: prepared.result.binary.length,
    gzipBytes: (await import("node:zlib")).gzipSync(prepared.result.binary).length,
    watBytes: prepared.result.wat.length,
    definedFunctions: [...prepared.result.wat.matchAll(/^\s*\(func \$/gm)].length,
    sha256: createHash("sha256").update(prepared.result.binary).digest("hex"),
    irLegacyBodies: outcomes.filter(({ legacyBodyEmitted }) => legacyBodyEmitted).length,
    irEmittedBodies: outcomes.filter(({ irBodyEmitted }) => irBodyEmitted).length,
  };
}

async function runWorker(lane: Lane, scenario: Scenario): Promise<WorkerResult> {
  if (typeof globalThis.gc !== "function") throw new Error("worker requires node --expose-gc");
  const prepared = await prepareLane(lane, scenario);
  for (let index = 0; index < 12; index++) runWarmup(prepared);
  const samples: number[] = [];
  for (let sample = 0; sample < SAMPLE_COUNT; sample++) {
    globalThis.gc();
    samples.push(measureBatch(prepared));
  }
  return workerResult(prepared, samples);
}

async function runPairedWorker(first: Lane, second: Lane, scenario: Scenario): Promise<PairedWorkerResult> {
  if (typeof globalThis.gc !== "function") throw new Error("paired worker requires node --expose-gc");
  const firstPrepared = await prepareLane(first, scenario);
  const secondPrepared = await prepareLane(second, scenario);
  for (let index = 0; index < 12; index++) {
    const order = index % 2 === 0 ? [firstPrepared, secondPrepared] : [secondPrepared, firstPrepared];
    for (const prepared of order) runWarmup(prepared);
  }
  const firstSamples: number[] = [];
  const secondSamples: number[] = [];
  for (let sample = 0; sample < SAMPLE_COUNT; sample++) {
    const order = sample % 2 === 0 ? [firstPrepared, secondPrepared] : [secondPrepared, firstPrepared];
    for (const prepared of order) {
      globalThis.gc();
      const elapsed = measureBatch(prepared);
      (prepared === firstPrepared ? firstSamples : secondSamples).push(elapsed);
    }
  }
  return {
    first: await workerResult(firstPrepared, firstSamples),
    second: await workerResult(secondPrepared, secondSamples),
  };
}

function runFreshWorker(lane: Lane, scenario: Scenario): WorkerResult {
  const script = fileURLToPath(import.meta.url);
  const child = spawnSync(process.execPath, ["--expose-gc", "--import", "tsx", script, "--worker", lane, scenario], {
    cwd: process.cwd(),
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (child.status !== 0) {
    throw new Error(`Calendar ${lane}/${scenario} worker failed (${child.status}):\n${child.stderr}\n${child.stdout}`);
  }
  return JSON.parse(child.stdout.trim()) as WorkerResult;
}

function runFreshPair(first: Lane, second: Lane, scenario: Scenario): PairedWorkerResult {
  const script = fileURLToPath(import.meta.url);
  const child = spawnSync(
    process.execPath,
    ["--expose-gc", "--import", "tsx", script, "--pair", first, second, scenario],
    {
      cwd: process.cwd(),
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  if (child.status !== 0) {
    throw new Error(
      `Calendar ${first}/${second}/${scenario} pair failed (${child.status}):\n${child.stderr}\n${child.stdout}`,
    );
  }
  return JSON.parse(child.stdout.trim()) as PairedWorkerResult;
}

function summarizeScenario(scenario: Scenario, rounds: number): void {
  const controlRatios: number[] = [];
  const candidateRatios: number[] = [];
  let directArtifact: WorkerResult | undefined;
  let irArtifact: WorkerResult | undefined;
  for (let round = 0; round < rounds; round++) {
    const control = runFreshPair("direct", "direct", scenario);
    const controlRatio = control.second.medianMs / control.first.medianMs;
    controlRatios.push(controlRatio);

    const ab = runFreshPair("direct", "ir", scenario);
    const ba = runFreshPair("ir", "direct", scenario);
    const candidateRatio = median([ab.second.medianMs / ab.first.medianMs, ba.first.medianMs / ba.second.medianMs]);
    candidateRatios.push(candidateRatio);
    directArtifact = ab.first;
    irArtifact = ab.second;
    console.error(
      `[calendar:${scenario}] round ${round + 1}/${rounds}: direct/direct=${controlRatio.toFixed(3)}x, IR/direct=${candidateRatio.toFixed(3)}x`,
    );
  }

  const medianControlDeviation = Math.abs(median(controlRatios) - 1);
  const maximumControlDeviation = Math.max(...controlRatios.map((ratio) => Math.abs(ratio - 1)));
  const valid = medianControlDeviation <= 0.1 && maximumControlDeviation <= 0.2;
  console.log(
    JSON.stringify(
      {
        scenario,
        rounds,
        directDirectRatios: controlRatios,
        irDirectRatios: candidateRatios,
        medianDirectDirectRatio: median(controlRatios),
        medianIrDirectRatio: median(candidateRatios),
        valid,
        validityRule: "median direct/direct deviation <= 10% and every round <= 20%",
        directArtifact: directArtifact && {
          binaryBytes: directArtifact.binaryBytes,
          gzipBytes: directArtifact.gzipBytes,
          watBytes: directArtifact.watBytes,
          definedFunctions: directArtifact.definedFunctions,
          sha256: directArtifact.sha256,
        },
        irArtifact: irArtifact && {
          binaryBytes: irArtifact.binaryBytes,
          gzipBytes: irArtifact.gzipBytes,
          watBytes: irArtifact.watBytes,
          definedFunctions: irArtifact.definedFunctions,
          sha256: irArtifact.sha256,
          legacyBodies: irArtifact.irLegacyBodies,
          irEmittedBodies: irArtifact.irEmittedBodies,
        },
      },
      null,
      2,
    ),
  );
  if (!valid) process.exitCode = 2;
}

const args = process.argv.slice(2);
if (args[0] === "--worker") {
  const lane = args[1] as Lane;
  const scenario = args[2] as Scenario;
  if ((lane !== "direct" && lane !== "ir") || (scenario !== "neutral" && scenario !== "original")) {
    throw new Error("worker usage: --worker <direct|ir> <neutral|original>");
  }
  console.log(JSON.stringify(await runWorker(lane, scenario)));
} else if (args[0] === "--pair") {
  const first = args[1] as Lane;
  const second = args[2] as Lane;
  const scenario = args[3] as Scenario;
  if (
    (first !== "direct" && first !== "ir") ||
    (second !== "direct" && second !== "ir") ||
    (scenario !== "neutral" && scenario !== "original")
  ) {
    throw new Error("pair usage: --pair <direct|ir> <direct|ir> <neutral|original>");
  }
  console.log(JSON.stringify(await runPairedWorker(first, second, scenario)));
} else {
  const scenarioArg = args[0] ?? "both";
  const rounds = Number(args[1] ?? "3");
  if (!Number.isInteger(rounds) || rounds < 1) throw new Error("round count must be a positive integer");
  if (scenarioArg !== "neutral" && scenarioArg !== "original" && scenarioArg !== "both") {
    throw new Error("usage: calendar-ir-runtime.mts [neutral|original|both] [rounds]");
  }
  const scenarios: Scenario[] = scenarioArg === "both" ? ["neutral", "original"] : [scenarioArg];
  for (const scenario of scenarios) summarizeScenario(scenario, rounds);
}
