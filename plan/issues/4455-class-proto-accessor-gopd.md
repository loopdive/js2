---
id: 4455
title: "gOPD on a class prototype returns undefined for accessors — blocks setter/static-method length-dflt files (R1 of #4440)"
status: in-progress
sprint: current
assignee: ttraenkler/claude-es5-standalone
created: 2026-08-15
updated: 2026-08-15
priority: high
horizon: s
feasibility: medium
reasoning_effort: high
task_type: bug
area: codegen
es_edition: 5
language_feature: property-descriptors
goal: standalone-gap
related: [4440, 2885, 2158]
origin: "2026-08-15 wave 10 — #4440's R1 residual: 3 setter/static-method-length-dflt files, identical on its base; gOPD on a class prototype answers undefined for accessor members."
---
# #4455 — gOPD on class-prototype accessors

READ FIRST: #4440's issue file R1 (the 3 blocked files + evidence), the #2885
descriptor-reflection core, and #2158 (class-prototype descriptor residual).
`Object.getOwnPropertyDescriptor(C.prototype, "m")` must synthesize an
ACCESSOR descriptor ({get, set, enumerable:false, configurable:true}) for
get/set members; today it answers undefined, so the propertyHelper-driven
`*length-dflt` files die before their length assert. Fix at the gOPD
synthesis for class-prototype receivers; verify the 3 files + the #4440 pin
+ a class-heavy control sample; gc/host byte-identity.
