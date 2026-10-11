// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// cross-module-struct-owners.ts — (#5225) the INBOUND twin of #5222.
//
// #5222 fixed the EXIT boundary of the #2527 linked-provider seam: a value the
// PROVIDER minted keeps the host mirror bound to the provider's exports, so the
// consumer can still decode it. This file answers the other direction.
//
// A raw WasmGC struct carries no decoder. Everything that reads one —
// `__struct_field_names`, `__sget_<field>`, `__call_fn_*` — is an EXPORT of one
// specific module, and every runtime read path resolves those exports from the
// module it is currently running inside (`callbackState.getExports()`). That is
// correct for a single module and wrong the moment two linked modules exchange
// values: an object literal built in the CONSUMER and handed to a provider
// function reaches the provider's `__extern_get` with the provider's exports,
// which cannot name a single one of its fields. It reads as an opaque object
// with zero members (`Temporal.PlainDate.from({year, month, day})` →
// "year is required").
//
// The registry below records every module of one linked project and answers
// "who can decode this value?". It is deliberately a MISS-PATH mechanism: the
// callers consult it only after the local exports have already failed to name
// the struct or to serve the field, so the single-module lane and the linked
// hot path (`__extern_get` runs ~10k times per `run()` on mixed/csv-parse,
// #3903) are byte-identical to before. Until some project has two modules
// registered the whole thing short-circuits on one boolean.
//
// (#6790) Modules are grouped into PROJECTS, one per `instantiateLinkedProviders`
// call (keyed by its root import object), and a read only ever consults the
// project of the module doing the reading. The registry used to be one Set for
// the whole process, so a second project — the same provider binary
// instantiated again, whose canonical WasmGC types alias the first's — could be
// answered by the first project's exports unless every embedder remembered to
// call `resetLinkedProjectRegistry()` in between, which no public entry point
// did. Scoping by project needs no reset and, unlike a reset, leaves the first
// project working while both are live.

/**
 * Registry of the modules taking part in one linked project, and a cache of
 * which of them owns (can decode) a given compiled struct.
 */
export function createCrossModuleStructOwners(canBeWeakKey: (value: unknown) => boolean) {
  type Project = Set<Record<string, Function>>;
  // Weak on both keys: a project lives as long as one of its modules (or its
  // root import object) does. Only the newest project is held strongly.
  let projectOf = new WeakMap<object, Project>();
  let projectByRoot = new WeakMap<object, Project>();
  let current: Project | undefined;
  const owners = new WeakMap<object, Record<string, Function>>();
  const states = new WeakMap<Record<string, Function>, { getExports: () => Record<string, Function> }>();
  // Sentinel for "nothing in this project can name it" (closures, vecs, plain
  // host objects). Caching the NEGATIVE is load-bearing, not tidiness: without
  // it every host-object read in a linked project re-probes every module's
  // `__struct_field_names` — two Wasm calls on the `__extern_get` hot path
  // (#3903, ~10k per `run()`).
  const NONE: Record<string, Function> = Object.create(null);
  // Fast opt-out: until some project has two modules every value is local.
  let enabled = false;

  /**
   * The modules that may decode for `local`: its own project. A host-bridge
   * export VIEW (`Object.create(rawExports)`, see `_hostBridgeExportView`)
   * belongs to its raw module's project. A reader with no known module (init,
   * or a module outside every project) gets the newest project, which is what
   * the single process-wide Set used to answer for the newest project.
   * `undefined` when that project cannot have a foreign decoder.
   */
  const projectFor = (local: Record<string, Function> | undefined): Project | undefined => {
    const own =
      local !== undefined && canBeWeakKey(local)
        ? (projectOf.get(local) ?? projectOf.get(Object.getPrototypeOf(local) as object))
        : undefined;
    const project = own ?? current;
    return project !== undefined && project.size > 1 ? project : undefined;
  };

  /**
   * Whether `exports` can name this struct's fields. `__struct_field_names` is
   * a `ref.test` ladder that answers "" for a type the module does not know, so
   * probing a foreign module's helper is safe — it cannot trap.
   */
  const decodes = (exports: Record<string, Function>, obj: object): boolean => {
    const fn = exports.__struct_field_names;
    if (typeof fn !== "function") return false;
    try {
      const csv = fn(obj);
      return typeof csv === "string" && csv !== "";
    } catch {
      return false;
    }
  };

  // (#6492) Second, INDEPENDENT owner cache for ArrayBuffer-shaped structs.
  //
  // `decodes` above asks `__struct_field_names`, which is the right question
  // for a named data struct and the WRONG one for a compiled ArrayBuffer: an
  // i32_byte vec has no field-name list, so it answers "" in its own module
  // too and the generic registry files it under NONE. The consequence is not a
  // missed optimisation — `_compiledAbToHostBuffer` then probes the READER's
  // `__dv_byte_len`, which either does not exist (a consumer whose own body
  // never mentions ArrayBuffer emits no such export) or `ref.test`-misses, so
  // the buffer degrades to a generic vec and `new BigInt64Array(<crossed AB>)`
  // sees an array of NUMBERS ("Cannot convert 0 to a BigInt", 128 linked-lane
  // rows). Kept as a separate map rather than a second arm of `decodes`
  // because the two answers are about different exports and must not share a
  // NONE entry: a struct that is not field-nameable can still be a buffer.
  const bufferOwners = new WeakMap<object, Record<string, Function>>();

  /** Whether `exports` can read this struct AS A BUFFER (`__dv_byte_len` ≥ 0). */
  const decodesBuffer = (exports: Record<string, Function>, obj: object): boolean => {
    const fn = exports.__dv_byte_len;
    if (typeof fn !== "function") return false;
    try {
      const n = fn(obj);
      return typeof n === "number" && n >= 0;
    } catch {
      return false;
    }
  };

  return {
    /**
     * (#6790) Open the project that `root`'s instantiation registers into. A
     * module registered later with the same `root` joins it, whatever project
     * has opened since.
     */
    beginProject(root: object): void {
      current = new Set();
      if (canBeWeakKey(root)) projectByRoot.set(root, current);
    },

    /**
     * Add a module to `root`'s project (or the newest one). A module already in
     * a project stays where it is — `wrapLinkedProviderValue` re-registers its
     * provider on every crossing, possibly long after a newer project opened.
     */
    registerModule(exports: Record<string, Function> | undefined, root?: object): void {
      if (exports === undefined || !canBeWeakKey(exports) || projectOf.has(exports)) return;
      const project =
        (root !== undefined && canBeWeakKey(root) ? projectByRoot.get(root) : undefined) ?? (current ??= new Set());
      project.add(exports);
      projectOf.set(exports, project);
      if (project.size > 1) enabled = true;
    },

    /**
     * The exports that own `obj` when `local` does NOT — `undefined` when
     * `local` is already the right decoder, when nothing in the project can
     * decode `obj` (closures, vecs and other unnamed shapes answer "" in their
     * own module too), or when no linked project is live.
     */
    decoderFor(obj: unknown, local: Record<string, Function> | undefined): Record<string, Function> | undefined {
      if (!enabled || !canBeWeakKey(obj)) return undefined;
      const modules = projectFor(local);
      if (modules === undefined) return undefined;
      const cached = owners.get(obj as object);
      // (#5379) A cache entry naming a RETIRED module outranks nothing: re-probe
      // the live project and prefer whatever it answers. The entry is kept as
      // the fallback rather than dropped, because a module that is gone from
      // `modules` can still DECODE the struct it minted — its Wasm instance is
      // alive as long as the struct is — so discarding it would turn a working
      // read of a surviving cross-project value into the `ref.test`-miss default.
      // Only the ORDER changes: live before retired, never retired before live.
      if (cached !== undefined && (cached === NONE || modules.has(cached))) {
        return cached === local || cached === NONE ? undefined : cached;
      }
      if (local !== undefined && decodes(local, obj as object)) {
        owners.set(obj as object, local);
        return undefined;
      }
      for (const peer of modules) {
        if (peer === local) continue;
        if (decodes(peer, obj as object)) {
          owners.set(obj as object, peer);
          return peer;
        }
      }
      if (cached !== undefined) return cached === local ? undefined : cached;
      owners.set(obj as object, NONE);
      return undefined;
    },

    /**
     * (#6492) The exports that can read `obj` as a compiled ArrayBuffer when
     * `local` cannot — `undefined` when `local` already can, when no module of
     * the project can, or when no linked project is live.
     *
     * Deliberately NOT folded into `decoderFor`: the buffer question is asked
     * by one caller (`_compiledAbToHostBuffer`) on the host-construct-argument
     * path, while `decoderFor` is on the `__extern_get` hot path where a second
     * Wasm probe per miss is not free. Same miss-path discipline: `local` is
     * always tried first, so the single-module lane never reaches this.
     */
    bufferDecoderFor(obj: unknown, local: Record<string, Function> | undefined): Record<string, Function> | undefined {
      if (!enabled || !canBeWeakKey(obj)) return undefined;
      const modules = projectFor(local);
      if (modules === undefined) return undefined;
      const cached = bufferOwners.get(obj as object);
      if (cached !== undefined && (cached === NONE || modules.has(cached))) {
        return cached === local || cached === NONE ? undefined : cached;
      }
      if (local !== undefined && decodesBuffer(local, obj as object)) {
        bufferOwners.set(obj as object, local);
        return undefined;
      }
      for (const peer of modules) {
        if (peer === local) continue;
        if (decodesBuffer(peer, obj as object)) {
          bufferOwners.set(obj as object, peer);
          return peer;
        }
      }
      if (cached !== undefined) return cached === local ? undefined : cached;
      bufferOwners.set(obj as object, NONE);
      return undefined;
    },

    /**
     * (#5364) Forget every project registered so far.
     *
     * (#6790) No longer needed for correctness — `beginProject` scopes each
     * instantiation — but kept for callers that want the registry empty: the
     * test262 seam retires each row's project before the next, and the unit
     * tests start clean. Before #6790 the registry was one Set for the whole
     * process, so a second linked project against the SAME provider binary
     * still held project 1's exports; those share canonical WasmGC types with
     * project 2's, so `decodes` answered TRUE for a struct project 1 never
     * minted and `decoderFor` handed back the wrong module.
     *
     * `owners` and `states` are deliberately NOT cleared, but NOT for the reason
     * this comment used to give. The old wording said both WeakMaps "become
     * unreachable with" the retiring project, which is only true when nothing
     * outlives it — and plenty does: a host mirror handed to the embedder keeps
     * its struct alive (and until #6790 the class-parent registry was a
     * process-global STRONG map of class objects). So an `owners` entry naming
     * a retired module can and does survive a reset.
     *
     * (#5379) What makes that safe is the retired-entry arm in `decoderFor`, not
     * unreachability: a cached module outside the reader's project never wins
     * over a live one — the entry is re-probed against the live project first
     * and only used as the fallback. Keeping the entry rather than dropping it
     * preserves the one thing a retired module is still good for, decoding the
     * struct it minted.
     *
     * Forgetting the project maps is what actually retires the projects, and
     * dropping `enabled` back to false restores the single-module fast path
     * byte-for-byte until the next project registers two modules.
     */
    reset(): void {
      projectOf = new WeakMap();
      projectByRoot = new WeakMap();
      current = undefined;
      enabled = false;
    },

    /**
     * The OTHER live modules of the project, for a caller that must retry an
     * operation through each of them (linked-closure-dispatch.ts). Empty when
     * no linked project is live, so the single-module lane never retries.
     */
    peersOf(local: Record<string, Function> | undefined): Record<string, Function>[] {
      const modules = enabled ? projectFor(local) : undefined;
      if (modules === undefined) return [];
      const peers: Record<string, Function>[] = [];
      for (const peer of modules) if (peer !== local) peers.push(peer);
      return peers;
    },

    /**
     * A `callbackState` view of a foreign module's exports, so a read path that
     * threads state (rather than exports) can be redirected with one
     * substitution. One allocation per module, not per call.
     */
    stateFor(exports: Record<string, Function>): { getExports: () => Record<string, Function> } {
      let state = states.get(exports);
      if (state === undefined) {
        state = { getExports: () => exports };
        states.set(exports, state);
      }
      return state;
    },
  };
}
