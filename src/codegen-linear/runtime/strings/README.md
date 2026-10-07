# Linear string instruction bodies

This folder contains target-specific string instruction builders. Inputs are
resolved helper indices and local ranges supplied by the registration owner;
builders do not allocate resources, mutate modules, or establish ownership.

The charCodeAt body consumes canonical Linear string layout constants and the
shared Wasm instruction model. It returns a fresh mutable instruction tree for
each invocation. Frontend APIs, compiler entry points and shared registry wiring
do not belong here.

The emitted ASCII-helper call retains its existing string-header cache effect.
Decoder preservation does not prove Unicode source admission, whole-program
Prepared IR support, or eligibility to retire legacy code.
