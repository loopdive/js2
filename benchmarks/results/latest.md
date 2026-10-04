# js2wasm Benchmark Results

Date: 2026-10-04
Node: v25.7.0
Platform: linux x64

## Summary

| Benchmark | JS | Host-call | GC-native | Linear | Winner |
|-----------|-----|-----------|-----------|--------|--------|
| string/concat-short | 0.044ms | 0.040ms | 0.043ms | FAILED | host-call |
| string/concat-long | 0.003ms | 0.004ms | 0.004ms | FAILED | js |
| string/indexOf | 0.014ms | 0.044ms | 0.010ms | 0.015ms | gc-native |
| string/includes | 0.014ms | 0.091ms | 0.012ms | 0.030ms | gc-native |
| string/split | 0.285ms | 5.83ms | 2.10ms | FAILED | js |
| string/replace | 0.087ms | 0.454ms | 0.250ms | FAILED | js |
| string/case-convert | 0.044ms | 0.416ms | 0.206ms | FAILED | js |
| string/substring | 0.089ms | 0.032ms | 0.027ms | FAILED | gc-native |
| string/trim | 0.144ms | 2.84ms | 2.16ms | FAILED | js |
| string/startsWith-endsWith | 0.403ms | 2.25ms | 2.34ms | 0.472ms | js |
| array/push-pop | 1.18ms | 0.393ms | 0.425ms | FAILED | host-call |
| array/sort-i32 | 0.553ms | 0.287ms | 0.293ms | FAILED | host-call |
| array/map-filter | 0.124ms | 0.067ms | 0.070ms | FAILED | host-call |
| array/reduce | 1.79ms | 0.417ms | 0.412ms | FAILED | gc-native |
| array/indexOf | 4.49ms | 2.23ms | 2.23ms | FAILED | host-call |
| array/slice | 0.017ms | 0.018ms | 0.018ms | FAILED | js |
| array/reverse | 7.04ms | 3.18ms | 3.17ms | FAILED | gc-native |
| array/forEach | 0.054ms | 0.022ms | 0.022ms | FAILED | host-call |
| array/find | 0.248ms | 0.012ms | 0.012ms | 0.861ms | gc-native |
| dom/create-elements | 0.038ms | 0.091ms | — | — | js |
| dom/set-attributes | 0.116ms | 0.168ms | — | — | js |
| dom/read-attributes | 0.046ms | 0.099ms | — | — | js |
| dom/modify-text | 0.033ms | 0.087ms | — | — | js |
| mixed/csv-parse | 0.358ms | 6.17ms | 0.497ms | FAILED | js |
| mixed/text-search | 0.377ms | 3.78ms | 2.27ms | 0.974ms | js |
| mixed/fibonacci | 0.114ms | 0.183ms | 0.186ms | 0.185ms | js |
| mixed/matrix-multiply | 0.165ms | 53.73ms | 56.37ms | 0.619ms | js |
| mixed/sieve | 1.43ms | 2.12ms | 2.09ms | FAILED | js |

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
| string/concat-short | 10000 | 4.40 | 4.01 | 4.27 | — |
| string/concat-long | 1000 | 2.87 | 4.08 | 3.70 | — |
| string/indexOf | 1000 | 13.90 | 43.86 | 9.72 | 14.61 |
| string/includes | 1000 | 13.86 | 91.37 | 12.09 | 29.79 |
| string/split | 10000 | 28.55 | 583.26 | 209.55 | — |
| string/replace | 1000 | 87.08 | 454.05 | 249.53 | — |
| string/case-convert | 2000 | 21.75 | 208.09 | 102.90 | — |
| string/substring | 10000 | 8.94 | 3.17 | 2.71 | — |
| string/trim | 10000 | 14.38 | 284.24 | 215.67 | — |
| string/startsWith-endsWith | 20000 | 20.13 | 112.58 | 116.79 | 23.58 |
| array/map-filter | 30000 | 4.14 | 2.25 | 2.33 | — |
| array/indexOf | 1000 | 4493.16 | 2226.63 | 2231.39 | — |
| dom/create-elements | 2000 | 19.19 | 45.75 | — | — |
| dom/set-attributes | 6000 | 19.35 | 27.97 | — | — |
| dom/read-attributes | 3000 | 15.48 | 33.03 | — | — |
| dom/modify-text | 2000 | 16.46 | 43.55 | — | — |
| mixed/csv-parse | 11000 | 32.51 | 560.76 | 45.22 | — |
| mixed/text-search | 40000 | 9.42 | 94.47 | 56.83 | 24.34 |
| mixed/fibonacci | 10000 | 11.42 | 18.33 | 18.55 | 18.49 |
| mixed/matrix-multiply | 125000 | 1.32 | 429.87 | 451.00 | 4.95 |
| mixed/sieve | 200000 | 7.16 | 10.58 | 10.43 | — |

## Speedup vs JS baseline

| Benchmark | Host-call | GC-native | Linear |
|-----------|-----------|-----------|--------|
| string/concat-short | 1.10x faster | 1.03x faster | — |
| string/concat-long | 1.42x slower | 1.29x slower | — |
| string/indexOf | 3.15x slower | 1.43x faster | 1.05x slower |
| string/includes | 6.59x slower | 1.15x faster | 2.15x slower |
| string/split | 20.43x slower | 7.34x slower | — |
| string/replace | 5.21x slower | 2.87x slower | — |
| string/case-convert | 9.57x slower | 4.73x slower | — |
| string/substring | 2.82x faster | 3.29x faster | — |
| string/trim | 19.77x slower | 15.00x slower | — |
| string/startsWith-endsWith | 5.59x slower | 5.80x slower | 1.17x slower |
| array/push-pop | 3.02x faster | 2.79x faster | — |
| array/sort-i32 | 1.93x faster | 1.89x faster | — |
| array/map-filter | 1.84x faster | 1.77x faster | — |
| array/reduce | 4.29x faster | 4.34x faster | — |
| array/indexOf | 2.02x faster | 2.01x faster | — |
| array/slice | 1.04x slower | 1.05x slower | — |
| array/reverse | 2.22x faster | 2.22x faster | — |
| array/forEach | 2.45x faster | 2.43x faster | — |
| array/find | 20.42x faster | 20.85x faster | 3.47x slower |
| dom/create-elements | 2.38x slower | — | — |
| dom/set-attributes | 1.45x slower | — | — |
| dom/read-attributes | 2.13x slower | — | — |
| dom/modify-text | 2.65x slower | — | — |
| mixed/csv-parse | 17.25x slower | 1.39x slower | — |
| mixed/text-search | 10.03x slower | 6.03x slower | 2.58x slower |
| mixed/fibonacci | 1.61x slower | 1.62x slower | 1.62x slower |
| mixed/matrix-multiply | 325.97x slower | 341.99x slower | 3.76x slower |
| mixed/sieve | 1.48x slower | 1.46x slower | — |

## GC-native vs Host-call

| Benchmark | Speedup |
|-----------|---------|
| string/concat-short | 1.07x slower |
| string/concat-long | 1.10x faster |
| string/indexOf | 4.51x faster |
| string/includes | 7.56x faster |
| string/split | 2.78x faster |
| string/replace | 1.82x faster |
| string/case-convert | 2.02x faster |
| string/substring | 1.17x faster |
| string/trim | 1.32x faster |
| string/startsWith-endsWith | 1.04x slower |
| array/push-pop | 1.08x slower |
| array/sort-i32 | 1.02x slower |
| array/map-filter | 1.04x slower |
| array/reduce | 1.01x faster |
| array/indexOf | 1.00x slower |
| array/slice | 1.01x slower |
| array/reverse | 1.00x faster |
| array/forEach | 1.01x slower |
| array/find | 1.02x faster |
| mixed/csv-parse | 12.40x faster |
| mixed/text-search | 1.66x faster |
| mixed/fibonacci | 1.01x slower |
| mixed/matrix-multiply | 1.05x slower |
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
| string/concat-short | 917.7ms | 508.1ms | — |
| string/concat-long | 365.1ms | 542.4ms | — |
| string/indexOf | 319.3ms | 569.3ms | 458.0ms |
| string/includes | 319.5ms | 558.5ms | 460.6ms |
| string/split | 436.9ms | 570.4ms | — |
| string/replace | 433.0ms | 631.6ms | — |
| string/case-convert | 449.1ms | 502.5ms | — |
| string/substring | 326.2ms | 395.7ms | — |
| string/trim | 421.3ms | 604.8ms | — |
| string/startsWith-endsWith | 429.4ms | 582.9ms | 533.5ms |
| array/push-pop | 448.0ms | 500.8ms | — |
| array/sort-i32 | 558.4ms | 599.1ms | — |
| array/map-filter | 571.9ms | 612.5ms | — |
| array/reduce | 530.3ms | 581.9ms | — |
| array/indexOf | 500.1ms | 551.5ms | — |
| array/slice | 438.0ms | 512.9ms | — |
| array/reverse | 435.6ms | 471.0ms | — |
| array/forEach | 547.7ms | 614.5ms | — |
| array/find | 414.9ms | 506.3ms | 460.1ms |
| dom/create-elements | 356.5ms | — | — |
| dom/set-attributes | 331.6ms | — | — |
| dom/read-attributes | 327.6ms | — | — |
| dom/modify-text | 319.1ms | — | — |
| mixed/csv-parse | 431.1ms | 579.7ms | — |
| mixed/text-search | 416.4ms | 595.4ms | 522.7ms |
| mixed/fibonacci | 378.2ms | 427.0ms | 437.7ms |
| mixed/matrix-multiply | 542.2ms | 617.4ms | 454.5ms |
| mixed/sieve | 548.7ms | 582.7ms | — |
