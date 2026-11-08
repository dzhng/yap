import { CompositionError } from "./errors.js";
import type { TimeValue, SignedTimeValue, Fraction } from "./schema.js";
export type Rational = Readonly<{ numerator: bigint; denominator: bigint }>;

export function rational(numerator: bigint, denominator = 1n): Rational {
  if (denominator <= 0n) throw new RangeError("Expected positive denominator");
  let a = numerator < 0n ? -numerator : numerator;
  let b = denominator;
  while (b) [a, b] = [b, a % b];
  return Object.freeze({ numerator: numerator / a, denominator: denominator / a });
}
export function add(a: Rational, b: Rational): Rational {
  return rational(
    a.numerator * b.denominator + b.numerator * a.denominator,
    a.denominator * b.denominator,
  );
}
export function subtract(a: Rational, b: Rational): Rational {
  return rational(
    a.numerator * b.denominator - b.numerator * a.denominator,
    a.denominator * b.denominator,
  );
}
export function multiply(a: Rational, b: Rational): Rational {
  return rational(a.numerator * b.numerator, a.denominator * b.denominator);
}
export function divide(a: Rational, b: Rational): Rational {
  if (b.numerator <= 0n) throw new RangeError("Expected positive divisor");
  return rational(a.numerator * b.denominator, a.denominator * b.numerator);
}
export function compare(a: Rational, b: Rational): number {
  const delta = a.numerator * b.denominator - b.numerator * a.denominator;
  return delta < 0n ? -1 : delta > 0n ? 1 : 0;
}
export function floor(value: Rational): number {
  const quotient = value.numerator / value.denominator;
  return Number(
    value.numerator < 0n && value.numerator % value.denominator ? quotient - 1n : quotient,
  );
}
export function ceil(value: Rational): number {
  return Number(
    value.numerator / value.denominator +
      (value.numerator > 0n && value.numerator % value.denominator ? 1n : 0n),
  );
}

export function fromTime(value: SignedTimeValue): Rational {
  return typeof value === "number"
    ? rational(BigInt(value))
    : rational(BigInt(value.numerator), BigInt(value.denominator));
}

/** A time as plain microseconds, for readers that compare, sort and add rather than keep it exact. */
export function timeUs(value: SignedTimeValue): number {
  return typeof value === "number" ? value : value.numerator / value.denominator;
}

function serializedFraction(value: Rational, signed: boolean): Fraction {
  if (
    value.numerator < (signed ? BigInt(Number.MIN_SAFE_INTEGER) : 0n) ||
    value.numerator > BigInt(Number.MAX_SAFE_INTEGER) ||
    value.denominator > BigInt(Number.MAX_SAFE_INTEGER)
  )
    throw new CompositionError("INVALID_EDIT", "Exact time exceeds serializable precision");
  return { numerator: Number(value.numerator), denominator: Number(value.denominator) };
}
export function toFraction(value: Rational): Fraction {
  return serializedFraction(value, false);
}
export function toTime(value: Rational): TimeValue {
  const result = toFraction(value);
  return result.denominator === 1 ? result.numerator : result;
}

export function toSignedTime(value: Rational): SignedTimeValue {
  const result = serializedFraction(value, true);
  return result.denominator === 1 ? result.numerator : result;
}

/** Observation labels use nearest microsecond, with half values away from zero. */
export function round(value: Rational): number {
  const magnitude = value.numerator < 0n ? -value.numerator : value.numerator;
  const whole =
    magnitude / value.denominator +
    (2n * (magnitude % value.denominator) >= value.denominator ? 1n : 0n);
  if (whole > BigInt(Number.MAX_SAFE_INTEGER))
    throw new CompositionError("INVALID_TIME", "Observed time exceeds safe-integer precision");
  return Number(value.numerator < 0n ? -whole : whole);
}
