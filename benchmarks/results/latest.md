# js2wasm Benchmark Results

Date: 2026-10-15
Node: v25.7.0
Platform: linux x64

## Summary

| Benchmark | JS | Host-call | GC-native | Linear | Winner |
|-----------|-----|-----------|-----------|--------|--------|
| string/concat-short | 0.044ms | 0.050ms | 0.051ms | FAILED | js |
| string/concat-long | 0.005ms | 0.005ms | 0.004ms | FAILED | gc-native |
| string/indexOf | 0.019ms | 0.061ms | 0.012ms | 0.016ms | gc-native |
| string/includes | 0.019ms | 0.120ms | 0.014ms | 0.025ms | gc-native |
| string/split | 0.446ms | 7.83ms | 2.64ms | FAILED | js |
| string/replace | 0.097ms | 0.605ms | 0.276ms | FAILED | js |
| string/case-convert | 0.060ms | 0.532ms | 0.244ms | FAILED | js |
| string/substring | 0.105ms | 0.040ms | 0.034ms | FAILED | gc-native |
| string/trim | 0.173ms | 3.35ms | 2.40ms | FAILED | js |
| string/startsWith-endsWith | 0.412ms | 2.52ms | 2.54ms | 0.557ms | js |
| array/push-pop | 1.65ms | 0.607ms | 0.602ms | FAILED | gc-native |
| array/sort-i32 | 0.839ms | 0.304ms | 0.296ms | FAILED | gc-native |
| array/map-filter | 0.134ms | 0.065ms | 0.065ms | FAILED | host-call |
| array/reduce | 1.59ms | 0.593ms | 0.593ms | FAILED | gc-native |
| array/indexOf | 4.46ms | 2.87ms | 2.87ms | FAILED | gc-native |
| array/slice | 0.034ms | 0.017ms | 0.017ms | FAILED | host-call |
| array/reverse | 8.85ms | 3.97ms | 3.97ms | FAILED | host-call |
| array/forEach | 0.093ms | 0.029ms | 0.029ms | FAILED | gc-native |
| array/find | 0.270ms | 0.015ms | 0.015ms | 1.21ms | host-call |
| dom/create-elements | 0.045ms | 0.164ms | — | — | js |
| dom/set-attributes | 0.108ms | 0.237ms | — | — | js |
| dom/read-attributes | 0.059ms | 0.138ms | — | — | js |
| dom/modify-text | 0.029ms | 0.115ms | — | — | js |
| mixed/csv-parse | 0.492ms | 8.54ms | 0.550ms | FAILED | js |
| mixed/text-search | 0.403ms | 4.69ms | 2.52ms | 1.10ms | js |
| mixed/fibonacci | 0.125ms | 0.327ms | 0.328ms | 0.325ms | js |
| mixed/matrix-multiply | 0.184ms | 70.18ms | 72.70ms | 0.722ms | js |
| mixed/sieve | 1.76ms | 2.32ms | 2.32ms | FAILED | js |

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
| string/concat-short | 10000 | 4.41 | 5.05 | 5.09 | — |
| string/concat-long | 1000 | 4.63 | 5.43 | 3.55 | — |
| string/indexOf | 1000 | 19.00 | 60.75 | 12.21 | 16.31 |
| string/includes | 1000 | 18.75 | 119.71 | 13.80 | 25.33 |
| string/split | 10000 | 44.57 | 782.66 | 263.56 | — |
| string/replace | 1000 | 97.00 | 604.75 | 276.26 | — |
| string/case-convert | 2000 | 29.88 | 266.08 | 122.08 | — |
| string/substring | 10000 | 10.47 | 3.99 | 3.44 | — |
| string/trim | 10000 | 17.34 | 335.27 | 240.35 | — |
| string/startsWith-endsWith | 20000 | 20.59 | 126.23 | 126.87 | 27.85 |
| array/map-filter | 30000 | 4.47 | 2.18 | 2.18 | — |
| array/indexOf | 1000 | 4460.31 | 2871.73 | 2870.68 | — |
| dom/create-elements | 2000 | 22.64 | 81.92 | — | — |
| dom/set-attributes | 6000 | 17.96 | 39.47 | — | — |
| dom/read-attributes | 3000 | 19.73 | 45.87 | — | — |
| dom/modify-text | 2000 | 14.70 | 57.32 | — | — |
| mixed/csv-parse | 11000 | 44.72 | 776.07 | 50.00 | — |
| mixed/text-search | 40000 | 10.07 | 117.32 | 63.01 | 27.50 |
| mixed/fibonacci | 10000 | 12.53 | 32.75 | 32.79 | 32.49 |
| mixed/matrix-multiply | 125000 | 1.47 | 561.41 | 581.63 | 5.78 |
| mixed/sieve | 200000 | 8.78 | 11.58 | 11.59 | — |

## Speedup vs JS baseline

| Benchmark | Host-call | GC-native | Linear |
|-----------|-----------|-----------|--------|
| string/concat-short | 1.14x slower | 1.15x slower | — |
| string/concat-long | 1.17x slower | 1.31x faster | — |
| string/indexOf | 3.20x slower | 1.56x faster | 1.17x faster |
| string/includes | 6.38x slower | 1.36x faster | 1.35x slower |
| string/split | 17.56x slower | 5.91x slower | — |
| string/replace | 6.23x slower | 2.85x slower | — |
| string/case-convert | 8.91x slower | 4.09x slower | — |
| string/substring | 2.63x faster | 3.05x faster | — |
| string/trim | 19.33x slower | 13.86x slower | — |
| string/startsWith-endsWith | 6.13x slower | 6.16x slower | 1.35x slower |
| array/push-pop | 2.71x faster | 2.73x faster | — |
| array/sort-i32 | 2.76x faster | 2.83x faster | — |
| array/map-filter | 2.05x faster | 2.05x faster | — |
| array/reduce | 2.68x faster | 2.68x faster | — |
| array/indexOf | 1.55x faster | 1.55x faster | — |
| array/slice | 2.07x faster | 2.05x faster | — |
| array/reverse | 2.23x faster | 2.23x faster | — |
| array/forEach | 3.25x faster | 3.26x faster | — |
| array/find | 18.39x faster | 18.32x faster | 4.47x slower |
| dom/create-elements | 3.62x slower | — | — |
| dom/set-attributes | 2.20x slower | — | — |
| dom/read-attributes | 2.32x slower | — | — |
| dom/modify-text | 3.90x slower | — | — |
| mixed/csv-parse | 17.35x slower | 1.12x slower | — |
| mixed/text-search | 11.65x slower | 6.26x slower | 2.73x slower |
| mixed/fibonacci | 2.61x slower | 2.62x slower | 2.59x slower |
| mixed/matrix-multiply | 380.86x slower | 394.57x slower | 3.92x slower |
| mixed/sieve | 1.32x slower | 1.32x slower | — |

## GC-native vs Host-call

| Benchmark | Speedup |
|-----------|---------|
| string/concat-short | 1.01x slower |
| string/concat-long | 1.53x faster |
| string/indexOf | 4.97x faster |
| string/includes | 8.67x faster |
| string/split | 2.97x faster |
| string/replace | 2.19x faster |
| string/case-convert | 2.18x faster |
| string/substring | 1.16x faster |
| string/trim | 1.39x faster |
| string/startsWith-endsWith | 1.01x slower |
| array/push-pop | 1.01x faster |
| array/sort-i32 | 1.03x faster |
| array/map-filter | 1.00x slower |
| array/reduce | 1.00x faster |
| array/indexOf | 1.00x faster |
| array/slice | 1.01x slower |
| array/reverse | 1.00x slower |
| array/forEach | 1.00x faster |
| array/find | 1.00x slower |
| mixed/csv-parse | 15.52x faster |
| mixed/text-search | 1.86x faster |
| mixed/fibonacci | 1.00x slower |
| mixed/matrix-multiply | 1.04x slower |
| mixed/sieve | 1.00x slower |

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
| string/concat-short | 1107.6ms | 592.4ms | — |
| string/concat-long | 441.9ms | 632.2ms | — |
| string/indexOf | 375.0ms | 661.7ms | 546.4ms |
| string/includes | 369.5ms | 654.4ms | 529.6ms |
| string/split | 526.8ms | 673.3ms | — |
| string/replace | 485.6ms | 721.8ms | — |
| string/case-convert | 518.3ms | 604.8ms | — |
| string/substring | 390.6ms | 453.0ms | — |
| string/trim | 475.8ms | 692.4ms | — |
| string/startsWith-endsWith | 474.8ms | 660.3ms | 598.0ms |
| array/push-pop | 486.0ms | 566.9ms | — |
| array/sort-i32 | 632.0ms | 709.2ms | — |
| array/map-filter | 678.3ms | 748.8ms | — |
| array/reduce | 600.9ms | 706.4ms | — |
| array/indexOf | 576.1ms | 648.0ms | — |
| array/slice | 509.1ms | 594.7ms | — |
| array/reverse | 493.2ms | 572.8ms | — |
| array/forEach | 616.9ms | 690.8ms | — |
| array/find | 498.1ms | 577.1ms | 526.2ms |
| dom/create-elements | 427.9ms | — | — |
| dom/set-attributes | 383.4ms | — | — |
| dom/read-attributes | 369.5ms | — | — |
| dom/modify-text | 381.3ms | — | — |
| mixed/csv-parse | 503.1ms | 650.2ms | — |
| mixed/text-search | 483.1ms | 701.5ms | 604.8ms |
| mixed/fibonacci | 427.2ms | 487.8ms | 479.6ms |
| mixed/matrix-multiply | 642.6ms | 689.3ms | 519.6ms |
| mixed/sieve | 600.5ms | 659.5ms | — |
