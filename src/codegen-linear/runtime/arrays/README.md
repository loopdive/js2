# Linear array runtime bodies

This folder owns target-specific instruction-body generation for Linear memory
arrays. Generic semantics and shared layout authority remain above the target
boundary. Runtime registration remains in `runtime.ts`.

The forwarding resolver builder receives readonly concrete tag/offset values
from its caller's existing shared layout constant. It imports only canonical
Wasm instruction types; it does not import a planner, source frontend, registry,
module or allocator. It constructs fresh instruction arrays, nested nodes and
block types on each call, without retaining or mutating its input bindings.

The body follows existing forwarding links and returns the current header. It
does not write memory, allocate, compress paths, validate chains, change the ABI
or claim new source admission. Registration/idempotence and actual defined-helper
selection remain with their existing owners. Keep unrelated array methods,
optimizations and allocation policy in their own modules.
