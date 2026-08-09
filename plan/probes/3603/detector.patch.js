// Instrumented propertyHelper.js `verifyProperty` — the VACUITY DETECTOR.
//
// This file is NOT compiled. `.tmp/vp/ab.mts` splices its two markers into a
// copy of test262/harness/propertyHelper.js:
//
//   __VP_COUNTER__   -> inserted right after `var failures = [];`
//   __VP_INCR__      -> inserted at the top of each of the four `if
//                       (__hasOwnProperty(desc, …))` bodies
//   __VP_ASSERT__    -> inserted right before `if (failures.length) {`
//
// Detector semantics: a `verifyProperty` call that performed ZERO of its four
// descriptor-field checks did not verify anything. It is vacuous, full stop.
// Deliberately NOT compared against a runtime query on `desc` (Object.keys /
// getOwnPropertyNames on an untyped harness PARAMETER is itself broken on the
// standalone lane — that is the bug under test, so using it as the yardstick
// would silently disarm the detector). The over-count from `{get: …}`-only and
// `{}` descriptors is subtracted STATICALLY from the census instead.
