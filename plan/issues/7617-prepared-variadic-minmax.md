---
id: 7617
title: "Lower ordinary variadic Math.min and Math.max calls in Prepared IR"
status: done
created: 2026-11-28
completed: 2026-11-28
priority: high
feasibility: medium
task_type: implementation
goal: ir-full-coverage
es_edition: ES5
related: [7564]
---

The Prepared Math call plan accepts any number of ordinary arguments for min and max. Lowering evaluates every argument before converting the values to numbers in order. It combines them with the existing binary intrinsic. One argument yields its converted number. An empty call yields the appropriate infinity. Spread requires an iterator and remains outside this plan.

On the eight ES5-tagged min/max Test262 files, four previously failing files pass in strict and sloppy mode with the original harness on standalone WasmGC IR. They exercise empty calls and conversion of a plain object. The other four require array construction or access to the Math function object.
