// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.

/** Reserved compiler/runtime contract for the authenticated timer dispatcher. */
export const STANDALONE_TIMER_CALLBACK_DISPATCH_EXPORT = "__\0js2_timer_callback_dispatch_0";
export const STANDALONE_TIMER_CALLBACK_DISPATCH_PHYSICAL_BASE = "$t0";
export const STANDALONE_TIMER_CALLBACK_MANIFEST_EXPORT = "__\0js2_timer_callback_manifest";
export const STANDALONE_TIMER_CALLBACK_MANIFEST_PHYSICAL_BASE = "$tm";
export const STANDALONE_TIMER_CALLBACK_MARKER_EXPORT = "__\0js2_timer_callback_marker";
export const STANDALONE_TIMER_CALLBACK_MARKER_PHYSICAL_BASE = "$tt";
export const STANDALONE_TIMER_CALLBACK_BINDINGS_EXPORT = "__\0js2_timer_callback_bindings";
export const STANDALONE_TIMER_CALLBACK_BINDINGS_PHYSICAL_BASE = "$tu";
export const STANDALONE_TIMER_CALLBACK_MANIFEST_MAGIC = 0x5a400001;

export type StandaloneTimerCallbackExportFamily = "dispatch" | "manifest" | "marker" | "bindings";

/** Preserve the timer bridge's logical aliases and terminal physical aliases. */
export function planStandaloneTimerCallbackExports(
  occupiedNames: Iterable<string>,
): readonly { readonly family: StandaloneTimerCallbackExportFamily; readonly name: string }[] {
  const occupied = new Set(occupiedNames);
  const result: { family: StandaloneTimerCallbackExportFamily; name: string }[] = [];
  const families = [
    ["dispatch", STANDALONE_TIMER_CALLBACK_DISPATCH_EXPORT, STANDALONE_TIMER_CALLBACK_DISPATCH_PHYSICAL_BASE],
    ["manifest", STANDALONE_TIMER_CALLBACK_MANIFEST_EXPORT, STANDALONE_TIMER_CALLBACK_MANIFEST_PHYSICAL_BASE],
    ["marker", STANDALONE_TIMER_CALLBACK_MARKER_EXPORT, STANDALONE_TIMER_CALLBACK_MARKER_PHYSICAL_BASE],
    ["bindings", STANDALONE_TIMER_CALLBACK_BINDINGS_EXPORT, STANDALONE_TIMER_CALLBACK_BINDINGS_PHYSICAL_BASE],
  ] as const;
  for (const [family, logicalName, physicalBase] of families) {
    if (!occupied.has(logicalName)) {
      result.push({ family, name: logicalName });
      occupied.add(logicalName);
    }
    let maxOccupiedSuffix = -1;
    for (const name of occupied) {
      if (!name.startsWith(physicalBase)) continue;
      const suffix = name.slice(physicalBase.length);
      if (/^\$*$/.test(suffix)) maxOccupiedSuffix = Math.max(maxOccupiedSuffix, suffix.length);
    }
    for (let suffixLength = 0; suffixLength <= maxOccupiedSuffix + 1; suffixLength++) {
      const name = `${physicalBase}${"$".repeat(suffixLength)}`;
      if (occupied.has(name)) continue;
      result.push({ family, name });
      occupied.add(name);
    }
  }
  return result;
}
