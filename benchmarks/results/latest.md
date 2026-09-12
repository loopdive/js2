# js2wasm Benchmark Results

Date: 2026-09-12
Node: v25.7.0
Platform: linux x64

## Summary

| Benchmark | JS | Host-call | GC-native | Linear | Winner |
|-----------|-----|-----------|-----------|--------|--------|
| string/concat-short | 0.035ms | 0.047ms | 0.046ms | FAILED | js |
| string/concat-long | 0.004ms | 0.005ms | 0.004ms | FAILED | js |
| string/indexOf | 0.019ms | 0.064ms | 0.012ms | 0.015ms | gc-native |
| string/includes | 0.019ms | 0.127ms | 0.015ms | 0.016ms | gc-native |
| string/split | 0.424ms | 8.21ms | 2.85ms | FAILED | js |
| string/replace | 0.104ms | 0.701ms | 0.316ms | FAILED | js |
| string/case-convert | 0.055ms | 0.567ms | 0.249ms | FAILED | js |
| string/substring | 0.098ms | 0.037ms | 0.031ms | FAILED | gc-native |
| string/trim | 0.170ms | 3.70ms | 2.63ms | FAILED | js |
| string/startsWith-endsWith | 0.400ms | 2.73ms | 2.81ms | 0.560ms | js |
| array/push-pop | 1.38ms | 0.506ms | 0.501ms | FAILED | gc-native |
| array/sort-i32 | 0.791ms | 0.294ms | 0.294ms | FAILED | host-call |
| array/map-filter | 0.125ms | 0.070ms | 0.069ms | FAILED | gc-native |
| array/reduce | 2.14ms | 0.501ms | 0.503ms | FAILED | host-call |
| array/indexOf | 3.95ms | 2.64ms | 2.64ms | FAILED | gc-native |
| array/slice | 0.024ms | 0.026ms | 0.026ms | FAILED | js |
| array/reverse | 7.83ms | 3.52ms | 3.52ms | FAILED | host-call |
| array/forEach | 0.086ms | 0.028ms | 0.028ms | FAILED | host-call |
| array/find | 0.253ms | 0.016ms | 0.016ms | 1.07ms | host-call |
| dom/create-elements | 0.034ms | 0.155ms | — | — | js |
| dom/set-attributes | 0.104ms | 0.218ms | — | — | js |
| dom/read-attributes | 0.058ms | 0.121ms | — | — | js |
| dom/modify-text | 0.029ms | 0.109ms | — | — | js |
| mixed/csv-parse | 0.492ms | 8.63ms | 0.594ms | FAILED | js |
| mixed/text-search | 0.389ms | 4.78ms | 2.64ms | 1.08ms | js |
| mixed/fibonacci | 0.122ms | 0.283ms | 0.283ms | 0.286ms | js |
| mixed/matrix-multiply | 0.157ms | 70.98ms | 69.52ms | 0.717ms | js |
| mixed/sieve | 1.55ms | 2.11ms | 2.10ms | FAILED | js |

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
| string/concat-short | 10000 | 3.48 | 4.68 | 4.61 | — |
| string/concat-long | 1000 | 3.59 | 4.56 | 3.64 | — |
| string/indexOf | 1000 | 19.15 | 63.74 | 12.25 | 14.60 |
| string/includes | 1000 | 19.20 | 126.81 | 14.52 | 15.59 |
| string/split | 10000 | 42.40 | 820.77 | 284.81 | — |
| string/replace | 1000 | 104.08 | 701.26 | 316.38 | — |
| string/case-convert | 2000 | 27.72 | 283.44 | 124.56 | — |
| string/substring | 10000 | 9.85 | 3.75 | 3.07 | — |
| string/trim | 10000 | 16.99 | 369.88 | 262.69 | — |
| string/startsWith-endsWith | 20000 | 20.00 | 136.65 | 140.73 | 28.02 |
| array/map-filter | 30000 | 4.18 | 2.32 | 2.31 | — |
| array/indexOf | 1000 | 3948.36 | 2641.88 | 2641.49 | — |
| dom/create-elements | 2000 | 16.98 | 77.62 | — | — |
| dom/set-attributes | 6000 | 17.27 | 36.28 | — | — |
| dom/read-attributes | 3000 | 19.21 | 40.33 | — | — |
| dom/modify-text | 2000 | 14.67 | 54.60 | — | — |
| mixed/csv-parse | 11000 | 44.75 | 784.83 | 53.97 | — |
| mixed/text-search | 40000 | 9.74 | 119.62 | 65.99 | 26.92 |
| mixed/fibonacci | 10000 | 12.17 | 28.31 | 28.31 | 28.57 |
| mixed/matrix-multiply | 125000 | 1.26 | 567.83 | 556.17 | 5.74 |
| mixed/sieve | 200000 | 7.77 | 10.54 | 10.52 | — |

## Speedup vs JS baseline

| Benchmark | Host-call | GC-native | Linear |
|-----------|-----------|-----------|--------|
| string/concat-short | 1.34x slower | 1.32x slower | — |
| string/concat-long | 1.27x slower | 1.01x slower | — |
| string/indexOf | 3.33x slower | 1.56x faster | 1.31x faster |
| string/includes | 6.60x slower | 1.32x faster | 1.23x faster |
| string/split | 19.36x slower | 6.72x slower | — |
| string/replace | 6.74x slower | 3.04x slower | — |
| string/case-convert | 10.22x slower | 4.49x slower | — |
| string/substring | 2.63x faster | 3.21x faster | — |
| string/trim | 21.77x slower | 15.46x slower | — |
| string/startsWith-endsWith | 6.83x slower | 7.04x slower | 1.40x slower |
| array/push-pop | 2.72x faster | 2.75x faster | — |
| array/sort-i32 | 2.69x faster | 2.69x faster | — |
| array/map-filter | 1.80x faster | 1.81x faster | — |
| array/reduce | 4.27x faster | 4.25x faster | — |
| array/indexOf | 1.49x faster | 1.49x faster | — |
| array/slice | 1.12x slower | 1.10x slower | — |
| array/reverse | 2.22x faster | 2.22x faster | — |
| array/forEach | 3.12x faster | 3.11x faster | — |
| array/find | 16.26x faster | 16.22x faster | 4.24x slower |
| dom/create-elements | 4.57x slower | — | — |
| dom/set-attributes | 2.10x slower | — | — |
| dom/read-attributes | 2.10x slower | — | — |
| dom/modify-text | 3.72x slower | — | — |
| mixed/csv-parse | 17.54x slower | 1.21x slower | — |
| mixed/text-search | 12.29x slower | 6.78x slower | 2.77x slower |
| mixed/fibonacci | 2.33x slower | 2.33x slower | 2.35x slower |
| mixed/matrix-multiply | 451.08x slower | 441.82x slower | 4.56x slower |
| mixed/sieve | 1.36x slower | 1.35x slower | — |

## GC-native vs Host-call

| Benchmark | Speedup |
|-----------|---------|
| string/concat-short | 1.02x faster |
| string/concat-long | 1.25x faster |
| string/indexOf | 5.20x faster |
| string/includes | 8.73x faster |
| string/split | 2.88x faster |
| string/replace | 2.22x faster |
| string/case-convert | 2.28x faster |
| string/substring | 1.22x faster |
| string/trim | 1.41x faster |
| string/startsWith-endsWith | 1.03x slower |
| array/push-pop | 1.01x faster |
| array/sort-i32 | 1.00x slower |
| array/map-filter | 1.01x faster |
| array/reduce | 1.00x slower |
| array/indexOf | 1.00x faster |
| array/slice | 1.01x faster |
| array/reverse | 1.00x slower |
| array/forEach | 1.00x slower |
| array/find | 1.00x slower |
| mixed/csv-parse | 14.54x faster |
| mixed/text-search | 1.81x faster |
| mixed/fibonacci | 1.00x faster |
| mixed/matrix-multiply | 1.02x faster |
| mixed/sieve | 1.00x faster |

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
| string/concat-short | 1130.5ms | 633.4ms | — |
| string/concat-long | 440.3ms | 672.9ms | — |
| string/indexOf | 380.8ms | 670.4ms | 560.2ms |
| string/includes | 383.2ms | 653.6ms | 546.7ms |
| string/split | 494.4ms | 676.1ms | — |
| string/replace | 493.7ms | 751.8ms | — |
| string/case-convert | 498.8ms | 596.0ms | — |
| string/substring | 400.4ms | 474.3ms | — |
| string/trim | 485.0ms | 693.0ms | — |
| string/startsWith-endsWith | 487.9ms | 685.3ms | 599.4ms |
| array/push-pop | 491.8ms | 554.4ms | — |
| array/sort-i32 | 643.7ms | 694.4ms | — |
| array/map-filter | 641.4ms | 728.3ms | — |
| array/reduce | 583.0ms | 690.9ms | — |
| array/indexOf | 564.2ms | 663.6ms | — |
| array/slice | 497.6ms | 568.8ms | — |
| array/reverse | 494.0ms | 551.6ms | — |
| array/forEach | 617.5ms | 683.9ms | — |
| array/find | 491.5ms | 561.8ms | 544.2ms |
| dom/create-elements | 416.1ms | — | — |
| dom/set-attributes | 406.8ms | — | — |
| dom/read-attributes | 434.0ms | — | — |
| dom/modify-text | 386.0ms | — | — |
| mixed/csv-parse | 499.5ms | 680.2ms | — |
| mixed/text-search | 492.3ms | 688.9ms | 629.4ms |
| mixed/fibonacci | 476.8ms | 495.8ms | 478.6ms |
| mixed/matrix-multiply | 610.7ms | 701.3ms | 527.6ms |
| mixed/sieve | 570.8ms | 656.7ms | — |
