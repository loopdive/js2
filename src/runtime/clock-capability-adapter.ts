// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.

import type { JavaScriptAdapterManifestV1 } from "../adapter-manifest.js";

const reflectApply = Reflect.apply;
const numberIsFinite = Number.isFinite;
const EMPTY_CLOCK_ARGUMENTS: readonly [] = Object.freeze([]);
const TIME_CLIP_BOUND_MS = 8_640_000_000_000_000;

type ClockProvider = () => unknown;

export type ClockCapabilityImport = () => number;

function wrapClockProvider(provider: ClockProvider, receiver: unknown): ClockCapabilityImport {
  return () => {
    const value = reflectApply(provider, receiver, EMPTY_CLOCK_ARGUMENTS);
    if (
      typeof value !== "number" ||
      !numberIsFinite(value) ||
      value < -TIME_CLIP_BOUND_MS ||
      value > TIME_CLIP_BOUND_MS
    ) {
      throw new TypeError("clock@1 deps.dateNow must return a finite number within the TimeClip range");
    }
    return value;
  };
}

/** Resolve the clock import while preserving the JS-host ambient provider. */
export function resolveClockCapabilityImport(explicitImport?: ClockCapabilityImport): ClockCapabilityImport {
  if (explicitImport) return explicitImport;
  // Preserve the historical JavaScript-host contract: look up Date.now on
  // every call, so ordinary monkey-patching remains observable. Explicit
  // standalone clocks are captured once above and never reach this branch.
  return () => Date.now();
}

/**
 * Capture the explicit standalone clock provider exactly once before import
 * binding. The returned import owns that provider for the adapter lifecycle,
 * so an accessor cannot swap it for ambient authority between validation and
 * binding.
 */
export function captureExplicitStandaloneClockCapabilityImport(
  manifest: JavaScriptAdapterManifestV1,
  deps: Readonly<Record<string, unknown>> | undefined,
): ClockCapabilityImport | undefined {
  const requiresEmbedderClock = manifest.capabilities.some(
    ({ id, selectedProviders }) => id === "clock" && selectedProviders.includes("embedder"),
  );
  if (!requiresEmbedderClock) return undefined;

  const supplied = deps?.dateNow;
  if (typeof supplied !== "function") {
    throw new Error("Explicit embedder capability 'clock' requires deps.dateNow for 'env::__date_now'");
  }
  return wrapClockProvider(supplied as ClockProvider, undefined);
}
