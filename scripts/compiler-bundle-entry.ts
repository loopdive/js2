// Entry point for the compiler bundle — re-exports everything the playground needs.
// Used by `build:compiler-bundle` to produce scripts/compiler-bundle.mjs.
export * from "../src/index.ts";
export { optimizeBinaryAsync } from "../src/optimize.ts";

// (#5353) The compile-once `Temporal` provider (#4628/#5248). The SHARDED
// test262 lane (`scripts/test262-worker.mjs`) runs against this bundle with no
// TypeScript loader, so a `src/` import there is impossible: the only way that
// lane can link the provider is for the bundle to publish it.
//
// The worker namespace-imports the bundle and feature-DETECTS these names, so a
// bundle built from an older entry (or straight from `src/index.ts`, which some
// helper scripts still do) degrades to the unlinked lane rather than failing to
// load.
export {
  buildTemporalProvider,
  compileWithTemporalGlobal,
  temporalProviderCacheKey,
  TEMPORAL_PRELUDE_LINES,
} from "../src/temporal-provider.ts";
export type { TemporalProvider } from "../src/temporal-provider.ts";
