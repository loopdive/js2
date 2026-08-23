# js2wasm Benchmark Results

Date: 2026-08-22
Node: v25.7.0
Platform: linux x64

## Summary

| Benchmark | JS | Host-call | GC-native | Linear | Winner |
|-----------|-----|-----------|-----------|--------|--------|
| string/concat-short | 0.044ms | 0.042ms | 0.049ms | FAILED | host-call |
| string/concat-long | 0.004ms | 0.005ms | 0.005ms | FAILED | js |
| string/indexOf | 0.012ms | 0.036ms | 0.009ms | 0.009ms | gc-native |
| string/includes | 0.012ms | 0.087ms | 0.011ms | 0.010ms | linear-memory |
| string/split | 0.250ms | 2.80ms | 0.300ms | FAILED | js |
| string/replace | 0.061ms | 0.172ms | 0.048ms | FAILED | gc-native |
| string/case-convert | 0.040ms | 0.132ms | 0.005ms | FAILED | gc-native |
| string/substring | 0.122ms | 0.027ms | 0.023ms | FAILED | gc-native |
| string/trim | 0.219ms | 0.507ms | 0.122ms | FAILED | gc-native |
| string/startsWith-endsWith | 0.361ms | 0.258ms | 0.188ms | 0.393ms | gc-native |
| array/push-pop | 1.09ms | 0.343ms | 0.380ms | FAILED | host-call |
| array/sort-i32 | 0.460ms | 0.250ms | 0.247ms | FAILED | gc-native |
| array/map-filter | 0.111ms | 0.062ms | 0.066ms | FAILED | host-call |
| array/reduce | 1.67ms | 0.387ms | 0.394ms | FAILED | host-call |
| array/indexOf | 4.56ms | 2.18ms | 1.87ms | FAILED | gc-native |
| array/slice | 0.030ms | 0.029ms | 0.030ms | FAILED | host-call |
| array/reverse | 4.95ms | 2.72ms | 2.72ms | FAILED | host-call |
| array/forEach | 0.049ms | 0.020ms | 0.019ms | FAILED | gc-native |
| array/find | 0.218ms | 0.012ms | 0.015ms | 0.704ms | host-call |
| dom/create-elements | 0.049ms | 0.118ms | — | — | js |
| dom/set-attributes | 0.105ms | 0.334ms | — | — | js |
| dom/read-attributes | 0.056ms | 0.095ms | — | — | js |
| dom/modify-text | 0.046ms | 0.088ms | — | — | js |
| mixed/csv-parse | 0.299ms | 4.03ms | 0.213ms | FAILED | gc-native |
| mixed/text-search | 0.355ms | 0.861ms | 0.186ms | 0.812ms | gc-native |
| mixed/fibonacci | 0.097ms | 0.153ms | 0.153ms | 0.155ms | js |
| mixed/matrix-multiply | 0.143ms | 0.169ms | 0.180ms | 0.512ms | js |
| mixed/sieve | 1.29ms | 1.23ms | 1.22ms | FAILED | gc-native |

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
| string/concat-short | 10000 | 4.38 | 4.15 | 4.87 | — |
| string/concat-long | 1000 | 4.42 | 4.53 | 4.81 | — |
| string/indexOf | 1000 | 11.77 | 35.64 | 8.62 | 9.38 |
| string/includes | 1000 | 11.79 | 86.89 | 10.66 | 9.68 |
| string/split | 10000 | 24.97 | 280.37 | 29.99 | — |
| string/replace | 1000 | 60.73 | 171.97 | 47.81 | — |
| string/case-convert | 2000 | 20.17 | 65.80 | 2.26 | — |
| string/substring | 10000 | 12.23 | 2.73 | 2.30 | — |
| string/trim | 10000 | 21.88 | 50.74 | 12.18 | — |
| string/startsWith-endsWith | 20000 | 18.05 | 12.91 | 9.42 | 19.65 |
| array/map-filter | 30000 | 3.71 | 2.05 | 2.21 | — |
| array/indexOf | 1000 | 4556.27 | 2184.22 | 1872.99 | — |
| dom/create-elements | 2000 | 24.71 | 58.90 | — | — |
| dom/set-attributes | 6000 | 17.49 | 55.68 | — | — |
| dom/read-attributes | 3000 | 18.73 | 31.65 | — | — |
| dom/modify-text | 2000 | 23.11 | 44.13 | — | — |
| mixed/csv-parse | 11000 | 27.16 | 366.20 | 19.39 | — |
| mixed/text-search | 40000 | 8.87 | 21.53 | 4.66 | 20.30 |
| mixed/fibonacci | 10000 | 9.75 | 15.30 | 15.28 | 15.50 |
| mixed/matrix-multiply | 125000 | 1.14 | 1.35 | 1.44 | 4.09 |
| mixed/sieve | 200000 | 6.44 | 6.13 | 6.11 | — |

## Speedup vs JS baseline

| Benchmark | Host-call | GC-native | Linear |
|-----------|-----------|-----------|--------|
| string/concat-short | 1.06x faster | 1.11x slower | — |
| string/concat-long | 1.02x slower | 1.09x slower | — |
| string/indexOf | 3.03x slower | 1.37x faster | 1.25x faster |
| string/includes | 7.37x slower | 1.11x faster | 1.22x faster |
| string/split | 11.23x slower | 1.20x slower | — |
| string/replace | 2.83x slower | 1.27x faster | — |
| string/case-convert | 3.26x slower | 8.91x faster | — |
| string/substring | 4.47x faster | 5.32x faster | — |
| string/trim | 2.32x slower | 1.80x faster | — |
| string/startsWith-endsWith | 1.40x faster | 1.92x faster | 1.09x slower |
| array/push-pop | 3.19x faster | 2.88x faster | — |
| array/sort-i32 | 1.84x faster | 1.86x faster | — |
| array/map-filter | 1.81x faster | 1.68x faster | — |
| array/reduce | 4.31x faster | 4.24x faster | — |
| array/indexOf | 2.09x faster | 2.43x faster | — |
| array/slice | 1.03x faster | 1.01x faster | — |
| array/reverse | 1.82x faster | 1.82x faster | — |
| array/forEach | 2.39x faster | 2.51x faster | — |
| array/find | 18.14x faster | 14.98x faster | 3.23x slower |
| dom/create-elements | 2.38x slower | — | — |
| dom/set-attributes | 3.18x slower | — | — |
| dom/read-attributes | 1.69x slower | — | — |
| dom/modify-text | 1.91x slower | — | — |
| mixed/csv-parse | 13.48x slower | 1.40x faster | — |
| mixed/text-search | 2.43x slower | 1.90x faster | 2.29x slower |
| mixed/fibonacci | 1.57x slower | 1.57x slower | 1.59x slower |
| mixed/matrix-multiply | 1.19x slower | 1.26x slower | 3.58x slower |
| mixed/sieve | 1.05x faster | 1.05x faster | — |

## GC-native vs Host-call

| Benchmark | Speedup |
|-----------|---------|
| string/concat-short | 1.17x slower |
| string/concat-long | 1.06x slower |
| string/indexOf | 4.14x faster |
| string/includes | 8.15x faster |
| string/split | 9.35x faster |
| string/replace | 3.60x faster |
| string/case-convert | 29.08x faster |
| string/substring | 1.19x faster |
| string/trim | 4.17x faster |
| string/startsWith-endsWith | 1.37x faster |
| array/push-pop | 1.11x slower |
| array/sort-i32 | 1.01x faster |
| array/map-filter | 1.08x slower |
| array/reduce | 1.02x slower |
| array/indexOf | 1.17x faster |
| array/slice | 1.02x slower |
| array/reverse | 1.00x slower |
| array/forEach | 1.05x faster |
| array/find | 1.21x slower |
| mixed/csv-parse | 18.89x faster |
| mixed/text-search | 4.62x faster |
| mixed/fibonacci | 1.00x faster |
| mixed/matrix-multiply | 1.06x slower |
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
| mixed/matrix-multiply | 1.7KB | 2.1KB | 992B |
| mixed/sieve | 1.6KB | 2.0KB | — |

## Compile times

| Benchmark | Host-call | GC-native | Linear |
|-----------|-----------|-----------|--------|
| string/concat-short | 996.7ms | 758.2ms | — |
| string/concat-long | 464.6ms | 655.4ms | — |
| string/indexOf | 470.9ms | 672.3ms | 591.1ms |
| string/includes | 500.5ms | 679.7ms | 588.0ms |
| string/split | 546.3ms | 676.0ms | — |
| string/replace | 543.2ms | 752.9ms | — |
| string/case-convert | 548.7ms | 586.4ms | — |
| string/substring | 493.2ms | 538.7ms | — |
| string/trim | 520.9ms | 670.9ms | — |
| string/startsWith-endsWith | 545.2ms | 662.0ms | 628.5ms |
| array/push-pop | 532.6ms | 570.7ms | — |
| array/sort-i32 | 632.9ms | 714.1ms | — |
| array/map-filter | 659.8ms | 682.5ms | — |
| array/reduce | 613.6ms | 743.7ms | — |
| array/indexOf | 665.7ms | 672.1ms | — |
| array/slice | 533.0ms | 615.3ms | — |
| array/reverse | 538.6ms | 599.6ms | — |
| array/forEach | 607.1ms | 663.3ms | — |
| array/find | 540.2ms | 579.6ms | 603.2ms |
| dom/create-elements | 436.0ms | — | — |
| dom/set-attributes | 520.7ms | — | — |
| dom/read-attributes | 483.8ms | — | — |
| dom/modify-text | 426.2ms | — | — |
| mixed/csv-parse | 573.3ms | 647.7ms | — |
| mixed/text-search | 600.9ms | 677.1ms | 619.3ms |
| mixed/fibonacci | 532.8ms | 594.3ms | 546.6ms |
| mixed/matrix-multiply | 608.1ms | 634.1ms | 568.4ms |
| mixed/sieve | 584.3ms | 659.7ms | — |
