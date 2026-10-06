# js2wasm Benchmark Results

Date: 2026-10-06
Node: v25.7.0
Platform: linux x64

## Summary

| Benchmark | JS | Host-call | GC-native | Linear | Winner |
|-----------|-----|-----------|-----------|--------|--------|
| string/concat-short | 0.032ms | 0.048ms | 0.045ms | FAILED | js |
| string/concat-long | 0.004ms | 0.005ms | 0.004ms | FAILED | js |
| string/indexOf | 0.019ms | 0.065ms | 0.012ms | 0.022ms | gc-native |
| string/includes | 0.019ms | 0.136ms | 0.014ms | 0.018ms | gc-native |
| string/split | 0.424ms | 8.43ms | 2.97ms | FAILED | js |
| string/replace | 0.105ms | 0.695ms | 0.316ms | FAILED | js |
| string/case-convert | 0.056ms | 0.562ms | 0.262ms | FAILED | js |
| string/substring | 0.099ms | 0.037ms | 0.031ms | FAILED | gc-native |
| string/trim | 0.170ms | 3.93ms | 2.71ms | FAILED | js |
| string/startsWith-endsWith | 0.402ms | 2.90ms | 3.01ms | 0.561ms | js |
| array/push-pop | 1.43ms | 0.512ms | 0.503ms | FAILED | gc-native |
| array/sort-i32 | 0.792ms | 0.293ms | 0.293ms | FAILED | gc-native |
| array/map-filter | 0.127ms | 0.070ms | 0.071ms | FAILED | host-call |
| array/reduce | 2.17ms | 0.509ms | 0.511ms | FAILED | host-call |
| array/indexOf | 3.95ms | 2.65ms | 2.64ms | FAILED | gc-native |
| array/slice | 0.026ms | 0.028ms | 0.028ms | FAILED | js |
| array/reverse | 7.83ms | 3.52ms | 3.52ms | FAILED | host-call |
| array/forEach | 0.051ms | 0.028ms | 0.028ms | FAILED | gc-native |
| array/find | 0.254ms | 0.016ms | 0.016ms | 1.08ms | gc-native |
| dom/create-elements | 0.036ms | 0.163ms | — | — | js |
| dom/set-attributes | 0.104ms | 0.216ms | — | — | js |
| dom/read-attributes | 0.057ms | 0.127ms | — | — | js |
| dom/modify-text | 0.030ms | 0.112ms | — | — | js |
| mixed/csv-parse | 0.483ms | 9.66ms | 0.641ms | FAILED | js |
| mixed/text-search | 0.390ms | 5.15ms | 2.91ms | 1.11ms | js |
| mixed/fibonacci | 0.122ms | 0.283ms | 0.283ms | 0.288ms | js |
| mixed/matrix-multiply | 0.158ms | 73.14ms | 78.49ms | 0.719ms | js |
| mixed/sieve | 1.57ms | 2.12ms | 2.13ms | FAILED | js |

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
| string/concat-short | 10000 | 3.23 | 4.76 | 4.47 | — |
| string/concat-long | 1000 | 3.57 | 4.55 | 3.73 | — |
| string/indexOf | 1000 | 19.20 | 64.64 | 12.06 | 22.41 |
| string/includes | 1000 | 19.22 | 136.42 | 14.43 | 18.17 |
| string/split | 10000 | 42.37 | 843.13 | 296.68 | — |
| string/replace | 1000 | 105.34 | 695.06 | 316.08 | — |
| string/case-convert | 2000 | 27.97 | 280.99 | 131.15 | — |
| string/substring | 10000 | 9.93 | 3.74 | 3.07 | — |
| string/trim | 10000 | 17.02 | 392.58 | 270.53 | — |
| string/startsWith-endsWith | 20000 | 20.08 | 144.77 | 150.26 | 28.04 |
| array/map-filter | 30000 | 4.24 | 2.35 | 2.36 | — |
| array/indexOf | 1000 | 3953.78 | 2648.89 | 2642.55 | — |
| dom/create-elements | 2000 | 17.80 | 81.74 | — | — |
| dom/set-attributes | 6000 | 17.32 | 35.99 | — | — |
| dom/read-attributes | 3000 | 18.97 | 42.49 | — | — |
| dom/modify-text | 2000 | 14.83 | 55.87 | — | — |
| mixed/csv-parse | 11000 | 43.90 | 878.17 | 58.26 | — |
| mixed/text-search | 40000 | 9.75 | 128.81 | 72.74 | 27.76 |
| mixed/fibonacci | 10000 | 12.19 | 28.31 | 28.30 | 28.81 |
| mixed/matrix-multiply | 125000 | 1.27 | 585.09 | 627.90 | 5.75 |
| mixed/sieve | 200000 | 7.86 | 10.59 | 10.64 | — |

## Speedup vs JS baseline

| Benchmark | Host-call | GC-native | Linear |
|-----------|-----------|-----------|--------|
| string/concat-short | 1.47x slower | 1.38x slower | — |
| string/concat-long | 1.27x slower | 1.05x slower | — |
| string/indexOf | 3.37x slower | 1.59x faster | 1.17x slower |
| string/includes | 7.10x slower | 1.33x faster | 1.06x faster |
| string/split | 19.90x slower | 7.00x slower | — |
| string/replace | 6.60x slower | 3.00x slower | — |
| string/case-convert | 10.05x slower | 4.69x slower | — |
| string/substring | 2.66x faster | 3.23x faster | — |
| string/trim | 23.07x slower | 15.90x slower | — |
| string/startsWith-endsWith | 7.21x slower | 7.48x slower | 1.40x slower |
| array/push-pop | 2.80x faster | 2.85x faster | — |
| array/sort-i32 | 2.70x faster | 2.70x faster | — |
| array/map-filter | 1.81x faster | 1.80x faster | — |
| array/reduce | 4.26x faster | 4.24x faster | — |
| array/indexOf | 1.49x faster | 1.50x faster | — |
| array/slice | 1.09x slower | 1.11x slower | — |
| array/reverse | 2.22x faster | 2.22x faster | — |
| array/forEach | 1.82x faster | 1.83x faster | — |
| array/find | 15.74x faster | 15.86x faster | 4.24x slower |
| dom/create-elements | 4.59x slower | — | — |
| dom/set-attributes | 2.08x slower | — | — |
| dom/read-attributes | 2.24x slower | — | — |
| dom/modify-text | 3.77x slower | — | — |
| mixed/csv-parse | 20.01x slower | 1.33x slower | — |
| mixed/text-search | 13.21x slower | 7.46x slower | 2.85x slower |
| mixed/fibonacci | 2.32x slower | 2.32x slower | 2.36x slower |
| mixed/matrix-multiply | 461.52x slower | 495.29x slower | 4.54x slower |
| mixed/sieve | 1.35x slower | 1.35x slower | — |

## GC-native vs Host-call

| Benchmark | Speedup |
|-----------|---------|
| string/concat-short | 1.07x faster |
| string/concat-long | 1.22x faster |
| string/indexOf | 5.36x faster |
| string/includes | 9.46x faster |
| string/split | 2.84x faster |
| string/replace | 2.20x faster |
| string/case-convert | 2.14x faster |
| string/substring | 1.22x faster |
| string/trim | 1.45x faster |
| string/startsWith-endsWith | 1.04x slower |
| array/push-pop | 1.02x faster |
| array/sort-i32 | 1.00x faster |
| array/map-filter | 1.00x slower |
| array/reduce | 1.00x slower |
| array/indexOf | 1.00x faster |
| array/slice | 1.02x slower |
| array/reverse | 1.00x slower |
| array/forEach | 1.01x faster |
| array/find | 1.01x faster |
| mixed/csv-parse | 15.07x faster |
| mixed/text-search | 1.77x faster |
| mixed/fibonacci | 1.00x faster |
| mixed/matrix-multiply | 1.07x slower |
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
| string/concat-short | 1145.0ms | 615.2ms | — |
| string/concat-long | 429.4ms | 642.7ms | — |
| string/indexOf | 373.1ms | 653.3ms | 601.5ms |
| string/includes | 369.3ms | 674.1ms | 551.3ms |
| string/split | 514.3ms | 677.5ms | — |
| string/replace | 530.1ms | 759.3ms | — |
| string/case-convert | 512.8ms | 691.7ms | — |
| string/substring | 389.6ms | 499.1ms | — |
| string/trim | 498.4ms | 701.3ms | — |
| string/startsWith-endsWith | 477.8ms | 726.1ms | 620.4ms |
| array/push-pop | 507.8ms | 589.1ms | — |
| array/sort-i32 | 657.0ms | 763.5ms | — |
| array/map-filter | 688.2ms | 760.6ms | — |
| array/reduce | 613.1ms | 686.1ms | — |
| array/indexOf | 590.3ms | 670.8ms | — |
| array/slice | 511.3ms | 619.9ms | — |
| array/reverse | 508.2ms | 588.9ms | — |
| array/forEach | 671.9ms | 710.8ms | — |
| array/find | 503.9ms | 582.1ms | 551.8ms |
| dom/create-elements | 424.0ms | — | — |
| dom/set-attributes | 380.1ms | — | — |
| dom/read-attributes | 403.4ms | — | — |
| dom/modify-text | 374.2ms | — | — |
| mixed/csv-parse | 527.9ms | 684.7ms | — |
| mixed/text-search | 501.0ms | 685.3ms | 600.2ms |
| mixed/fibonacci | 466.8ms | 483.3ms | 467.8ms |
| mixed/matrix-multiply | 623.8ms | 694.7ms | 536.2ms |
| mixed/sieve | 614.2ms | 684.1ms | — |
