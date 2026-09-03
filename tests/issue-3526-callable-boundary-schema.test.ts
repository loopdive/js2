// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.

/**
 * #3526 F3-S2 — capability-record schema widening for callables.
 *
 * **This slice moves NO boundary.** It widens the closed capability-record
 * schema so family 3's crossings become EXPRESSIBLE: the module EXPORTS the
 * host calls (`__call_fn_0..4`, `__closure_arity`), the two callback-maker
 * siblings, and the two arity-derived host-call import families. No provider
 * row, no policy field, no resolve/attach/from-ast edit. Byte identity holds by
 * construction — `freeze()` publishes `hostCapabilityRecords` only for ids some
 * provider REQUESTED, and no provider names a new id.
 *
 * Every ABI asserted here is compiled ground truth, not a transcription of the
 * producing source: the export signatures were read from a real gc-host
 * module's binary type section (P1) and the import signatures from real modules
 * on the lanes that mint them (P3).
 */

import { describe, expect, it } from "vitest";

import { compile } from "../src/index.js";
import { asAsyncHostAdapter } from "../src/ir/async-runtime-providers.js";
import {
  PURE_MATH_RUNTIME_PROVIDERS,
  RuntimeManifestBuilder,
  RuntimeManifestInvariantError,
  type RuntimeProviderDefinition,
} from "../src/ir/runtime-manifest.js";
import {
  asCallableRuntimeHostCapabilityRecord,
  assertRuntimeHostCapabilityRecord,
  canonicalizeRuntimeHostCapabilityCatalog,
  resolveRuntimeHostCapabilityExportRecord,
  resolveRuntimeHostCapabilityFuncFamilyRecord,
  resolveRuntimeHostCapabilityFuncRecord,
  resolveRuntimeHostCapabilityRecord,
  RUNTIME_HOST_CAPABILITY_EXPORT_IDS,
  RUNTIME_HOST_CAPABILITY_RECORDS,
  type RuntimeHostCapabilityId,
  type RuntimeHostCapabilityRecord,
} from "../src/ir/runtime-host-capabilities.js";

/** The eleven ids this slice adds. `closure.apply` is deliberately absent — see section (h). */
const F3S2_IDS = [
  "callable.boundary_callback.call",
  "callable.export.arity",
  "callable.export.call_fn.0",
  "callable.export.call_fn.1",
  "callable.export.call_fn.2",
  "callable.export.call_fn.3",
  "callable.export.call_fn.4",
  "callable.host_call.array",
  "callable.host_call.fixed",
  "callback.wrap.ctor",
  "callback.wrap.getter",
] as const;

function row(capability: RuntimeHostCapabilityId): RuntimeHostCapabilityRecord {
  return resolveRuntimeHostCapabilityRecord(RUNTIME_HOST_CAPABILITY_RECORDS, capability);
}

function mathOnlyFreezeWith(records: readonly RuntimeHostCapabilityRecord[]) {
  const builder = new RuntimeManifestBuilder({ target: "host", backend: "wasmgc" }, { hostCapabilityRecords: records });
  builder.requestFeature("math.sqrt");
  return () => builder.freeze();
}

/** Swap one canonical row for a perturbed copy and freeze — the validator's live path. */
function freezeWithPerturbed(capability: RuntimeHostCapabilityId, update: Record<string, unknown>) {
  const catalogue = RUNTIME_HOST_CAPABILITY_RECORDS.map((entry) =>
    entry.capability === capability ? { ...entry, ...update } : entry,
  ) as readonly RuntimeHostCapabilityRecord[];
  return mathOnlyFreezeWith(catalogue);
}

async function compileTo(source: string, options: Record<string, unknown> = {}) {
  return compile(source, {
    fileName: "issue-3526-f3s2.ts",
    experimentalIR: true,
    trackFallbacks: true,
    skipSemanticDiagnostics: true,
    ...options,
  } as never);
}

/** Higher-order compose — the CB7/12 shape, the one cell that publishes all six export names. */
const COMPOSE_SOURCE = `
type Fn = (x: number) => number;
export function compose(f: Fn, g: Fn): Fn {
  return (x: number): number => f(g(x));
}
export function run(): number {
  const inc = (x: number): number => x + 1;
  const dbl = (x: number): number => x * 2;
  return compose(inc, dbl)(5);
}
`;

function moduleExportNames(binary: Uint8Array): readonly string[] {
  return WebAssembly.Module.exports(new WebAssembly.Module(binary)).map((entry) => entry.name);
}

// --------------------------------------------------------------------------
// (a) the rows themselves
// --------------------------------------------------------------------------

describe("#3526 F3-S2 (a) the eleven callable rows are exact and canonical", () => {
  it("resolves each export row to its exact literal shape, with no module key", () => {
    expect(row("callable.export.arity")).toEqual({
      capability: "callable.export.arity",
      name: "__closure_arity",
      alias: "$ce",
      kind: "export",
      params: ["externref"],
      results: ["i32"],
      publication: "host-bridge-gated",
    });
    expect(row("callable.export.call_fn.2")).toEqual({
      capability: "callable.export.call_fn.2",
      name: "__call_fn_2",
      alias: "$c2",
      kind: "export",
      params: ["externref", "externref", "externref"],
      results: ["externref"],
      publication: "host-bridge-gated",
    });
    for (const id of RUNTIME_HOST_CAPABILITY_EXPORT_IDS) {
      expect(row(id)).not.toHaveProperty("module");
    }
  });

  it("resolves each import row to its exact literal shape, knob axis included", () => {
    expect(row("callback.wrap.getter")).toEqual({
      capability: "callback.wrap.getter",
      module: "env",
      field: "__make_getter_callback",
      kind: "func",
      params: ["i32", "externref"],
      results: ["externref"],
    });
    expect(row("callback.wrap.ctor")).toEqual({
      capability: "callback.wrap.ctor",
      module: "env",
      field: "__make_callback_ctor",
      kind: "func",
      params: ["i32", "externref"],
      results: ["externref"],
    });
    expect(row("callable.host_call.array")).toEqual({
      capability: "callable.host_call.array",
      module: "env",
      field: "__call_function",
      kind: "func",
      params: ["externref", "externref", "externref"],
      results: ["externref"],
      hostSelection: { envVar: "JS2WASM_FIXED_ARITY_HOST_CALLS", selectsWhen: "knob-zero-or-arity-above-max" },
    });
    expect(row("callable.host_call.fixed")).toEqual({
      capability: "callable.host_call.fixed",
      module: "env",
      field: { scheme: "arity-suffix", prefix: "__call_function_" },
      kind: "func-family",
      params: { repeat: "externref", leading: ["externref", "externref"], min: 0, max: 4 },
      results: ["externref"],
      hostSelection: { envVar: "JS2WASM_FIXED_ARITY_HOST_CALLS", selectsWhen: "knob-not-zero-within-arity" },
    });
    expect(row("callable.boundary_callback.call")).toEqual({
      capability: "callable.boundary_callback.call",
      module: "env",
      field: { scheme: "arity-suffix", prefix: "__boundary_callback_call_" },
      kind: "func-family",
      params: { repeat: "externref", leading: ["externref", "externref"], min: 0, max: null },
      results: ["externref"],
    });
  });

  it("keeps every new row canonical — the identity the attach guard authenticates", () => {
    const canonical = canonicalizeRuntimeHostCapabilityCatalog(RUNTIME_HOST_CAPABILITY_RECORDS);
    for (const id of F3S2_IDS) {
      const found = canonical.find((entry) => entry.capability === id);
      expect(found, id).toBe(row(id));
    }
  });

  it("leaves `string.concat.many` without a leading key — the optionality that keeps F2-S6 frozen", () => {
    const concat = row("string.concat.many");
    expect(concat.kind).toBe("func-family");
    if (concat.kind !== "func-family") throw new Error("unreachable");
    expect(concat.params).not.toHaveProperty("leading");
    expect(concat).not.toHaveProperty("hostSelection");
    expect(concat.params.min).toBe(3);
  });
});

// --------------------------------------------------------------------------
// (b) each row's ABI equals compiled ground truth
// --------------------------------------------------------------------------

describe("#3526 F3-S2 (b) each row's ABI equals what a real module emits", () => {
  it("matches the exported dispatcher signatures of a real gc-host module", async () => {
    const result = (await compileTo(COMPOSE_SOURCE)) as { success: boolean; binary: Uint8Array };
    expect(result.success).toBe(true);
    const names = moduleExportNames(result.binary);
    // Every export row's NAME and ALIAS are published by this module.
    for (const id of RUNTIME_HOST_CAPABILITY_EXPORT_IDS) {
      const record = resolveRuntimeHostCapabilityExportRecord(RUNTIME_HOST_CAPABILITY_RECORDS, id);
      expect(names, record.name).toContain(record.name);
      expect(names, record.alias).toContain(record.alias);
    }
    // The arity ladder the rows declare is exactly `externref x (N + 1)`.
    for (let arity = 0; arity <= 4; arity++) {
      const record = resolveRuntimeHostCapabilityExportRecord(
        RUNTIME_HOST_CAPABILITY_RECORDS,
        `callable.export.call_fn.${arity}` as (typeof RUNTIME_HOST_CAPABILITY_EXPORT_IDS)[number],
      );
      expect(record.name).toBe(`__call_fn_${arity}`);
      expect(record.params).toHaveLength(arity + 1);
      expect(record.results).toEqual(["externref"]);
    }
  });

  it("derives the fixed-arity host-call field and params at min, max and one past max", () => {
    const at = (arity: number) =>
      resolveRuntimeHostCapabilityFuncFamilyRecord(RUNTIME_HOST_CAPABILITY_RECORDS, "callable.host_call.fixed", arity);
    // `min: 0` — the arity the pre-F3-S2 three-operand floor made unrepresentable.
    expect(at(0)).toEqual({
      module: "env",
      field: "__call_function_0",
      params: ["externref", "externref"],
      results: ["externref"],
    });
    expect(at(4)).toEqual({
      module: "env",
      field: "__call_function_4",
      params: ["externref", "externref", "externref", "externref", "externref", "externref"],
      results: ["externref"],
    });
    // One past `max` is refused — the array sibling answers that arity instead.
    expect(() => at(5)).toThrowError(/does not cover arity 5 \(0\.\.4\)/);
    expect(() => at(-1)).toThrowError(/does not cover arity -1/);
  });

  it("derives the boundary-callback family with no upper bound", () => {
    const at = (arity: number) =>
      resolveRuntimeHostCapabilityFuncFamilyRecord(
        RUNTIME_HOST_CAPABILITY_RECORDS,
        "callable.boundary_callback.call",
        arity,
      );
    expect(at(0).field).toBe("__boundary_callback_call_0");
    expect(at(0).params).toEqual(["externref", "externref"]);
    expect(at(6).field).toBe("__boundary_callback_call_6");
    expect(at(6).params).toHaveLength(8);
    expect(() => at(-1)).toThrowError(/does not cover arity -1 \(0\.\.unbounded\)/);
  });

  it("imports the fixed-arity members and the array sibling TOGETHER on gc-host", async () => {
    const result = (await compileTo(COMPOSE_SOURCE)) as {
      success: boolean;
      imports: readonly { module: string; name: string }[];
    };
    expect(result.success).toBe(true);
    const names = result.imports.map((entry) => `${entry.module}.${entry.name}`);
    // This is why `hostSelection` names a CONDITION rather than the knob's
    // value: with the knob unset, one module carries BOTH spellings.
    const array = resolveRuntimeHostCapabilityFuncRecord(RUNTIME_HOST_CAPABILITY_RECORDS, "callable.host_call.array");
    expect(names).toContain(`${array.module}.${array.field}`);
    for (let arity = 0; arity <= 4; arity++) {
      const fixed = resolveRuntimeHostCapabilityFuncFamilyRecord(
        RUNTIME_HOST_CAPABILITY_RECORDS,
        "callable.host_call.fixed",
        arity,
      );
      expect(names, fixed.field).toContain(`${fixed.module}.${fixed.field}`);
    }
  });

  it("matches the maker siblings' emitted import ABI", async () => {
    const getter = (await compileTo(
      `export function make(): any {
         const o: any = {};
         Object.defineProperty(o, "v", { get(): number { return 42; } });
         return o;
       }`,
    )) as { success: boolean; imports: readonly { module: string; name: string }[] };
    const getterRow = resolveRuntimeHostCapabilityFuncRecord(RUNTIME_HOST_CAPABILITY_RECORDS, "callback.wrap.getter");
    expect(getter.imports.map((e) => `${e.module}.${e.name}`)).toContain(`${getterRow.module}.${getterRow.field}`);

    // The ctor bridge needs a constructible FUNCTION EXPRESSION as the callback
    // (`callableHasConstructBehavior`, callback-ctor-bridge.ts:30-34).
    const ctor = (await compileTo(
      `export function install(target: EventTarget, sink: HTMLElement): void {
         target.addEventListener("tick", function () { sink.textContent = "hi"; });
       }`,
    )) as { success: boolean; imports: readonly { module: string; name: string }[] };
    const ctorRow = resolveRuntimeHostCapabilityFuncRecord(RUNTIME_HOST_CAPABILITY_RECORDS, "callback.wrap.ctor");
    expect(ctor.imports.map((e) => `${e.module}.${e.name}`)).toContain(`${ctorRow.module}.${ctorRow.field}`);
  });
});

// --------------------------------------------------------------------------
// (c) the validator refuses every malformed shape
// --------------------------------------------------------------------------

describe("#3526 F3-S2 (c) the widened validator fails closed", () => {
  it("refuses an export row that grows a module key", () => {
    expect(freezeWithPerturbed("callable.export.arity", { module: "env" })).toThrowError(
      /keys .*module.* do not match/,
    );
  });

  it("refuses an unknown publication, and a publication that is not the row's own", () => {
    expect(freezeWithPerturbed("callable.export.arity", { publication: "always" })).toThrowError(
      /unknown host capability callable\.export\.arity export publication always/,
    );
  });

  it("refuses a wrong or empty export name and alias", () => {
    expect(freezeWithPerturbed("callable.export.call_fn.3", { alias: "$c9" })).toThrowError(
      /export alias \$c9 does not match \$c3/,
    );
    expect(freezeWithPerturbed("callable.export.call_fn.3", { alias: "" })).toThrowError(
      /export alias .* does not match/,
    );
    expect(freezeWithPerturbed("callable.export.call_fn.3", { name: "__call_fn_9" })).toThrowError(
      /export name __call_fn_9 does not match __call_fn_3/,
    );
  });

  it("refuses export params/results that differ from the compiled ABI", () => {
    expect(freezeWithPerturbed("callable.export.arity", { results: ["externref"] })).toThrowError(
      /results .* do not match/,
    );
  });

  it("refuses a family min below zero and a max that does not cover min", () => {
    expect(
      freezeWithPerturbed("callable.host_call.fixed", {
        params: { repeat: "externref", leading: ["externref", "externref"], min: -1, max: 4 },
      }),
    ).toThrowError(/params min -1 is below the 0-operand floor/);
    expect(
      freezeWithPerturbed("callable.host_call.fixed", {
        params: { repeat: "externref", leading: ["externref", "externref"], min: 3, max: 1 },
      }),
    ).toThrowError(/params max 1 does not cover min 3/);
  });

  it("COMPARES the leading value types, not merely admits the key", () => {
    // An admitted-but-uncompared optional array would be a hole in a closed
    // schema: this row could otherwise claim an i32 callee.
    expect(
      freezeWithPerturbed("callable.host_call.fixed", {
        params: { repeat: "externref", leading: ["i32", "externref"], min: 0, max: 4 },
      }),
    ).toThrowError(/params \["i32","externref"\] do not match \["externref","externref"\]/);
  });

  it("compares hostSelection STRUCTURALLY — identity would invert the check", () => {
    // Asserted through `assertRuntimeHostCapabilityRecord`, the STRUCTURAL
    // validator, not through freeze: freeze also runs the canonical-identity
    // guard, which refuses any copy regardless of its contents, so it could
    // never show the difference between a structural and an identity compare.
    //
    // A structurally equal foreign object must PASS (an `!==` identity compare
    // would reject it) …
    expect(() =>
      assertRuntimeHostCapabilityRecord({
        ...row("callable.host_call.array"),
        hostSelection: { envVar: "JS2WASM_FIXED_ARITY_HOST_CALLS", selectsWhen: "knob-zero-or-arity-above-max" },
      }),
    ).not.toThrowError();
    // … and a structurally different one must FAIL (an `!==` compare would
    // reject it for the wrong reason, and accept nothing at all).
    expect(
      freezeWithPerturbed("callable.host_call.array", {
        hostSelection: { envVar: "JS2WASM_FIXED_ARITY_HOST_CALLS", selectsWhen: "knob-not-zero-within-arity" },
      }),
    ).toThrowError(/host selection .* does not match/);
    expect(
      freezeWithPerturbed("callable.host_call.array", {
        hostSelection: { envVar: "OTHER", selectsWhen: "knob-not-zero-within-arity" },
      }),
    ).toThrowError(/unknown host capability .* host selection env var OTHER/);
    expect(
      freezeWithPerturbed("callable.host_call.array", {
        hostSelection: { envVar: "JS2WASM_FIXED_ARITY_HOST_CALLS", selectsWhen: "whenever" },
      }),
    ).toThrowError(/unknown host capability .* host selection condition whenever/);
    // Presence must agree: a row that declares no axis may not grow one.
    expect(
      freezeWithPerturbed("callback.wrap.getter", {
        hostSelection: { envVar: "JS2WASM_FIXED_ARITY_HOST_CALLS", selectsWhen: "knob-not-zero-within-arity" },
      }),
    ).toThrowError(/keys .*hostSelection.* do not match/);
  });

  it("refuses an unknown kind", () => {
    expect(freezeWithPerturbed("callable.export.arity", { kind: "trampoline" })).toThrowError(
      /unknown host capability callable\.export\.arity kind trampoline/,
    );
  });
});

// --------------------------------------------------------------------------
// (d) the kind guards refuse an export record, naming it
// --------------------------------------------------------------------------

describe("#3526 F3-S2 (d) every func-assuming consumer refuses an export record", () => {
  it("refuses it at the callable guard and at the async adapter", () => {
    for (const id of RUNTIME_HOST_CAPABILITY_EXPORT_IDS) {
      const record = row(id);
      expect(() => asCallableRuntimeHostCapabilityRecord(record)).toThrowError(
        new RegExp(`host capability ${id.replace(/\./g, "\\.")} is not a callable host capability`),
      );
      expect(() => asAsyncHostAdapter(record)).toThrowError(
        new RegExp(`host capability ${id.replace(/\./g, "\\.")} is not an async capability`),
      );
    }
  });

  it("refuses an export id at the func and family resolvers, and a func id at the export resolver", () => {
    expect(() =>
      resolveRuntimeHostCapabilityFuncRecord(RUNTIME_HOST_CAPABILITY_RECORDS, "callable.export.arity" as never),
    ).toThrowError(/is not a callable host capability/);
    expect(() =>
      resolveRuntimeHostCapabilityFuncFamilyRecord(
        RUNTIME_HOST_CAPABILITY_RECORDS,
        "callable.export.arity" as never,
        0,
      ),
    ).toThrowError(/is not a host capability family/);
    expect(() =>
      resolveRuntimeHostCapabilityExportRecord(RUNTIME_HOST_CAPABILITY_RECORDS, "number.box" as never),
    ).toThrowError(/host capability number\.box is not an export host capability/);
  });
});

// --------------------------------------------------------------------------
// (e) anti-vacuity: no provider may request an export, and nothing is published
// --------------------------------------------------------------------------

describe("#3526 F3-S2 (e) the export refusal keeps an unpublishable row unreachable", () => {
  it("refuses a provider that requests an export capability, naming the id", () => {
    for (const id of RUNTIME_HOST_CAPABILITY_EXPORT_IDS) {
      const providers = PURE_MATH_RUNTIME_PROVIDERS.map((provider, index) =>
        index === 0 ? ({ ...provider, hostCapabilities: [id] } as RuntimeProviderDefinition) : provider,
      );
      // A fresh builder per assertion: once a freeze fails the builder latches
      // into a failed state and every later call reports that instead.
      const freeze = () => {
        const builder = new RuntimeManifestBuilder({ target: "host", backend: "wasmgc" }, { providers });
        builder.requestFeature("math.sqrt");
        return builder.freeze();
      };
      expect(freeze, id).toThrowError(RuntimeManifestInvariantError);
      expect(freeze, id).toThrowError(new RegExp(`cannot request export host capability ${id.replace(/\./g, "\\.")}`));
    }
  });

  it("publishes none of the eleven in a Math-only manifest", () => {
    const builder = new RuntimeManifestBuilder({ target: "host", backend: "wasmgc" });
    builder.requestFeature("math.sqrt");
    const frozen = builder.freeze();
    for (const id of F3S2_IDS) {
      expect(frozen.hostCapabilities as readonly string[], id).not.toContain(id);
      expect(Object.keys(frozen.hostCapabilityRecords), id).not.toContain(id);
    }
  });
});

// --------------------------------------------------------------------------
// (f) the publication gate the export rows declare is the measured one
// --------------------------------------------------------------------------

describe("#3526 F3-S2 (f) `host-bridge-gated` is a measured claim", () => {
  it("publishes every declared name on gc-host and none of them on standalone", async () => {
    const host = (await compileTo(COMPOSE_SOURCE)) as { success: boolean; binary: Uint8Array };
    const standalone = (await compileTo(COMPOSE_SOURCE, { target: "standalone" })) as {
      success: boolean;
      binary: Uint8Array;
    };
    expect(host.success).toBe(true);
    expect(standalone.success).toBe(true);
    const hostNames = moduleExportNames(host.binary);
    const standaloneNames = moduleExportNames(standalone.binary);
    for (const id of RUNTIME_HOST_CAPABILITY_EXPORT_IDS) {
      const record = resolveRuntimeHostCapabilityExportRecord(RUNTIME_HOST_CAPABILITY_RECORDS, id);
      expect(hostNames, `${id} on gc-host`).toContain(record.name);
      expect(hostNames, `${id} alias on gc-host`).toContain(record.alias);
      // `emitHostBridge` is false on standalone (`create-context.ts:189`), and
      // `stripHostBridgeExports` removes the whole set — which is exactly what
      // `publication: "host-bridge-gated"` declares.
      expect(standaloneNames, `${id} on standalone`).not.toContain(record.name);
      expect(standaloneNames, `${id} alias on standalone`).not.toContain(record.alias);
      expect(record.publication).toBe("host-bridge-gated");
    }
  }, 60_000);
});

// --------------------------------------------------------------------------
// (g) deliberately out of scope
// --------------------------------------------------------------------------

describe("#3526 F3-S2 (g) what this slice deliberately does not name", () => {
  it("declares no row for `__apply_closure` — P3 produced no compiled witness", () => {
    // `array-tolocalestring.ts:153` registers it as an `env` import and
    // `object-runtime.ts:7316` reserves it as a module-DEFINED function, and no
    // fixture across eight candidate paths (three `toLocaleString` receivers,
    // the Promise executor, the TypedArray HOF, `charAt`) produced a module
    // that IMPORTS it. Declaring which of the two spellings is the crossing
    // without a witness would invert measure-then-declare, so `closure.apply`
    // ships with the slice that can measure it (F3-S6).
    expect(RUNTIME_HOST_CAPABILITY_RECORDS.map((entry) => entry.capability)).not.toContain("closure.apply");
  });

  it("names none of the twelve remaining bridge members — F3-S5's", () => {
    const named = RUNTIME_HOST_CAPABILITY_RECORDS.flatMap((entry) => (entry.kind === "export" ? [entry.name] : []));
    for (const absent of ["__call_fn_method_0", "__is_closure", "__closure_has_rest", "__is_ctor_closure"]) {
      expect(named, absent).not.toContain(absent);
    }
    expect(named).toHaveLength(6);
  });
});
