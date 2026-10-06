# js2wasm Benchmark Results

Date: 2026-10-06
Node: v25.7.0
Platform: linux x64

## Summary

| Benchmark | JS | Host-call | GC-native | Linear | Winner |
|-----------|-----|-----------|-----------|--------|--------|
| string/concat-short | 0.032ms | 0.048ms | 0.045ms | FAILED | js |
| string/concat-long | 0.004ms | 0.004ms | 0.004ms | FAILED | js |
| string/indexOf | 0.019ms | 0.064ms | 0.012ms | 0.016ms | gc-native |
| string/includes | 0.019ms | 0.137ms | 0.015ms | 0.017ms | gc-native |
| string/split | 0.424ms | 8.08ms | 2.91ms | FAILED | js |
| string/replace | 0.104ms | 0.668ms | 0.336ms | FAILED | js |
| string/case-convert | 0.056ms | 0.618ms | 0.270ms | FAILED | js |
| string/substring | 0.099ms | 0.037ms | 0.031ms | FAILED | gc-native |
| string/trim | 0.170ms | 3.89ms | 2.90ms | FAILED | js |
| string/startsWith-endsWith | 0.401ms | 2.88ms | 2.97ms | 0.561ms | js |
| array/push-pop | 1.39ms | 0.497ms | 0.501ms | FAILED | host-call |
| array/sort-i32 | 0.790ms | 0.296ms | 0.293ms | FAILED | gc-native |
| array/map-filter | 0.130ms | 0.070ms | 0.071ms | FAILED | host-call |
| array/reduce | 1.36ms | 0.499ms | 0.505ms | FAILED | host-call |
| array/indexOf | 3.95ms | 2.65ms | 2.64ms | FAILED | gc-native |
| array/slice | 0.025ms | 0.027ms | 0.027ms | FAILED | js |
| array/reverse | 7.83ms | 3.52ms | 3.52ms | FAILED | host-call |
| array/forEach | 0.049ms | 0.028ms | 0.028ms | FAILED | host-call |
| array/find | 0.253ms | 0.016ms | 0.016ms | 1.07ms | host-call |
| dom/create-elements | 0.041ms | 0.163ms | — | — | js |
| dom/set-attributes | 0.103ms | 0.215ms | — | — | js |
| dom/read-attributes | 0.055ms | 0.123ms | — | — | js |
| dom/modify-text | 0.028ms | 0.106ms | — | — | js |
| mixed/csv-parse | 0.475ms | 8.53ms | 0.662ms | FAILED | js |
| mixed/text-search | 0.390ms | 5.24ms | 2.98ms | 1.10ms | js |
| mixed/fibonacci | 0.120ms | 0.283ms | 0.283ms | 0.286ms | js |
| mixed/matrix-multiply | 0.158ms | 75.06ms | 78.49ms | 0.722ms | js |
| mixed/sieve | 1.61ms | 2.13ms | 2.10ms | FAILED | js |

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
| string/concat-short | 10000 | 3.24 | 4.82 | 4.45 | — |
| string/concat-long | 1000 | 3.59 | 4.48 | 3.70 | — |
| string/indexOf | 1000 | 19.17 | 63.61 | 12.30 | 16.29 |
| string/includes | 1000 | 19.21 | 136.77 | 14.52 | 16.95 |
| string/split | 10000 | 42.39 | 807.97 | 290.56 | — |
| string/replace | 1000 | 103.63 | 667.62 | 336.19 | — |
| string/case-convert | 2000 | 27.84 | 309.23 | 135.16 | — |
| string/substring | 10000 | 9.90 | 3.74 | 3.07 | — |
| string/trim | 10000 | 16.99 | 388.89 | 289.72 | — |
| string/startsWith-endsWith | 20000 | 20.05 | 143.77 | 148.32 | 28.03 |
| array/map-filter | 30000 | 4.34 | 2.34 | 2.35 | — |
| array/indexOf | 1000 | 3950.63 | 2646.88 | 2644.18 | — |
| dom/create-elements | 2000 | 20.32 | 81.52 | — | — |
| dom/set-attributes | 6000 | 17.13 | 35.90 | — | — |
| dom/read-attributes | 3000 | 18.41 | 40.90 | — | — |
| dom/modify-text | 2000 | 14.15 | 53.04 | — | — |
| mixed/csv-parse | 11000 | 43.19 | 775.66 | 60.21 | — |
| mixed/text-search | 40000 | 9.76 | 131.07 | 74.53 | 27.51 |
| mixed/fibonacci | 10000 | 12.02 | 28.29 | 28.32 | 28.59 |
| mixed/matrix-multiply | 125000 | 1.26 | 600.45 | 627.92 | 5.78 |
| mixed/sieve | 200000 | 8.07 | 10.63 | 10.48 | — |

## Speedup vs JS baseline

| Benchmark | Host-call | GC-native | Linear |
|-----------|-----------|-----------|--------|
| string/concat-short | 1.49x slower | 1.37x slower | — |
| string/concat-long | 1.25x slower | 1.03x slower | — |
| string/indexOf | 3.32x slower | 1.56x faster | 1.18x faster |
| string/includes | 7.12x slower | 1.32x faster | 1.13x faster |
| string/split | 19.06x slower | 6.85x slower | — |
| string/replace | 6.44x slower | 3.24x slower | — |
| string/case-convert | 11.11x slower | 4.86x slower | — |
| string/substring | 2.65x faster | 3.23x faster | — |
| string/trim | 22.88x slower | 17.05x slower | — |
| string/startsWith-endsWith | 7.17x slower | 7.40x slower | 1.40x slower |
| array/push-pop | 2.79x faster | 2.77x faster | — |
| array/sort-i32 | 2.67x faster | 2.70x faster | — |
| array/map-filter | 1.85x faster | 1.85x faster | — |
| array/reduce | 2.72x faster | 2.69x faster | — |
| array/indexOf | 1.49x faster | 1.49x faster | — |
| array/slice | 1.08x slower | 1.09x slower | — |
| array/reverse | 2.22x faster | 2.22x faster | — |
| array/forEach | 1.76x faster | 1.75x faster | — |
| array/find | 16.04x faster | 15.94x faster | 4.23x slower |
| dom/create-elements | 4.01x slower | — | — |
| dom/set-attributes | 2.10x slower | — | — |
| dom/read-attributes | 2.22x slower | — | — |
| dom/modify-text | 3.75x slower | — | — |
| mixed/csv-parse | 17.96x slower | 1.39x slower | — |
| mixed/text-search | 13.43x slower | 7.64x slower | 2.82x slower |
| mixed/fibonacci | 2.35x slower | 2.36x slower | 2.38x slower |
| mixed/matrix-multiply | 476.47x slower | 498.26x slower | 4.58x slower |
| mixed/sieve | 1.32x slower | 1.30x slower | — |

## GC-native vs Host-call

| Benchmark | Speedup |
|-----------|---------|
| string/concat-short | 1.08x faster |
| string/concat-long | 1.21x faster |
| string/indexOf | 5.17x faster |
| string/includes | 9.42x faster |
| string/split | 2.78x faster |
| string/replace | 1.99x faster |
| string/case-convert | 2.29x faster |
| string/substring | 1.22x faster |
| string/trim | 1.34x faster |
| string/startsWith-endsWith | 1.03x slower |
| array/push-pop | 1.01x slower |
| array/sort-i32 | 1.01x faster |
| array/map-filter | 1.00x slower |
| array/reduce | 1.01x slower |
| array/indexOf | 1.00x faster |
| array/slice | 1.01x slower |
| array/reverse | 1.00x slower |
| array/forEach | 1.00x slower |
| array/find | 1.01x slower |
| mixed/csv-parse | 12.88x faster |
| mixed/text-search | 1.76x faster |
| mixed/fibonacci | 1.00x slower |
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
| string/concat-short | 1199.0ms | 613.4ms | — |
| string/concat-long | 447.4ms | 650.5ms | — |
| string/indexOf | 370.0ms | 635.0ms | 550.9ms |
| string/includes | 375.6ms | 658.6ms | 543.5ms |
| string/split | 513.9ms | 663.8ms | — |
| string/replace | 498.7ms | 734.3ms | — |
| string/case-convert | 515.1ms | 590.9ms | — |
| string/substring | 397.0ms | 459.8ms | — |
| string/trim | 462.8ms | 689.1ms | — |
| string/startsWith-endsWith | 474.4ms | 687.1ms | 594.0ms |
| array/push-pop | 504.2ms | 555.4ms | — |
| array/sort-i32 | 688.1ms | 695.2ms | — |
| array/map-filter | 697.6ms | 752.2ms | — |
| array/reduce | 619.7ms | 682.0ms | — |
| array/indexOf | 587.3ms | 676.3ms | — |
| array/slice | 511.9ms | 607.3ms | — |
| array/reverse | 491.3ms | 558.4ms | — |
| array/forEach | 647.3ms | 711.4ms | — |
| array/find | 500.8ms | 601.3ms | 529.3ms |
| dom/create-elements | 431.0ms | — | — |
| dom/set-attributes | 362.8ms | — | — |
| dom/read-attributes | 373.7ms | — | — |
| dom/modify-text | 362.8ms | — | — |
| mixed/csv-parse | 511.6ms | 657.0ms | — |
| mixed/text-search | 478.9ms | 698.8ms | 630.3ms |
| mixed/fibonacci | 450.2ms | 505.6ms | 460.2ms |
| mixed/matrix-multiply | 627.2ms | 714.5ms | 518.9ms |
| mixed/sieve | 594.5ms | 674.0ms | — |
