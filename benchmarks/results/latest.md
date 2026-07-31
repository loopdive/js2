# js2wasm Benchmark Results

Date: 2026-07-31
Node: v25.7.0
Platform: linux x64

## Summary

| Benchmark | JS | Host-call | GC-native | Linear | Winner |
|-----------|-----|-----------|-----------|--------|--------|
| string/concat-short | 0.034ms | 0.053ms | 0.038ms | — | js |
| string/concat-long | 0.004ms | 0.005ms | 0.006ms | — | js |
| string/indexOf | 0.001ms | 0.427ms | 0.014ms | — | js |
| string/includes | 0.001ms | 0.435ms | 0.015ms | — | js |
| string/split | 0.275ms | 19.72ms | 0.903ms | — | js |
| string/replace | 0.033ms | 0.555ms | 0.101ms | — | js |
| string/case-convert | <0.001ms | 0.824ms | 3.86ms | — | js |
| string/substring | 0.003ms | 4.13ms | 0.026ms | — | js |
| string/trim | 0.141ms | 3.78ms | 0.528ms | — | js |
| string/startsWith-endsWith | 0.226ms | 8.69ms | 1.61ms | — | js |
| array/push-pop | 1.31ms | 1.30ms | 0.720ms | — | gc-native |
| array/sort-i32 | 0.547ms | 914.4ms | — | — | js |
| array/map-filter | 0.101ms | 0.533ms | 0.043ms | — | gc-native |
| array/reduce | 1.78ms | 1.45ms | 0.739ms | — | gc-native |
| array/indexOf | 4.54ms | 3.79ms | 2.34ms | — | gc-native |
| array/slice | 0.019ms | 0.021ms | 0.011ms | — | gc-native |
| array/reverse | 7.28ms | 3.29ms | 2.87ms | — | gc-native |
| array/forEach | 0.045ms | 0.047ms | 0.031ms | — | gc-native |
| array/find | 0.253ms | 0.436ms | — | — | js |
| dom/create-elements | 0.034ms | — | — | — | js |
| dom/set-attributes | 0.120ms | — | — | — | js |
| dom/read-attributes | 0.051ms | — | — | — | js |
| dom/modify-text | 0.076ms | — | — | — | js |
| mixed/csv-parse | 0.336ms | 28.33ms | 0.962ms | — | js |
| mixed/text-search | 0.221ms | 18.48ms | 1.42ms | — | js |
| mixed/fibonacci | 0.108ms | 0.126ms | 0.068ms | 0.128ms | gc-native |
| mixed/matrix-multiply | 0.166ms | 1.57ms | 0.169ms | 1.42ms | js |
| mixed/sieve | 1.41ms | 2.08ms | 1.16ms | — | gc-native |

## Speedup vs JS baseline

| Benchmark | Host-call | GC-native | Linear |
|-----------|-----------|-----------|--------|
| string/concat-short | 1.55x slower | 1.11x slower | — |
| string/concat-long | 1.45x slower | 1.65x slower | — |
| string/indexOf | 396.94x slower | 13.44x slower | — |
| string/includes | 349.38x slower | 11.79x slower | — |
| string/split | 71.77x slower | 3.29x slower | — |
| string/replace | 17.00x slower | 3.10x slower | — |
| string/case-convert | 2824.28x slower | 13248.57x slower | — |
| string/substring | 1469.83x slower | 9.44x slower | — |
| string/trim | 26.76x slower | 3.73x slower | — |
| string/startsWith-endsWith | 38.39x slower | 7.09x slower | — |
| array/push-pop | 1.01x faster | 1.82x faster | — |
| array/sort-i32 | 1672.89x slower | — | — |
| array/map-filter | 5.26x slower | 2.36x faster | — |
| array/reduce | 1.23x faster | 2.41x faster | — |
| array/indexOf | 1.20x faster | 1.94x faster | — |
| array/slice | 1.12x slower | 1.77x faster | — |
| array/reverse | 2.21x faster | 2.54x faster | — |
| array/forEach | 1.04x slower | 1.48x faster | — |
| array/find | 1.73x slower | — | — |
| dom/create-elements | — | — | — |
| dom/set-attributes | — | — | — |
| dom/read-attributes | — | — | — |
| dom/modify-text | — | — | — |
| mixed/csv-parse | 84.26x slower | 2.86x slower | — |
| mixed/text-search | 83.58x slower | 6.44x slower | — |
| mixed/fibonacci | 1.17x slower | 1.58x faster | 1.19x slower |
| mixed/matrix-multiply | 9.43x slower | 1.02x slower | 8.53x slower |
| mixed/sieve | 1.48x slower | 1.21x faster | — |

## GC-native vs Host-call

| Benchmark | Speedup |
|-----------|---------|
| string/concat-short | 1.40x faster |
| string/concat-long | 1.13x slower |
| string/indexOf | 29.53x faster |
| string/includes | 29.63x faster |
| string/split | 21.83x faster |
| string/replace | 5.48x faster |
| string/case-convert | 4.69x slower |
| string/substring | 155.71x faster |
| string/trim | 7.17x faster |
| string/startsWith-endsWith | 5.42x faster |
| array/push-pop | 1.80x faster |
| array/map-filter | 12.41x faster |
| array/reduce | 1.96x faster |
| array/indexOf | 1.62x faster |
| array/slice | 1.98x faster |
| array/reverse | 1.15x faster |
| array/forEach | 1.53x faster |
| mixed/csv-parse | 29.44x faster |
| mixed/text-search | 12.98x faster |
| mixed/fibonacci | 1.84x faster |
| mixed/matrix-multiply | 9.26x faster |
| mixed/sieve | 1.79x faster |

## Binary sizes

| Benchmark | Host-call | GC-native | Linear |
|-----------|-----------|-----------|--------|
| string/concat-short | 209B | 1.7KB | — |
| string/concat-long | 236B | 1.9KB | — |
| string/indexOf | 216B | 2.1KB | — |
| string/includes | 236B | 2.1KB | — |
| string/split | 973B | 1.7KB | — |
| string/replace | 289B | 2.5KB | — |
| string/case-convert | 249B | 11.5KB | — |
| string/substring | 239B | 1.3KB | — |
| string/trim | 205B | 1.8KB | — |
| string/startsWith-endsWith | 330B | 1.7KB | — |
| array/push-pop | 947B | 1.4KB | — |
| array/sort-i32 | 1.2KB | — | — |
| array/map-filter | 3.3KB | 3.3KB | — |
| array/reduce | 2.3KB | 2.8KB | — |
| array/indexOf | 1022B | 1.5KB | — |
| array/slice | 1.0KB | 1.5KB | — |
| array/reverse | 1.0KB | 1.5KB | — |
| array/forEach | 2.6KB | 3.1KB | — |
| array/find | 2.7KB | — | — |
| dom/create-elements | — | — | — |
| dom/set-attributes | — | — | — |
| dom/read-attributes | — | — | — |
| dom/modify-text | — | — | — |
| mixed/csv-parse | 1.4KB | 2.9KB | — |
| mixed/text-search | 600B | 2.2KB | — |
| mixed/fibonacci | 157B | 1.1KB | 173B |
| mixed/matrix-multiply | 1.3KB | 1.8KB | 950B |
| mixed/sieve | 1.5KB | 1.8KB | — |

## Compile times

| Benchmark | Host-call | GC-native | Linear |
|-----------|-----------|-----------|--------|
| string/concat-short | 1020.5ms | 964.4ms | — |
| string/concat-long | 520.7ms | 838.9ms | — |
| string/indexOf | 470.9ms | 868.5ms | — |
| string/includes | 463.6ms | 822.3ms | — |
| string/split | 600.4ms | 831.1ms | — |
| string/replace | 447.6ms | 840.0ms | — |
| string/case-convert | 462.6ms | 1054.7ms | — |
| string/substring | 446.6ms | 700.8ms | — |
| string/trim | 438.5ms | 793.1ms | — |
| string/startsWith-endsWith | 498.4ms | 808.4ms | — |
| array/push-pop | 638.2ms | 681.3ms | — |
| array/sort-i32 | 684.2ms | — | — |
| array/map-filter | 782.7ms | 809.4ms | — |
| array/reduce | 705.9ms | 801.2ms | — |
| array/indexOf | 621.7ms | 690.6ms | — |
| array/slice | 615.6ms | 721.1ms | — |
| array/reverse | 656.4ms | 677.8ms | — |
| array/forEach | 714.6ms | 801.1ms | — |
| array/find | 751.9ms | — | — |
| dom/create-elements | — | — | — |
| dom/set-attributes | — | — | — |
| dom/read-attributes | — | — | — |
| dom/modify-text | — | — | — |
| mixed/csv-parse | 641.0ms | 850.3ms | — |
| mixed/text-search | 549.1ms | 904.1ms | — |
| mixed/fibonacci | 552.7ms | 685.4ms | 551.2ms |
| mixed/matrix-multiply | 689.1ms | 728.5ms | 652.2ms |
| mixed/sieve | 670.5ms | 732.3ms | — |
