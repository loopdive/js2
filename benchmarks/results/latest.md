# js2wasm Benchmark Results

Date: 2026-10-03
Node: v25.7.0
Platform: linux x64

## Summary

| Benchmark | JS | Host-call | GC-native | Linear | Winner |
|-----------|-----|-----------|-----------|--------|--------|
| string/concat-short | 0.030ms | 0.048ms | 0.047ms | FAILED | js |
| string/concat-long | 0.004ms | 0.004ms | 0.004ms | FAILED | js |
| string/indexOf | 0.019ms | 0.064ms | 0.012ms | 0.015ms | gc-native |
| string/includes | 0.019ms | 0.126ms | 0.015ms | 0.019ms | gc-native |
| string/split | 0.428ms | 8.45ms | 2.81ms | FAILED | js |
| string/replace | 0.111ms | 0.698ms | 0.338ms | FAILED | js |
| string/case-convert | 0.056ms | 0.629ms | 0.274ms | FAILED | js |
| string/substring | 0.099ms | 0.037ms | 0.031ms | FAILED | gc-native |
| string/trim | 0.170ms | 4.13ms | 2.82ms | FAILED | js |
| string/startsWith-endsWith | 0.401ms | 2.94ms | 3.06ms | 0.561ms | js |
| array/push-pop | 1.46ms | 0.521ms | 0.515ms | FAILED | gc-native |
| array/sort-i32 | 0.795ms | 0.293ms | 0.293ms | FAILED | gc-native |
| array/map-filter | 0.130ms | 0.071ms | 0.070ms | FAILED | gc-native |
| array/reduce | 2.19ms | 0.508ms | 0.519ms | FAILED | host-call |
| array/indexOf | 3.95ms | 2.65ms | 2.65ms | FAILED | host-call |
| array/slice | 0.028ms | 0.028ms | 0.030ms | FAILED | js |
| array/reverse | 7.83ms | 3.52ms | 3.53ms | FAILED | host-call |
| array/forEach | 0.087ms | 0.028ms | 0.028ms | FAILED | gc-native |
| array/find | 0.256ms | 0.016ms | 0.016ms | 1.08ms | gc-native |
| dom/create-elements | 0.037ms | 0.155ms | — | — | js |
| dom/set-attributes | 0.105ms | 0.221ms | — | — | js |
| dom/read-attributes | 0.056ms | 0.123ms | — | — | js |
| dom/modify-text | 0.032ms | 0.112ms | — | — | js |
| mixed/csv-parse | 0.484ms | 8.81ms | 0.621ms | FAILED | js |
| mixed/text-search | 0.389ms | 4.84ms | 2.92ms | 1.10ms | js |
| mixed/fibonacci | 0.120ms | 0.283ms | 0.283ms | 0.281ms | js |
| mixed/matrix-multiply | 0.158ms | 73.74ms | 73.17ms | 0.722ms | js |
| mixed/sieve | 1.57ms | 2.12ms | 2.13ms | FAILED | js |

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
| string/concat-short | 10000 | 2.96 | 4.80 | 4.69 | — |
| string/concat-long | 1000 | 3.76 | 4.49 | 4.19 | — |
| string/indexOf | 1000 | 19.18 | 64.27 | 12.14 | 14.71 |
| string/includes | 1000 | 19.20 | 125.96 | 14.75 | 18.56 |
| string/split | 10000 | 42.78 | 844.96 | 281.39 | — |
| string/replace | 1000 | 111.12 | 697.88 | 338.41 | — |
| string/case-convert | 2000 | 28.03 | 314.55 | 136.90 | — |
| string/substring | 10000 | 9.93 | 3.74 | 3.08 | — |
| string/trim | 10000 | 17.03 | 412.57 | 281.58 | — |
| string/startsWith-endsWith | 20000 | 20.03 | 147.10 | 153.00 | 28.04 |
| array/map-filter | 30000 | 4.34 | 2.36 | 2.35 | — |
| array/indexOf | 1000 | 3953.33 | 2645.44 | 2645.77 | — |
| dom/create-elements | 2000 | 18.64 | 77.46 | — | — |
| dom/set-attributes | 6000 | 17.58 | 36.81 | — | — |
| dom/read-attributes | 3000 | 18.55 | 40.99 | — | — |
| dom/modify-text | 2000 | 16.17 | 55.88 | — | — |
| mixed/csv-parse | 11000 | 43.97 | 801.23 | 56.41 | — |
| mixed/text-search | 40000 | 9.74 | 120.92 | 73.03 | 27.57 |
| mixed/fibonacci | 10000 | 12.02 | 28.31 | 28.30 | 28.08 |
| mixed/matrix-multiply | 125000 | 1.26 | 589.93 | 585.40 | 5.78 |
| mixed/sieve | 200000 | 7.86 | 10.61 | 10.67 | — |

## Speedup vs JS baseline

| Benchmark | Host-call | GC-native | Linear |
|-----------|-----------|-----------|--------|
| string/concat-short | 1.62x slower | 1.58x slower | — |
| string/concat-long | 1.20x slower | 1.11x slower | — |
| string/indexOf | 3.35x slower | 1.58x faster | 1.30x faster |
| string/includes | 6.56x slower | 1.30x faster | 1.03x faster |
| string/split | 19.75x slower | 6.58x slower | — |
| string/replace | 6.28x slower | 3.05x slower | — |
| string/case-convert | 11.22x slower | 4.88x slower | — |
| string/substring | 2.66x faster | 3.23x faster | — |
| string/trim | 24.23x slower | 16.54x slower | — |
| string/startsWith-endsWith | 7.34x slower | 7.64x slower | 1.40x slower |
| array/push-pop | 2.80x faster | 2.83x faster | — |
| array/sort-i32 | 2.71x faster | 2.71x faster | — |
| array/map-filter | 1.84x faster | 1.85x faster | — |
| array/reduce | 4.31x faster | 4.22x faster | — |
| array/indexOf | 1.49x faster | 1.49x faster | — |
| array/slice | 1.01x slower | 1.06x slower | — |
| array/reverse | 2.22x faster | 2.22x faster | — |
| array/forEach | 3.12x faster | 3.12x faster | — |
| array/find | 16.15x faster | 16.22x faster | 4.22x slower |
| dom/create-elements | 4.16x slower | — | — |
| dom/set-attributes | 2.09x slower | — | — |
| dom/read-attributes | 2.21x slower | — | — |
| dom/modify-text | 3.46x slower | — | — |
| mixed/csv-parse | 18.22x slower | 1.28x slower | — |
| mixed/text-search | 12.42x slower | 7.50x slower | 2.83x slower |
| mixed/fibonacci | 2.36x slower | 2.35x slower | 2.34x slower |
| mixed/matrix-multiply | 466.55x slower | 462.97x slower | 4.57x slower |
| mixed/sieve | 1.35x slower | 1.36x slower | — |

## GC-native vs Host-call

| Benchmark | Speedup |
|-----------|---------|
| string/concat-short | 1.03x faster |
| string/concat-long | 1.07x faster |
| string/indexOf | 5.29x faster |
| string/includes | 8.54x faster |
| string/split | 3.00x faster |
| string/replace | 2.06x faster |
| string/case-convert | 2.30x faster |
| string/substring | 1.22x faster |
| string/trim | 1.47x faster |
| string/startsWith-endsWith | 1.04x slower |
| array/push-pop | 1.01x faster |
| array/sort-i32 | 1.00x faster |
| array/map-filter | 1.00x faster |
| array/reduce | 1.02x slower |
| array/indexOf | 1.00x slower |
| array/slice | 1.04x slower |
| array/reverse | 1.00x slower |
| array/forEach | 1.00x faster |
| array/find | 1.00x faster |
| mixed/csv-parse | 14.20x faster |
| mixed/text-search | 1.66x faster |
| mixed/fibonacci | 1.00x faster |
| mixed/matrix-multiply | 1.01x faster |
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
| string/concat-short | 1214.8ms | 629.3ms | — |
| string/concat-long | 456.5ms | 694.4ms | — |
| string/indexOf | 401.6ms | 674.8ms | 572.7ms |
| string/includes | 381.1ms | 675.4ms | 575.3ms |
| string/split | 551.3ms | 690.5ms | — |
| string/replace | 514.0ms | 765.5ms | — |
| string/case-convert | 527.8ms | 707.2ms | — |
| string/substring | 405.2ms | 482.4ms | — |
| string/trim | 506.1ms | 716.9ms | — |
| string/startsWith-endsWith | 508.0ms | 730.4ms | 658.8ms |
| array/push-pop | 523.1ms | 604.5ms | — |
| array/sort-i32 | 686.9ms | 769.6ms | — |
| array/map-filter | 687.1ms | 784.7ms | — |
| array/reduce | 629.1ms | 719.2ms | — |
| array/indexOf | 606.5ms | 681.2ms | — |
| array/slice | 523.1ms | 627.9ms | — |
| array/reverse | 520.2ms | 590.2ms | — |
| array/forEach | 664.0ms | 731.5ms | — |
| array/find | 508.8ms | 622.1ms | 563.6ms |
| dom/create-elements | 438.1ms | — | — |
| dom/set-attributes | 396.8ms | — | — |
| dom/read-attributes | 395.0ms | — | — |
| dom/modify-text | 388.2ms | — | — |
| mixed/csv-parse | 542.0ms | 692.1ms | — |
| mixed/text-search | 507.7ms | 714.4ms | 620.5ms |
| mixed/fibonacci | 472.4ms | 504.8ms | 484.6ms |
| mixed/matrix-multiply | 689.8ms | 728.9ms | 512.2ms |
| mixed/sieve | 609.1ms | 715.9ms | — |
