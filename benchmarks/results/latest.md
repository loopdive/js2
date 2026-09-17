# js2wasm Benchmark Results

Date: 2026-09-17
Node: v25.7.0
Platform: linux x64

## Summary

| Benchmark | JS | Host-call | GC-native | Linear | Winner |
|-----------|-----|-----------|-----------|--------|--------|
| string/concat-short | 0.054ms | 0.056ms | 0.066ms | FAILED | js |
| string/concat-long | 0.005ms | 0.006ms | 0.006ms | FAILED | js |
| string/indexOf | 0.017ms | 0.055ms | 0.011ms | 0.022ms | gc-native |
| string/includes | 0.016ms | 0.114ms | 0.014ms | 0.024ms | gc-native |
| string/split | 0.361ms | 7.06ms | 2.42ms | FAILED | js |
| string/replace | 0.099ms | 0.531ms | 0.289ms | FAILED | js |
| string/case-convert | 0.051ms | 0.485ms | 0.237ms | FAILED | js |
| string/substring | 0.106ms | 0.038ms | 0.032ms | FAILED | gc-native |
| string/trim | 0.165ms | 3.34ms | 2.47ms | FAILED | js |
| string/startsWith-endsWith | 0.478ms | 2.63ms | 2.74ms | 0.555ms | js |
| array/push-pop | 1.46ms | 0.493ms | 0.496ms | FAILED | host-call |
| array/sort-i32 | 0.651ms | 0.339ms | 0.402ms | FAILED | host-call |
| array/map-filter | 0.140ms | 0.083ms | 0.082ms | FAILED | gc-native |
| array/reduce | 2.10ms | 0.487ms | 0.489ms | FAILED | host-call |
| array/indexOf | 5.38ms | 2.66ms | 2.66ms | FAILED | gc-native |
| array/slice | 0.042ms | 0.037ms | 0.040ms | FAILED | host-call |
| array/reverse | 8.39ms | 3.80ms | 3.80ms | FAILED | host-call |
| array/forEach | 0.087ms | 0.026ms | 0.026ms | FAILED | gc-native |
| array/find | 0.293ms | 0.022ms | 0.018ms | 1.01ms | gc-native |
| dom/create-elements | 0.066ms | 0.099ms | — | — | js |
| dom/set-attributes | 0.135ms | 0.194ms | — | — | js |
| dom/read-attributes | 0.072ms | 0.117ms | — | — | js |
| dom/modify-text | 0.061ms | 0.103ms | — | — | js |
| mixed/csv-parse | 0.398ms | 7.08ms | 0.569ms | FAILED | js |
| mixed/text-search | 0.440ms | 4.03ms | 2.51ms | 1.18ms | js |
| mixed/fibonacci | 0.136ms | 0.217ms | 0.217ms | 0.216ms | js |
| mixed/matrix-multiply | 0.189ms | 60.71ms | 61.15ms | 0.725ms | js |
| mixed/sieve | 1.65ms | 2.46ms | 2.44ms | FAILED | js |

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
| string/concat-short | 10000 | 5.38 | 5.57 | 6.63 | — |
| string/concat-long | 1000 | 5.38 | 5.66 | 6.40 | — |
| string/indexOf | 1000 | 16.58 | 55.19 | 11.49 | 22.31 |
| string/includes | 1000 | 16.37 | 114.08 | 14.37 | 24.16 |
| string/split | 10000 | 36.06 | 706.16 | 242.13 | — |
| string/replace | 1000 | 99.03 | 531.13 | 289.39 | — |
| string/case-convert | 2000 | 25.61 | 242.29 | 118.49 | — |
| string/substring | 10000 | 10.63 | 3.79 | 3.24 | — |
| string/trim | 10000 | 16.48 | 333.50 | 247.32 | — |
| string/startsWith-endsWith | 20000 | 23.91 | 131.74 | 137.07 | 27.75 |
| array/map-filter | 30000 | 4.66 | 2.75 | 2.73 | — |
| array/indexOf | 1000 | 5384.84 | 2658.29 | 2657.21 | — |
| dom/create-elements | 2000 | 33.04 | 49.27 | — | — |
| dom/set-attributes | 6000 | 22.43 | 32.29 | — | — |
| dom/read-attributes | 3000 | 23.97 | 38.88 | — | — |
| dom/modify-text | 2000 | 30.72 | 51.36 | — | — |
| mixed/csv-parse | 11000 | 36.22 | 643.25 | 51.76 | — |
| mixed/text-search | 40000 | 11.00 | 100.73 | 62.76 | 29.42 |
| mixed/fibonacci | 10000 | 13.62 | 21.69 | 21.66 | 21.55 |
| mixed/matrix-multiply | 125000 | 1.51 | 485.68 | 489.22 | 5.80 |
| mixed/sieve | 200000 | 8.26 | 12.31 | 12.18 | — |

## Speedup vs JS baseline

| Benchmark | Host-call | GC-native | Linear |
|-----------|-----------|-----------|--------|
| string/concat-short | 1.03x slower | 1.23x slower | — |
| string/concat-long | 1.05x slower | 1.19x slower | — |
| string/indexOf | 3.33x slower | 1.44x faster | 1.35x slower |
| string/includes | 6.97x slower | 1.14x faster | 1.48x slower |
| string/split | 19.58x slower | 6.71x slower | — |
| string/replace | 5.36x slower | 2.92x slower | — |
| string/case-convert | 9.46x slower | 4.63x slower | — |
| string/substring | 2.81x faster | 3.28x faster | — |
| string/trim | 20.24x slower | 15.01x slower | — |
| string/startsWith-endsWith | 5.51x slower | 5.73x slower | 1.16x slower |
| array/push-pop | 2.97x faster | 2.95x faster | — |
| array/sort-i32 | 1.92x faster | 1.62x faster | — |
| array/map-filter | 1.69x faster | 1.71x faster | — |
| array/reduce | 4.32x faster | 4.30x faster | — |
| array/indexOf | 2.03x faster | 2.03x faster | — |
| array/slice | 1.14x faster | 1.06x faster | — |
| array/reverse | 2.21x faster | 2.20x faster | — |
| array/forEach | 3.41x faster | 3.42x faster | — |
| array/find | 13.47x faster | 16.11x faster | 3.44x slower |
| dom/create-elements | 1.49x slower | — | — |
| dom/set-attributes | 1.44x slower | — | — |
| dom/read-attributes | 1.62x slower | — | — |
| dom/modify-text | 1.67x slower | — | — |
| mixed/csv-parse | 17.76x slower | 1.43x slower | — |
| mixed/text-search | 9.16x slower | 5.71x slower | 2.67x slower |
| mixed/fibonacci | 1.59x slower | 1.59x slower | 1.58x slower |
| mixed/matrix-multiply | 320.99x slower | 323.33x slower | 3.84x slower |
| mixed/sieve | 1.49x slower | 1.47x slower | — |

## GC-native vs Host-call

| Benchmark | Speedup |
|-----------|---------|
| string/concat-short | 1.19x slower |
| string/concat-long | 1.13x slower |
| string/indexOf | 4.80x faster |
| string/includes | 7.94x faster |
| string/split | 2.92x faster |
| string/replace | 1.84x faster |
| string/case-convert | 2.04x faster |
| string/substring | 1.17x faster |
| string/trim | 1.35x faster |
| string/startsWith-endsWith | 1.04x slower |
| array/push-pop | 1.01x slower |
| array/sort-i32 | 1.19x slower |
| array/map-filter | 1.01x faster |
| array/reduce | 1.01x slower |
| array/indexOf | 1.00x faster |
| array/slice | 1.07x slower |
| array/reverse | 1.00x slower |
| array/forEach | 1.00x faster |
| array/find | 1.20x faster |
| mixed/csv-parse | 12.43x faster |
| mixed/text-search | 1.60x faster |
| mixed/fibonacci | 1.00x faster |
| mixed/matrix-multiply | 1.01x slower |
| mixed/sieve | 1.01x faster |

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
| string/concat-short | 1132.3ms | 603.9ms | — |
| string/concat-long | 441.6ms | 650.7ms | — |
| string/indexOf | 379.6ms | 669.4ms | 538.0ms |
| string/includes | 379.8ms | 672.4ms | 544.6ms |
| string/split | 501.4ms | 686.6ms | — |
| string/replace | 497.3ms | 734.1ms | — |
| string/case-convert | 514.2ms | 570.9ms | — |
| string/substring | 394.3ms | 463.5ms | — |
| string/trim | 482.1ms | 673.4ms | — |
| string/startsWith-endsWith | 477.7ms | 713.2ms | 621.7ms |
| array/push-pop | 495.2ms | 578.0ms | — |
| array/sort-i32 | 670.0ms | 726.4ms | — |
| array/map-filter | 684.4ms | 738.7ms | — |
| array/reduce | 578.0ms | 674.1ms | — |
| array/indexOf | 571.9ms | 673.0ms | — |
| array/slice | 497.3ms | 581.6ms | — |
| array/reverse | 484.3ms | 555.7ms | — |
| array/forEach | 595.6ms | 757.3ms | — |
| array/find | 504.4ms | 543.7ms | 539.5ms |
| dom/create-elements | 419.0ms | — | — |
| dom/set-attributes | 394.2ms | — | — |
| dom/read-attributes | 389.2ms | — | — |
| dom/modify-text | 388.3ms | — | — |
| mixed/csv-parse | 497.4ms | 672.9ms | — |
| mixed/text-search | 502.7ms | 687.7ms | 630.3ms |
| mixed/fibonacci | 474.4ms | 494.7ms | 494.6ms |
| mixed/matrix-multiply | 626.4ms | 705.9ms | 527.3ms |
| mixed/sieve | 571.1ms | 650.4ms | — |
