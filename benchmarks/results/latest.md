# js2wasm Benchmark Results

Date: 2026-10-07
Node: v25.7.0
Platform: linux x64

## Summary

| Benchmark | JS | Host-call | GC-native | Linear | Winner |
|-----------|-----|-----------|-----------|--------|--------|
| string/concat-short | 0.027ms | 0.042ms | 0.039ms | FAILED | js |
| string/concat-long | 0.003ms | 0.004ms | 0.003ms | FAILED | gc-native |
| string/indexOf | 0.015ms | 0.047ms | 0.010ms | 0.023ms | gc-native |
| string/includes | 0.015ms | 0.100ms | 0.011ms | 0.032ms | gc-native |
| string/split | 0.328ms | 5.94ms | 2.06ms | FAILED | js |
| string/replace | 0.074ms | 0.471ms | 0.212ms | FAILED | js |
| string/case-convert | 0.045ms | 0.417ms | 0.188ms | FAILED | js |
| string/substring | 0.081ms | 0.031ms | 0.027ms | FAILED | gc-native |
| string/trim | 0.134ms | 2.66ms | 1.86ms | FAILED | js |
| string/startsWith-endsWith | 0.320ms | 1.96ms | 2.02ms | 0.436ms | js |
| array/push-pop | 1.36ms | 0.486ms | 0.485ms | FAILED | gc-native |
| array/sort-i32 | 0.659ms | 0.232ms | 0.238ms | FAILED | host-call |
| array/map-filter | 0.111ms | 0.053ms | 0.053ms | FAILED | gc-native |
| array/reduce | 1.92ms | 0.483ms | 0.481ms | FAILED | gc-native |
| array/indexOf | 3.46ms | 2.23ms | 2.23ms | FAILED | host-call |
| array/slice | 0.034ms | 0.015ms | 0.015ms | FAILED | gc-native |
| array/reverse | 6.87ms | 3.08ms | 3.09ms | FAILED | host-call |
| array/forEach | 0.076ms | 0.023ms | 0.023ms | FAILED | gc-native |
| array/find | 0.214ms | 0.012ms | 0.012ms | 0.945ms | host-call |
| dom/create-elements | 0.031ms | 0.080ms | — | — | js |
| dom/set-attributes | 0.086ms | 0.183ms | — | — | js |
| dom/read-attributes | 0.049ms | 0.103ms | — | — | js |
| dom/modify-text | 0.023ms | 0.087ms | — | — | js |
| mixed/csv-parse | 0.393ms | 6.47ms | 0.427ms | FAILED | js |
| mixed/text-search | 0.315ms | 3.48ms | 1.91ms | 0.881ms | js |
| mixed/fibonacci | 0.097ms | 0.254ms | 0.254ms | 1.09ms | js |
| mixed/matrix-multiply | 0.149ms | 51.76ms | 56.51ms | 0.565ms | js |
| mixed/sieve | 1.45ms | 1.83ms | 1.82ms | FAILED | js |

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
| string/concat-short | 10000 | 2.74 | 4.23 | 3.92 | — |
| string/concat-long | 1000 | 3.38 | 4.27 | 3.09 | — |
| string/indexOf | 1000 | 14.81 | 46.74 | 9.92 | 22.87 |
| string/includes | 1000 | 14.57 | 100.25 | 11.29 | 32.18 |
| string/split | 10000 | 32.84 | 593.82 | 206.27 | — |
| string/replace | 1000 | 74.38 | 471.41 | 211.96 | — |
| string/case-convert | 2000 | 22.63 | 208.62 | 94.08 | — |
| string/substring | 10000 | 8.10 | 3.09 | 2.66 | — |
| string/trim | 10000 | 13.40 | 265.77 | 186.14 | — |
| string/startsWith-endsWith | 20000 | 16.02 | 97.98 | 101.23 | 21.79 |
| array/map-filter | 30000 | 3.70 | 1.78 | 1.77 | — |
| array/indexOf | 1000 | 3463.91 | 2228.06 | 2228.32 | — |
| dom/create-elements | 2000 | 15.54 | 40.09 | — | — |
| dom/set-attributes | 6000 | 14.30 | 30.43 | — | — |
| dom/read-attributes | 3000 | 16.33 | 34.18 | — | — |
| dom/modify-text | 2000 | 11.59 | 43.74 | — | — |
| mixed/csv-parse | 11000 | 35.68 | 587.84 | 38.82 | — |
| mixed/text-search | 40000 | 7.88 | 87.02 | 47.72 | 22.02 |
| mixed/fibonacci | 10000 | 9.71 | 25.41 | 25.41 | 108.53 |
| mixed/matrix-multiply | 125000 | 1.19 | 414.12 | 452.07 | 4.52 |
| mixed/sieve | 200000 | 7.24 | 9.15 | 9.09 | — |

## Speedup vs JS baseline

| Benchmark | Host-call | GC-native | Linear |
|-----------|-----------|-----------|--------|
| string/concat-short | 1.54x slower | 1.43x slower | — |
| string/concat-long | 1.26x slower | 1.09x faster | — |
| string/indexOf | 3.16x slower | 1.49x faster | 1.54x slower |
| string/includes | 6.88x slower | 1.29x faster | 2.21x slower |
| string/split | 18.08x slower | 6.28x slower | — |
| string/replace | 6.34x slower | 2.85x slower | — |
| string/case-convert | 9.22x slower | 4.16x slower | — |
| string/substring | 2.62x faster | 3.04x faster | — |
| string/trim | 19.83x slower | 13.89x slower | — |
| string/startsWith-endsWith | 6.11x slower | 6.32x slower | 1.36x slower |
| array/push-pop | 2.80x faster | 2.80x faster | — |
| array/sort-i32 | 2.84x faster | 2.78x faster | — |
| array/map-filter | 2.07x faster | 2.09x faster | — |
| array/reduce | 3.98x faster | 3.99x faster | — |
| array/indexOf | 1.55x faster | 1.55x faster | — |
| array/slice | 2.33x faster | 2.35x faster | — |
| array/reverse | 2.23x faster | 2.22x faster | — |
| array/forEach | 3.29x faster | 3.34x faster | — |
| array/find | 17.62x faster | 17.48x faster | 4.41x slower |
| dom/create-elements | 2.58x slower | — | — |
| dom/set-attributes | 2.13x slower | — | — |
| dom/read-attributes | 2.09x slower | — | — |
| dom/modify-text | 3.77x slower | — | — |
| mixed/csv-parse | 16.47x slower | 1.09x slower | — |
| mixed/text-search | 11.05x slower | 6.06x slower | 2.80x slower |
| mixed/fibonacci | 2.62x slower | 2.62x slower | 11.17x slower |
| mixed/matrix-multiply | 347.87x slower | 379.75x slower | 3.80x slower |
| mixed/sieve | 1.26x slower | 1.25x slower | — |

## GC-native vs Host-call

| Benchmark | Speedup |
|-----------|---------|
| string/concat-short | 1.08x faster |
| string/concat-long | 1.38x faster |
| string/indexOf | 4.71x faster |
| string/includes | 8.88x faster |
| string/split | 2.88x faster |
| string/replace | 2.22x faster |
| string/case-convert | 2.22x faster |
| string/substring | 1.16x faster |
| string/trim | 1.43x faster |
| string/startsWith-endsWith | 1.03x slower |
| array/push-pop | 1.00x faster |
| array/sort-i32 | 1.02x slower |
| array/map-filter | 1.01x faster |
| array/reduce | 1.00x faster |
| array/indexOf | 1.00x slower |
| array/slice | 1.01x faster |
| array/reverse | 1.00x slower |
| array/forEach | 1.02x faster |
| array/find | 1.01x slower |
| mixed/csv-parse | 15.14x faster |
| mixed/text-search | 1.82x faster |
| mixed/fibonacci | 1.00x slower |
| mixed/matrix-multiply | 1.09x slower |
| mixed/sieve | 1.01x faster |

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
| string/concat-short | 908.2ms | 468.3ms | — |
| string/concat-long | 340.4ms | 495.4ms | — |
| string/indexOf | 289.9ms | 495.9ms | 412.6ms |
| string/includes | 289.6ms | 525.0ms | 432.1ms |
| string/split | 395.1ms | 523.0ms | — |
| string/replace | 383.4ms | 548.6ms | — |
| string/case-convert | 393.6ms | 464.9ms | — |
| string/substring | 301.2ms | 366.6ms | — |
| string/trim | 382.2ms | 524.7ms | — |
| string/startsWith-endsWith | 381.8ms | 569.2ms | 477.8ms |
| array/push-pop | 387.3ms | 439.7ms | — |
| array/sort-i32 | 501.0ms | 551.3ms | — |
| array/map-filter | 513.6ms | 561.3ms | — |
| array/reduce | 470.8ms | 519.4ms | — |
| array/indexOf | 469.2ms | 513.1ms | — |
| array/slice | 401.1ms | 466.2ms | — |
| array/reverse | 383.7ms | 455.5ms | — |
| array/forEach | 486.5ms | 532.8ms | — |
| array/find | 381.2ms | 470.4ms | 418.6ms |
| dom/create-elements | 332.2ms | — | — |
| dom/set-attributes | 300.0ms | — | — |
| dom/read-attributes | 300.8ms | — | — |
| dom/modify-text | 293.1ms | — | — |
| mixed/csv-parse | 392.8ms | 529.4ms | — |
| mixed/text-search | 385.2ms | 520.3ms | 463.0ms |
| mixed/fibonacci | 357.1ms | 389.7ms | 372.1ms |
| mixed/matrix-multiply | 507.4ms | 534.5ms | 409.6ms |
| mixed/sieve | 479.4ms | 509.6ms | — |
