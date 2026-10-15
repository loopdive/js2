// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/** #4401 — zero-debt ratchet for the migrated native-first semantic surface. */
import { readFileSync } from "node:fs";
import { compile } from "../src/index.ts";
import { REGIME_GAP_FAMILIES } from "../src/host-import-policy.ts";

// (#6686/#5385 S5, #6708 S6, #6979 S7) native-first is the compiler's only
// semantic-provider policy and the native regime its lowering in a JS
// environment; the probes compile with no semanticProviders option, so this
// ratchet measures exactly what the compiler ships. Since S7-b the
// `legacy-semantic` class is gone: a retired host-semantic import classifies
// `unknown` and is a compile error on every WasmGC profile, so every probe is
// held to a hard zero. The only host imports outside adapters, capabilities,
// lifecycle hooks and selected accelerators are the named #5385 regime gaps,
// held to the explicit name ceiling below.

/**
 * (#6979) The regime-gap ceiling: exactly these families, and within them only
 * these import names (or name prefixes ending in `*`). A fourth family, or a new
 * name in an existing one, fails this ratchet until it is reviewed.
 */
const REGIME_GAP_CEILING: Record<string, readonly string[]> = {
  "eager-generator-buffer": ["__gen_*", "__create_generator", "__create_async_generator"],
  "shared-array-buffer": ["SharedArrayBuffer_*"],
  "temporal-strings": [
    "__temporal_plain_date_to_string",
    "__temporal_plain_time_to_string",
    "__temporal_duration_to_string",
    "__temporal_plain_date_from_string_field",
    "__temporal_duration_from_string_field",
    "__temporal_plain_date_add_field",
    "__temporal_plain_date_month_code",
    "__temporal_plain_time_from_string_field",
    "__temporal_plain_time_add_field",
    "__temporal_duration_sign",
  ],
};
{
  const declared = Object.keys(REGIME_GAP_FAMILIES).sort();
  const ceiling = Object.keys(REGIME_GAP_CEILING).sort();
  if (declared.join(",") !== ceiling.join(",")) {
    throw new Error(`regime-gap families ${declared.join(", ")} do not match the ceiling ${ceiling.join(", ")}`);
  }
}
const withinRegimeGapCeiling = (family: string, name: string): boolean =>
  (REGIME_GAP_CEILING[family] ?? []).some((allowed) =>
    allowed.endsWith("*") ? name.startsWith(allowed.slice(0, -1)) : name === allowed,
  );

interface HostImportPolicyBaseline {
  schemaVersion: 1;
  nativeFirst: {
    minimumProbes: number;
    maximumImports: number;
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
let nativeRegimeGapTotal = 0;
let nativeUnknownTotal = 0;

for (const [name, source] of Object.entries(probes)) {
  const result = await compile(source, {
    fileName: `host-import-policy-native-first-${name}.ts`,
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
  nativeRegimeGapTotal += inventory.filter((entry) => entry.classification === "regime-gap").length;
  nativeUnknownTotal += inventory.filter((entry) => entry.classification === "unknown").length;
  const debt = inventory.filter((entry) => entry.classification === "unknown");
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

// #6978 — per-family host-accelerator probes: a family's host imports appear
// only when that accelerator is selected, classify as `host-accelerator`, and
// never smuggle in legacy/unknown imports. Families whose host path is not
// implemented yet (js-string) must refuse selection instead of compiling as a no-op.
const acceleratorProbes = {
  regexp: probes.stringProtocols,
  date: `export function run(value: string): number { return Date.parse(value) + new Date(value).getTime(); }`,
  // #6986: Intl constructors, a locale-sensitive method and a namespace function.
  intl: `export function run(value: number): string {
    const fmt = new Intl.NumberFormat("de-DE", { style: "currency", currency: "EUR" });
    return fmt.format(value) + value.toLocaleString("en-US") + Intl.getCanonicalLocales("en")[0];
  }`,
} as const;
type ProbedAccelerator = keyof typeof acceleratorProbes;
const acceleratorImports: Record<string, number> = Object.create(null);
for (const [family, source] of Object.entries(acceleratorProbes)) {
  const compileProbe = (hostAccelerators?: readonly ProbedAccelerator[]) =>
    compile(source, {
      fileName: `host-import-policy-accelerator-${family}${hostAccelerators ? "-selected" : ""}.ts`,
      semanticProviders: "native-first",
      ...(hostAccelerators ? { hostAccelerators } : {}),
    });
  const [plain, selected] = await Promise.all([compileProbe(), compileProbe([family as ProbedAccelerator])]);
  // #6986: there is no native Intl, so without the accelerator the intl probe is a
  // compile error naming it (no import at all) rather than a native build.
  const plainRefusedIntl =
    family === "intl" &&
    !plain.success &&
    plain.errors.some((error) => error.message.includes("--host-accelerator intl"));
  if ((!plain.success && !plainRefusedIntl) || !selected.success) {
    throw new Error(`host-accelerator ${family} probe did not compile`);
  }
  const accelerated = (selected.hostImportInventory ?? []).filter(
    (entry) => entry.classification === "host-accelerator" && entry.family === family,
  );
  if (accelerated.length === 0) throw new Error(`host-accelerator ${family} probe selected no ${family} imports`);
  const debt = (selected.hostImportInventory ?? []).filter((entry) => entry.classification === "unknown");
  if (debt.length > 0) {
    throw new Error(`host-accelerator ${family} probe carries ${debt.map((entry) => entry.name).join(", ")}`);
  }
  const plainNames = new Set((plain.hostImportInventory ?? []).map((entry) => `${entry.module}::${entry.name}`));
  const leaked = accelerated.filter((entry) => plainNames.has(`${entry.module}::${entry.name}`));
  if (leaked.length > 0) {
    throw new Error(`${family} accelerator imports present without selection: ${leaked.map((e) => e.name).join(", ")}`);
  }
  acceleratorImports[family] = accelerated.length;
}
for (const family of ["js-string"] as const) {
  const refused = await compile(probes.core, {
    fileName: `host-import-policy-accelerator-${family}.ts`,
    semanticProviders: "native-first",
    hostAccelerators: [family],
  }).then(
    () => false,
    (error: unknown) => String(error).includes("not available yet"),
  );
  if (!refused) throw new Error(`host-accelerator ${family} must refuse selection until its host path exists`);
}

// #6979 — one probe per named regime gap: each still compiles (the gap is the
// construct's only implementation), and every import it needs beyond adapters
// and capabilities is a regime-gap import inside the explicit name ceiling.
const regimeGapProbes = {
  "eager-generator-buffer": `
    export async function run(): Promise<number> {
      async function* values(): AsyncGenerator<number> { const x = yield 1; yield (x as any) + 1; }
      const it = values(); await it.next(); return (await it.next(2)).value as number;
    }
  `,
  "shared-array-buffer": `export function run(): number {
    const buffer: any = new SharedArrayBuffer(16);
    return Atomics.load(new Int32Array(buffer), 0);
  }`,
  "temporal-strings": `export function run(): string { return Temporal.PlainDate.from("2020-01-02").toString(); }`,
} as const;
const regimeGapImports: Record<string, string[]> = Object.create(null);
for (const [family, source] of Object.entries(regimeGapProbes)) {
  const result = await compile(source, { fileName: `host-import-policy-regime-gap-${family}.ts` });
  const inventory = result.hostImportInventory ?? [];
  const outside = inventory.filter(
    (entry) =>
      entry.classification === "unknown" ||
      (entry.classification === "regime-gap" && !withinRegimeGapCeiling(entry.family, entry.name)),
  );
  if (outside.length > 0) {
    throw new Error(
      `regime-gap ${family} probe carries imports outside the ceiling: ` +
        outside.map((entry) => `${entry.name} (${entry.classification}/${entry.family})`).join(", "),
    );
  }
  regimeGapImports[family] = inventory
    .filter((entry) => entry.classification === "regime-gap")
    .map((entry) => entry.name)
    .sort();
  if (regimeGapImports[family]!.length === 0) {
    throw new Error(`regime-gap ${family} probe no longer needs the gap: close it and drop the family (#5385)`);
  }
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
  "src/runtime/console-host-marshal.ts", // (#6685) console value-adapter marshal
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
// (#6979) Hard zero, not a baseline: no profile may publish implicit or
// unclassified host semantics.
if (nativeRegimeGapTotal > 0) budgetViolations.push(`regime-gap imports on the probes ${nativeRegimeGapTotal} > 0`);
if (nativeUnknownTotal > 0) budgetViolations.push(`unknown imports ${nativeUnknownTotal} > 0`);
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
      regimeGapImports: nativeRegimeGapTotal,
      unknownImports: nativeUnknownTotal,
    },
    hostAcceleratorImports: acceleratorImports,
    regimeGapImports,
    migrationMetrics,
  }),
);
