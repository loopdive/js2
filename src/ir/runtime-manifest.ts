// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.

/**
 * Deterministic R6 semantic-runtime manifest for the certified pure-Math slice.
 *
 * The builder is the preparation-time mutation boundary. `freeze()` verifies
 * intrinsic contracts, expands provider dependencies to a fixed point,
 * validates cycles and target/backend adapters, and publishes only deeply
 * frozen arrays/records. Lowering receives lookup-only `resolveProvider` calls;
 * a request absent from the frozen plan is a typed invariant.
 */
import { irTypeEquals, type IrIntrinsicBackendOp } from "./nodes.js";
import {
  ASYNC_HOST_CAPABILITY_IDS,
  ASYNC_OPTIONAL_RUNTIME_FEATURES,
  ASYNC_RUNTIME_FEATURES,
  ASYNC_RUNTIME_PROVIDERS,
  ASYNC_RUNTIME_PROVIDER_IDS,
  type AsyncHostCapabilityId,
  type AsyncRuntimeFeature,
  type AsyncRuntimeProviderId,
} from "./async-runtime-providers.js";
import {
  F64_BINARY_INTRINSIC_SIGNATURE,
  F64_UNARY_INTRINSIC_SIGNATURE,
  INTRINSIC_DEFINITIONS,
  PURE_MATH_HOST_CAPABILITIES,
  PURE_MATH_RUNTIME_FEATURES,
  type IntrinsicEffectEvidence,
  type IntrinsicId,
  type IntrinsicSignature,
  type IntrinsicUse,
  type IntrinsicVerificationCode,
  type RuntimeFeature as MathRuntimeFeature,
  verifyIntrinsicUse,
} from "./intrinsics.js";

export type RuntimeTarget = "host" | "strict-no-host" | "standalone" | "wasi";
export type RuntimeBackend = "wasmgc" | "linear";
export type RuntimeFeature = MathRuntimeFeature | AsyncRuntimeFeature;
export type HostCapabilityId = AsyncHostCapabilityId;

export interface RuntimeManifestPolicy {
  readonly target: RuntimeTarget;
  readonly backend: RuntimeBackend;
}

export const PURE_MATH_RUNTIME_PROVIDER_IDS = Object.freeze([
  "backend.f64.abs",
  "backend.f64.ceil",
  "backend.f64.floor",
  "backend.f64.sqrt",
  "backend.f64.trunc",
  "selfhost.math.atan",
  "selfhost.math.atan2",
  "selfhost.math.cos",
  "selfhost.math.exp",
  "selfhost.math.log",
  "selfhost.math.log2",
  "selfhost.math.pow",
  "selfhost.math.reduce-trig",
  "selfhost.math.sin",
] as const);

export type MathRuntimeProviderId = (typeof PURE_MATH_RUNTIME_PROVIDER_IDS)[number];
export type RuntimeProviderId = MathRuntimeProviderId | AsyncRuntimeProviderId;

export type RuntimeProviderImplementation =
  | {
      readonly kind: "backend-op";
      readonly opcode: IrIntrinsicBackendOp;
    }
  | {
      readonly kind: "self-hosted";
      /** Concrete ABI spelling, deliberately below the semantic feature. */
      readonly symbol: string;
    }
  | {
      /** The provider closes over one or more declared host capabilities. */
      readonly kind: "host-capability";
    }
  | {
      /** Scheduling is supplied by the host Promise job queue, with no import. */
      readonly kind: "host-managed";
      readonly service: "promise-job-queue";
    }
  | {
      /** Promise allocation, reactions, settlement, and queueing stay in WasmGC. */
      readonly kind: "native-managed";
      readonly service: "native-promise-runtime";
    };

export type MathRuntimeProviderImplementation = Extract<
  RuntimeProviderImplementation,
  { readonly kind: "backend-op" | "self-hosted" }
>;

export interface RuntimeProviderDefinition {
  readonly id: RuntimeProviderId;
  readonly feature: RuntimeFeature;
  /** Present for source intrinsics; semantic runtime requirements need no call ABI. */
  readonly signature?: IntrinsicSignature;
  readonly dependencies: readonly RuntimeFeature[];
  readonly hostCapabilities: readonly HostCapabilityId[];
  readonly supportedTargets: readonly RuntimeTarget[];
  readonly supportedBackends: readonly RuntimeBackend[];
  readonly implementation: RuntimeProviderImplementation;
}

/** Math lowering compatibility view; async providers are consumed by later adapters. */
export type RuntimeProviderPlan = RuntimeProviderDefinition & {
  readonly implementation: MathRuntimeProviderImplementation;
};

export interface RuntimeProviderComponent {
  readonly features: readonly RuntimeFeature[];
  readonly providers: readonly RuntimeProviderId[];
  readonly cyclic: boolean;
}

export interface FrozenRuntimeManifest {
  readonly policy: RuntimeManifestPolicy;
  readonly intrinsicUses: readonly IntrinsicUse[];
  readonly features: readonly RuntimeFeature[];
  readonly providers: readonly RuntimeProviderDefinition[];
  readonly providerComponents: readonly RuntimeProviderComponent[];
  readonly hostCapabilities: readonly HostCapabilityId[];
}

export type RuntimeManifestInvariantCode =
  | IntrinsicVerificationCode
  | "manifest-frozen"
  | "manifest-build-failed"
  | "manifest-not-frozen"
  | "unknown-runtime-feature"
  | "unknown-runtime-provider"
  | "unknown-host-capability"
  | "duplicate-runtime-provider"
  | "duplicate-cycle-declaration"
  | "invalid-cycle-declaration"
  | "missing-runtime-provider"
  | "ambiguous-runtime-provider"
  | "provider-target-unavailable"
  | "missing-backend-adapter"
  | "provider-signature-mismatch"
  | "undeclared-provider-cycle"
  | "declared-cycle-mismatch"
  | "late-unplanned-intrinsic"
  | "late-unplanned-feature"
  | "late-unplanned-provider"
  | "late-unplanned-host-capability";

export class RuntimeManifestInvariantError extends Error {
  readonly kind = "invariant" as const;
  readonly stage = "verify" as const;

  constructor(
    readonly code: RuntimeManifestInvariantCode,
    detail: string,
  ) {
    super(detail);
    this.name = "RuntimeManifestInvariantError";
  }
}

const ALL_TARGETS = Object.freeze<readonly RuntimeTarget[]>(["host", "standalone", "strict-no-host", "wasi"]);
const ALL_BACKENDS = Object.freeze<readonly RuntimeBackend[]>(["linear", "wasmgc"]);

export const RUNTIME_FEATURE_SIGNATURES: Readonly<Partial<Record<RuntimeFeature, IntrinsicSignature>>> = Object.freeze({
  "math.abs": F64_UNARY_INTRINSIC_SIGNATURE,
  "math.atan": F64_UNARY_INTRINSIC_SIGNATURE,
  "math.atan2": F64_BINARY_INTRINSIC_SIGNATURE,
  "math.ceil": F64_UNARY_INTRINSIC_SIGNATURE,
  "math.cos": F64_UNARY_INTRINSIC_SIGNATURE,
  "math.exp": F64_UNARY_INTRINSIC_SIGNATURE,
  "math.floor": F64_UNARY_INTRINSIC_SIGNATURE,
  "math.log": F64_UNARY_INTRINSIC_SIGNATURE,
  "math.log2": F64_UNARY_INTRINSIC_SIGNATURE,
  "math.pow": F64_BINARY_INTRINSIC_SIGNATURE,
  "math.reduce-trig": F64_UNARY_INTRINSIC_SIGNATURE,
  "math.sin": F64_UNARY_INTRINSIC_SIGNATURE,
  "math.sqrt": F64_UNARY_INTRINSIC_SIGNATURE,
  "math.trunc": F64_UNARY_INTRINSIC_SIGNATURE,
});

function provider(
  id: RuntimeProviderId,
  feature: RuntimeFeature,
  signature: IntrinsicSignature,
  implementation: RuntimeProviderImplementation,
  dependencies: readonly RuntimeFeature[] = [],
): RuntimeProviderDefinition {
  return Object.freeze({
    id,
    feature,
    signature,
    dependencies: Object.freeze([...dependencies].sort()),
    hostCapabilities: PURE_MATH_HOST_CAPABILITIES,
    supportedTargets: ALL_TARGETS,
    supportedBackends: ALL_BACKENDS,
    implementation: Object.freeze({ ...implementation }),
  });
}

const PROVIDERS_BY_FEATURE: Readonly<Record<MathRuntimeFeature, RuntimeProviderDefinition>> = Object.freeze({
  "math.abs": provider("backend.f64.abs", "math.abs", F64_UNARY_INTRINSIC_SIGNATURE, {
    kind: "backend-op",
    opcode: "f64.abs",
  }),
  "math.atan": provider("selfhost.math.atan", "math.atan", F64_UNARY_INTRINSIC_SIGNATURE, {
    kind: "self-hosted",
    symbol: "Math_atan",
  }),
  "math.atan2": provider(
    "selfhost.math.atan2",
    "math.atan2",
    F64_BINARY_INTRINSIC_SIGNATURE,
    { kind: "self-hosted", symbol: "Math_atan2" },
    ["math.atan"],
  ),
  "math.ceil": provider("backend.f64.ceil", "math.ceil", F64_UNARY_INTRINSIC_SIGNATURE, {
    kind: "backend-op",
    opcode: "f64.ceil",
  }),
  "math.cos": provider(
    "selfhost.math.cos",
    "math.cos",
    F64_UNARY_INTRINSIC_SIGNATURE,
    { kind: "self-hosted", symbol: "Math_cos" },
    ["math.reduce-trig"],
  ),
  "math.exp": provider("selfhost.math.exp", "math.exp", F64_UNARY_INTRINSIC_SIGNATURE, {
    kind: "self-hosted",
    symbol: "Math_exp",
  }),
  "math.floor": provider("backend.f64.floor", "math.floor", F64_UNARY_INTRINSIC_SIGNATURE, {
    kind: "backend-op",
    opcode: "f64.floor",
  }),
  "math.log": provider("selfhost.math.log", "math.log", F64_UNARY_INTRINSIC_SIGNATURE, {
    kind: "self-hosted",
    symbol: "Math_log",
  }),
  "math.log2": provider("selfhost.math.log2", "math.log2", F64_UNARY_INTRINSIC_SIGNATURE, {
    kind: "self-hosted",
    symbol: "Math_log2",
  }),
  "math.pow": provider(
    "selfhost.math.pow",
    "math.pow",
    F64_BINARY_INTRINSIC_SIGNATURE,
    { kind: "self-hosted", symbol: "Math_pow" },
    ["math.exp", "math.log"],
  ),
  "math.reduce-trig": provider("selfhost.math.reduce-trig", "math.reduce-trig", F64_UNARY_INTRINSIC_SIGNATURE, {
    kind: "self-hosted",
    symbol: "__math_reduce_trig",
  }),
  "math.sin": provider(
    "selfhost.math.sin",
    "math.sin",
    F64_UNARY_INTRINSIC_SIGNATURE,
    { kind: "self-hosted", symbol: "Math_sin" },
    ["math.reduce-trig"],
  ),
  "math.sqrt": provider("backend.f64.sqrt", "math.sqrt", F64_UNARY_INTRINSIC_SIGNATURE, {
    kind: "backend-op",
    opcode: "f64.sqrt",
  }),
  "math.trunc": provider("backend.f64.trunc", "math.trunc", F64_UNARY_INTRINSIC_SIGNATURE, {
    kind: "backend-op",
    opcode: "f64.trunc",
  }),
});

/** Canonically ordered default provider catalogue for the twelve-method slice. */
export const PURE_MATH_RUNTIME_PROVIDERS: readonly RuntimeProviderDefinition[] = Object.freeze(
  PURE_MATH_RUNTIME_FEATURES.map((feature) => PROVIDERS_BY_FEATURE[feature]).sort((left, right) =>
    left.id.localeCompare(right.id),
  ),
);

/** Closed, canonically ordered catalogue used by production manifest builders. */
export const RUNTIME_PROVIDERS: readonly RuntimeProviderDefinition[] = Object.freeze(
  [...PURE_MATH_RUNTIME_PROVIDERS, ...ASYNC_RUNTIME_PROVIDERS].sort((left, right) => left.id.localeCompare(right.id)),
);

const FEATURE_SET: ReadonlySet<string> = new Set([
  ...PURE_MATH_RUNTIME_FEATURES,
  ...ASYNC_RUNTIME_FEATURES,
  ...ASYNC_OPTIONAL_RUNTIME_FEATURES,
]);
const PROVIDER_ID_SET: ReadonlySet<string> = new Set([
  ...PURE_MATH_RUNTIME_PROVIDER_IDS,
  ...ASYNC_RUNTIME_PROVIDER_IDS,
]);
const HOST_CAPABILITY_ID_SET: ReadonlySet<string> = new Set(ASYNC_HOST_CAPABILITY_IDS);
const TARGET_SET: ReadonlySet<string> = new Set(ALL_TARGETS);
const BACKEND_SET: ReadonlySet<string> = new Set(ALL_BACKENDS);

function isRuntimeFeature(value: string): value is RuntimeFeature {
  return FEATURE_SET.has(value);
}

function compareStrings(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function signatureEquals(left: IntrinsicSignature, right: IntrinsicSignature): boolean {
  if (left.version !== right.version || left.params.length !== right.params.length) return false;
  for (let index = 0; index < left.params.length; index++) {
    if (!irTypeEquals(left.params[index]!, right.params[index]!)) return false;
  }
  return irTypeEquals(left.result, right.result);
}

function cloneProvider(value: RuntimeProviderDefinition): RuntimeProviderDefinition {
  const signature =
    value.signature === undefined
      ? undefined
      : signatureEquals(value.signature, F64_UNARY_INTRINSIC_SIGNATURE)
        ? F64_UNARY_INTRINSIC_SIGNATURE
        : signatureEquals(value.signature, F64_BINARY_INTRINSIC_SIGNATURE)
          ? F64_BINARY_INTRINSIC_SIGNATURE
          : value.signature;
  return Object.freeze({
    ...value,
    ...(signature === undefined ? {} : { signature }),
    dependencies: Object.freeze([...new Set(value.dependencies)].sort(compareStrings)),
    hostCapabilities: Object.freeze([...new Set(value.hostCapabilities)].sort(compareStrings)),
    supportedTargets: Object.freeze([...new Set(value.supportedTargets)].sort(compareStrings)),
    supportedBackends: Object.freeze([...new Set(value.supportedBackends)].sort(compareStrings)),
    implementation: Object.freeze({ ...value.implementation }),
  });
}

function cycleKey(features: readonly RuntimeFeature[]): string {
  return [...features].sort(compareStrings).join("\u0000");
}

function useOrder(left: IntrinsicUse, right: IntrinsicUse): number {
  return (
    compareStrings(left.id, right.id) ||
    compareStrings(left.location.file, right.location.file) ||
    left.location.line - right.location.line ||
    left.location.column - right.location.column
  );
}

function stronglyConnectedComponents(
  features: readonly RuntimeFeature[],
  dependencies: ReadonlyMap<RuntimeFeature, readonly RuntimeFeature[]>,
): RuntimeFeature[][] {
  let nextIndex = 0;
  const indices = new Map<RuntimeFeature, number>();
  const lowLinks = new Map<RuntimeFeature, number>();
  const stack: RuntimeFeature[] = [];
  const onStack = new Set<RuntimeFeature>();
  const components: RuntimeFeature[][] = [];

  const visit = (feature: RuntimeFeature): void => {
    const index = nextIndex++;
    indices.set(feature, index);
    lowLinks.set(feature, index);
    stack.push(feature);
    onStack.add(feature);

    for (const dependency of dependencies.get(feature) ?? []) {
      if (!indices.has(dependency)) {
        visit(dependency);
        lowLinks.set(feature, Math.min(lowLinks.get(feature)!, lowLinks.get(dependency)!));
      } else if (onStack.has(dependency)) {
        lowLinks.set(feature, Math.min(lowLinks.get(feature)!, indices.get(dependency)!));
      }
    }

    if (lowLinks.get(feature) !== indices.get(feature)) return;
    const component: RuntimeFeature[] = [];
    let member: RuntimeFeature;
    do {
      member = stack.pop()!;
      onStack.delete(member);
      component.push(member);
    } while (member !== feature);
    components.push(component.sort(compareStrings));
  };

  for (const feature of features) if (!indices.has(feature)) visit(feature);
  return components.sort((left, right) => compareStrings(cycleKey(left), cycleKey(right)));
}

function buildProviderComponents(
  features: readonly RuntimeFeature[],
  providers: ReadonlyMap<RuntimeFeature, RuntimeProviderDefinition>,
  declaredCycles: ReadonlyMap<string, readonly RuntimeFeature[]>,
): readonly RuntimeProviderComponent[] {
  const dependencies = new Map<RuntimeFeature, readonly RuntimeFeature[]>();
  for (const feature of features) dependencies.set(feature, providers.get(feature)!.dependencies);
  const components = stronglyConnectedComponents(features, dependencies);
  const actualCycleKeys = new Set<string>();

  for (const component of components) {
    const selfCycle = component.length === 1 && dependencies.get(component[0]!)!.includes(component[0]!);
    if (component.length === 1 && !selfCycle) continue;
    const key = cycleKey(component);
    actualCycleKeys.add(key);
    if (!declaredCycles.has(key)) {
      throw new RuntimeManifestInvariantError(
        "undeclared-provider-cycle",
        `runtime provider cycle ${component.join(" -> ")} was not declared`,
      );
    }
  }

  const selected = new Set(features);
  for (const [key, declaration] of declaredCycles) {
    if (declaration.every((feature) => selected.has(feature)) && !actualCycleKeys.has(key)) {
      throw new RuntimeManifestInvariantError(
        "declared-cycle-mismatch",
        `declared runtime provider cycle ${declaration.join(", ")} is not one canonical component`,
      );
    }
  }

  const componentOf = new Map<RuntimeFeature, number>();
  components.forEach((component, index) => component.forEach((feature) => componentOf.set(feature, index)));
  const orderedIndices: number[] = [];
  const visited = new Set<number>();
  const order = [...components.keys()].sort((left, right) =>
    compareStrings(cycleKey(components[left]!), cycleKey(components[right]!)),
  );
  const visitComponent = (index: number): void => {
    if (visited.has(index)) return;
    visited.add(index);
    const dependenciesOfComponent = new Set<number>();
    for (const feature of components[index]!) {
      for (const dependency of dependencies.get(feature) ?? []) {
        const dependencyIndex = componentOf.get(dependency)!;
        if (dependencyIndex !== index) dependenciesOfComponent.add(dependencyIndex);
      }
    }
    for (const dependencyIndex of [...dependenciesOfComponent].sort((left, right) =>
      compareStrings(cycleKey(components[left]!), cycleKey(components[right]!)),
    )) {
      visitComponent(dependencyIndex);
    }
    orderedIndices.push(index);
  };
  for (const index of order) visitComponent(index);

  return Object.freeze(
    orderedIndices.map((index) => {
      const componentFeatures = Object.freeze([...components[index]!]);
      return Object.freeze({
        features: componentFeatures,
        providers: Object.freeze(componentFeatures.map((feature) => providers.get(feature)!.id).sort(compareStrings)),
        cyclic:
          componentFeatures.length > 1 || dependencies.get(componentFeatures[0]!)!.includes(componentFeatures[0]!),
      });
    }),
  );
}

export interface RuntimeManifestBuilderOptions {
  /** Test/integration seam; omission uses the exhaustive production catalogue. */
  readonly providers?: readonly RuntimeProviderDefinition[];
}

type BuilderState = "open" | "building" | "frozen" | "failed";

export class RuntimeManifestBuilder {
  readonly #policy: RuntimeManifestPolicy;
  readonly #uses: IntrinsicUse[] = [];
  readonly #requestedFeatures = new Set<RuntimeFeature>();
  readonly #providers: RuntimeProviderDefinition[];
  readonly #addedDependencies = new Map<RuntimeFeature, Set<RuntimeFeature>>();
  readonly #declaredCycles = new Map<string, readonly RuntimeFeature[]>();
  readonly #plannedIntrinsicIds = new Set<IntrinsicId>();
  readonly #plannedProviderIds = new Set<RuntimeProviderId>();
  readonly #plannedHostCapabilityIds = new Set<HostCapabilityId>();
  readonly #providerPlans = new Map<RuntimeFeature, RuntimeProviderDefinition>();
  #state: BuilderState = "open";
  #manifest?: FrozenRuntimeManifest;

  constructor(policy: RuntimeManifestPolicy, options: RuntimeManifestBuilderOptions = {}) {
    if (!TARGET_SET.has(policy.target) || !BACKEND_SET.has(policy.backend)) {
      throw new RuntimeManifestInvariantError(
        "provider-target-unavailable",
        `invalid runtime manifest policy ${String(policy.target)}/${String(policy.backend)}`,
      );
    }
    this.#policy = Object.freeze({ ...policy });
    this.#providers = (options.providers ?? RUNTIME_PROVIDERS).map(cloneProvider);
  }

  addIntrinsicUse(use: IntrinsicUse, effects: IntrinsicEffectEvidence): void {
    this.#assertMutable();
    const failure = verifyIntrinsicUse(use, effects);
    if (failure) throw new RuntimeManifestInvariantError(failure.code, failure.detail);
    const canonical = INTRINSIC_DEFINITIONS[use.id];
    this.#uses.push(
      Object.freeze({
        id: use.id,
        version: canonical.signature.version,
        argumentTypes: canonical.signature.params,
        resultType: canonical.signature.result,
        location: Object.freeze({ ...use.location }),
      }),
    );
  }

  /** Register a semantic runtime requirement discovered during preparation. */
  requestFeature(feature: RuntimeFeature): void {
    this.#assertMutable();
    this.#assertKnownFeature(feature);
    this.#requestedFeatures.add(feature);
  }

  registerProvider(value: RuntimeProviderDefinition): void {
    this.#assertMutable();
    if (this.#providers.some((candidate) => candidate.id === value.id)) {
      throw new RuntimeManifestInvariantError(
        "duplicate-runtime-provider",
        `provider ${value.id} is already registered`,
      );
    }
    this.#providers.push(cloneProvider(value));
  }

  addProviderDependency(feature: RuntimeFeature, dependency: RuntimeFeature): void {
    this.#assertMutable();
    this.#assertKnownFeature(feature);
    this.#assertKnownFeature(dependency);
    let additions = this.#addedDependencies.get(feature);
    if (!additions) {
      additions = new Set();
      this.#addedDependencies.set(feature, additions);
    }
    additions.add(dependency);
  }

  declareProviderCycle(features: readonly RuntimeFeature[]): void {
    this.#assertMutable();
    const canonical = [...new Set(features)].sort(compareStrings);
    if (canonical.length === 0 || canonical.length !== features.length) {
      throw new RuntimeManifestInvariantError(
        "invalid-cycle-declaration",
        "provider cycle declarations must contain one or more unique features",
      );
    }
    canonical.forEach((feature) => this.#assertKnownFeature(feature));
    const key = cycleKey(canonical);
    if (this.#declaredCycles.has(key)) {
      throw new RuntimeManifestInvariantError(
        "duplicate-cycle-declaration",
        `provider cycle ${canonical.join(", ")} was declared more than once`,
      );
    }
    this.#declaredCycles.set(key, Object.freeze(canonical));
  }

  freeze(): FrozenRuntimeManifest {
    this.#assertMutable();
    this.#state = "building";
    try {
      this.#manifest = this.#buildManifest();
      this.#state = "frozen";
      return this.#manifest;
    } catch (error) {
      this.#state = "failed";
      throw error;
    }
  }

  get manifest(): FrozenRuntimeManifest {
    if (this.#state !== "frozen" || !this.#manifest) {
      throw new RuntimeManifestInvariantError("manifest-not-frozen", "runtime manifest is not frozen");
    }
    return this.#manifest;
  }

  resolveProvider(feature: MathRuntimeFeature): RuntimeProviderPlan;
  resolveProvider(feature: AsyncRuntimeFeature): RuntimeProviderDefinition;
  resolveProvider(feature: RuntimeFeature): RuntimeProviderDefinition {
    this.#assertFrozen();
    const provider = this.#providerPlans.get(feature);
    if (!provider) {
      throw new RuntimeManifestInvariantError(
        "late-unplanned-feature",
        `runtime feature ${String(feature)} was not present at manifest freeze`,
      );
    }
    return provider;
  }

  assertIntrinsicPlanned(id: IntrinsicId): void {
    this.#assertFrozen();
    if (!this.#plannedIntrinsicIds.has(id)) {
      throw new RuntimeManifestInvariantError(
        "late-unplanned-intrinsic",
        `intrinsic ${String(id)} was not present at manifest freeze`,
      );
    }
  }

  assertProviderPlanned(id: RuntimeProviderId): void {
    this.#assertFrozen();
    if (!this.#plannedProviderIds.has(id)) {
      throw new RuntimeManifestInvariantError(
        "late-unplanned-provider",
        `runtime provider ${String(id)} was not present at manifest freeze`,
      );
    }
  }

  assertHostCapabilityPlanned(capability: string): void {
    this.#assertFrozen();
    if (!this.#plannedHostCapabilityIds.has(capability as HostCapabilityId)) {
      throw new RuntimeManifestInvariantError(
        "late-unplanned-host-capability",
        `host capability ${capability} was not present at manifest freeze`,
      );
    }
  }

  #buildManifest(): FrozenRuntimeManifest {
    const providersByFeature = this.#indexProviders();
    const pending = new Set<RuntimeFeature>(this.#requestedFeatures);
    for (const use of this.#uses) pending.add(INTRINSIC_DEFINITIONS[use.id].feature);

    while (pending.size > 0) {
      const feature = [...pending].sort(compareStrings)[0]!;
      pending.delete(feature);
      if (this.#providerPlans.has(feature)) continue;
      const selected = this.#selectProvider(feature, providersByFeature);
      const expectedSignature = RUNTIME_FEATURE_SIGNATURES[feature];
      if (
        expectedSignature !== undefined &&
        (selected.signature === undefined || !signatureEquals(selected.signature, expectedSignature))
      ) {
        throw new RuntimeManifestInvariantError(
          "provider-signature-mismatch",
          `provider ${selected.id} does not implement the ${feature} signature`,
        );
      }
      const dependencies = new Set(selected.dependencies);
      for (const dependency of this.#addedDependencies.get(feature) ?? []) dependencies.add(dependency);
      const plan = Object.freeze({
        ...selected,
        dependencies: Object.freeze([...dependencies].sort(compareStrings)),
      });
      this.#providerPlans.set(feature, plan);
      for (const dependency of plan.dependencies) pending.add(dependency);
    }

    const features = Object.freeze([...this.#providerPlans.keys()].sort(compareStrings));
    const providerComponents = buildProviderComponents(features, this.#providerPlans, this.#declaredCycles);
    const providers = Object.freeze(
      [...this.#providerPlans.values()].sort((left, right) => compareStrings(left.id, right.id)),
    );
    const intrinsicUses = Object.freeze([...this.#uses].sort(useOrder));
    const hostCapabilityIds = new Set<HostCapabilityId>();
    for (const provider of providers) {
      for (const capability of provider.hostCapabilities) hostCapabilityIds.add(capability);
    }
    const hostCapabilities = Object.freeze([...hostCapabilityIds].sort(compareStrings));

    for (const use of intrinsicUses) this.#plannedIntrinsicIds.add(use.id);
    for (const value of providers) this.#plannedProviderIds.add(value.id);
    for (const capability of hostCapabilities) this.#plannedHostCapabilityIds.add(capability);

    return Object.freeze({
      policy: this.#policy,
      intrinsicUses,
      features,
      providers,
      providerComponents,
      hostCapabilities,
    });
  }

  #indexProviders(): ReadonlyMap<RuntimeFeature, readonly RuntimeProviderDefinition[]> {
    const ids = new Set<RuntimeProviderId>();
    const byFeature = new Map<RuntimeFeature, RuntimeProviderDefinition[]>();
    for (const provider of this.#providers) {
      if (!PROVIDER_ID_SET.has(provider.id)) {
        throw new RuntimeManifestInvariantError(
          "unknown-runtime-provider",
          `unknown runtime provider ${String(provider.id)}`,
        );
      }
      this.#assertKnownFeature(provider.feature);
      if (ids.has(provider.id)) {
        throw new RuntimeManifestInvariantError(
          "duplicate-runtime-provider",
          `runtime provider ${provider.id} was registered more than once`,
        );
      }
      ids.add(provider.id);
      for (const dependency of provider.dependencies) this.#assertKnownFeature(dependency);
      for (const capability of provider.hostCapabilities) {
        if (!HOST_CAPABILITY_ID_SET.has(capability)) {
          throw new RuntimeManifestInvariantError(
            "unknown-host-capability",
            `provider ${provider.id} requests unknown host capability ${String(capability)}`,
          );
        }
      }
      if (provider.implementation.kind === "host-managed" && provider.hostCapabilities.length > 0) {
        throw new RuntimeManifestInvariantError(
          "unknown-host-capability",
          `host-managed provider ${provider.id} cannot request concrete host capabilities`,
        );
      }
      if (provider.implementation.kind === "native-managed" && provider.hostCapabilities.length > 0) {
        throw new RuntimeManifestInvariantError(
          "unknown-host-capability",
          `native-managed provider ${provider.id} cannot request concrete host capabilities`,
        );
      }
      if (provider.implementation.kind === "host-capability" && provider.hostCapabilities.length === 0) {
        throw new RuntimeManifestInvariantError(
          "unknown-host-capability",
          `host-capability provider ${provider.id} must request at least one host capability`,
        );
      }
      if (!provider.supportedTargets.every((target) => TARGET_SET.has(target))) {
        throw new RuntimeManifestInvariantError(
          "provider-target-unavailable",
          `provider ${provider.id} has an unknown target`,
        );
      }
      if (!provider.supportedBackends.every((backend) => BACKEND_SET.has(backend))) {
        throw new RuntimeManifestInvariantError(
          "missing-backend-adapter",
          `provider ${provider.id} has an unknown backend`,
        );
      }
      const candidates = byFeature.get(provider.feature) ?? [];
      candidates.push(provider);
      byFeature.set(provider.feature, candidates);
    }
    return byFeature;
  }

  #selectProvider(
    feature: RuntimeFeature,
    providers: ReadonlyMap<RuntimeFeature, readonly RuntimeProviderDefinition[]>,
  ): RuntimeProviderDefinition {
    const candidates = providers.get(feature) ?? [];
    if (candidates.length === 0) {
      throw new RuntimeManifestInvariantError("missing-runtime-provider", `runtime feature ${feature} has no provider`);
    }
    const targetCandidates = candidates.filter((candidate) => candidate.supportedTargets.includes(this.#policy.target));
    if (targetCandidates.length === 0) {
      throw new RuntimeManifestInvariantError(
        "provider-target-unavailable",
        `runtime feature ${feature} is unavailable for target ${this.#policy.target}`,
      );
    }
    const backendCandidates = targetCandidates.filter((candidate) =>
      candidate.supportedBackends.includes(this.#policy.backend),
    );
    if (backendCandidates.length === 0) {
      throw new RuntimeManifestInvariantError(
        "missing-backend-adapter",
        `runtime feature ${feature} has no ${this.#policy.backend} adapter`,
      );
    }
    if (backendCandidates.length !== 1) {
      throw new RuntimeManifestInvariantError(
        "ambiguous-runtime-provider",
        `runtime feature ${feature} has ${backendCandidates.length} matching providers`,
      );
    }
    return backendCandidates[0]!;
  }

  #assertKnownFeature(feature: RuntimeFeature): void {
    if (!isRuntimeFeature(feature)) {
      throw new RuntimeManifestInvariantError("unknown-runtime-feature", `unknown runtime feature ${String(feature)}`);
    }
  }

  #assertMutable(): void {
    if (this.#state === "open") return;
    throw new RuntimeManifestInvariantError(
      this.#state === "failed" ? "manifest-build-failed" : "manifest-frozen",
      `runtime manifest builder is ${this.#state}`,
    );
  }

  #assertFrozen(): void {
    if (this.#state !== "frozen") {
      throw new RuntimeManifestInvariantError("manifest-not-frozen", `runtime manifest builder is ${this.#state}`);
    }
  }
}
