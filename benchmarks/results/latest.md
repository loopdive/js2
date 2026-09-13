# js2wasm Benchmark Results

Date: 2026-09-13
Node: v25.7.0
Platform: linux x64

## Summary

| Benchmark | JS | Host-call | GC-native | Linear | Winner |
|-----------|-----|-----------|-----------|--------|--------|
| string/concat-short | 0.028ms | 0.048ms | 0.044ms | FAILED | js |
| string/concat-long | 0.004ms | 0.005ms | 0.004ms | FAILED | gc-native |
| string/indexOf | 0.019ms | 0.066ms | 0.012ms | 0.015ms | gc-native |
| string/includes | 0.019ms | 0.143ms | 0.015ms | 0.016ms | gc-native |
| string/split | 3.16ms | 8.32ms | 2.72ms | FAILED | gc-native |
| string/replace | 0.104ms | 0.705ms | 0.322ms | FAILED | js |
| string/case-convert | 0.056ms | 0.616ms | 0.267ms | FAILED | js |
| string/substring | 0.098ms | 0.037ms | 0.031ms | FAILED | gc-native |
| string/trim | 0.170ms | 3.86ms | 2.84ms | FAILED | js |
| string/startsWith-endsWith | 0.401ms | 2.89ms | 2.89ms | 0.560ms | js |
| array/push-pop | 1.41ms | 0.502ms | 0.507ms | FAILED | host-call |
| array/sort-i32 | 0.791ms | 0.293ms | 0.294ms | FAILED | host-call |
| array/map-filter | 0.126ms | 0.070ms | 0.069ms | FAILED | gc-native |
| array/reduce | 2.15ms | 0.508ms | 0.509ms | FAILED | host-call |
| array/indexOf | 3.95ms | 2.64ms | 2.64ms | FAILED | gc-native |
| array/slice | 0.025ms | 0.027ms | 0.027ms | FAILED | js |
| array/reverse | 7.83ms | 3.52ms | 3.52ms | FAILED | gc-native |
| array/forEach | 0.048ms | 0.028ms | 0.028ms | FAILED | gc-native |
| array/find | 0.253ms | 0.016ms | 0.016ms | 1.07ms | host-call |
| dom/create-elements | 0.035ms | 0.096ms | — | — | js |
| dom/set-attributes | 0.104ms | 0.219ms | — | — | js |
| dom/read-attributes | 0.056ms | 0.123ms | — | — | js |
| dom/modify-text | 0.028ms | 0.108ms | — | — | js |
| mixed/csv-parse | 1.39ms | 8.58ms | 0.591ms | FAILED | gc-native |
| mixed/text-search | 0.390ms | 4.83ms | 2.63ms | 1.08ms | js |
| mixed/fibonacci | 0.120ms | 0.283ms | 0.283ms | 0.281ms | js |
| mixed/matrix-multiply | 0.157ms | 71.79ms | 75.05ms | 0.718ms | js |
| mixed/sieve | 1.56ms | 2.09ms | 2.12ms | FAILED | js |

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
| string/concat-short | 10000 | 2.77 | 4.85 | 4.39 | — |
| string/concat-long | 1000 | 3.65 | 4.51 | 3.55 | — |
| string/indexOf | 1000 | 19.21 | 65.59 | 12.26 | 14.72 |
| string/includes | 1000 | 19.18 | 142.88 | 14.71 | 15.56 |
| string/split | 10000 | 316.15 | 832.43 | 272.30 | — |
| string/replace | 1000 | 104.19 | 704.87 | 322.15 | — |
| string/case-convert | 2000 | 27.88 | 308.15 | 133.31 | — |
| string/substring | 10000 | 9.84 | 3.74 | 3.07 | — |
| string/trim | 10000 | 17.03 | 385.99 | 283.67 | — |
| string/startsWith-endsWith | 20000 | 20.04 | 144.37 | 144.32 | 27.98 |
| array/map-filter | 30000 | 4.21 | 2.32 | 2.31 | — |
| array/indexOf | 1000 | 3952.00 | 2641.79 | 2639.17 | — |
| dom/create-elements | 2000 | 17.44 | 47.88 | — | — |
| dom/set-attributes | 6000 | 17.31 | 36.45 | — | — |
| dom/read-attributes | 3000 | 18.57 | 40.98 | — | — |
| dom/modify-text | 2000 | 14.17 | 53.97 | — | — |
| mixed/csv-parse | 11000 | 126.34 | 779.56 | 53.72 | — |
| mixed/text-search | 40000 | 9.74 | 120.63 | 65.77 | 27.12 |
| mixed/fibonacci | 10000 | 12.03 | 28.29 | 28.32 | 28.07 |
| mixed/matrix-multiply | 125000 | 1.26 | 574.32 | 600.36 | 5.75 |
| mixed/sieve | 200000 | 7.81 | 10.46 | 10.58 | — |

## Speedup vs JS baseline

| Benchmark | Host-call | GC-native | Linear |
|-----------|-----------|-----------|--------|
| string/concat-short | 1.75x slower | 1.59x slower | — |
| string/concat-long | 1.24x slower | 1.03x faster | — |
| string/indexOf | 3.41x slower | 1.57x faster | 1.31x faster |
| string/includes | 7.45x slower | 1.30x faster | 1.23x faster |
| string/split | 2.63x slower | 1.16x faster | — |
| string/replace | 6.77x slower | 3.09x slower | — |
| string/case-convert | 11.05x slower | 4.78x slower | — |
| string/substring | 2.63x faster | 3.20x faster | — |
| string/trim | 22.67x slower | 16.66x slower | — |
| string/startsWith-endsWith | 7.21x slower | 7.20x slower | 1.40x slower |
| array/push-pop | 2.80x faster | 2.77x faster | — |
| array/sort-i32 | 2.70x faster | 2.69x faster | — |
| array/map-filter | 1.82x faster | 1.82x faster | — |
| array/reduce | 4.23x faster | 4.22x faster | — |
| array/indexOf | 1.50x faster | 1.50x faster | — |
| array/slice | 1.09x slower | 1.08x slower | — |
| array/reverse | 2.22x faster | 2.22x faster | — |
| array/forEach | 1.72x faster | 1.72x faster | — |
| array/find | 16.24x faster | 16.05x faster | 4.24x slower |
| dom/create-elements | 2.75x slower | — | — |
| dom/set-attributes | 2.11x slower | — | — |
| dom/read-attributes | 2.21x slower | — | — |
| dom/modify-text | 3.81x slower | — | — |
| mixed/csv-parse | 6.17x slower | 2.35x faster | — |
| mixed/text-search | 12.39x slower | 6.75x slower | 2.78x slower |
| mixed/fibonacci | 2.35x slower | 2.35x slower | 2.33x slower |
| mixed/matrix-multiply | 457.18x slower | 477.91x slower | 4.58x slower |
| mixed/sieve | 1.34x slower | 1.36x slower | — |

## GC-native vs Host-call

| Benchmark | Speedup |
|-----------|---------|
| string/concat-short | 1.10x faster |
| string/concat-long | 1.27x faster |
| string/indexOf | 5.35x faster |
| string/includes | 9.71x faster |
| string/split | 3.06x faster |
| string/replace | 2.19x faster |
| string/case-convert | 2.31x faster |
| string/substring | 1.22x faster |
| string/trim | 1.36x faster |
| string/startsWith-endsWith | 1.00x faster |
| array/push-pop | 1.01x slower |
| array/sort-i32 | 1.00x slower |
| array/map-filter | 1.00x faster |
| array/reduce | 1.00x slower |
| array/indexOf | 1.00x faster |
| array/slice | 1.01x faster |
| array/reverse | 1.00x faster |
| array/forEach | 1.00x faster |
| array/find | 1.01x slower |
| mixed/csv-parse | 14.51x faster |
| mixed/text-search | 1.83x faster |
| mixed/fibonacci | 1.00x slower |
| mixed/matrix-multiply | 1.05x slower |
| mixed/sieve | 1.01x slower |

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
| array/sort-i32 | 2.8KB | 3.3KB | — |
| array/map-filter | 3.6KB | 4.1KB | — |
| array/reduce | 2.5KB | 3.0KB | — |
| array/indexOf | 1.8KB | 2.1KB | — |
| array/slice | 999B | 1.3KB | — |
| array/reverse | 977B | 1.3KB | — |
| array/forEach | 2.8KB | 3.4KB | — |
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
| string/concat-short | 1123.3ms | 637.5ms | — |
| string/concat-long | 427.5ms | 677.5ms | — |
| string/indexOf | 378.8ms | 689.5ms | 566.2ms |
| string/includes | 374.4ms | 675.4ms | 544.6ms |
| string/split | 487.1ms | 682.4ms | — |
| string/replace | 550.4ms | 741.5ms | — |
| string/case-convert | 511.8ms | 571.3ms | — |
| string/substring | 382.4ms | 507.9ms | — |
| string/trim | 481.0ms | 674.2ms | — |
| string/startsWith-endsWith | 499.0ms | 678.3ms | 638.2ms |
| array/push-pop | 492.4ms | 558.1ms | — |
| array/sort-i32 | 634.4ms | 719.1ms | — |
| array/map-filter | 679.6ms | 746.8ms | — |
| array/reduce | 587.9ms | 695.8ms | — |
| array/indexOf | 575.1ms | 684.8ms | — |
| array/slice | 512.8ms | 582.5ms | — |
| array/reverse | 493.1ms | 576.2ms | — |
| array/forEach | 627.4ms | 716.0ms | — |
| array/find | 502.7ms | 564.3ms | 547.8ms |
| dom/create-elements | 423.5ms | — | — |
| dom/set-attributes | 427.9ms | — | — |
| dom/read-attributes | 412.0ms | — | — |
| dom/modify-text | 390.7ms | — | — |
| mixed/csv-parse | 505.1ms | 667.7ms | — |
| mixed/text-search | 491.0ms | 702.8ms | 621.9ms |
| mixed/fibonacci | 470.2ms | 501.2ms | 486.6ms |
| mixed/matrix-multiply | 620.2ms | 687.0ms | 553.4ms |
| mixed/sieve | 585.4ms | 655.6ms | — |
