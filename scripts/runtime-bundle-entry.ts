// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * Entry point for `scripts/runtime-bundle.mjs` — the host runtime the fork
 * workers (`scripts/test262-worker.mjs`, `scripts/wasm-exec-worker.mjs`) build
 * their import objects with.
 *
 * It exists to add ONE thing to `src/runtime.ts`: the linked-provider
 * lifecycle (#5353). That is not a convenience re-export, it is a correctness
 * requirement. `src/runtime.ts` owns the #5225 cross-module decoder registry as
 * MODULE-LEVEL state, and `registerLinkedProviderModule` /
 * `registerLinkedConsumerModule` must write into the SAME copy of that module
 * whose `buildImports` produced the import object the instance reads through.
 * The worker already loads a second copy of the runtime inside
 * `compiler-bundle.mjs`; registering a Temporal provider there while decoding
 * through this one leaves the registry empty on the reading side, which does
 * not fail loudly — it silently returns the reader's own `ref.test`-miss
 * default (0) for a field name both modules happen to use, which the Temporal
 * polyfill has plenty of (`month`, `day`, …).
 *
 * `src/runtime.ts` itself must NOT import `linked-provider-runtime.ts`: that
 * would drag the provider-manifest/rec-group decoder into every browser
 * consumer of the runtime, and it is a cycle (`linked-provider-runtime`
 * imports the runtime).
 */
export * from "../src/runtime.ts";
export { instantiateLinkedProviders, wireCompiledInstance } from "../src/linked-provider-runtime.ts";
