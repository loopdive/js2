# js2wasm Benchmark Results

Date: 2026-10-06
Node: v25.7.0
Platform: linux x64

## Summary

| Benchmark | JS | Host-call | GC-native | Linear | Winner |
|-----------|-----|-----------|-----------|--------|--------|
| string/concat-short | 0.038ms | 0.047ms | 0.048ms | FAILED | js |
| string/concat-long | 0.004ms | 0.005ms | 0.004ms | FAILED | js |
| string/indexOf | 0.019ms | 0.064ms | 0.012ms | 0.015ms | gc-native |
| string/includes | 0.019ms | 0.141ms | 0.015ms | 0.015ms | gc-native |
| string/split | 0.424ms | 8.85ms | 2.85ms | FAILED | js |
| string/replace | 0.108ms | 0.694ms | 0.331ms | FAILED | js |
| string/case-convert | 0.056ms | 0.637ms | 0.264ms | FAILED | js |
| string/substring | 0.099ms | 0.037ms | 0.031ms | FAILED | gc-native |
| string/trim | 0.171ms | 4.06ms | 2.76ms | FAILED | js |
| string/startsWith-endsWith | 0.401ms | 2.78ms | 2.97ms | 0.560ms | js |
| array/push-pop | 1.50ms | 0.519ms | 0.532ms | FAILED | host-call |
| array/sort-i32 | 0.795ms | 0.297ms | 0.295ms | FAILED | gc-native |
| array/map-filter | 0.135ms | 0.074ms | 0.073ms | FAILED | gc-native |
| array/reduce | 2.22ms | 0.523ms | 0.520ms | FAILED | gc-native |
| array/indexOf | 3.95ms | 2.65ms | 2.64ms | FAILED | gc-native |
| array/slice | 0.029ms | 0.031ms | 0.032ms | FAILED | js |
| array/reverse | 7.83ms | 3.53ms | 3.52ms | FAILED | gc-native |
| array/forEach | 0.050ms | 0.028ms | 0.028ms | FAILED | gc-native |
| array/find | 0.256ms | 0.016ms | 0.016ms | 1.08ms | host-call |
| dom/create-elements | 0.038ms | 0.095ms | — | — | js |
| dom/set-attributes | 0.107ms | 0.226ms | — | — | js |
| dom/read-attributes | 0.057ms | 0.123ms | — | — | js |
| dom/modify-text | 0.032ms | 0.109ms | — | — | js |
| mixed/csv-parse | 0.494ms | 8.86ms | 0.644ms | FAILED | js |
| mixed/text-search | 0.391ms | 5.16ms | 2.84ms | 1.08ms | js |
| mixed/fibonacci | 0.120ms | 0.283ms | 0.283ms | 0.281ms | js |
| mixed/matrix-multiply | 0.161ms | 77.11ms | 78.29ms | 0.719ms | js |
| mixed/sieve | 1.61ms | 2.13ms | 2.14ms | FAILED | js |

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
| string/concat-short | 10000 | 3.75 | 4.73 | 4.76 | — |
| string/concat-long | 1000 | 3.68 | 4.67 | 4.21 | — |
| string/indexOf | 1000 | 19.25 | 63.83 | 12.33 | 14.63 |
| string/includes | 1000 | 19.28 | 140.61 | 14.74 | 15.43 |
| string/split | 10000 | 42.37 | 884.57 | 284.82 | — |
| string/replace | 1000 | 108.36 | 694.39 | 331.13 | — |
| string/case-convert | 2000 | 27.82 | 318.37 | 132.16 | — |
| string/substring | 10000 | 9.93 | 3.74 | 3.07 | — |
| string/trim | 10000 | 17.05 | 406.09 | 276.18 | — |
| string/startsWith-endsWith | 20000 | 20.06 | 138.82 | 148.48 | 28.02 |
| array/map-filter | 30000 | 4.50 | 2.46 | 2.43 | — |
| array/indexOf | 1000 | 3954.75 | 2650.82 | 2644.08 | — |
| dom/create-elements | 2000 | 19.23 | 47.31 | — | — |
| dom/set-attributes | 6000 | 17.85 | 37.65 | — | — |
| dom/read-attributes | 3000 | 19.11 | 41.00 | — | — |
| dom/modify-text | 2000 | 16.11 | 54.28 | — | — |
| mixed/csv-parse | 11000 | 44.87 | 805.58 | 58.50 | — |
| mixed/text-search | 40000 | 9.77 | 129.09 | 71.10 | 27.05 |
| mixed/fibonacci | 10000 | 12.03 | 28.30 | 28.32 | 28.11 |
| mixed/matrix-multiply | 125000 | 1.28 | 616.89 | 626.33 | 5.75 |
| mixed/sieve | 200000 | 8.06 | 10.66 | 10.71 | — |

## Speedup vs JS baseline

| Benchmark | Host-call | GC-native | Linear |
|-----------|-----------|-----------|--------|
| string/concat-short | 1.26x slower | 1.27x slower | — |
| string/concat-long | 1.27x slower | 1.14x slower | — |
| string/indexOf | 3.32x slower | 1.56x faster | 1.32x faster |
| string/includes | 7.29x slower | 1.31x faster | 1.25x faster |
| string/split | 20.88x slower | 6.72x slower | — |
| string/replace | 6.41x slower | 3.06x slower | — |
| string/case-convert | 11.45x slower | 4.75x slower | — |
| string/substring | 2.66x faster | 3.23x faster | — |
| string/trim | 23.82x slower | 16.20x slower | — |
| string/startsWith-endsWith | 6.92x slower | 7.40x slower | 1.40x slower |
| array/push-pop | 2.88x faster | 2.81x faster | — |
| array/sort-i32 | 2.68x faster | 2.69x faster | — |
| array/map-filter | 1.83x faster | 1.85x faster | — |
| array/reduce | 4.26x faster | 4.28x faster | — |
| array/indexOf | 1.49x faster | 1.50x faster | — |
| array/slice | 1.09x slower | 1.11x slower | — |
| array/reverse | 2.22x faster | 2.22x faster | — |
| array/forEach | 1.77x faster | 1.77x faster | — |
| array/find | 15.76x faster | 15.70x faster | 4.21x slower |
| dom/create-elements | 2.46x slower | — | — |
| dom/set-attributes | 2.11x slower | — | — |
| dom/read-attributes | 2.15x slower | — | — |
| dom/modify-text | 3.37x slower | — | — |
| mixed/csv-parse | 17.95x slower | 1.30x slower | — |
| mixed/text-search | 13.21x slower | 7.28x slower | 2.77x slower |
| mixed/fibonacci | 2.35x slower | 2.36x slower | 2.34x slower |
| mixed/matrix-multiply | 480.34x slower | 487.70x slower | 4.48x slower |
| mixed/sieve | 1.32x slower | 1.33x slower | — |

## GC-native vs Host-call

| Benchmark | Speedup |
|-----------|---------|
| string/concat-short | 1.00x slower |
| string/concat-long | 1.11x faster |
| string/indexOf | 5.18x faster |
| string/includes | 9.54x faster |
| string/split | 3.11x faster |
| string/replace | 2.10x faster |
| string/case-convert | 2.41x faster |
| string/substring | 1.22x faster |
| string/trim | 1.47x faster |
| string/startsWith-endsWith | 1.07x slower |
| array/push-pop | 1.03x slower |
| array/sort-i32 | 1.01x faster |
| array/map-filter | 1.01x faster |
| array/reduce | 1.00x faster |
| array/indexOf | 1.00x faster |
| array/slice | 1.02x slower |
| array/reverse | 1.00x faster |
| array/forEach | 1.00x faster |
| array/find | 1.00x slower |
| mixed/csv-parse | 13.77x faster |
| mixed/text-search | 1.82x faster |
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
| string/concat-short | 1194.3ms | 617.9ms | — |
| string/concat-long | 446.2ms | 672.1ms | — |
| string/indexOf | 380.6ms | 685.0ms | 565.1ms |
| string/includes | 386.2ms | 698.2ms | 556.3ms |
| string/split | 513.6ms | 711.9ms | — |
| string/replace | 532.9ms | 748.7ms | — |
| string/case-convert | 617.0ms | 616.6ms | — |
| string/substring | 397.6ms | 489.8ms | — |
| string/trim | 511.3ms | 688.7ms | — |
| string/startsWith-endsWith | 515.6ms | 724.4ms | 645.7ms |
| array/push-pop | 521.0ms | 627.7ms | — |
| array/sort-i32 | 684.6ms | 728.5ms | — |
| array/map-filter | 687.5ms | 762.5ms | — |
| array/reduce | 630.5ms | 710.5ms | — |
| array/indexOf | 598.6ms | 663.5ms | — |
| array/slice | 521.4ms | 621.6ms | — |
| array/reverse | 502.7ms | 590.2ms | — |
| array/forEach | 648.3ms | 729.9ms | — |
| array/find | 489.6ms | 596.4ms | 543.2ms |
| dom/create-elements | 414.7ms | — | — |
| dom/set-attributes | 379.1ms | — | — |
| dom/read-attributes | 379.7ms | — | — |
| dom/modify-text | 387.8ms | — | — |
| mixed/csv-parse | 513.9ms | 696.5ms | — |
| mixed/text-search | 497.5ms | 706.2ms | 628.9ms |
| mixed/fibonacci | 462.7ms | 505.8ms | 470.2ms |
| mixed/matrix-multiply | 650.4ms | 693.3ms | 531.9ms |
| mixed/sieve | 610.9ms | 697.2ms | — |
