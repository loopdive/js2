# Linear runtime instruction bodies

This folder holds focused instruction builders for Linear runtime operations.
Registration and module-resource ownership stay with the caller; builders do
not mutate modules, choose function indices, or perform source compilation.

Builders return fresh instruction arrays and objects. They may depend on the
shared Wasm instruction model and canonical IR layout contracts, but not on
frontend AST/checker APIs or another target's runtime implementation.

The vector initializer implements the existing value-first f64 store ABI.
Its use does not establish whole-program Prepared IR allocation support.
