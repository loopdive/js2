// Copyright (C) 2026 the V8 project authors. All rights reserved.
// This code is governed by the BSD license found in the LICENSE file.
/*---
description: >
  Negative control for scripts/harness-flip-probe.ts — MUST report a failing
  status. This is the arm that catches a vacuous instrument: a harness that
  reports success for a case that cannot succeed is a real failure mode in this
  repo's history, and it is invisible unless something is expected to fail.
esid: pending
flags: [noStrict]
---*/

assert.sameValue(1, 2, "this comparison must fail");
