// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.

// #3526 F3-S1 — the HOST CALLBACK MAKER moves under manifest authority.
//
// Family 3's first slice, and the first in the whole issue whose two live arms
// are not two spellings of one crossing but a crossing and its ABSENCE:
//
//  * **host** — a JS-host lane wraps the packed closure through
//    `env.__make_callback`, with the compiler-owned one-shot sentinel `-2` in
//    front of it. The import is minted by the LEGACY pre-pass
//    (`declarations/import-collector.ts`) long before any IR preparation, so the
//    provider's whole job is to NAME it: the crossing binds the funcMap index
//    that already exists, and this slice registers nothing.
//
//  * **native-dispatch** — the exact standalone-DOM lane has no maker at all.
//    The reserved standalone DOM dispatcher owns the crossing and the packed
//    closure goes straight to the DOM import. The frozen row is a LICENCE for an
//    emission that does not happen, which is why it can carry no target and no
//    host capability.
//
// Everywhere else the selection gate (`calendar-selection-support.ts`) never
// certifies the arrow, so nothing reaches the boundary and the seam is
// `unsupported`.
//
// Three consequences shape this file:
//
//  * **The capability record is REUSED, not minted.** `async.callback.wrap`
//    already states `env.__make_callback (i32, externref) -> externref` with the
//    `module-tag-payload` exception policy, and `host.promise.react` already
//    cites it. F3-S1 adds a second citer, no rename and no second row — and
//    makes that record the single source of the maker ABI for from-ast's
//    spelling (Phase 1, static catalogue), for the frozen manifest's admission
//    (post-freeze) and for the overlay's final-context ABI proof.
//
//  * **The native arm needed its OWN implementation kind, on a measurement.**
//    Riding on a new `native-managed.service` value would have been the cheaper
//    edit and is byte-UNSAFE: `projectRuntimeBackendRequirements` treats EVERY
//    `native-managed` row as a member of the native ASYNC family, adding
//    `async.native.drive` / `async.native.number-boundary` to the frozen vector
//    and throwing `invalid-backend-requirement-projection` the moment such a row
//    shares a manifest with a host async provider. Section (e) measures both
//    halves of that rather than asserting them.
//
//  * **The demand is read off `closure.new`, not off the maker call.** On the
//    dispatcher lane there IS no call to find, so a call-shaped demand would
//    leave that lane with no frozen row and the manifest would not be the
//    authority admitting it. `hostOneShot` and `domCallbackAuthority` are set
//    only by `lowerHostVoidCallbackExpression`, one per arm, which makes them
//    the one lane-free place both crossings are visible.
//
// Byte neutrality is the contract, and it held: 21 cells (09, 09b, shape-04 and
// a number-only CLEAN control × five lanes, plus the exact standalone-DOM
// calendar cell) are identical before and after on byte length, sha256, import
// set AND order, errors, outcomes and full WAT text.

import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import { compile, type CompileResult } from "../src/index.js";
import { hasExactHostVoidCallbackMakerImport } from "../src/codegen/ir-overlay-finalize.js";
import type { CodegenContext } from "../src/codegen/context/types.js";
import type { IrBindingOwnerId } from "../src/ir/identity.js";
import { prepareIrRuntimeManifest, preparedHostCallbackWrapProvider } from "../src/ir/intrinsic-support.js";
import { asBlockId, asValueId, irVal, type IrFunction, type IrInstr, type IrType } from "../src/ir/nodes.js";
import {
  projectRuntimeBackendRequirements,
  RuntimeManifestBuilder,
  RuntimeManifestInvariantError,
  RUNTIME_PROVIDERS,
  HOST_CALLBACK_WRAP_POLICY_DISABLED,
  HOST_CALLBACK_WRAP_RUNTIME_FEATURES,
  HOST_CALLBACK_WRAP_RUNTIME_PROVIDER_IDS,
  type HostCallbackWrapPolicy,
  type RuntimeManifestPolicy,
  type RuntimeProviderDefinition,
} from "../src/ir/runtime-manifest.js";
import {
  HOST_CALLBACK_WRAP_CAPABILITY_RECORD,
  RUNTIME_HOST_CAPABILITY_RECORDS,
  resolveRuntimeHostCapabilityRecord,
} from "../src/ir/runtime-host-capabilities.js";
import { buildImports } from "../src/runtime.js";
import { createTestIrFunctionIdentityFactory } from "./helpers/ir-identities.js";

const identities = createTestIrFunctionIdentityFactory("issue-3526-callable-boundary-callback");
const INTEGRATION_SOURCE = readFileSync(new URL("../src/ir/integration.ts", import.meta.url), "utf8");
const OWNER = "issue-3526-f3s1" as IrBindingOwnerId;
const NUMBER: IrType = { kind: "number" };

const HOST_WRAP: HostCallbackWrapPolicy = { wrap: "host" };
const NATIVE_WRAP: HostCallbackWrapPolicy = { wrap: "native-dispatch" };

const FEATURE = HOST_CALLBACK_WRAP_RUNTIME_FEATURES[0];

/** The pinned B2 source: one certified void host callback on `addEventListener`. */
const B2_SOURCE = `
export function install(target: EventTarget, sink: HTMLElement, value: number): void {
  target.addEventListener("tick", () => {
    sink.textContent = value.toString();
  });
}
`;

/** Shape 04: a closure with no host-callback crossing at all — the control. */
const CLOSURE_SOURCE = `
export function make(n: number): number {
  const add = (x: number): number => x + n;
  return add(1) + add(2);
}
`;

function policy(
  hostCallbackWrap?: HostCallbackWrapPolicy,
  target: "host" | "standalone" = "host",
): RuntimeManifestPolicy {
  return { target, backend: "wasmgc", ...(hostCallbackWrap ? { hostCallbackWrap } : {}) };
}

/**
 * One hand-built owner carrying exactly the `closure.new` the certified void
 * callback lowers to, on the requested arm — and nothing else.
 *
 * It carries no `intrinsic` instruction and no async plan, which is the point:
 * without `hostCallbackWrapDemand` this owner freezes NO manifest at all, so
 * neither arm would have an authority to be admitted by.
 */
function callbackFunction(name: string, arm: "host" | "native-dispatch" | "none"): IrFunction {
  const closure = {
    kind: "closure.new",
    liftedFunc: { binding: { kind: "unit", owner: OWNER, unitId: identities.next(`${name}__lifted`).unitId } },
    signature: { params: [], returnType: null },
    captureFieldTypes: [],
    captures: [],
    result: asValueId(0),
    resultType: irVal({ kind: "externref" }),
    ...(arm === "host" ? { hostOneShot: true } : {}),
    ...(arm === "native-dispatch"
      ? { domCallbackAuthority: { ownerUnitId: identities.next(`${name}__dom`).unitId, liftedOrdinal: 0 } }
      : {}),
  } as unknown as IrInstr;
  return {
    unitId: identities.next(name).unitId,
    name,
    params: [],
    resultTypes: [NUMBER],
    blocks: [
      {
        id: asBlockId(0),
        blockArgs: [],
        blockArgTypes: [],
        instrs: [closure],
        terminator: { kind: "return", values: [asValueId(0)] },
      },
    ],
    exported: false,
    valueCount: 1,
    funcKind: "regular",
  } as unknown as IrFunction;
}

function prepare(arm: "host" | "native-dispatch" | "none", wrap: HostCallbackWrapPolicy | undefined) {
  const prepared = prepareIrRuntimeManifest({
    functions: [callbackFunction("install", arm)],
    sourceFile: "/repo/callback.ts",
    policy: policy(wrap, wrap?.wrap === "native-dispatch" ? "standalone" : "host"),
    hostCallbackWrapDemand: { host: arm === "host", nativeDispatch: arm === "native-dispatch" },
  });
  return prepared;
}

function freezeWith(wrap: HostCallbackWrapPolicy["wrap"]) {
  const builder = new RuntimeManifestBuilder({
    target: wrap === "native-dispatch" ? "standalone" : "host",
    backend: "wasmgc",
    hostCallbackWrap: { wrap },
  });
  builder.requestFeature(FEATURE);
  return builder.freeze();
}

async function compileB2(options: Parameters<typeof compile>[1] = {}): Promise<CompileResult> {
  return compile(B2_SOURCE, {
    fileName: "issue-3214-b2.ts",
    experimentalIR: true,
    trackFallbacks: true,
    trackIrOutcomes: true,
    skipSemanticDiagnostics: true,
    emitWat: true,
    ...options,
  });
}

/** Function-kind import index of `name`, or -1 — the parity anchor V-B pins. */
function functionImportIndex(binary: Uint8Array, name: string): number {
  let functionIndex = 0;
  for (const entry of WebAssembly.Module.imports(new WebAssembly.Module(binary))) {
    if (entry.kind !== "function") continue;
    if (entry.name === name) return functionIndex;
    functionIndex++;
  }
  return -1;
}

/** A minimal fake final context for the overlay's ABI proof. */
function makerContext(
  overrides: {
    readonly module?: string;
    readonly name?: string;
    readonly params?: readonly string[];
    readonly results?: readonly string[];
  } = {},
): CodegenContext {
  const record = HOST_CALLBACK_WRAP_CAPABILITY_RECORD;
  const params = (overrides.params ?? record.params).map((kind) => ({ kind }));
  const results = (overrides.results ?? record.results).map((kind) => ({ kind }));
  return {
    funcMap: new Map([[record.field, 0]]),
    numImportFuncs: 1,
    mod: {
      imports: [
        {
          module: overrides.module ?? record.module,
          name: overrides.name ?? record.field,
          desc: { kind: "func", typeIdx: 0 },
        },
      ],
      types: [{ kind: "func", params, results }],
    },
  } as unknown as CodegenContext;
}

// --------------------------------------------------------------------------
// (a) contract — one feature row, two arms, one REUSED record
// --------------------------------------------------------------------------

describe("#3526 F3-S1 host-callback-wrap contract", () => {
  it("adds exactly ONE feature row — the policy picks the authority, not the namespace", () => {
    expect(HOST_CALLBACK_WRAP_RUNTIME_FEATURES).toEqual(["js.callback.wrap"]);
  });

  it("is TWO-armed, and the arms are a crossing and its absence", () => {
    expect(HOST_CALLBACK_WRAP_RUNTIME_PROVIDER_IDS).toEqual(["host.callback.wrap", "native.callback.dispatch"]);
    const rows = RUNTIME_PROVIDERS.filter((provider) => provider.feature === FEATURE);
    expect(rows.map((row) => row.id).sort()).toEqual(["host.callback.wrap", "native.callback.dispatch"]);
    expect(rows.map((row) => row.implementation.kind).sort()).toEqual(["host-callable", "native-dispatch"]);
  });

  it("REUSES the async catalogue's callback record — no rename, no second row", () => {
    const host = RUNTIME_PROVIDERS.find((provider) => provider.id === "host.callback.wrap")!;
    expect(host.implementation).toEqual({ kind: "host-callable", capability: "async.callback.wrap" });
    expect(host.hostCapabilities).toEqual(["async.callback.wrap"]);
    // The async projection's own citer is still there; this is a SECOND citer.
    const reactor = RUNTIME_PROVIDERS.find((provider) => provider.id === "host.promise.react")!;
    expect(reactor.hostCapabilities).toContain("async.callback.wrap");
    const record = resolveRuntimeHostCapabilityRecord(RUNTIME_HOST_CAPABILITY_RECORDS, "async.callback.wrap");
    expect(record).toEqual(HOST_CALLBACK_WRAP_CAPABILITY_RECORD);
    expect({ module: record.module, field: record.field, params: record.params, results: record.results }).toEqual({
      module: "env",
      field: "__make_callback",
      params: ["i32", "externref"],
      results: ["externref"],
    });
  });

  it("gives the dispatcher arm a ROLE and NO host capability", () => {
    const native = RUNTIME_PROVIDERS.find((provider) => provider.id === "native.callback.dispatch")!;
    expect(native.implementation).toEqual({
      kind: "native-dispatch",
      service: "standalone-dom-callback-dispatch",
    });
    expect(native.hostCapabilities).toEqual([]);
  });

  it("carries NO intrinsic signature — the maker's ABI is the record's, not a closed IntrinsicId's", () => {
    for (const row of RUNTIME_PROVIDERS.filter((provider) => provider.feature === FEATURE)) {
      expect(Object.prototype.hasOwnProperty.call(row, "signature")).toBe(false);
    }
  });
});

// --------------------------------------------------------------------------
// (b) policy — the frozen row is the authority
// --------------------------------------------------------------------------

describe("#3526 F3-S1 provider policy", () => {
  it("selects the host arm through the reused record, publishing module, field and ABI", () => {
    const manifest = freezeWith("host");
    expect(manifest.providers.map((provider) => provider.id)).toEqual(["host.callback.wrap"]);
    expect(manifest.hostCapabilities).toEqual(["async.callback.wrap"]);
    expect(manifest.hostCapabilityRecords.map((record) => `${record.module}.${record.field}`)).toEqual([
      "env.__make_callback",
    ]);
  });

  it("selects the dispatcher arm by ROLE, requesting NO host capability and importing nothing", () => {
    const manifest = freezeWith("native-dispatch");
    expect(manifest.providers.map((provider) => provider.id)).toEqual(["native.callback.dispatch"]);
    expect(manifest.hostCapabilities).toEqual([]);
    expect(manifest.hostCapabilityRecords).toEqual([]);
  });

  it("refuses the arm its caller resolved to unsupported, naming the seam and the policy", () => {
    let thrown: unknown;
    try {
      freezeWith("unsupported");
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(RuntimeManifestInvariantError);
    expect((thrown as RuntimeManifestInvariantError).code).toBe("provider-target-unavailable");
    expect((thrown as Error).message).toContain("host-callback-wrap policy");
    expect((thrown as Error).message).toContain("wrap=unsupported");
    expect((thrown as Error).message).toContain("js.callback.wrap");
  });

  it("defaults an omitted policy closed and publishes the resolved decision", () => {
    const resolved = new RuntimeManifestBuilder({ target: "host", backend: "wasmgc" }).freeze().policy;
    expect(resolved.hostCallbackWrap).toEqual(HOST_CALLBACK_WRAP_POLICY_DISABLED);
    expect(HOST_CALLBACK_WRAP_POLICY_DISABLED).toEqual({ wrap: "unsupported" });
    expect(Object.isFrozen(resolved.hostCallbackWrap)).toBe(true);
  });

  it("resolves independently of every sibling policy", () => {
    const resolved = new RuntimeManifestBuilder({
      target: "host",
      backend: "wasmgc",
      hostCallbackWrap: HOST_WRAP,
    }).freeze().policy;
    expect(resolved.hostCallbackWrap).toEqual(HOST_WRAP);
    expect(resolved.stringConst).toEqual({ storage: "unsupported" });
    expect(resolved.numberBoundary).toEqual({ box: "unsupported", unbox: "unsupported" });
    expect(resolved.generatorNumberBox).toEqual({ box: "unsupported" });
  });

  it("freezes NOTHING when no closure crosses the boundary", () => {
    expect(prepare("none", HOST_WRAP)).toBeUndefined();
    expect(preparedHostCallbackWrapProvider(undefined)).toBeUndefined();
  });

  it("freezes the row for EITHER arm's demand — the dispatcher lane emits no call to scan for", () => {
    const host = prepare("host", HOST_WRAP)!;
    expect(preparedHostCallbackWrapProvider(host)).toEqual({
      arm: "host",
      module: "env",
      field: "__make_callback",
      params: ["i32", "externref"],
      results: ["externref"],
    });
    const native = prepare("native-dispatch", NATIVE_WRAP)!;
    expect(preparedHostCallbackWrapProvider(native)).toEqual({
      arm: "native-dispatch",
      service: "standalone-dom-callback-dispatch",
    });
  });

  it("refuses a manifest frozen for the OTHER arm", () => {
    expect(() => prepare("host", NATIVE_WRAP)).not.toThrow();
    // The freeze itself selects by POLICY, so the mismatch is caught by the
    // owner-local partition and the post-freeze admission, not here — what the
    // freeze guarantees is that the published arm is the policy's, never the
    // instruction's.
    expect(preparedHostCallbackWrapProvider(prepare("host", NATIVE_WRAP)!)!.arm).toBe("native-dispatch");
  });
});

// --------------------------------------------------------------------------
// (c) end-to-end behaviour is unchanged — the authority moved, nothing else
// --------------------------------------------------------------------------

describe("#3526 F3-S1 end-to-end behaviour is unchanged", () => {
  it("keeps the maker at its pre-slice import position and spells it from the record", async () => {
    const result = await compileB2();
    expect(result.success, result.errors.map((error) => error.message).join("\n")).toBe(true);
    expect(result.irCompiledFuncs ?? []).toContain("install");
    // V-B: the exact ordered import list of the gc-host B2 cell.
    expect(
      WebAssembly.Module.imports(new WebAssembly.Module(result.binary)).map((entry) => `${entry.module}.${entry.name}`),
    ).toEqual([
      "env.EventTarget_addEventListener",
      "env.Element_set_textContent",
      "env.number_toString",
      "string_constants.install",
      "string_constants.tick",
      "string_constants.",
      "env.__make_callback",
      "env.__call_function_0",
    ]);
    const makerIndex = functionImportIndex(result.binary, HOST_CALLBACK_WRAP_CAPABILITY_RECORD.field);
    expect(makerIndex).toBe(3);
    expect(result.wat).toContain("i32.const -2");
    expect(result.wat).toContain(`call ${makerIndex}`);
  });

  it("dispatches the wrapped one-shot callback exactly as before", async () => {
    const result = await compileB2();
    const imports = buildImports(result.imports, undefined, result.stringPool);
    const { instance } = await WebAssembly.instantiate(result.binary, imports);
    imports.setExports?.(instance.exports as Record<string, Function>);
    const listeners: Function[] = [];
    const target = {
      addEventListener(_type: string, listener: Function): void {
        listeners.push(listener);
      },
    };
    const sink = { textContent: "" };
    (instance.exports.install as (t: object, s: object, v: number) => void)(target, sink, 42);
    expect(listeners).toHaveLength(1);
    expect(listeners[0]!({ type: "tick" })).toBeUndefined();
    expect(sink.textContent).toBe("42");
    expect(() => Reflect.construct(listeners[0]!, [])).toThrow(TypeError);
  });

  it("imports no maker on a lane the selection gate never admits", async () => {
    for (const options of [{ target: "standalone" as const }, { strictNoHostImports: true }]) {
      const result = await compileB2(options);
      const names = result.binary.length
        ? WebAssembly.Module.imports(new WebAssembly.Module(result.binary)).map((entry) => entry.name)
        : [];
      expect(names).not.toContain(HOST_CALLBACK_WRAP_CAPABILITY_RECORD.field);
    }
  });

  it("leaves a closure with no host-callback crossing entirely alone", async () => {
    const result = await compile(CLOSURE_SOURCE, {
      fileName: "issue-3526-f3s1-04.ts",
      experimentalIR: true,
      trackIrOutcomes: true,
    });
    expect(result.success).toBe(true);
    const names = WebAssembly.Module.imports(new WebAssembly.Module(result.binary)).map((entry) => entry.name);
    expect(names).not.toContain(HOST_CALLBACK_WRAP_CAPABILITY_RECORD.field);
  });
});

// --------------------------------------------------------------------------
// (d) the record is the single source of the maker ABI (sub-B)
// --------------------------------------------------------------------------

describe("#3526 F3-S1 the overlay proof reads the record", () => {
  it("accepts a maker whose physical ABI is the record's", () => {
    expect(hasExactHostVoidCallbackMakerImport(makerContext())).toBe(true);
  });

  it("refuses a maker whose ABI drifts from the record", () => {
    expect(hasExactHostVoidCallbackMakerImport(makerContext({ params: ["externref", "externref"] }))).toBe(false);
    expect(hasExactHostVoidCallbackMakerImport(makerContext({ params: ["i32"] }))).toBe(false);
    expect(hasExactHostVoidCallbackMakerImport(makerContext({ results: ["i32"] }))).toBe(false);
    expect(hasExactHostVoidCallbackMakerImport(makerContext({ results: [] }))).toBe(false);
  });

  it("refuses a maker imported from the wrong module or under the wrong name", () => {
    expect(hasExactHostVoidCallbackMakerImport(makerContext({ module: "wasm:js-string" }))).toBe(false);
    expect(hasExactHostVoidCallbackMakerImport(makerContext({ name: "__make_getter_callback" }))).toBe(false);
  });

  it("still refuses when the funcMap slot is absent or out of the import range", () => {
    const ctx = makerContext();
    expect(hasExactHostVoidCallbackMakerImport({ ...ctx, funcMap: new Map() } as CodegenContext)).toBe(false);
    expect(hasExactHostVoidCallbackMakerImport({ ...ctx, numImportFuncs: 0 } as CodegenContext)).toBe(false);
  });
});

// --------------------------------------------------------------------------
// (d2) the two seams that USED to spell the maker no longer can
//
// These are the V-C non-vacuity pins, and they are grep-shaped on purpose: the
// record names exactly the spelling both seams used to hard-code, so restoring
// either hand-written form is byte-identical and pin-identical to everything
// else in this file. What is actually gone is the SECOND AUTHORITY — and the
// only way to pin the absence of a duplicated constant is to look for it.
// Precedent: the #2955 depolymorph grep gate.
// --------------------------------------------------------------------------

describe("#3526 F3-S1 the maker spelling has ONE source", () => {
  const read = (path: string): string =>
    readFileSync(new URL(`../${path}`, import.meta.url), "utf8")
      // Comments may still NAME the import; only code may not spell it.
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/\/\/[^\n]*/g, "");

  it("leaves no maker string literal in from-ast — the crossing is built from the record", () => {
    const source = read("src/ir/from-ast.ts");
    expect(source).not.toContain('"__make_callback"');
    expect(source).toContain("HOST_CALLBACK_WRAP_CAPABILITY_RECORD");
  });

  it("leaves no maker string literal and no hand-written ABI in the overlay proof", () => {
    const source = read("src/codegen/ir-overlay-finalize.ts");
    expect(source).not.toContain('"__make_callback"');
    // The old shape check, spelled out field by field.
    expect(source).not.toMatch(/params\[0\]\?\.kind === "i32"/);
    expect(source).not.toMatch(/params\[1\]\?\.kind === "externref"/);
    expect(source).toContain("HOST_CALLBACK_WRAP_CAPABILITY_RECORD");
  });

  it("keeps the post-freeze admission keyed on the FROZEN provider, not on a name", () => {
    const source = read("src/ir/integration.ts");
    expect(source).not.toContain('"__make_callback"');
    expect(source).toContain("hostCallbackWrapArm");
    expect(source).toContain("preparedHostCallbackWrapProvider");
  });
});

// --------------------------------------------------------------------------
// (e) validation — the new kind is policed, and its ALTERNATIVE is measured
// --------------------------------------------------------------------------

describe("#3526 F3-S1 native-dispatch validation", () => {
  it("refuses a native-dispatch provider that requests a host capability", () => {
    const rogue: RuntimeProviderDefinition = {
      ...RUNTIME_PROVIDERS.find((provider) => provider.id === "native.callback.dispatch")!,
      hostCapabilities: ["async.callback.wrap"],
    };
    const builder = new RuntimeManifestBuilder(policy(NATIVE_WRAP, "standalone"), { providers: [rogue] });
    builder.requestFeature(FEATURE);
    expect(() => builder.freeze()).toThrow(/native-dispatch provider .* cannot request concrete host capabilities/);
  });

  it("refuses a host-callback-wrap provider whose implementation is neither arm", () => {
    const rogue: RuntimeProviderDefinition = {
      ...RUNTIME_PROVIDERS.find((provider) => provider.id === "native.callback.dispatch")!,
      implementation: { kind: "runtime-callable", symbol: "__make_callback" },
    };
    const builder = new RuntimeManifestBuilder(policy(NATIVE_WRAP, "standalone"), { providers: [rogue] });
    builder.requestFeature(FEATURE);
    const manifest = builder.freeze();
    expect(() => preparedHostCallbackWrapProvider({ functions: [], manifest, providers: new Map() })).toThrow(
      /is not a callback-boundary implementation/,
    );
  });

  it("is INVISIBLE to the async backend projection — the reason it is not a native-managed service", () => {
    const native = RUNTIME_PROVIDERS.find((provider) => provider.id === "native.callback.dispatch")!;
    const hostAsync = RUNTIME_PROVIDERS.find((provider) => provider.implementation.kind === "host-managed")!;
    expect(projectRuntimeBackendRequirements([native])).toEqual([]);
    // It coexists with a host async provider; a `native-managed` row would not.
    expect(projectRuntimeBackendRequirements([hostAsync, native])).toEqual([]);
    const asNativeManaged = {
      ...native,
      implementation: { kind: "native-managed", service: "native-promise-runtime" },
    } as unknown as RuntimeProviderDefinition;
    expect(projectRuntimeBackendRequirements([asNativeManaged])).toEqual([
      "async.native.drive",
      "async.native.number-boundary",
    ]);
    expect(() => projectRuntimeBackendRequirements([hostAsync, asNativeManaged])).toThrow(
      /mixes host and native async providers/,
    );
    expect(freezeWith("native-dispatch").backendRequirements).toEqual([]);
  });

  it("keeps the dispatcher service closed at the TYPE level", () => {
    const native = RUNTIME_PROVIDERS.find((provider) => provider.id === "native.callback.dispatch")!;
    // @ts-expect-error — only the one dispatcher role is representable.
    const widened: typeof native.implementation = { kind: "native-dispatch", service: "some-other-dispatcher" };
    expect(widened.kind).toBe("native-dispatch");
  });
});

// --------------------------------------------------------------------------
// (f) the exact standalone-DOM lane keeps its dispatcher and gains an authority
// --------------------------------------------------------------------------

describe("#3526 F3-S1 the exact standalone-DOM lane", () => {
  it("still reserves the dispatcher and imports no maker", async () => {
    const source = await import("node:fs").then((fs) =>
      fs.readFileSync(new URL("../website/playground/examples/dom/calendar.ts", import.meta.url), "utf8"),
    );
    const result = await compile(source, {
      fileName: "website/playground/examples/dom/calendar.ts",
      target: "standalone",
      experimentalIR: true,
      trackFallbacks: true,
      trackIrOutcomes: true,
      emitWat: true,
    });
    expect(result.success, result.errors.map((error) => error.message).join("\n")).toBe(true);
    expect(result.wat).toContain("$standalone_dom_callback_dispatch_type");
    const names = WebAssembly.Module.imports(new WebAssembly.Module(result.binary)).map((entry) => entry.name);
    expect(names).not.toContain(HOST_CALLBACK_WRAP_CAPABILITY_RECORD.field);
    expect(names).toContain("HTMLElement_addEventListener");
    expect(result.irCompiledFuncs ?? []).toContain("main");
  });
});

// --------------------------------------------------------------------------
// (g) the demand scan is the ONE enumeration both the freeze and the
//     partition run
// --------------------------------------------------------------------------

describe("#3526 F3-S1 the demand scan", () => {
  it("counts a hostOneShot closure as the host arm's demand", () => {
    expect(prepare("host", HOST_WRAP)).toBeDefined();
  });

  it("counts a domCallbackAuthority closure as the dispatcher arm's demand", () => {
    expect(prepare("native-dispatch", NATIVE_WRAP)).toBeDefined();
  });

  it("counts an ordinary closure as neither", () => {
    expect(prepare("none", HOST_WRAP)).toBeUndefined();
    expect(prepare("none", NATIVE_WRAP)).toBeUndefined();
  });

  it("requests the demand at freeze from the same scan the partition runs", () => {
    expect(INTEGRATION_SOURCE).toContain(
      "hostCallbackWrapDemand: irHostCallbackWrapDemand(entries.map((entry) => entry.fn))",
    );
    expect(INTEGRATION_SOURCE).toContain("const hostCallbackWrapDemand = irHostCallbackWrapDemand([entry.fn]);");
  });

  it("partitions a refused arm owner-locally, naming the arm and the policy", () => {
    // The disabled arm is UNREACHABLE on every real lane — the selection gate
    // never certifies an arrow where the policy is `unsupported`, which is the
    // structural reason this slice is byte-neutral — so the partition is pinned
    // where F2-S8 pinned its own unreachable arm: on the source slice, plus the
    // live typed refusal in section (b).
    const start = INTEGRATION_SOURCE.indexOf("const hostCallbackWrapDemand = irHostCallbackWrapDemand([entry.fn]);");
    const end = INTEGRATION_SOURCE.indexOf("// (#3526 F1-S2) The boolean boundary", start);
    expect(start).toBeGreaterThan(0);
    const partition = INTEGRATION_SOURCE.slice(start, end);
    expect(partition).toContain("late-preparation-unsupported");
    expect(partition).toContain("host-callback-wrap policy");
    expect(partition).toContain("markOwnerFailure(");
    expect(partition).toContain("terminalOwnerOf(entry)");
    // Two-sided: an `unsupported` policy AND a policy that selected the other arm.
    expect(partition).toContain('hostCallbackWrapPolicy.wrap !== "host"');
    expect(partition).toContain('hostCallbackWrapPolicy.wrap !== "native-dispatch"');
    // `continue` keeps a clean co-owner in `healthyForLower`.
    expect(partition.trimEnd().endsWith("continue;\n    }")).toBe(true);
  });

  it("projects the policy ONCE, before the freeze, from the two lane predicates", () => {
    const start = INTEGRATION_SOURCE.indexOf("function integrationHostCallbackWrapPolicy(");
    expect(start).toBeGreaterThan(0);
    const projection = INTEGRATION_SOURCE.slice(start, INTEGRATION_SOURCE.indexOf("\n}", start));
    expect(projection).toContain("ctx.requiresStandaloneDomInteractionCapability === true");
    expect(projection).toContain('ctx.targetProfile.environment === "none"');
    expect(projection).toContain('ctx.targetProfile.semanticProviders === "native-first"');
    expect(projection).toContain('ctx.targetProfile.capabilityPolicy === "ambient-js"');
    // No live manifest read, and no third arm invented here.
    expect(projection).not.toContain("prepared");
  });
});

// --------------------------------------------------------------------------
// (h) the sentinel and the closure shape are NOT the manifest's business
// --------------------------------------------------------------------------

describe("#3526 F3-S1 deliberately out of scope", () => {
  it("keeps the one-shot sentinel a from-ast fact, with no record field for it", () => {
    expect(Object.keys(HOST_CALLBACK_WRAP_CAPABILITY_RECORD).sort()).toEqual([
      "capability",
      "exceptionPolicy",
      "field",
      "kind",
      "module",
      "params",
      "results",
    ]);
    expect(JSON.stringify(HOST_CALLBACK_WRAP_CAPABILITY_RECORD)).not.toContain("sentinel");
  });

  /**
   * (#3526 F3-S2) INVERTED, as this pin's own name said it would be: the two
   * maker siblings now have catalogue rows. F3-S1 left them out because its
   * slice governed one crossing; F3-S2 widened the schema and added them with
   * a compiled witness each. What stays out of scope HERE is unchanged —
   * F3-S1's policy governs `async.callback.wrap` alone, and neither sibling
   * gained a provider, a policy field or a demand scan.
   */
  it("hands the legacy `_ctor` and getter makers to F3-S2's sibling rows", () => {
    const fields = RUNTIME_HOST_CAPABILITY_RECORDS.map((record) => record.field);
    expect(fields).toContain("__make_callback_ctor");
    expect(fields).toContain("__make_getter_callback");
    // Still exactly one record governs the F3-S1 crossing.
    expect(HOST_CALLBACK_WRAP_CAPABILITY_RECORD.field).toBe("__make_callback");
  });
});

// --------------------------------------------------------------------------
// (i) the disabled adapters
// --------------------------------------------------------------------------

describe("#3526 F3-S1 adapters resolve the arm explicitly", () => {
  it("refuses nothing, because neither adapter passes a callback demand", () => {
    const builder = new RuntimeManifestBuilder({
      target: "host",
      backend: "linear",
      hostCallbackWrap: HOST_CALLBACK_WRAP_POLICY_DISABLED,
    });
    expect(builder.freeze().policy.hostCallbackWrap).toEqual({ wrap: "unsupported" });
  });
});
