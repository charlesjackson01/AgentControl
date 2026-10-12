---
name: unit-conversion
description: Convert supported measurements and check dimensional consistency using local unit conversion. Use for supplied lengths, masses, volumes, or temperatures.
tools: convert_units, calculate
---

# Unit Conversion

Convert supplied measurements with `convert_units`, preserving the source value and stating the destination unit.

## Workflow

1. Identify the value, source unit, and desired unit. Clarify ambiguous labels rather than guessing a regional or scientific convention.
2. Call `convert_units` once per measurement. Use supported unit identifiers from its description or error feedback.
3. For totals or averages, first convert all values to a common unit, then use `calculate` on the returned numeric values.
4. Report the original measurement, converted result, and any rounding. Keep enough precision for the user's purpose.

## Example

User: “Convert 5 km to meters.”

Call `convert_units` with `{"value":5,"from":"km","to":"m"}` and report the returned result as 5,000 m.

## Limits

Only the built-in unit catalog is supported. Currency exchange, live rates, and conversions requiring material density or other missing physical data are unavailable. Do not convert between incompatible dimensions. An absolute temperature and a temperature difference are different quantities; do not apply an absolute-temperature offset to a difference.
