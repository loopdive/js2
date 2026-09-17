# js2wasm Benchmark Results

Date: 2026-09-17
Node: v25.7.0
Platform: linux x64

## Summary

| Benchmark | JS | Host-call | GC-native | Linear | Winner |
|-----------|-----|-----------|-----------|--------|--------|
| string/concat-short | 0.034ms | 0.049ms | 0.045ms | FAILED | js |
| string/concat-long | 0.004ms | 0.005ms | 0.004ms | FAILED | gc-native |
| string/indexOf | 0.019ms | 0.060ms | 0.012ms | 0.016ms | gc-native |
| string/includes | 0.019ms | 0.123ms | 0.014ms | 0.025ms | gc-native |
| string/split | 0.434ms | 7.95ms | 2.59ms | FAILED | js |
| string/replace | 0.094ms | 0.601ms | 0.273ms | FAILED | js |
| string/case-convert | 0.058ms | 0.565ms | 0.239ms | FAILED | js |
| string/substring | 0.104ms | 0.040ms | 0.034ms | FAILED | gc-native |
| string/trim | 0.173ms | 3.32ms | 2.40ms | FAILED | js |
| string/startsWith-endsWith | 0.414ms | 2.54ms | 2.72ms | 0.557ms | js |
| array/push-pop | 1.63ms | 0.602ms | 0.601ms | FAILED | gc-native |
| array/sort-i32 | 0.847ms | 0.300ms | 0.298ms | FAILED | gc-native |
| array/map-filter | 0.136ms | 0.066ms | 0.066ms | FAILED | gc-native |
| array/reduce | 2.41ms | 0.606ms | 0.606ms | FAILED | host-call |
| array/indexOf | 4.46ms | 2.86ms | 2.86ms | FAILED | gc-native |
| array/slice | 0.037ms | 0.018ms | 0.018ms | FAILED | host-call |
| array/reverse | 8.84ms | 3.97ms | 3.97ms | FAILED | host-call |
| array/forEach | 0.096ms | 0.029ms | 0.029ms | FAILED | host-call |
| array/find | 0.273ms | 0.015ms | 0.015ms | 1.21ms | host-call |
| dom/create-elements | 0.037ms | 0.102ms | — | — | js |
| dom/set-attributes | 0.110ms | 0.239ms | — | — | js |
| dom/read-attributes | 0.059ms | 0.134ms | — | — | js |
| dom/modify-text | 0.029ms | 0.113ms | — | — | js |
| mixed/csv-parse | 0.487ms | 8.19ms | 0.535ms | FAILED | js |
| mixed/text-search | 0.402ms | 4.11ms | 2.40ms | 1.12ms | js |
| mixed/fibonacci | 0.125ms | 0.327ms | 0.328ms | 0.325ms | js |
| mixed/matrix-multiply | 0.187ms | 66.50ms | 64.88ms | 0.723ms | js |
| mixed/sieve | 1.83ms | 2.32ms | 2.33ms | FAILED | js |

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
| string/concat-short | 10000 | 3.43 | 4.85 | 4.50 | — |
| string/concat-long | 1000 | 4.02 | 5.47 | 3.59 | — |
| string/indexOf | 1000 | 19.02 | 60.03 | 12.26 | 16.15 |
| string/includes | 1000 | 18.71 | 122.50 | 13.76 | 25.45 |
| string/split | 10000 | 43.40 | 794.82 | 259.28 | — |
| string/replace | 1000 | 93.58 | 600.62 | 273.29 | — |
| string/case-convert | 2000 | 29.14 | 282.41 | 119.57 | — |
| string/substring | 10000 | 10.40 | 3.99 | 3.43 | — |
| string/trim | 10000 | 17.27 | 332.44 | 240.20 | — |
| string/startsWith-endsWith | 20000 | 20.68 | 126.84 | 135.92 | 27.83 |
| array/map-filter | 30000 | 4.53 | 2.21 | 2.21 | — |
| array/indexOf | 1000 | 4457.88 | 2863.07 | 2858.09 | — |
| dom/create-elements | 2000 | 18.75 | 50.83 | — | — |
| dom/set-attributes | 6000 | 18.26 | 39.76 | — | — |
| dom/read-attributes | 3000 | 19.68 | 44.82 | — | — |
| dom/modify-text | 2000 | 14.74 | 56.70 | — | — |
| mixed/csv-parse | 11000 | 44.31 | 744.19 | 48.65 | — |
| mixed/text-search | 40000 | 10.06 | 102.69 | 59.97 | 27.94 |
| mixed/fibonacci | 10000 | 12.53 | 32.72 | 32.77 | 32.49 |
| mixed/matrix-multiply | 125000 | 1.50 | 531.97 | 519.05 | 5.79 |
| mixed/sieve | 200000 | 9.13 | 11.61 | 11.63 | — |

## Speedup vs JS baseline

| Benchmark | Host-call | GC-native | Linear |
|-----------|-----------|-----------|--------|
| string/concat-short | 1.42x slower | 1.31x slower | — |
| string/concat-long | 1.36x slower | 1.12x faster | — |
| string/indexOf | 3.16x slower | 1.55x faster | 1.18x faster |
| string/includes | 6.55x slower | 1.36x faster | 1.36x slower |
| string/split | 18.31x slower | 5.97x slower | — |
| string/replace | 6.42x slower | 2.92x slower | — |
| string/case-convert | 9.69x slower | 4.10x slower | — |
| string/substring | 2.61x faster | 3.03x faster | — |
| string/trim | 19.24x slower | 13.90x slower | — |
| string/startsWith-endsWith | 6.13x slower | 6.57x slower | 1.35x slower |
| array/push-pop | 2.70x faster | 2.71x faster | — |
| array/sort-i32 | 2.82x faster | 2.84x faster | — |
| array/map-filter | 2.05x faster | 2.05x faster | — |
| array/reduce | 3.97x faster | 3.97x faster | — |
| array/indexOf | 1.56x faster | 1.56x faster | — |
| array/slice | 2.13x faster | 2.11x faster | — |
| array/reverse | 2.23x faster | 2.23x faster | — |
| array/forEach | 3.35x faster | 3.34x faster | — |
| array/find | 18.40x faster | 18.32x faster | 4.44x slower |
| dom/create-elements | 2.71x slower | — | — |
| dom/set-attributes | 2.18x slower | — | — |
| dom/read-attributes | 2.28x slower | — | — |
| dom/modify-text | 3.85x slower | — | — |
| mixed/csv-parse | 16.80x slower | 1.10x slower | — |
| mixed/text-search | 10.21x slower | 5.96x slower | 2.78x slower |
| mixed/fibonacci | 2.61x slower | 2.61x slower | 2.59x slower |
| mixed/matrix-multiply | 355.08x slower | 346.45x slower | 3.86x slower |
| mixed/sieve | 1.27x slower | 1.27x slower | — |

## GC-native vs Host-call

| Benchmark | Speedup |
|-----------|---------|
| string/concat-short | 1.08x faster |
| string/concat-long | 1.53x faster |
| string/indexOf | 4.90x faster |
| string/includes | 8.90x faster |
| string/split | 3.07x faster |
| string/replace | 2.20x faster |
| string/case-convert | 2.36x faster |
| string/substring | 1.16x faster |
| string/trim | 1.38x faster |
| string/startsWith-endsWith | 1.07x slower |
| array/push-pop | 1.00x faster |
| array/sort-i32 | 1.01x faster |
| array/map-filter | 1.00x faster |
| array/reduce | 1.00x slower |
| array/indexOf | 1.00x faster |
| array/slice | 1.01x slower |
| array/reverse | 1.00x slower |
| array/forEach | 1.00x slower |
| array/find | 1.00x slower |
| mixed/csv-parse | 15.30x faster |
| mixed/text-search | 1.71x faster |
| mixed/fibonacci | 1.00x slower |
| mixed/matrix-multiply | 1.02x faster |
| mixed/sieve | 1.00x slower |

## Binary sizes

| Benchmark | Host-call | GC-native | Linear |
|-----------|-----------|-----------|--------|
| string/concat-short | 209B | 745B | — |
| string/concat-long | 223B | 932B | — |
| string/indexOf | 254B | 1.1KB | 10.4KB |
| string/includes | 241B | 1.1KB | 10.4KB |
| string/split | 1.6KB | 3.1KB | — |
| string/replace | 1.6KB | 4.1KB | — |
| string/case-convert | 1.5KB | 2.2KB | — |
| string/substring | 202B | 279B | — |
| string/trim | 1.2KB | 2.7KB | — |
| string/startsWith-endsWith | 1.7KB | 3.6KB | 1.7KB |
| array/push-pop | 940B | 1.3KB | — |
| array/sort-i32 | 2.7KB | 3.2KB | — |
| array/map-filter | 3.6KB | 4.1KB | — |
| array/reduce | 2.5KB | 3.0KB | — |
| array/indexOf | 1.8KB | 2.1KB | — |
| array/slice | 999B | 1.3KB | — |
| array/reverse | 977B | 1.3KB | — |
| array/forEach | 2.8KB | 3.3KB | — |
| array/find | 946B | 1.3KB | 634B |
| dom/create-elements | 271B | — | — |
| dom/set-attributes | 524B | — | — |
| dom/read-attributes | 389B | — | — |
| dom/modify-text | 264B | — | — |
| mixed/csv-parse | 2.2KB | 4.2KB | — |
| mixed/text-search | 1.9KB | 4.0KB | 1.9KB |
| mixed/fibonacci | 438B | 438B | 411B |
| mixed/matrix-multiply | 2.6KB | 3.2KB | 991B |
| mixed/sieve | 1.7KB | 2.0KB | — |

## Compile times

| Benchmark | Host-call | GC-native | Linear |
|-----------|-----------|-----------|--------|
| string/concat-short | 1105.5ms | 596.9ms | — |
| string/concat-long | 433.4ms | 655.9ms | — |
| string/indexOf | 373.3ms | 645.3ms | 557.1ms |
| string/includes | 371.0ms | 668.5ms | 548.8ms |
| string/split | 493.8ms | 661.6ms | — |
| string/replace | 488.9ms | 730.6ms | — |
| string/case-convert | 520.7ms | 586.4ms | — |
| string/substring | 392.2ms | 463.0ms | — |
| string/trim | 463.2ms | 697.2ms | — |
| string/startsWith-endsWith | 472.0ms | 686.0ms | 626.8ms |
| array/push-pop | 488.6ms | 563.2ms | — |
| array/sort-i32 | 638.1ms | 670.6ms | — |
| array/map-filter | 671.9ms | 689.2ms | — |
| array/reduce | 600.5ms | 670.1ms | — |
| array/indexOf | 560.0ms | 656.9ms | — |
| array/slice | 491.8ms | 577.0ms | — |
| array/reverse | 466.4ms | 541.7ms | — |
| array/forEach | 620.0ms | 693.1ms | — |
| array/find | 485.9ms | 559.5ms | 537.5ms |
| dom/create-elements | 432.1ms | — | — |
| dom/set-attributes | 383.7ms | — | — |
| dom/read-attributes | 380.4ms | — | — |
| dom/modify-text | 382.8ms | — | — |
| mixed/csv-parse | 492.8ms | 704.7ms | — |
| mixed/text-search | 497.6ms | 660.7ms | 598.1ms |
| mixed/fibonacci | 437.1ms | 495.0ms | 477.9ms |
| mixed/matrix-multiply | 599.9ms | 673.6ms | 515.9ms |
| mixed/sieve | 558.7ms | 660.1ms | — |
