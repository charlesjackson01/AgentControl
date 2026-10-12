---
name: unit-conversion
description: Convert supported measurements and check dimensional consistency using local unit conversion. Use for supplied lengths, masses, volumes, temperatures, durations, data sizes, or speeds.
tools: convert_units, calculate
---

# Unit Conversion

Convert supplied measurements with `convert_units`, preserving the source value and stating the destination unit.

## Workflow

1. Identify the value, source unit, and desired unit. Clarify ambiguous labels rather than guessing a regional or scientific convention: US `gal` versus `imp gal`, bits (`Mbit`) versus bytes (`MB`), and decimal `GB` (1,000³ bytes) versus binary `GiB` (1,024³ bytes).
2. Call `convert_units` once per measurement. Use supported unit identifiers from its description or error feedback; the result names the unit it used, so check that it matches the intended one.
3. For totals, averages, or rates, first convert all values to a common unit, then use `calculate` on the returned numeric values.
4. Report the original measurement, converted result, and any rounding. Keep enough precision for the user's purpose.

## Example

User: “Convert 5 km to meters.”

Call `convert_units` with `{"value":5,"from":"km","to":"m"}` and report the returned result as 5,000 m.

User: “How long does a 2 GB download take at 100 Mbit/s?” Convert the size with `{"value":2,"from":"GB","to":"Mbit"}` (16,000), divide with `calculate` using `{"expression":"16000 / 100"}` (160 seconds), and convert that with `{"value":160,"from":"s","to":"min"}`.

## Limits

Only the built-in unit catalog is supported: length, mass, volume, temperature, time, data, and speed. Currency exchange, live rates, and conversions requiring material density or other missing physical data are unavailable. Do not convert between incompatible dimensions. A data rate such as Mbit/s is not a unit here: convert the size and divide by the rate. An absolute temperature and a temperature difference are different quantities; do not apply an absolute-temperature offset to a difference.
