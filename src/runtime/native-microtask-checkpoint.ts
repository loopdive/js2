// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * (#6982) Map the native microtask ring onto the JavaScript embedder's
 * microtask checkpoint.
 *
 * A native-regime module owns its Promise jobs in a Wasm ring, drained by the
 * exported `__drain_microtasks`. The JS value adapter already drains it when a
 * native Promise crosses the boundary, but a SYNCHRONOUS export that started
 * async work (`f(); return x;` where `f` awaits) left its jobs queued until
 * some later Promise happened to cross. Once `await <settled>` yields a turn as
 * §27.7.5.3 requires, that is every fire-and-forget async call. Queue one host
 * microtask after the export returns, so the native jobs run exactly where a
 * JavaScript engine would run its own: after the current job, before timers.
 */
export function scheduleNativeMicrotaskCheckpoint(exports: Record<string, unknown> | undefined): void {
  const pending = exports?.__microtasks_pending;
  const drain = exports?.__drain_microtasks;
  if (typeof pending !== "function" || typeof drain !== "function") return;
  if (pending() === 0) return;
  queueMicrotask(() => {
    if (pending() !== 0) drain();
  });
}
