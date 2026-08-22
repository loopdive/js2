# js2wasm Benchmark Results

Date: 2026-08-22
Node: v25.7.0
Platform: linux x64

## Summary

| Benchmark | JS | Host-call | GC-native | Linear | Winner |
|-----------|-----|-----------|-----------|--------|--------|
| string/concat-short | 0.039ms | 0.048ms | 0.050ms | FAILED | js |
| string/concat-long | 0.003ms | 0.004ms | 0.005ms | FAILED | js |
| string/indexOf | 0.014ms | 0.056ms | 0.010ms | 0.029ms | gc-native |
| string/includes | 0.014ms | 0.082ms | 0.012ms | 0.012ms | gc-native |
| string/split | 0.301ms | 3.59ms | 0.349ms | FAILED | js |
| string/replace | 0.085ms | 0.208ms | 0.043ms | FAILED | gc-native |
| string/case-convert | 0.043ms | 0.158ms | 0.004ms | FAILED | gc-native |
| string/substring | 0.091ms | 0.032ms | 0.027ms | FAILED | gc-native |
| string/trim | 0.127ms | 0.629ms | 0.141ms | FAILED | js |
| string/startsWith-endsWith | 0.405ms | 0.285ms | 0.222ms | 0.472ms | gc-native |
| array/push-pop | 1.20ms | 0.392ms | 0.392ms | FAILED | gc-native |
| array/sort-i32 | 0.554ms | 0.286ms | 0.286ms | FAILED | gc-native |
| array/map-filter | 0.113ms | 0.065ms | 0.068ms | FAILED | host-call |
| array/reduce | 1.80ms | 0.371ms | 0.382ms | FAILED | host-call |
| array/indexOf | 4.49ms | 2.23ms | 2.22ms | FAILED | gc-native |
| array/slice | 0.017ms | 0.017ms | 0.021ms | FAILED | js |
| array/reverse | 7.05ms | 3.17ms | 3.17ms | FAILED | gc-native |
| array/forEach | 0.070ms | 0.019ms | 0.022ms | FAILED | host-call |
| array/find | 0.247ms | 0.012ms | 0.015ms | 0.824ms | host-call |
| dom/create-elements | 0.035ms | 0.138ms | — | — | js |
| dom/set-attributes | 0.101ms | 0.420ms | — | — | js |
| dom/read-attributes | 0.045ms | 0.091ms | — | — | js |
| dom/modify-text | 0.030ms | 0.078ms | — | — | js |
| mixed/csv-parse | 0.875ms | 5.11ms | 0.265ms | FAILED | gc-native |
| mixed/text-search | 0.367ms | 1.06ms | 0.219ms | 0.992ms | gc-native |
| mixed/fibonacci | 0.114ms | 0.179ms | 0.179ms | 0.178ms | js |
| mixed/matrix-multiply | 0.162ms | 0.191ms | 0.191ms | 0.597ms | js |
| mixed/sieve | 1.41ms | 1.37ms | 1.36ms | FAILED | gc-native |

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
| string/concat-short | 10000 | 3.91 | 4.80 | 4.98 | — |
| string/concat-long | 1000 | 3.41 | 4.08 | 4.54 | — |
| string/indexOf | 1000 | 13.97 | 55.73 | 9.67 | 29.37 |
| string/includes | 1000 | 13.80 | 82.04 | 11.96 | 12.14 |
| string/split | 10000 | 30.09 | 359.46 | 34.92 | — |
| string/replace | 1000 | 85.14 | 207.55 | 42.77 | — |
| string/case-convert | 2000 | 21.42 | 79.19 | 2.13 | — |
| string/substring | 10000 | 9.14 | 3.17 | 2.71 | — |
| string/trim | 10000 | 12.71 | 62.90 | 14.11 | — |
| string/startsWith-endsWith | 20000 | 20.24 | 14.25 | 11.08 | 23.62 |
| array/map-filter | 30000 | 3.77 | 2.18 | 2.26 | — |
| array/indexOf | 1000 | 4492.35 | 2225.31 | 2224.20 | — |
| dom/create-elements | 2000 | 17.36 | 68.75 | — | — |
| dom/set-attributes | 6000 | 16.90 | 69.99 | — | — |
| dom/read-attributes | 3000 | 14.88 | 30.31 | — | — |
| dom/modify-text | 2000 | 14.89 | 38.87 | — | — |
| mixed/csv-parse | 11000 | 79.56 | 464.16 | 24.08 | — |
| mixed/text-search | 40000 | 9.19 | 26.62 | 5.48 | 24.81 |
| mixed/fibonacci | 10000 | 11.38 | 17.90 | 17.89 | 17.83 |
| mixed/matrix-multiply | 125000 | 1.30 | 1.53 | 1.53 | 4.77 |
| mixed/sieve | 200000 | 7.06 | 6.85 | 6.82 | — |

## Speedup vs JS baseline

| Benchmark | Host-call | GC-native | Linear |
|-----------|-----------|-----------|--------|
| string/concat-short | 1.23x slower | 1.27x slower | — |
| string/concat-long | 1.20x slower | 1.33x slower | — |
| string/indexOf | 3.99x slower | 1.44x faster | 2.10x slower |
| string/includes | 5.94x slower | 1.15x faster | 1.14x faster |
| string/split | 11.95x slower | 1.16x slower | — |
| string/replace | 2.44x slower | 1.99x faster | — |
| string/case-convert | 3.70x slower | 10.05x faster | — |
| string/substring | 2.88x faster | 3.37x faster | — |
| string/trim | 4.95x slower | 1.11x slower | — |
| string/startsWith-endsWith | 1.42x faster | 1.83x faster | 1.17x slower |
| array/push-pop | 3.07x faster | 3.07x faster | — |
| array/sort-i32 | 1.94x faster | 1.94x faster | — |
| array/map-filter | 1.73x faster | 1.67x faster | — |
| array/reduce | 4.84x faster | 4.70x faster | — |
| array/indexOf | 2.02x faster | 2.02x faster | — |
| array/slice | 1.01x slower | 1.22x slower | — |
| array/reverse | 2.22x faster | 2.22x faster | — |
| array/forEach | 3.71x faster | 3.21x faster | — |
| array/find | 21.38x faster | 16.19x faster | 3.34x slower |
| dom/create-elements | 3.96x slower | — | — |
| dom/set-attributes | 4.14x slower | — | — |
| dom/read-attributes | 2.04x slower | — | — |
| dom/modify-text | 2.61x slower | — | — |
| mixed/csv-parse | 5.83x slower | 3.30x faster | — |
| mixed/text-search | 2.90x slower | 1.68x faster | 2.70x slower |
| mixed/fibonacci | 1.57x slower | 1.57x slower | 1.57x slower |
| mixed/matrix-multiply | 1.18x slower | 1.18x slower | 3.68x slower |
| mixed/sieve | 1.03x faster | 1.04x faster | — |

## GC-native vs Host-call

| Benchmark | Speedup |
|-----------|---------|
| string/concat-short | 1.04x slower |
| string/concat-long | 1.11x slower |
| string/indexOf | 5.77x faster |
| string/includes | 6.86x faster |
| string/split | 10.29x faster |
| string/replace | 4.85x faster |
| string/case-convert | 37.18x faster |
| string/substring | 1.17x faster |
| string/trim | 4.46x faster |
| string/startsWith-endsWith | 1.29x faster |
| array/push-pop | 1.00x faster |
| array/sort-i32 | 1.00x faster |
| array/map-filter | 1.04x slower |
| array/reduce | 1.03x slower |
| array/indexOf | 1.00x faster |
| array/slice | 1.21x slower |
| array/reverse | 1.00x faster |
| array/forEach | 1.16x slower |
| array/find | 1.32x slower |
| mixed/csv-parse | 19.27x faster |
| mixed/text-search | 4.86x faster |
| mixed/fibonacci | 1.00x faster |
| mixed/matrix-multiply | 1.00x faster |
| mixed/sieve | 1.00x faster |

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
| array/sort-i32 | 2.6KB | 3.1KB | — |
| array/map-filter | 3.3KB | 3.8KB | — |
| array/reduce | 2.3KB | 2.8KB | — |
| array/indexOf | 1.7KB | 2.0KB | — |
| array/slice | 1020B | 1.3KB | — |
| array/reverse | 998B | 1.3KB | — |
| array/forEach | 2.5KB | 3.1KB | — |
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
| string/concat-short | 1061.1ms | 900.9ms | — |
| string/concat-long | 515.9ms | 782.1ms | — |
| string/indexOf | 539.7ms | 776.0ms | 696.2ms |
| string/includes | 534.6ms | 807.7ms | 667.5ms |
| string/split | 640.8ms | 811.3ms | — |
| string/replace | 640.2ms | 838.0ms | — |
| string/case-convert | 645.9ms | 703.7ms | — |
| string/substring | 547.7ms | 600.6ms | — |
| string/trim | 622.5ms | 785.4ms | — |
| string/startsWith-endsWith | 636.7ms | 824.6ms | 749.8ms |
| array/push-pop | 650.0ms | 687.4ms | — |
| array/sort-i32 | 739.2ms | 814.9ms | — |
| array/map-filter | 775.5ms | 794.9ms | — |
| array/reduce | 721.8ms | 749.9ms | — |
| array/indexOf | 695.2ms | 744.4ms | — |
| array/slice | 635.2ms | 701.8ms | — |
| array/reverse | 638.1ms | 678.0ms | — |
| array/forEach | 718.4ms | 795.3ms | — |
| array/find | 623.3ms | 721.8ms | 693.0ms |
| dom/create-elements | 497.2ms | — | — |
| dom/set-attributes | 569.4ms | — | — |
| dom/read-attributes | 571.0ms | — | — |
| dom/modify-text | 493.3ms | — | — |
| mixed/csv-parse | 657.2ms | 794.9ms | — |
| mixed/text-search | 616.8ms | 809.6ms | 751.0ms |
| mixed/fibonacci | 606.5ms | 632.2ms | 643.1ms |
| mixed/matrix-multiply | 682.5ms | 743.5ms | 663.8ms |
| mixed/sieve | 705.3ms | 757.7ms | — |
