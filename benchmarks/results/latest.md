# js2wasm Benchmark Results

Date: 2026-10-11
Node: v25.7.0
Platform: linux x64

## Summary

| Benchmark | JS | Host-call | GC-native | Linear | Winner |
|-----------|-----|-----------|-----------|--------|--------|
| string/concat-short | 0.042ms | 0.052ms | 0.055ms | FAILED | js |
| string/concat-long | 0.004ms | 0.004ms | 0.006ms | FAILED | js |
| string/indexOf | 0.014ms | 0.046ms | 0.010ms | 0.031ms | gc-native |
| string/includes | 0.014ms | 0.087ms | 0.012ms | 0.033ms | gc-native |
| string/split | 0.309ms | 6.00ms | 2.11ms | FAILED | js |
| string/replace | 0.086ms | 0.466ms | 0.260ms | FAILED | js |
| string/case-convert | 0.044ms | 0.421ms | 0.207ms | FAILED | js |
| string/substring | 0.090ms | 0.032ms | 0.027ms | FAILED | gc-native |
| string/trim | 0.142ms | 2.94ms | 2.16ms | FAILED | js |
| string/startsWith-endsWith | 0.405ms | 2.32ms | 2.43ms | 0.478ms | js |
| array/push-pop | 1.19ms | 0.393ms | 0.404ms | FAILED | host-call |
| array/sort-i32 | 0.552ms | 0.288ms | 0.287ms | FAILED | gc-native |
| array/map-filter | 0.122ms | 0.072ms | 0.073ms | FAILED | host-call |
| array/reduce | 1.83ms | 0.394ms | 0.412ms | FAILED | host-call |
| array/indexOf | 4.58ms | 2.27ms | 2.26ms | FAILED | gc-native |
| array/slice | 0.022ms | 0.020ms | 0.021ms | FAILED | host-call |
| array/reverse | 7.09ms | 3.21ms | 3.21ms | FAILED | host-call |
| array/forEach | 0.055ms | 0.022ms | 0.021ms | FAILED | gc-native |
| array/find | 0.248ms | 0.012ms | 0.012ms | 0.849ms | gc-native |
| dom/create-elements | 0.040ms | 0.093ms | — | — | js |
| dom/set-attributes | 0.117ms | 0.166ms | — | — | js |
| dom/read-attributes | 0.049ms | 0.100ms | — | — | js |
| dom/modify-text | 0.035ms | 0.087ms | — | — | js |
| mixed/csv-parse | 0.345ms | 6.08ms | 0.504ms | FAILED | js |
| mixed/text-search | 0.366ms | 3.49ms | 2.23ms | 0.976ms | js |
| mixed/fibonacci | 0.114ms | 0.182ms | 0.184ms | 0.185ms | js |
| mixed/matrix-multiply | 0.165ms | 53.47ms | 56.95ms | 0.621ms | js |
| mixed/sieve | 1.50ms | 2.12ms | 2.10ms | FAILED | js |

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
| string/concat-short | 10000 | 4.20 | 5.18 | 5.52 | — |
| string/concat-long | 1000 | 3.77 | 4.03 | 6.00 | — |
| string/indexOf | 1000 | 14.05 | 45.64 | 9.80 | 31.10 |
| string/includes | 1000 | 13.99 | 87.03 | 12.30 | 32.76 |
| string/split | 10000 | 30.94 | 600.11 | 211.34 | — |
| string/replace | 1000 | 85.95 | 465.64 | 259.93 | — |
| string/case-convert | 2000 | 21.84 | 210.39 | 103.68 | — |
| string/substring | 10000 | 8.97 | 3.17 | 2.71 | — |
| string/trim | 10000 | 14.20 | 293.88 | 215.87 | — |
| string/startsWith-endsWith | 20000 | 20.24 | 115.88 | 121.64 | 23.88 |
| array/map-filter | 30000 | 4.08 | 2.40 | 2.44 | — |
| array/indexOf | 1000 | 4579.03 | 2272.15 | 2264.32 | — |
| dom/create-elements | 2000 | 19.86 | 46.55 | — | — |
| dom/set-attributes | 6000 | 19.46 | 27.72 | — | — |
| dom/read-attributes | 3000 | 16.47 | 33.47 | — | — |
| dom/modify-text | 2000 | 17.56 | 43.57 | — | — |
| mixed/csv-parse | 11000 | 31.40 | 552.44 | 45.86 | — |
| mixed/text-search | 40000 | 9.16 | 87.37 | 55.87 | 24.41 |
| mixed/fibonacci | 10000 | 11.39 | 18.21 | 18.44 | 18.49 |
| mixed/matrix-multiply | 125000 | 1.32 | 427.73 | 455.61 | 4.97 |
| mixed/sieve | 200000 | 7.50 | 10.61 | 10.50 | — |

## Speedup vs JS baseline

| Benchmark | Host-call | GC-native | Linear |
|-----------|-----------|-----------|--------|
| string/concat-short | 1.23x slower | 1.31x slower | — |
| string/concat-long | 1.07x slower | 1.59x slower | — |
| string/indexOf | 3.25x slower | 1.43x faster | 2.21x slower |
| string/includes | 6.22x slower | 1.14x faster | 2.34x slower |
| string/split | 19.40x slower | 6.83x slower | — |
| string/replace | 5.42x slower | 3.02x slower | — |
| string/case-convert | 9.64x slower | 4.75x slower | — |
| string/substring | 2.83x faster | 3.31x faster | — |
| string/trim | 20.70x slower | 15.20x slower | — |
| string/startsWith-endsWith | 5.73x slower | 6.01x slower | 1.18x slower |
| array/push-pop | 3.04x faster | 2.96x faster | — |
| array/sort-i32 | 1.92x faster | 1.92x faster | — |
| array/map-filter | 1.70x faster | 1.67x faster | — |
| array/reduce | 4.63x faster | 4.44x faster | — |
| array/indexOf | 2.02x faster | 2.02x faster | — |
| array/slice | 1.13x faster | 1.06x faster | — |
| array/reverse | 2.21x faster | 2.21x faster | — |
| array/forEach | 2.50x faster | 2.60x faster | — |
| array/find | 20.27x faster | 20.40x faster | 3.42x slower |
| dom/create-elements | 2.34x slower | — | — |
| dom/set-attributes | 1.42x slower | — | — |
| dom/read-attributes | 2.03x slower | — | — |
| dom/modify-text | 2.48x slower | — | — |
| mixed/csv-parse | 17.59x slower | 1.46x slower | — |
| mixed/text-search | 9.54x slower | 6.10x slower | 2.67x slower |
| mixed/fibonacci | 1.60x slower | 1.62x slower | 1.62x slower |
| mixed/matrix-multiply | 323.08x slower | 344.14x slower | 3.75x slower |
| mixed/sieve | 1.41x slower | 1.40x slower | — |

## GC-native vs Host-call

| Benchmark | Speedup |
|-----------|---------|
| string/concat-short | 1.07x slower |
| string/concat-long | 1.49x slower |
| string/indexOf | 4.66x faster |
| string/includes | 7.08x faster |
| string/split | 2.84x faster |
| string/replace | 1.79x faster |
| string/case-convert | 2.03x faster |
| string/substring | 1.17x faster |
| string/trim | 1.36x faster |
| string/startsWith-endsWith | 1.05x slower |
| array/push-pop | 1.03x slower |
| array/sort-i32 | 1.00x faster |
| array/map-filter | 1.02x slower |
| array/reduce | 1.04x slower |
| array/indexOf | 1.00x faster |
| array/slice | 1.06x slower |
| array/reverse | 1.00x slower |
| array/forEach | 1.04x faster |
| array/find | 1.01x faster |
| mixed/csv-parse | 12.05x faster |
| mixed/text-search | 1.56x faster |
| mixed/fibonacci | 1.01x slower |
| mixed/matrix-multiply | 1.07x slower |
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
| string/concat-short | 955.4ms | 536.4ms | — |
| string/concat-long | 376.9ms | 549.2ms | — |
| string/indexOf | 331.2ms | 557.2ms | 472.5ms |
| string/includes | 322.4ms | 577.0ms | 482.4ms |
| string/split | 441.8ms | 590.6ms | — |
| string/replace | 432.4ms | 648.1ms | — |
| string/case-convert | 434.5ms | 541.2ms | — |
| string/substring | 332.0ms | 418.6ms | — |
| string/trim | 423.8ms | 587.8ms | — |
| string/startsWith-endsWith | 423.0ms | 591.0ms | 547.3ms |
| array/push-pop | 434.2ms | 420.6ms | — |
| array/sort-i32 | 551.3ms | 613.1ms | — |
| array/map-filter | 576.6ms | 641.0ms | — |
| array/reduce | 517.5ms | 603.1ms | — |
| array/indexOf | 504.0ms | 562.2ms | — |
| array/slice | 442.7ms | 523.8ms | — |
| array/reverse | 428.6ms | 506.6ms | — |
| array/forEach | 558.7ms | 584.8ms | — |
| array/find | 423.6ms | 519.3ms | 456.5ms |
| dom/create-elements | 357.0ms | — | — |
| dom/set-attributes | 334.3ms | — | — |
| dom/read-attributes | 335.0ms | — | — |
| dom/modify-text | 327.5ms | — | — |
| mixed/csv-parse | 445.8ms | 575.8ms | — |
| mixed/text-search | 441.6ms | 599.1ms | 526.1ms |
| mixed/fibonacci | 382.2ms | 436.5ms | 397.7ms |
| mixed/matrix-multiply | 568.5ms | 593.1ms | 442.2ms |
| mixed/sieve | 523.6ms | 578.9ms | — |
