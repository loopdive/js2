# js2wasm Benchmark Results

Date: 2026-08-16
Node: v25.7.0
Platform: linux x64

## Summary

| Benchmark | JS | Host-call | GC-native | Linear | Winner |
|-----------|-----|-----------|-----------|--------|--------|
| string/concat-short | 0.041ms | 0.049ms | 0.054ms | FAILED | js |
| string/concat-long | 0.004ms | 0.004ms | 0.004ms | FAILED | js |
| string/indexOf | 0.014ms | 0.048ms | 0.010ms | 0.028ms | gc-native |
| string/includes | 0.014ms | 0.092ms | 0.013ms | 0.028ms | gc-native |
| string/split | 2.31ms | 3.76ms | 0.353ms | FAILED | gc-native |
| string/replace | 0.088ms | 0.204ms | 0.044ms | FAILED | gc-native |
| string/case-convert | 0.044ms | 0.154ms | 0.004ms | FAILED | gc-native |
| string/substring | 0.092ms | 0.033ms | 0.027ms | FAILED | gc-native |
| string/trim | 0.141ms | 0.631ms | 0.146ms | FAILED | js |
| string/startsWith-endsWith | 0.404ms | 0.286ms | 0.231ms | 0.479ms | gc-native |
| array/push-pop | 1.29ms | 0.491ms | 0.384ms | FAILED | gc-native |
| array/sort-i32 | 0.559ms | 0.312ms | 0.294ms | FAILED | gc-native |
| array/map-filter | 0.116ms | 0.067ms | 0.072ms | FAILED | host-call |
| array/reduce | 1.82ms | 0.442ms | 0.425ms | FAILED | gc-native |
| array/indexOf | 4.68ms | 2.29ms | 2.29ms | FAILED | gc-native |
| array/slice | 0.019ms | 0.034ms | 0.018ms | FAILED | gc-native |
| array/reverse | 7.27ms | 3.35ms | 3.36ms | FAILED | host-call |
| array/forEach | 0.055ms | 0.024ms | 0.023ms | FAILED | gc-native |
| array/find | 0.261ms | 0.016ms | 0.014ms | 0.914ms | gc-native |
| dom/create-elements | 0.042ms | 0.151ms | — | — | js |
| dom/set-attributes | 0.125ms | 0.458ms | — | — | js |
| dom/read-attributes | 0.050ms | 0.106ms | — | — | js |
| dom/modify-text | 0.043ms | 0.095ms | — | — | js |
| mixed/csv-parse | 0.762ms | 5.21ms | 0.269ms | FAILED | gc-native |
| mixed/text-search | 0.385ms | 1.10ms | 0.229ms | 1.00ms | gc-native |
| mixed/fibonacci | 0.117ms | 0.184ms | 0.188ms | 0.200ms | js |
| mixed/matrix-multiply | 0.165ms | 0.203ms | 0.212ms | 0.662ms | js |
| mixed/sieve | 1.50ms | 1.53ms | 1.51ms | FAILED | js |

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
| string/concat-short | 10000 | 4.11 | 4.86 | 5.43 | — |
| string/concat-long | 1000 | 3.88 | 4.01 | 4.24 | — |
| string/indexOf | 1000 | 14.35 | 47.87 | 10.34 | 27.94 |
| string/includes | 1000 | 14.11 | 91.89 | 12.82 | 27.69 |
| string/split | 10000 | 230.55 | 375.94 | 35.28 | — |
| string/replace | 1000 | 87.53 | 203.81 | 44.17 | — |
| string/case-convert | 2000 | 21.99 | 76.89 | 2.24 | — |
| string/substring | 10000 | 9.21 | 3.28 | 2.71 | — |
| string/trim | 10000 | 14.07 | 63.08 | 14.56 | — |
| string/startsWith-endsWith | 20000 | 20.22 | 14.32 | 11.57 | 23.94 |
| array/map-filter | 30000 | 3.87 | 2.24 | 2.41 | — |
| array/indexOf | 1000 | 4675.96 | 2289.32 | 2287.51 | — |
| dom/create-elements | 2000 | 20.95 | 75.62 | — | — |
| dom/set-attributes | 6000 | 20.79 | 76.40 | — | — |
| dom/read-attributes | 3000 | 16.62 | 35.25 | — | — |
| dom/modify-text | 2000 | 21.51 | 47.65 | — | — |
| mixed/csv-parse | 11000 | 69.28 | 473.18 | 24.46 | — |
| mixed/text-search | 40000 | 9.62 | 27.57 | 5.73 | 25.12 |
| mixed/fibonacci | 10000 | 11.68 | 18.39 | 18.75 | 20.01 |
| mixed/matrix-multiply | 125000 | 1.32 | 1.62 | 1.70 | 5.29 |
| mixed/sieve | 200000 | 7.48 | 7.64 | 7.56 | — |

## Speedup vs JS baseline

| Benchmark | Host-call | GC-native | Linear |
|-----------|-----------|-----------|--------|
| string/concat-short | 1.18x slower | 1.32x slower | — |
| string/concat-long | 1.03x slower | 1.09x slower | — |
| string/indexOf | 3.34x slower | 1.39x faster | 1.95x slower |
| string/includes | 6.51x slower | 1.10x faster | 1.96x slower |
| string/split | 1.63x slower | 6.53x faster | — |
| string/replace | 2.33x slower | 1.98x faster | — |
| string/case-convert | 3.50x slower | 9.80x faster | — |
| string/substring | 2.81x faster | 3.40x faster | — |
| string/trim | 4.48x slower | 1.03x slower | — |
| string/startsWith-endsWith | 1.41x faster | 1.75x faster | 1.18x slower |
| array/push-pop | 2.63x faster | 3.35x faster | — |
| array/sort-i32 | 1.79x faster | 1.90x faster | — |
| array/map-filter | 1.72x faster | 1.61x faster | — |
| array/reduce | 4.11x faster | 4.27x faster | — |
| array/indexOf | 2.04x faster | 2.04x faster | — |
| array/slice | 1.85x slower | 1.01x faster | — |
| array/reverse | 2.17x faster | 2.16x faster | — |
| array/forEach | 2.26x faster | 2.37x faster | — |
| array/find | 16.04x faster | 18.39x faster | 3.50x slower |
| dom/create-elements | 3.61x slower | — | — |
| dom/set-attributes | 3.68x slower | — | — |
| dom/read-attributes | 2.12x slower | — | — |
| dom/modify-text | 2.22x slower | — | — |
| mixed/csv-parse | 6.83x slower | 2.83x faster | — |
| mixed/text-search | 2.87x slower | 1.68x faster | 2.61x slower |
| mixed/fibonacci | 1.57x slower | 1.61x slower | 1.71x slower |
| mixed/matrix-multiply | 1.23x slower | 1.28x slower | 4.00x slower |
| mixed/sieve | 1.02x slower | 1.01x slower | — |

## GC-native vs Host-call

| Benchmark | Speedup |
|-----------|---------|
| string/concat-short | 1.12x slower |
| string/concat-long | 1.06x slower |
| string/indexOf | 4.63x faster |
| string/includes | 7.17x faster |
| string/split | 10.66x faster |
| string/replace | 4.61x faster |
| string/case-convert | 34.26x faster |
| string/substring | 1.21x faster |
| string/trim | 4.33x faster |
| string/startsWith-endsWith | 1.24x faster |
| array/push-pop | 1.28x faster |
| array/sort-i32 | 1.06x faster |
| array/map-filter | 1.07x slower |
| array/reduce | 1.04x faster |
| array/indexOf | 1.00x faster |
| array/slice | 1.87x faster |
| array/reverse | 1.00x slower |
| array/forEach | 1.05x faster |
| array/find | 1.15x faster |
| mixed/csv-parse | 19.35x faster |
| mixed/text-search | 4.82x faster |
| mixed/fibonacci | 1.02x slower |
| mixed/matrix-multiply | 1.04x slower |
| mixed/sieve | 1.01x faster |

## Binary sizes

| Benchmark | Host-call | GC-native | Linear |
|-----------|-----------|-----------|--------|
| string/concat-short | 197B | 731B | — |
| string/concat-long | 223B | 935B | — |
| string/indexOf | 254B | 1.1KB | 10.4KB |
| string/includes | 241B | 1.1KB | 10.4KB |
| string/split | 1.6KB | 3.1KB | — |
| string/replace | 1.6KB | 4.0KB | — |
| string/case-convert | 1.5KB | 2.2KB | — |
| string/substring | 202B | 279B | — |
| string/trim | 1.3KB | 2.7KB | — |
| string/startsWith-endsWith | 1.7KB | 3.6KB | 1.7KB |
| array/push-pop | 940B | 1.3KB | — |
| array/sort-i32 | 2.6KB | 2.9KB | — |
| array/map-filter | 3.3KB | 3.7KB | — |
| array/reduce | 2.3KB | 2.6KB | — |
| array/indexOf | 1.7KB | 2.0KB | — |
| array/slice | 1020B | 1.3KB | — |
| array/reverse | 998B | 1.3KB | — |
| array/forEach | 2.5KB | 2.9KB | — |
| array/find | 946B | 1.3KB | 635B |
| dom/create-elements | 271B | — | — |
| dom/set-attributes | 524B | — | — |
| dom/read-attributes | 389B | — | — |
| dom/modify-text | 264B | — | — |
| mixed/csv-parse | 2.3KB | 4.2KB | — |
| mixed/text-search | 1.9KB | 4.0KB | 1.9KB |
| mixed/fibonacci | 411B | 411B | 386B |
| mixed/matrix-multiply | 1.6KB | 2.0KB | 992B |
| mixed/sieve | 1.6KB | 2.0KB | — |

## Compile times

| Benchmark | Host-call | GC-native | Linear |
|-----------|-----------|-----------|--------|
| string/concat-short | 1098.3ms | 943.3ms | — |
| string/concat-long | 535.7ms | 784.2ms | — |
| string/indexOf | 566.2ms | 811.5ms | 695.1ms |
| string/includes | 544.5ms | 832.6ms | 721.3ms |
| string/split | 655.9ms | 805.8ms | — |
| string/replace | 639.8ms | 864.4ms | — |
| string/case-convert | 658.5ms | 703.5ms | — |
| string/substring | 547.9ms | 635.5ms | — |
| string/trim | 622.9ms | 785.7ms | — |
| string/startsWith-endsWith | 638.4ms | 825.9ms | 784.4ms |
| array/push-pop | 682.9ms | 722.7ms | — |
| array/sort-i32 | 758.6ms | 847.1ms | — |
| array/map-filter | 778.5ms | 841.4ms | — |
| array/reduce | 726.0ms | 819.3ms | — |
| array/indexOf | 733.9ms | 774.2ms | — |
| array/slice | 635.9ms | 764.0ms | — |
| array/reverse | 669.0ms | 719.9ms | — |
| array/forEach | 754.5ms | 890.7ms | — |
| array/find | 655.4ms | 754.2ms | 710.3ms |
| dom/create-elements | 550.6ms | — | — |
| dom/set-attributes | 623.8ms | — | — |
| dom/read-attributes | 579.5ms | — | — |
| dom/modify-text | 509.1ms | — | — |
| mixed/csv-parse | 680.5ms | 847.7ms | — |
| mixed/text-search | 642.6ms | 874.1ms | 797.3ms |
| mixed/fibonacci | 666.4ms | 719.6ms | 694.6ms |
| mixed/matrix-multiply | 740.1ms | 801.1ms | 725.5ms |
| mixed/sieve | 761.2ms | 852.6ms | — |
