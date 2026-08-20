// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.

import type { ImportIntent } from "../index.js";

type TimerCapabilityIntent = Extract<ImportIntent, { type: "timer_set" | "timer_clear" }>;

/** Narrow services needed to bind timer capability imports. */
export interface TimerCapabilityAdapterContext {
  deps?: Record<string, any>;
  wrapWasmClosure(value: unknown, arity: number, boundary?: "timer"): ((...args: any[]) => any) | null;
}

let warnedTimerCallbackUnresolvable = false;

function warnTimerCallbackUnresolvable(mode: "timeout" | "interval"): void {
  if (warnedTimerCallbackUnresolvable) return;
  warnedTimerCallbackUnresolvable = true;
  console.warn(
    `[js2wasm] ${mode === "interval" ? "setInterval" : "setTimeout"} callback could not be wrapped as a JS function ` +
      `(WasmGC closure bridge unavailable — likely missing __call_fn_0 export, see #1382). ` +
      `The call is being dropped to avoid a host coercion error. Provide a real JS function via deps to test in the meantime.`,
  );
}

function resolveTimerHost(
  intent: TimerCapabilityIntent,
  deps: Record<string, any> | undefined,
): (...args: any[]) => any {
  const operation = intent.type === "timer_set" ? "set" : "clear";
  const dependencyName = `${operation}${intent.mode === "interval" ? "Interval" : "Timeout"}`;
  const supplied = deps?.[dependencyName];
  if (typeof supplied === "function") return supplied.bind(deps);

  if (intent.type === "timer_set") return intent.mode === "interval" ? setInterval : setTimeout;
  return intent.mode === "interval" ? clearInterval : clearTimeout;
}

/** Bind an explicit set/clear timeout or interval capability intent. */
export function resolveTimerCapabilityImport(
  intent: TimerCapabilityIntent,
  context: TimerCapabilityAdapterContext,
): Function {
  const host = resolveTimerHost(intent, context.deps);

  if (intent.type === "timer_set") {
    return (callback: unknown, delay: unknown) => {
      const callable = typeof callback === "function" ? callback : context.wrapWasmClosure(callback, 0, "timer");
      if (!callable) {
        warnTimerCallbackUnresolvable(intent.mode);
        return 0;
      }
      return host(callable, Number(delay));
    };
  }

  return (handle: unknown) => {
    try {
      host(handle);
    } catch {
      // Browsers ignore invalid timer handles; retain that behavior.
    }
  };
}
