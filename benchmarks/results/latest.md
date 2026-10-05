# js2wasm Benchmark Results

Date: 2026-10-04
Node: v25.7.0
Platform: linux x64

## Summary

| Benchmark | JS | Host-call | GC-native | Linear | Winner |
|-----------|-----|-----------|-----------|--------|--------|
| string/concat-short | 0.030ms | 0.052ms | 0.046ms | FAILED | js |
| string/concat-long | 0.004ms | 0.005ms | 0.003ms | FAILED | gc-native |
| string/indexOf | 0.019ms | 0.060ms | 0.012ms | 0.016ms | gc-native |
| string/includes | 0.019ms | 0.128ms | 0.014ms | 0.017ms | gc-native |
| string/split | 0.422ms | 7.84ms | 2.62ms | FAILED | js |
| string/replace | 0.097ms | 0.607ms | 0.286ms | FAILED | js |
| string/case-convert | 0.058ms | 0.541ms | 0.243ms | FAILED | js |
| string/substring | 0.106ms | 0.040ms | 0.034ms | FAILED | gc-native |
| string/trim | 0.173ms | 3.42ms | 2.41ms | FAILED | js |
| string/startsWith-endsWith | 0.413ms | 2.54ms | 2.52ms | 0.560ms | js |
| array/push-pop | 1.68ms | 0.604ms | 0.602ms | FAILED | gc-native |
| array/sort-i32 | 0.841ms | 0.294ms | 0.301ms | FAILED | host-call |
| array/map-filter | 0.134ms | 0.065ms | 0.066ms | FAILED | host-call |
| array/reduce | 2.40ms | 0.608ms | 0.609ms | FAILED | host-call |
| array/indexOf | 4.46ms | 2.87ms | 2.87ms | FAILED | gc-native |
| array/slice | 0.034ms | 0.018ms | 0.018ms | FAILED | gc-native |
| array/reverse | 8.84ms | 3.97ms | 3.97ms | FAILED | gc-native |
| array/forEach | 0.052ms | 0.029ms | 0.029ms | FAILED | host-call |
| array/find | 0.272ms | 0.015ms | 0.015ms | 1.20ms | gc-native |
| dom/create-elements | 0.038ms | 0.156ms | — | — | js |
| dom/set-attributes | 0.108ms | 0.242ms | — | — | js |
| dom/read-attributes | 0.059ms | 0.133ms | — | — | js |
| dom/modify-text | 0.029ms | 0.113ms | — | — | js |
| mixed/csv-parse | 0.467ms | 8.46ms | 0.541ms | FAILED | js |
| mixed/text-search | 0.403ms | 4.33ms | 2.46ms | 1.10ms | js |
| mixed/fibonacci | 0.125ms | 0.327ms | 0.327ms | 0.326ms | js |
| mixed/matrix-multiply | 0.184ms | 67.71ms | 66.09ms | 0.724ms | js |
| mixed/sieve | 1.77ms | 2.31ms | 2.32ms | FAILED | js |

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
| string/concat-short | 10000 | 3.00 | 5.15 | 4.60 | — |
| string/concat-long | 1000 | 4.32 | 5.02 | 3.46 | — |
| string/indexOf | 1000 | 18.93 | 60.11 | 12.22 | 16.33 |
| string/includes | 1000 | 18.64 | 128.04 | 13.76 | 16.65 |
| string/split | 10000 | 42.15 | 783.78 | 262.38 | — |
| string/replace | 1000 | 96.81 | 607.37 | 286.15 | — |
| string/case-convert | 2000 | 29.02 | 270.59 | 121.40 | — |
| string/substring | 10000 | 10.55 | 3.99 | 3.44 | — |
| string/trim | 10000 | 17.33 | 342.48 | 241.26 | — |
| string/startsWith-endsWith | 20000 | 20.66 | 127.15 | 126.25 | 28.00 |
| array/map-filter | 30000 | 4.47 | 2.18 | 2.18 | — |
| array/indexOf | 1000 | 4456.53 | 2870.33 | 2868.53 | — |
| dom/create-elements | 2000 | 19.17 | 78.15 | — | — |
| dom/set-attributes | 6000 | 18.02 | 40.27 | — | — |
| dom/read-attributes | 3000 | 19.50 | 44.48 | — | — |
| dom/modify-text | 2000 | 14.55 | 56.28 | — | — |
| mixed/csv-parse | 11000 | 42.43 | 769.05 | 49.16 | — |
| mixed/text-search | 40000 | 10.07 | 108.28 | 61.55 | 27.60 |
| mixed/fibonacci | 10000 | 12.53 | 32.73 | 32.74 | 32.65 |
| mixed/matrix-multiply | 125000 | 1.47 | 541.66 | 528.70 | 5.79 |
| mixed/sieve | 200000 | 8.86 | 11.54 | 11.62 | — |

## Speedup vs JS baseline

| Benchmark | Host-call | GC-native | Linear |
|-----------|-----------|-----------|--------|
| string/concat-short | 1.72x slower | 1.53x slower | — |
| string/concat-long | 1.16x slower | 1.25x faster | — |
| string/indexOf | 3.17x slower | 1.55x faster | 1.16x faster |
| string/includes | 6.87x slower | 1.35x faster | 1.12x faster |
| string/split | 18.59x slower | 6.22x slower | — |
| string/replace | 6.27x slower | 2.96x slower | — |
| string/case-convert | 9.33x slower | 4.18x slower | — |
| string/substring | 2.65x faster | 3.07x faster | — |
| string/trim | 19.76x slower | 13.92x slower | — |
| string/startsWith-endsWith | 6.16x slower | 6.11x slower | 1.36x slower |
| array/push-pop | 2.78x faster | 2.78x faster | — |
| array/sort-i32 | 2.86x faster | 2.79x faster | — |
| array/map-filter | 2.05x faster | 2.05x faster | — |
| array/reduce | 3.94x faster | 3.94x faster | — |
| array/indexOf | 1.55x faster | 1.55x faster | — |
| array/slice | 1.90x faster | 1.92x faster | — |
| array/reverse | 2.23x faster | 2.23x faster | — |
| array/forEach | 1.82x faster | 1.82x faster | — |
| array/find | 18.37x faster | 18.59x faster | 4.43x slower |
| dom/create-elements | 4.08x slower | — | — |
| dom/set-attributes | 2.23x slower | — | — |
| dom/read-attributes | 2.28x slower | — | — |
| dom/modify-text | 3.87x slower | — | — |
| mixed/csv-parse | 18.12x slower | 1.16x slower | — |
| mixed/text-search | 10.76x slower | 6.11x slower | 2.74x slower |
| mixed/fibonacci | 2.61x slower | 2.61x slower | 2.61x slower |
| mixed/matrix-multiply | 367.58x slower | 358.79x slower | 3.93x slower |
| mixed/sieve | 1.30x slower | 1.31x slower | — |

## GC-native vs Host-call

| Benchmark | Speedup |
|-----------|---------|
| string/concat-short | 1.12x faster |
| string/concat-long | 1.45x faster |
| string/indexOf | 4.92x faster |
| string/includes | 9.30x faster |
| string/split | 2.99x faster |
| string/replace | 2.12x faster |
| string/case-convert | 2.23x faster |
| string/substring | 1.16x faster |
| string/trim | 1.42x faster |
| string/startsWith-endsWith | 1.01x faster |
| array/push-pop | 1.00x faster |
| array/sort-i32 | 1.02x slower |
| array/map-filter | 1.00x slower |
| array/reduce | 1.00x slower |
| array/indexOf | 1.00x faster |
| array/slice | 1.01x faster |
| array/reverse | 1.00x faster |
| array/forEach | 1.00x slower |
| array/find | 1.01x faster |
| mixed/csv-parse | 15.64x faster |
| mixed/text-search | 1.76x faster |
| mixed/fibonacci | 1.00x slower |
| mixed/matrix-multiply | 1.02x faster |
| mixed/sieve | 1.01x slower |

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
| string/concat-short | 1117.3ms | 574.1ms | — |
| string/concat-long | 435.0ms | 624.4ms | — |
| string/indexOf | 369.1ms | 627.2ms | 545.8ms |
| string/includes | 392.1ms | 649.1ms | 536.1ms |
| string/split | 515.4ms | 663.0ms | — |
| string/replace | 482.8ms | 699.1ms | — |
| string/case-convert | 510.3ms | 614.3ms | — |
| string/substring | 396.9ms | 469.6ms | — |
| string/trim | 486.7ms | 655.4ms | — |
| string/startsWith-endsWith | 479.9ms | 691.9ms | 585.6ms |
| array/push-pop | 495.1ms | 570.8ms | — |
| array/sort-i32 | 654.7ms | 711.2ms | — |
| array/map-filter | 678.8ms | 744.3ms | — |
| array/reduce | 585.3ms | 663.9ms | — |
| array/indexOf | 564.0ms | 634.0ms | — |
| array/slice | 507.6ms | 600.5ms | — |
| array/reverse | 479.3ms | 558.9ms | — |
| array/forEach | 654.8ms | 667.4ms | — |
| array/find | 480.0ms | 562.1ms | 535.5ms |
| dom/create-elements | 411.0ms | — | — |
| dom/set-attributes | 377.8ms | — | — |
| dom/read-attributes | 375.0ms | — | — |
| dom/modify-text | 390.8ms | — | — |
| mixed/csv-parse | 507.9ms | 665.2ms | — |
| mixed/text-search | 493.9ms | 667.4ms | 597.1ms |
| mixed/fibonacci | 448.5ms | 460.3ms | 465.2ms |
| mixed/matrix-multiply | 618.8ms | 676.4ms | 506.0ms |
| mixed/sieve | 581.2ms | 671.1ms | — |
