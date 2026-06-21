(module
  ;; js2wasm:node-io shim — implements the byte-boundary IO interface over WASI.
  (import "wasi_snapshot_preview1" "fd_write"
    (func $fd_write (param i32 i32 i32 i32) (result i32)))
  (import "wasi_snapshot_preview1" "fd_read"
    (func $fd_read (param i32 i32 i32 i32) (result i32)))

  ;; The shim owns + exports the shared linear memory. min 3 pages matches the
  ;; user module's reservation; grows on demand.
  (memory (export "memory") 3)

  ;; write(fd, ptr, len) -> bytes written. Builds an iovec at [0] pointing
  ;; at the CALLER's bytes (same memory) and issues fd_write.
  (func $write (param $fd i32) (param $ptr i32) (param $len i32) (result i32)
    (i32.store (i32.const 0) (local.get $ptr))
    (i32.store (i32.const 4) (local.get $len))
    (drop (call $fd_write (local.get $fd) (i32.const 0) (i32.const 1) (i32.const 8)))
    (i32.load (i32.const 8)))

  (func (export "stdout_write") (param $ptr i32) (param $len i32) (result i32)
    (call $write (i32.const 1) (local.get $ptr) (local.get $len)))

  (func (export "stderr_write") (param $ptr i32) (param $len i32)
    (drop (call $write (i32.const 2) (local.get $ptr) (local.get $len))))

  ;; read(ptr, len) -> bytes read. iovec points at the caller's destination.
  (func (export "stdin_read") (param $ptr i32) (param $len i32) (result i32)
    (i32.store (i32.const 0) (local.get $ptr))
    (i32.store (i32.const 4) (local.get $len))
    (drop (call $fd_read (i32.const 0) (i32.const 0) (i32.const 1) (i32.const 8)))
    (i32.load (i32.const 8))))
