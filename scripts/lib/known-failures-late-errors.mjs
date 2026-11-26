// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// (#7509) A setup file vitest.config.ts adds to every run under the known-failures gate. With forks and isolation, vitest tears a
// file's worker down as soon as its last hook ends, so an error a test schedules to fire later (a timer that
// rejects, a callback that throws) never fires and the gate never sees it. Holding each file open for a short grace
// period lets such an error fire inside the worker, where vitest reports it as an unhandled error and the gate
// refuses it. An error scheduled further out than the grace period is still lost.
import { afterAll } from "vitest";

const graceMs = Number(process.env.KNOWN_FAILURES_LATE_ERROR_GRACE_MS) || 100;

// Registered first, so with vitest's default stack order it runs after the file's own afterAll hooks.
afterAll(() => new Promise((resolve) => setTimeout(resolve, graceMs)));
