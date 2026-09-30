# js2wasm Benchmark Results

Date: 2026-09-30
Node: v25.7.0
Platform: linux x64

## Summary

| Benchmark | JS | Host-call | GC-native | Linear | Winner |
|-----------|-----|-----------|-----------|--------|--------|
| string/concat-short | 0.035ms | 0.049ms | 0.045ms | FAILED | js |
| string/concat-long | 0.004ms | 0.004ms | 0.004ms | FAILED | js |
| string/indexOf | 0.019ms | 0.069ms | 0.012ms | 0.015ms | gc-native |
| string/includes | 0.019ms | 0.118ms | 0.015ms | 0.016ms | gc-native |
| string/split | 0.428ms | 8.51ms | 2.88ms | FAILED | js |
| string/replace | 0.109ms | 0.709ms | 0.327ms | FAILED | js |
| string/case-convert | 0.058ms | 0.579ms | 0.271ms | FAILED | js |
| string/substring | 0.099ms | 0.037ms | 0.031ms | FAILED | gc-native |
| string/trim | 0.170ms | 4.02ms | 2.95ms | FAILED | js |
| string/startsWith-endsWith | 0.401ms | 2.94ms | 3.00ms | 0.564ms | js |
| array/push-pop | 1.50ms | 0.518ms | 0.515ms | FAILED | gc-native |
| array/sort-i32 | 0.792ms | 0.293ms | 0.294ms | FAILED | host-call |
| array/map-filter | 0.135ms | 0.071ms | 0.071ms | FAILED | host-call |
| array/reduce | 2.17ms | 0.515ms | 0.512ms | FAILED | gc-native |
| array/indexOf | 3.95ms | 2.64ms | 2.64ms | FAILED | gc-native |
| array/slice | 0.026ms | 0.028ms | 0.028ms | FAILED | js |
| array/reverse | 7.83ms | 3.52ms | 3.52ms | FAILED | host-call |
| array/forEach | 0.057ms | 0.028ms | 0.028ms | FAILED | gc-native |
| array/find | 0.256ms | 0.016ms | 0.016ms | 1.08ms | gc-native |
| dom/create-elements | 0.036ms | 0.154ms | — | — | js |
| dom/set-attributes | 0.107ms | 0.219ms | — | — | js |
| dom/read-attributes | 0.055ms | 0.121ms | — | — | js |
| dom/modify-text | 0.031ms | 0.116ms | — | — | js |
| mixed/csv-parse | 0.489ms | 8.69ms | 0.643ms | FAILED | js |
| mixed/text-search | 0.388ms | 5.46ms | 2.97ms | 1.10ms | js |
| mixed/fibonacci | 0.120ms | 0.283ms | 0.283ms | 0.291ms | js |
| mixed/matrix-multiply | 0.159ms | 74.18ms | 75.83ms | 0.721ms | js |
| mixed/sieve | 1.59ms | 2.12ms | 2.12ms | FAILED | js |

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
| string/concat-short | 10000 | 3.50 | 4.87 | 4.48 | — |
| string/concat-long | 1000 | 3.64 | 4.49 | 3.83 | — |
| string/indexOf | 1000 | 19.24 | 69.43 | 12.36 | 14.81 |
| string/includes | 1000 | 19.22 | 117.81 | 14.92 | 16.02 |
| string/split | 10000 | 42.82 | 850.88 | 287.72 | — |
| string/replace | 1000 | 109.17 | 708.89 | 327.30 | — |
| string/case-convert | 2000 | 29.04 | 289.32 | 135.73 | — |
| string/substring | 10000 | 9.87 | 3.74 | 3.07 | — |
| string/trim | 10000 | 17.03 | 401.75 | 294.87 | — |
| string/startsWith-endsWith | 20000 | 20.04 | 147.21 | 149.86 | 28.21 |
| array/map-filter | 30000 | 4.51 | 2.35 | 2.37 | — |
| array/indexOf | 1000 | 3951.05 | 2643.63 | 2639.08 | — |
| dom/create-elements | 2000 | 18.17 | 77.25 | — | — |
| dom/set-attributes | 6000 | 17.78 | 36.47 | — | — |
| dom/read-attributes | 3000 | 18.20 | 40.33 | — | — |
| dom/modify-text | 2000 | 15.37 | 58.00 | — | — |
| mixed/csv-parse | 11000 | 44.49 | 789.75 | 58.43 | — |
| mixed/text-search | 40000 | 9.71 | 136.45 | 74.35 | 27.47 |
| mixed/fibonacci | 10000 | 12.01 | 28.31 | 28.31 | 29.07 |
| mixed/matrix-multiply | 125000 | 1.27 | 593.47 | 606.67 | 5.77 |
| mixed/sieve | 200000 | 7.93 | 10.58 | 10.60 | — |

## Speedup vs JS baseline

| Benchmark | Host-call | GC-native | Linear |
|-----------|-----------|-----------|--------|
| string/concat-short | 1.39x slower | 1.28x slower | — |
| string/concat-long | 1.23x slower | 1.05x slower | — |
| string/indexOf | 3.61x slower | 1.56x faster | 1.30x faster |
| string/includes | 6.13x slower | 1.29x faster | 1.20x faster |
| string/split | 19.87x slower | 6.72x slower | — |
| string/replace | 6.49x slower | 3.00x slower | — |
| string/case-convert | 9.96x slower | 4.67x slower | — |
| string/substring | 2.64x faster | 3.21x faster | — |
| string/trim | 23.59x slower | 17.32x slower | — |
| string/startsWith-endsWith | 7.35x slower | 7.48x slower | 1.41x slower |
| array/push-pop | 2.90x faster | 2.91x faster | — |
| array/sort-i32 | 2.70x faster | 2.69x faster | — |
| array/map-filter | 1.92x faster | 1.90x faster | — |
| array/reduce | 4.22x faster | 4.24x faster | — |
| array/indexOf | 1.49x faster | 1.50x faster | — |
| array/slice | 1.07x slower | 1.08x slower | — |
| array/reverse | 2.22x faster | 2.22x faster | — |
| array/forEach | 2.02x faster | 2.02x faster | — |
| array/find | 16.19x faster | 16.19x faster | 4.20x slower |
| dom/create-elements | 4.25x slower | — | — |
| dom/set-attributes | 2.05x slower | — | — |
| dom/read-attributes | 2.22x slower | — | — |
| dom/modify-text | 3.77x slower | — | — |
| mixed/csv-parse | 17.75x slower | 1.31x slower | — |
| mixed/text-search | 14.06x slower | 7.66x slower | 2.83x slower |
| mixed/fibonacci | 2.36x slower | 2.36x slower | 2.42x slower |
| mixed/matrix-multiply | 465.83x slower | 476.19x slower | 4.53x slower |
| mixed/sieve | 1.33x slower | 1.34x slower | — |

## GC-native vs Host-call

| Benchmark | Speedup |
|-----------|---------|
| string/concat-short | 1.09x faster |
| string/concat-long | 1.17x faster |
| string/indexOf | 5.62x faster |
| string/includes | 7.90x faster |
| string/split | 2.96x faster |
| string/replace | 2.17x faster |
| string/case-convert | 2.13x faster |
| string/substring | 1.22x faster |
| string/trim | 1.36x faster |
| string/startsWith-endsWith | 1.02x slower |
| array/push-pop | 1.01x faster |
| array/sort-i32 | 1.00x slower |
| array/map-filter | 1.01x slower |
| array/reduce | 1.01x faster |
| array/indexOf | 1.00x faster |
| array/slice | 1.01x slower |
| array/reverse | 1.00x slower |
| array/forEach | 1.00x faster |
| array/find | 1.00x faster |
| mixed/csv-parse | 13.52x faster |
| mixed/text-search | 1.84x faster |
| mixed/fibonacci | 1.00x slower |
| mixed/matrix-multiply | 1.02x slower |
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
| string/concat-short | 1155.0ms | 614.3ms | — |
| string/concat-long | 439.6ms | 656.5ms | — |
| string/indexOf | 377.2ms | 679.6ms | 570.9ms |
| string/includes | 378.6ms | 688.2ms | 564.3ms |
| string/split | 536.7ms | 719.0ms | — |
| string/replace | 523.7ms | 761.1ms | — |
| string/case-convert | 508.0ms | 663.4ms | — |
| string/substring | 391.4ms | 461.2ms | — |
| string/trim | 488.9ms | 684.0ms | — |
| string/startsWith-endsWith | 512.8ms | 696.6ms | 643.5ms |
| array/push-pop | 531.8ms | 586.8ms | — |
| array/sort-i32 | 710.3ms | 710.1ms | — |
| array/map-filter | 693.1ms | 762.0ms | — |
| array/reduce | 616.8ms | 712.1ms | — |
| array/indexOf | 614.6ms | 677.7ms | — |
| array/slice | 548.5ms | 612.5ms | — |
| array/reverse | 543.7ms | 565.6ms | — |
| array/forEach | 636.3ms | 723.1ms | — |
| array/find | 501.4ms | 597.8ms | 548.0ms |
| dom/create-elements | 427.3ms | — | — |
| dom/set-attributes | 389.6ms | — | — |
| dom/read-attributes | 377.4ms | — | — |
| dom/modify-text | 383.9ms | — | — |
| mixed/csv-parse | 520.2ms | 682.2ms | — |
| mixed/text-search | 507.1ms | 720.2ms | 656.2ms |
| mixed/fibonacci | 454.3ms | 481.7ms | 482.7ms |
| mixed/matrix-multiply | 658.6ms | 706.4ms | 523.1ms |
| mixed/sieve | 632.0ms | 671.1ms | — |
