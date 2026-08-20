// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/** #4401 — zero-debt ratchet for the migrated native-first semantic surface. */
import { readFileSync } from "node:fs";
import { compile } from "../src/index.ts";

interface HostImportPolicyBaseline {
  schemaVersion: 1;
  nativeFirst: {
    minimumProbes: number;
    maximumImports: number;
    maximumLegacySemanticImports: number;
    maximumUnknownImports: number;
  };
  compatibility: {
    minimumLegacySemanticImports: number;
    maximumLegacySemanticImports: number;
  };
  runtimeSource: {
    maximumRuntimeTsLines: number;
    maximumResolveImportLines: number;
    maximumResolveImportCases: number;
    maximumOwnedAdapterLines: number;
    maximumExplicitCapabilityLines: number;
  };
}

const countLines = (source: string): number => source.split(/\r?\n/).length - 1;
const readRepoFile = (path: string): string => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");
const baseline = JSON.parse(readRepoFile("plan/audit/host-import-policy-baseline.json")) as HostImportPolicyBaseline;
if (baseline.schemaVersion !== 1) throw new Error(`unsupported host-import-policy baseline schema`);

const probes = {
  core: `
    export function stringValue(value: string): string { return value.trim().toUpperCase(); }
    export function jsonValue(value: string): string { return JSON.stringify(JSON.parse(value)); }
    export function symbolValue(value: string): symbol { return Symbol.for(value); }
    export function arrayValue(): any { const values = [1, 2, 3]; values.push(4); return values.slice(1); }
    export function arrayPipeline(value: number): string {
      return [value, value + 1, value + 2].map(item => item * 2).join("-");
    }
    export function boundaryRead(value: any, key: any): any { return Reflect.get(value, key); }
    export function boundaryApply(target: any, thisArg: any, args: any): any {
      return Reflect.apply(target, thisArg, args);
    }
  `,
  regexp: `export function run(value: string): boolean { return /^a+$/.test(value); }`,
  collections: `
    export function mapValue(): any { const value = new Map<string, number>(); value.set("x", 1); return value.get("x"); }
    export function setValue(): boolean { const value = new Set<number>(); value.add(1); return value.has(1); }
    export function weakMapValue(key: object): any {
      const value = new WeakMap<object, number>(); value.set(key, 1); return value.get(key);
    }
  `,
  promise: `export async function run(): Promise<number> { return await Promise.resolve(1).then(value => value + 1); }`,
  date: `export function run(value: number): number { return new Date(value).getUTCFullYear(); }`,
  dataView: `
    export function run(): number {
      const buffer = new ArrayBuffer(8);
      const view = new DataView(buffer, 2, 4);
      view.setUint16(0, 0x1234);
      return view.getUint16(0) + view.byteOffset + view.byteLength;
    }
    export function readBoundary(view: any): any { return view.getUint8(0); }
  `,
  bigint: `export function run(value: string): bigint { return BigInt(value) + 1n; }`,
  bigintFormatting: `export function run(value: bigint): string { return value.toString(16); }`,
  number: `export function run(value: number): string { return value.toFixed(1); }`,
  textGlobals: `
    export function parse(value: string): number { return parseInt(value, 16) + parseFloat(value); }
    export function uri(value: string): string { return decodeURIComponent(encodeURIComponent(value)); }
    export function legacy(value: string): string { return unescape(escape(value)); }
  `,
  object: `
    export function run(): any { const value: any = { a: 1 }; Object.freeze(value); return Object.keys(value); }
    export function keys(value: number): string[] { return Object.keys({ value }); }
    export function assign(value: number): any { return Object.assign({}, { value }); }
  `,
  objectRest: `
    export function run(value: any): any { const { skip, ...rest } = value; return rest; }
    export function local(value: number): any { const { ignored, ...rest } = { ignored: 0, value }; return rest; }
  `,
  functionBind: `
    function add(left: number, right: number): number { return left + right; }
    export function local(): number { const bound = add.bind(undefined, 4); return bound(5); }
    export function boundary(fn: any): any {
      const bound = fn.bind({ base: 7 }, 3);
      return bound(2);
    }
  `,
  proxy: `
    export function run(): any {
      const value = new Proxy({ x: 1 }, { get(target, key) { return Reflect.get(target, key); } });
      return value.x;
    }
    export function boundaryConstruct(target: any, value: number): any {
      const Constructor: any = new Proxy(target, {});
      return new Constructor(value);
    }
  `,
  typedArrays: `
    export function run(): number {
      const values = new Uint8Array([1, 2, 3]);
      values[1] = 7;
      return values[0] + values[1] + values.length;
    }
  `,
  objectDescriptors: `
    export function run(): number {
      const value: any = {};
      Object.defineProperty(value, "count", { value: 4, enumerable: true });
      const descriptor = Object.getOwnPropertyDescriptor(value, "count");
      return descriptor!.value + Object.keys(value).length;
    }
  `,
  objectPrototype: `
    export function run(): number {
      const prototype: any = { inherited: 2 };
      const value: any = Object.create(prototype);
      value.own = 3;
      return Object.getPrototypeOf(value).inherited + ("own" in value ? 1 : 0);
    }
  `,
  functionCall: `
    function add(value: number): number { return value + 1; }
    export function run(): number { return add.call(undefined, 6); }
  `,
  functionApply: `
    function add(value: number): number { return value + 1; }
    export function run(): number { return add.apply(undefined, [8]); }
  `,
  errors: `
    export function run(value: boolean): string {
      try { if (value) throw new TypeError("bad"); return "ok"; }
      catch (error: any) { return error.name + ":" + error.message; }
    }
  `,
  generators: `
    function* values(): Generator<number> { yield 1; yield 2; }
    export function run(): number {
      let total = 0;
      for (const value of values()) total += value;
      return total;
    }
  `,
  iterators: `
    export function run(): number {
      let total = 0;
      for (const value of [1, 2, 3]) total += value;
      return total;
    }
  `,
  promiseCombinators: `
    export async function run(): Promise<number> {
      const values = await Promise.all([Promise.resolve(1), Promise.resolve(2)]);
      const settled = await Promise.allSettled([Promise.resolve(values[0])]);
      return values[1] + settled.length;
    }
  `,
  promiseAnyRace: `
    export async function run(): Promise<number> {
      const value = await Promise.any([Promise.reject(0), Promise.resolve(3)]);
      return await Promise.race([Promise.resolve(value)]);
    }
  `,
  regexpDynamic: `
    export function run(pattern: string, value: string): boolean {
      return new RegExp(pattern, "i").test(value);
    }
  `,
  mapIteration: `
    export function run(): number {
      const values = new Map<string, number>();
      values.set("a", 1); values.set("b", 2);
      let total = 0;
      for (const value of values.values()) total += value;
      return total;
    }
  `,
  setIteration: `
    export function run(): number {
      const values = new Set<number>([1, 2, 3]);
      let total = 0;
      values.forEach(value => { total += value; });
      return total;
    }
  `,
  reflect: `
    export function run(): number {
      const value: any = { count: 2 };
      Reflect.set(value, "count", 4);
      return Reflect.get(value, "count") + Reflect.ownKeys(value).length;
    }
  `,
  dynamicOps: `
    export function run(left: any, right: any): any {
      const value = left + right;
      return value == right ? typeof value : value < right;
    }
  `,
  destructuring: `
    export function run(): number {
      const source: any = { a: 1, b: 2 };
      const { a, ...rest } = source;
      const [first, ...tail] = [3, 4, 5];
      return a + rest.b + first + tail.length;
    }
  `,
  proxyMop: `
    export function run(): number {
      let hits = 0;
      const target: any = { value: 2 };
      const proxy: any = new Proxy(target, {
        get(value, key, receiver) { hits++; return Reflect.get(value, key, receiver); },
        set(value, key, next, receiver) { hits++; return Reflect.set(value, key, next, receiver); },
        ownKeys(value) { hits++; return Reflect.ownKeys(value); },
      });
      proxy.value = proxy.value + 1;
      return proxy.value + Object.keys(proxy).length + hits;
    }
  `,
  proxyRevocable: `
    export function run(): number {
      const pair: any = Proxy.revocable({ value: 1 }, {
        get(target: any, key: string): any { return Reflect.get(target, key); },
      });
      const value = pair.proxy.value;
      pair.revoke();
      return value;
    }
  `,
  stringProtocols: `
    export function run(value: string): string {
      return value.replace(/a/g, "b").split(/b/).join("-") + String.raw({ raw: ["x", "y"] }, 1);
    }
  `,
} as const;

const nativeSummaries: Record<string, unknown> = Object.create(null);
const nativeInventories = new Map<string, NonNullable<Awaited<ReturnType<typeof compile>>["hostImportInventory"]>>();
let nativeImportTotal = 0;
let nativeLegacySemanticTotal = 0;
let nativeUnknownTotal = 0;

for (const [name, source] of Object.entries(probes)) {
  const result = await compile(source, {
    fileName: `host-import-policy-native-first-${name}.ts`,
    semanticProviders: "native-first",
  });
  if (!result.success) {
    throw new Error(
      `native-first ${name} ratchet probe did not compile: ${result.errors.map((error) => error.message).join("; ")}`,
    );
  }

  const inventory = result.hostImportInventory ?? [];
  nativeInventories.set(name, inventory);
  nativeSummaries[name] = result.hostImportSummary;
  nativeImportTotal += inventory.length;
  nativeLegacySemanticTotal += inventory.filter((entry) => entry.classification === "legacy-semantic").length;
  nativeUnknownTotal += inventory.filter((entry) => entry.classification === "unknown").length;
  const debt = inventory.filter(
    (entry) => entry.classification === "legacy-semantic" || entry.classification === "unknown",
  );
  if (debt.length > 0) {
    throw new Error(
      `native-first ${name} host semantic debt grew:\n${debt
        .map((entry) => `  ${entry.classification}: ${entry.module}::${entry.name} (${entry.family})`)
        .join("\n")}`,
    );
  }
}

const requiredBoundaryAdapters = {
  core: ["__boundary_object_get", "__boundary_object_apply"],
  proxy: ["__boundary_object_callable_kind", "__boundary_object_construct"],
  dataView: ["__boundary_object_call"],
  functionBind: ["__boundary_callback_call_1"],
  objectRest: ["__boundary_object_keys", "__boundary_object_get"],
  promise: ["__boundary_promise_resolve", "__boundary_promise_reject"],
} as const;
for (const [probe, names] of Object.entries(requiredBoundaryAdapters)) {
  for (const name of names) {
    const entry = nativeInventories.get(probe)?.find((candidate) => candidate.name === name);
    if (entry?.classification !== "value-adapter") {
      throw new Error(`${name} must remain an explicit value adapter, got ${entry?.classification ?? "missing"}`);
    }
  }
}

const compatibility = await compile(probes.core, { fileName: "host-import-policy-compatibility.ts" });
const compatibilityDebt = compatibility.hostImportSummary?.byClassification["legacy-semantic"] ?? 0;
if (!compatibility.success || compatibilityDebt === 0) {
  throw new Error(
    "compatibility control must compile and retain at least one legacy semantic import (non-vacuity control)",
  );
}

const runtimeSource = readRepoFile("src/runtime.ts");
const resolveStart = runtimeSource.indexOf("function resolveImport(");
const resolveEnd = runtimeSource.indexOf("\n/** Check a manifest", resolveStart);
if (resolveStart < 0 || resolveEnd < 0) throw new Error("could not locate resolveImport for the #4401 source budget");
const resolveSource = runtimeSource.slice(resolveStart, resolveEnd);
const ownedAdapterPaths = [
  "src/runtime/boundary-callback-adapter.ts",
  "src/runtime/boundary-object-adapter.ts",
  "src/runtime/boundary-promise-adapter.ts",
  "src/runtime/boundary-value-adapter.ts",
  "src/runtime/instance-lifecycle-adapter.ts",
  "src/runtime/platform-capability-adapter.ts",
  "src/runtime/compatibility-adapter.ts",
  "src/runtime/compatibility-semantic-adapter.ts",
] as const;
// Explicit provider implementations are tracked separately so #4401 does not
// conflate required platform-capability code with implicit semantic-host debt.
const explicitCapabilityPaths = [
  "src/runtime/clock-capability-adapter.ts",
  "src/runtime/compiled-capability-authority.ts",
  "src/runtime/dom-capability-adapter.ts",
  "src/runtime/standalone-dom-string-bridge.ts",
  "src/runtime/standalone-timer-callback-bridge.ts",
  "src/runtime/timer-capability-adapter.ts",
] as const;
const migrationMetrics = {
  runtimeTsLines: countLines(runtimeSource),
  resolveImportLines: countLines(resolveSource),
  resolveImportCases: resolveSource.match(/^ {4}case "/gm)?.length ?? 0,
  ownedAdapterLines: ownedAdapterPaths.reduce((total, path) => total + countLines(readRepoFile(path)), 0),
  explicitCapabilityLines: explicitCapabilityPaths.reduce((total, path) => total + countLines(readRepoFile(path)), 0),
};

const budgetViolations: string[] = [];
const probeCount = Object.keys(probes).length;
if (probeCount < baseline.nativeFirst.minimumProbes) {
  budgetViolations.push(`native-first probes ${probeCount} < minimum ${baseline.nativeFirst.minimumProbes}`);
}
if (nativeImportTotal > baseline.nativeFirst.maximumImports) {
  budgetViolations.push(`native-first imports ${nativeImportTotal} > maximum ${baseline.nativeFirst.maximumImports}`);
}
if (nativeLegacySemanticTotal > baseline.nativeFirst.maximumLegacySemanticImports) {
  budgetViolations.push(
    `native-first legacy imports ${nativeLegacySemanticTotal} > maximum ${baseline.nativeFirst.maximumLegacySemanticImports}`,
  );
}
if (nativeUnknownTotal > baseline.nativeFirst.maximumUnknownImports) {
  budgetViolations.push(
    `native-first unknown imports ${nativeUnknownTotal} > maximum ${baseline.nativeFirst.maximumUnknownImports}`,
  );
}
if (compatibilityDebt < baseline.compatibility.minimumLegacySemanticImports) {
  budgetViolations.push(
    `compatibility legacy imports ${compatibilityDebt} < non-vacuity minimum ${baseline.compatibility.minimumLegacySemanticImports}`,
  );
}
if (compatibilityDebt > baseline.compatibility.maximumLegacySemanticImports) {
  budgetViolations.push(
    `compatibility legacy imports ${compatibilityDebt} > maximum ${baseline.compatibility.maximumLegacySemanticImports}`,
  );
}
for (const [metric, maximum] of [
  ["runtimeTsLines", baseline.runtimeSource.maximumRuntimeTsLines],
  ["resolveImportLines", baseline.runtimeSource.maximumResolveImportLines],
  ["resolveImportCases", baseline.runtimeSource.maximumResolveImportCases],
  ["ownedAdapterLines", baseline.runtimeSource.maximumOwnedAdapterLines],
  ["explicitCapabilityLines", baseline.runtimeSource.maximumExplicitCapabilityLines],
] as const) {
  if (migrationMetrics[metric] > maximum) {
    budgetViolations.push(`${metric} ${migrationMetrics[metric]} > maximum ${maximum}`);
  }
}
if (budgetViolations.length > 0) {
  throw new Error(
    `host-import migration baseline regressed:\n${budgetViolations.map((line) => `  ${line}`).join("\n")}`,
  );
}

console.log(
  JSON.stringify({
    schemaVersion: 1,
    nativeFirst: nativeSummaries,
    nativeFirstTotals: {
      probes: Object.keys(probes).length,
      imports: nativeImportTotal,
      legacySemanticImports: nativeLegacySemanticTotal,
      unknownImports: nativeUnknownTotal,
    },
    compatibilityLegacySemanticImports: compatibilityDebt,
    migrationMetrics,
  }),
);
