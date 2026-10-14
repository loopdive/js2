# js2wasm Benchmark Results

Date: 2026-10-14
Node: v25.7.0
Platform: linux x64

## Summary

| Benchmark | JS | Host-call | GC-native | Linear | Winner |
|-----------|-----|-----------|-----------|--------|--------|
| string/concat-short | 0.044ms | 0.043ms | 0.043ms | FAILED | gc-native |
| string/concat-long | 0.004ms | 0.005ms | 0.006ms | FAILED | js |
| string/indexOf | 0.012ms | 0.042ms | 0.009ms | 0.013ms | gc-native |
| string/includes | 0.013ms | 0.064ms | 0.012ms | 0.010ms | linear-memory |
| string/split | 0.269ms | 4.67ms | 1.77ms | FAILED | js |
| string/replace | 0.062ms | 0.426ms | 0.247ms | FAILED | js |
| string/case-convert | 0.042ms | 0.332ms | 0.166ms | FAILED | js |
| string/substring | 0.124ms | 0.027ms | 0.023ms | FAILED | gc-native |
| string/trim | 0.241ms | 2.28ms | 1.73ms | FAILED | js |
| string/startsWith-endsWith | 0.360ms | 1.89ms | 1.94ms | 0.393ms | js |
| array/push-pop | 1.17ms | 0.409ms | 0.405ms | FAILED | gc-native |
| array/sort-i32 | 0.479ms | 0.280ms | 0.261ms | FAILED | gc-native |
| array/map-filter | 0.114ms | 0.067ms | 0.066ms | FAILED | gc-native |
| array/reduce | 1.73ms | 0.389ms | 0.380ms | FAILED | gc-native |
| array/indexOf | 3.91ms | 1.88ms | 1.88ms | FAILED | gc-native |
| array/slice | 0.032ms | 0.029ms | 0.031ms | FAILED | host-call |
| array/reverse | 4.95ms | 2.86ms | 2.79ms | FAILED | gc-native |
| array/forEach | 0.072ms | 0.019ms | 0.020ms | FAILED | host-call |
| array/find | 0.218ms | 0.015ms | 0.012ms | 0.795ms | gc-native |
| dom/create-elements | 0.055ms | 0.124ms | — | — | js |
| dom/set-attributes | 0.117ms | 0.145ms | — | — | js |
| dom/read-attributes | 0.068ms | 0.096ms | — | — | js |
| dom/modify-text | 0.054ms | 0.093ms | — | — | js |
| mixed/csv-parse | 0.305ms | 4.86ms | 0.417ms | FAILED | js |
| mixed/text-search | 0.313ms | 2.82ms | 1.84ms | 0.822ms | js |
| mixed/fibonacci | 0.098ms | 0.157ms | 0.157ms | 0.159ms | js |
| mixed/matrix-multiply | 0.147ms | 44.62ms | 45.58ms | 0.523ms | js |
| mixed/sieve | 1.21ms | 1.81ms | 1.84ms | FAILED | js |

## Failed strategies

| Benchmark | Strategy | Phase | Error |
|-----------|----------|-------|-------|
| string/concat-short | linear-memory | warmup | memory access out of bounds |
| string/concat-long | linear-memory | warmup | memory access out of bounds |
| string/split | linear-memory | mid-loop | memory access out of bounds |
| string/replace | linear-memory | setup | Compilation failed (fast=true, target=linear): |
| string/case-convert | linear-memory | setup | Compilation failed (fast=true, target=linear): |
| string/substring | linear-memory | setup | Compilation failed (fast=true, target=linear): |
| string/trim | linear-memory | setup | Compilation failed (fast=true, target=linear): |
| array/push-pop | linear-memory | setup | Compilation failed (fast=true, target=linear): |
| array/sort-i32 | linear-memory | setup | Compilation failed (fast=true, target=linear): |
| array/map-filter | linear-memory | mid-loop | memory access out of bounds |
| array/reduce | linear-memory | setup | Compilation failed (fast=true, target=linear): |
| array/indexOf | linear-memory | setup | Compilation failed (fast=true, target=linear): |
| array/slice | linear-memory | setup | Compilation failed (fast=true, target=linear): |
| array/reverse | linear-memory | setup | Compilation failed (fast=true, target=linear): |
| array/forEach | linear-memory | setup | Compilation failed (fast=true, target=linear): |
| mixed/csv-parse | linear-memory | mid-loop | memory access out of bounds |
| mixed/sieve | linear-memory | mid-loop | memory access out of bounds |

## Cost per operation (ns)

| Benchmark | ops/call | JS | Host-call | GC-native | Linear |
|-----------|----------|-----|-----------|-----------|--------|
| string/concat-short | 10000 | 4.37 | 4.34 | 4.33 | — |
| string/concat-long | 1000 | 3.85 | 4.58 | 6.32 | — |
| string/indexOf | 1000 | 12.18 | 42.49 | 9.03 | 13.43 |
| string/includes | 1000 | 12.81 | 63.90 | 12.06 | 9.97 |
| string/split | 10000 | 26.91 | 466.66 | 177.48 | — |
| string/replace | 1000 | 61.85 | 426.44 | 246.56 | — |
| string/case-convert | 2000 | 20.91 | 166.07 | 82.88 | — |
| string/substring | 10000 | 12.43 | 2.73 | 2.31 | — |
| string/trim | 10000 | 24.11 | 227.67 | 173.32 | — |
| string/startsWith-endsWith | 20000 | 17.98 | 94.47 | 97.00 | 19.66 |
| array/map-filter | 30000 | 3.81 | 2.24 | 2.22 | — |
| array/indexOf | 1000 | 3910.24 | 1877.77 | 1877.09 | — |
| dom/create-elements | 2000 | 27.45 | 62.01 | — | — |
| dom/set-attributes | 6000 | 19.46 | 24.21 | — | — |
| dom/read-attributes | 3000 | 22.63 | 32.02 | — | — |
| dom/modify-text | 2000 | 26.97 | 46.41 | — | — |
| mixed/csv-parse | 11000 | 27.74 | 442.13 | 37.93 | — |
| mixed/text-search | 40000 | 7.82 | 70.49 | 46.00 | 20.56 |
| mixed/fibonacci | 10000 | 9.80 | 15.71 | 15.73 | 15.88 |
| mixed/matrix-multiply | 125000 | 1.17 | 356.98 | 364.64 | 4.18 |
| mixed/sieve | 200000 | 6.05 | 9.07 | 9.21 | — |

## Speedup vs JS baseline

| Benchmark | Host-call | GC-native | Linear |
|-----------|-----------|-----------|--------|
| string/concat-short | 1.01x faster | 1.01x faster | — |
| string/concat-long | 1.19x slower | 1.64x slower | — |
| string/indexOf | 3.49x slower | 1.35x faster | 1.10x slower |
| string/includes | 4.99x slower | 1.06x faster | 1.29x faster |
| string/split | 17.34x slower | 6.60x slower | — |
| string/replace | 6.89x slower | 3.99x slower | — |
| string/case-convert | 7.94x slower | 3.96x slower | — |
| string/substring | 4.55x faster | 5.39x faster | — |
| string/trim | 9.44x slower | 7.19x slower | — |
| string/startsWith-endsWith | 5.25x slower | 5.39x slower | 1.09x slower |
| array/push-pop | 2.87x faster | 2.90x faster | — |
| array/sort-i32 | 1.71x faster | 1.83x faster | — |
| array/map-filter | 1.70x faster | 1.72x faster | — |
| array/reduce | 4.44x faster | 4.54x faster | — |
| array/indexOf | 2.08x faster | 2.08x faster | — |
| array/slice | 1.09x faster | 1.02x faster | — |
| array/reverse | 1.73x faster | 1.77x faster | — |
| array/forEach | 3.80x faster | 3.67x faster | — |
| array/find | 15.00x faster | 18.89x faster | 3.65x slower |
| dom/create-elements | 2.26x slower | — | — |
| dom/set-attributes | 1.24x slower | — | — |
| dom/read-attributes | 1.41x slower | — | — |
| dom/modify-text | 1.72x slower | — | — |
| mixed/csv-parse | 15.94x slower | 1.37x slower | — |
| mixed/text-search | 9.02x slower | 5.89x slower | 2.63x slower |
| mixed/fibonacci | 1.60x slower | 1.60x slower | 1.62x slower |
| mixed/matrix-multiply | 304.01x slower | 310.54x slower | 3.56x slower |
| mixed/sieve | 1.50x slower | 1.52x slower | — |

## GC-native vs Host-call

| Benchmark | Speedup |
|-----------|---------|
| string/concat-short | 1.00x faster |
| string/concat-long | 1.38x slower |
| string/indexOf | 4.71x faster |
| string/includes | 5.30x faster |
| string/split | 2.63x faster |
| string/replace | 1.73x faster |
| string/case-convert | 2.00x faster |
| string/substring | 1.18x faster |
| string/trim | 1.31x faster |
| string/startsWith-endsWith | 1.03x slower |
| array/push-pop | 1.01x faster |
| array/sort-i32 | 1.07x faster |
| array/map-filter | 1.01x faster |
| array/reduce | 1.02x faster |
| array/indexOf | 1.00x faster |
| array/slice | 1.07x slower |
| array/reverse | 1.02x faster |
| array/forEach | 1.04x slower |
| array/find | 1.26x faster |
| mixed/csv-parse | 11.66x faster |
| mixed/text-search | 1.53x faster |
| mixed/fibonacci | 1.00x slower |
| mixed/matrix-multiply | 1.02x slower |
| mixed/sieve | 1.01x slower |

## Binary sizes

| Benchmark | Host-call | GC-native | Linear |
|-----------|-----------|-----------|--------|
| string/concat-short | 209B | 745B | — |
| string/concat-long | 223B | 932B | — |
| string/indexOf | 254B | 1.1KB | 10.4KB |
| string/includes | 241B | 1.1KB | 10.4KB |
| string/split | 1.8KB | 3.5KB | — |
| string/replace | 1.9KB | 4.4KB | — |
| string/case-convert | 1.8KB | 2.5KB | — |
| string/substring | 202B | 279B | — |
| string/trim | 1.5KB | 3.1KB | — |
| string/startsWith-endsWith | 2.0KB | 4.0KB | 1.7KB |
| array/push-pop | 1.2KB | 1.6KB | — |
| array/sort-i32 | 3.3KB | 3.8KB | — |
| array/map-filter | 4.3KB | 4.8KB | — |
| array/reduce | 3.0KB | 3.5KB | — |
| array/indexOf | 2.1KB | 2.5KB | — |
| array/slice | 1.3KB | 1.7KB | — |
| array/reverse | 1.2KB | 1.7KB | — |
| array/forEach | 3.4KB | 4.0KB | — |
| array/find | 1.2KB | 1.6KB | 634B |
| dom/create-elements | 271B | — | — |
| dom/set-attributes | 524B | — | — |
| dom/read-attributes | 389B | — | — |
| dom/modify-text | 264B | — | — |
| mixed/csv-parse | 2.5KB | 4.5KB | — |
| mixed/text-search | 2.2KB | 4.3KB | 1.9KB |
| mixed/fibonacci | 438B | 438B | 411B |
| mixed/matrix-multiply | 3.5KB | 4.0KB | 991B |
| mixed/sieve | 2.5KB | 2.7KB | — |

## Compile times

| Benchmark | Host-call | GC-native | Linear |
|-----------|-----------|-----------|--------|
| string/concat-short | 833.4ms | 447.8ms | — |
| string/concat-long | 349.3ms | 552.1ms | — |
| string/indexOf | 313.5ms | 506.2ms | 415.0ms |
| string/includes | 291.2ms | 473.0ms | 417.7ms |
| string/split | 404.3ms | 512.0ms | — |
| string/replace | 378.2ms | 575.3ms | — |
| string/case-convert | 392.9ms | 438.9ms | — |
| string/substring | 291.4ms | 365.4ms | — |
| string/trim | 372.7ms | 483.8ms | — |
| string/startsWith-endsWith | 362.4ms | 500.3ms | 449.6ms |
| array/push-pop | 372.1ms | 466.4ms | — |
| array/sort-i32 | 563.3ms | 596.3ms | — |
| array/map-filter | 507.0ms | 543.3ms | — |
| array/reduce | 421.9ms | 525.0ms | — |
| array/indexOf | 418.0ms | 467.5ms | — |
| array/slice | 371.9ms | 420.7ms | — |
| array/reverse | 407.1ms | 414.4ms | — |
| array/forEach | 446.9ms | 501.7ms | — |
| array/find | 368.4ms | 429.2ms | 412.7ms |
| dom/create-elements | 322.7ms | — | — |
| dom/set-attributes | 289.6ms | — | — |
| dom/read-attributes | 301.7ms | — | — |
| dom/modify-text | 281.0ms | — | — |
| mixed/csv-parse | 375.8ms | 490.0ms | — |
| mixed/text-search | 377.3ms | 533.2ms | 495.0ms |
| mixed/fibonacci | 339.0ms | 371.1ms | 354.2ms |
| mixed/matrix-multiply | 470.3ms | 539.9ms | 374.1ms |
| mixed/sieve | 427.2ms | 503.7ms | — |
