# js2wasm Benchmark Results

Date: 2026-10-05
Node: v25.7.0
Platform: linux x64

## Summary

| Benchmark | JS | Host-call | GC-native | Linear | Winner |
|-----------|-----|-----------|-----------|--------|--------|
| string/concat-short | 0.032ms | 0.048ms | 0.045ms | FAILED | js |
| string/concat-long | 0.004ms | 0.005ms | 0.003ms | FAILED | gc-native |
| string/indexOf | 0.019ms | 0.064ms | 0.012ms | 0.015ms | gc-native |
| string/includes | 0.019ms | 0.138ms | 0.015ms | 0.017ms | gc-native |
| string/split | 0.424ms | 8.53ms | 2.88ms | FAILED | js |
| string/replace | 0.101ms | 0.699ms | 0.334ms | FAILED | js |
| string/case-convert | 0.056ms | 0.615ms | 0.267ms | FAILED | js |
| string/substring | 0.099ms | 0.037ms | 0.031ms | FAILED | gc-native |
| string/trim | 0.170ms | 4.02ms | 2.85ms | FAILED | js |
| string/startsWith-endsWith | 0.401ms | 3.12ms | 2.99ms | 0.561ms | js |
| array/push-pop | 1.40ms | 0.510ms | 0.509ms | FAILED | gc-native |
| array/sort-i32 | 0.805ms | 0.292ms | 0.293ms | FAILED | host-call |
| array/map-filter | 0.129ms | 0.069ms | 0.070ms | FAILED | host-call |
| array/reduce | 2.16ms | 0.512ms | 0.505ms | FAILED | gc-native |
| array/indexOf | 3.95ms | 2.64ms | 2.64ms | FAILED | gc-native |
| array/slice | 0.025ms | 0.027ms | 0.027ms | FAILED | js |
| array/reverse | 7.83ms | 3.52ms | 3.52ms | FAILED | gc-native |
| array/forEach | 0.048ms | 0.028ms | 0.028ms | FAILED | host-call |
| array/find | 0.253ms | 0.015ms | 0.016ms | 1.07ms | host-call |
| dom/create-elements | 0.035ms | 0.095ms | — | — | js |
| dom/set-attributes | 0.103ms | 0.217ms | — | — | js |
| dom/read-attributes | 0.057ms | 0.146ms | — | — | js |
| dom/modify-text | 0.028ms | 0.108ms | — | — | js |
| mixed/csv-parse | 1.01ms | 8.83ms | 0.636ms | FAILED | gc-native |
| mixed/text-search | 0.390ms | 5.18ms | 2.85ms | 1.08ms | js |
| mixed/fibonacci | 0.120ms | 0.283ms | 0.283ms | 0.281ms | js |
| mixed/matrix-multiply | 0.157ms | 69.81ms | 74.77ms | 0.721ms | js |
| mixed/sieve | 1.55ms | 2.12ms | 2.12ms | FAILED | js |

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
| string/concat-short | 10000 | 3.22 | 4.80 | 4.46 | — |
| string/concat-long | 1000 | 3.54 | 4.55 | 3.50 | — |
| string/indexOf | 1000 | 19.12 | 63.93 | 12.33 | 14.60 |
| string/includes | 1000 | 19.19 | 137.71 | 14.74 | 17.43 |
| string/split | 10000 | 42.41 | 852.75 | 287.66 | — |
| string/replace | 1000 | 101.07 | 698.87 | 333.80 | — |
| string/case-convert | 2000 | 27.98 | 307.37 | 133.66 | — |
| string/substring | 10000 | 9.88 | 3.74 | 3.07 | — |
| string/trim | 10000 | 17.01 | 402.18 | 284.58 | — |
| string/startsWith-endsWith | 20000 | 20.05 | 156.03 | 149.38 | 28.05 |
| array/map-filter | 30000 | 4.30 | 2.31 | 2.32 | — |
| array/indexOf | 1000 | 3952.31 | 2643.75 | 2641.91 | — |
| dom/create-elements | 2000 | 17.25 | 47.59 | — | — |
| dom/set-attributes | 6000 | 17.17 | 36.16 | — | — |
| dom/read-attributes | 3000 | 18.86 | 48.68 | — | — |
| dom/modify-text | 2000 | 14.14 | 54.10 | — | — |
| mixed/csv-parse | 11000 | 91.40 | 802.48 | 57.85 | — |
| mixed/text-search | 40000 | 9.75 | 129.40 | 71.16 | 27.01 |
| mixed/fibonacci | 10000 | 12.02 | 28.32 | 28.31 | 28.08 |
| mixed/matrix-multiply | 125000 | 1.25 | 558.47 | 598.15 | 5.77 |
| mixed/sieve | 200000 | 7.75 | 10.62 | 10.60 | — |

## Speedup vs JS baseline

| Benchmark | Host-call | GC-native | Linear |
|-----------|-----------|-----------|--------|
| string/concat-short | 1.49x slower | 1.39x slower | — |
| string/concat-long | 1.28x slower | 1.01x faster | — |
| string/indexOf | 3.34x slower | 1.55x faster | 1.31x faster |
| string/includes | 7.18x slower | 1.30x faster | 1.10x faster |
| string/split | 20.11x slower | 6.78x slower | — |
| string/replace | 6.91x slower | 3.30x slower | — |
| string/case-convert | 10.99x slower | 4.78x slower | — |
| string/substring | 2.64x faster | 3.21x faster | — |
| string/trim | 23.64x slower | 16.73x slower | — |
| string/startsWith-endsWith | 7.78x slower | 7.45x slower | 1.40x slower |
| array/push-pop | 2.75x faster | 2.75x faster | — |
| array/sort-i32 | 2.75x faster | 2.75x faster | — |
| array/map-filter | 1.86x faster | 1.85x faster | — |
| array/reduce | 4.21x faster | 4.27x faster | — |
| array/indexOf | 1.49x faster | 1.50x faster | — |
| array/slice | 1.09x slower | 1.08x slower | — |
| array/reverse | 2.22x faster | 2.22x faster | — |
| array/forEach | 1.74x faster | 1.74x faster | — |
| array/find | 16.41x faster | 16.20x faster | 4.25x slower |
| dom/create-elements | 2.76x slower | — | — |
| dom/set-attributes | 2.11x slower | — | — |
| dom/read-attributes | 2.58x slower | — | — |
| dom/modify-text | 3.83x slower | — | — |
| mixed/csv-parse | 8.78x slower | 1.58x faster | — |
| mixed/text-search | 13.27x slower | 7.30x slower | 2.77x slower |
| mixed/fibonacci | 2.36x slower | 2.36x slower | 2.34x slower |
| mixed/matrix-multiply | 445.64x slower | 477.31x slower | 4.60x slower |
| mixed/sieve | 1.37x slower | 1.37x slower | — |

## GC-native vs Host-call

| Benchmark | Speedup |
|-----------|---------|
| string/concat-short | 1.08x faster |
| string/concat-long | 1.30x faster |
| string/indexOf | 5.19x faster |
| string/includes | 9.34x faster |
| string/split | 2.96x faster |
| string/replace | 2.09x faster |
| string/case-convert | 2.30x faster |
| string/substring | 1.22x faster |
| string/trim | 1.41x faster |
| string/startsWith-endsWith | 1.04x faster |
| array/push-pop | 1.00x faster |
| array/sort-i32 | 1.00x slower |
| array/map-filter | 1.00x slower |
| array/reduce | 1.01x faster |
| array/indexOf | 1.00x faster |
| array/slice | 1.01x faster |
| array/reverse | 1.00x faster |
| array/forEach | 1.00x slower |
| array/find | 1.01x slower |
| mixed/csv-parse | 13.87x faster |
| mixed/text-search | 1.82x faster |
| mixed/fibonacci | 1.00x faster |
| mixed/matrix-multiply | 1.07x slower |
| mixed/sieve | 1.00x faster |

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
| string/concat-short | 1153.5ms | 614.7ms | — |
| string/concat-long | 420.8ms | 648.2ms | — |
| string/indexOf | 374.4ms | 680.3ms | 551.5ms |
| string/includes | 368.7ms | 651.8ms | 544.4ms |
| string/split | 527.5ms | 670.4ms | — |
| string/replace | 501.2ms | 733.5ms | — |
| string/case-convert | 523.6ms | 607.3ms | — |
| string/substring | 384.6ms | 486.6ms | — |
| string/trim | 485.2ms | 685.0ms | — |
| string/startsWith-endsWith | 481.9ms | 679.2ms | 606.0ms |
| array/push-pop | 509.1ms | 577.5ms | — |
| array/sort-i32 | 668.6ms | 741.5ms | — |
| array/map-filter | 686.5ms | 748.1ms | — |
| array/reduce | 612.7ms | 699.4ms | — |
| array/indexOf | 584.4ms | 664.2ms | — |
| array/slice | 503.1ms | 577.8ms | — |
| array/reverse | 492.2ms | 570.5ms | — |
| array/forEach | 631.5ms | 688.9ms | — |
| array/find | 496.2ms | 571.9ms | 540.6ms |
| dom/create-elements | 395.4ms | — | — |
| dom/set-attributes | 369.5ms | — | — |
| dom/read-attributes | 380.7ms | — | — |
| dom/modify-text | 367.0ms | — | — |
| mixed/csv-parse | 500.4ms | 663.2ms | — |
| mixed/text-search | 494.4ms | 688.3ms | 610.2ms |
| mixed/fibonacci | 449.3ms | 493.9ms | 479.6ms |
| mixed/matrix-multiply | 635.1ms | 722.1ms | 504.4ms |
| mixed/sieve | 609.9ms | 660.5ms | — |
