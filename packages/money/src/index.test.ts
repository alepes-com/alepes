import { describe, it, expect } from "vitest";
import {
  cents,
  nonNegativeCents,
  fromDecimalString,
  centsFromDollarsFloat,
  toString,
  toCurrencyString,
  add,
  sub,
  neg,
  mulInt,
  mulByRatio,
  divideIntoParts,
  min,
  max,
  sum,
  ZERO,
  isZero,
  isNegative,
} from "../src/index";

describe("construction", () => {
  it("wraps integer cents", () => {
    expect(cents(2481216)).toBe(2481216);
  });
  it("rejects non-integers", () => {
    expect(() => cents(1.5)).toThrow(RangeError);
    expect(() => cents(0.1)).toThrow(RangeError);
  });
  it("rejects unsafe integers", () => {
    expect(() => cents(Number.MAX_SAFE_INTEGER + 1)).toThrow(RangeError);
  });
  it("nonNegativeCents rejects negatives", () => {
    expect(() => nonNegativeCents(-1)).toThrow(RangeError);
    expect(nonNegativeCents(0)).toBe(0);
  });
});

describe("fromDecimalString", () => {
  it("parses exact cents", () => {
    expect(fromDecimalString("24812.16")).toBe(2481216);
    expect(fromDecimalString("0.01")).toBe(1);
    expect(fromDecimalString("100")).toBe(10000);
    expect(fromDecimalString("-3.00")).toBe(-300);
    expect(fromDecimalString(".5")).toBe(50);
  });
  it("rejects malformed input", () => {
    expect(() => fromDecimalString("12.345")).toThrow(RangeError);
    expect(() => fromDecimalString("abc")).toThrow(RangeError);
    expect(() => fromDecimalString("")).toThrow(RangeError);
  });
});

describe("centsFromDollarsFloat", () => {
  it("rounds to nearest cent (and avoids 0.1 + 0.2 float error)", () => {
    expect(centsFromDollarsFloat(0.1 + 0.2)).toBe(30);
    expect(centsFromDollarsFloat(24812.16)).toBe(2481216);
  });
  it("rejects non-finite", () => {
    expect(() => centsFromDollarsFloat(Infinity)).toThrow(RangeError);
    expect(() => centsFromDollarsFloat(NaN)).toThrow(RangeError);
  });
});

describe("output", () => {
  it("toString emits plain decimals", () => {
    expect(toString(cents(2481216))).toBe("24812.16");
    expect(toString(cents(5))).toBe("0.05");
    expect(toString(cents(-300))).toBe("-3.00");
    expect(toString(ZERO)).toBe("0.00");
  });
  it("toCurrencyString formats USD", () => {
    expect(toCurrencyString(cents(2481216))).toBe("$24,812.16");
    expect(toCurrencyString(cents(-300))).toBe("-$3.00");
  });
});

describe("arithmetic — exactness invariants", () => {
  it("add/sub are exact", () => {
    expect(add(cents(10), cents(5))).toBe(15);
    expect(sub(cents(10), cents(15))).toBe(-5);
  });
  it("0.1+0.2-style float error cannot occur (integer cents)", () => {
    // 10.10 + 20.20 must be exactly 30.30 → 3030 cents
    const a = cents(1010);
    const b = cents(2020);
    expect(add(a, b)).toBe(3030);
  });
  it("mulInt is exact", () => {
    expect(mulInt(cents(3333), 3)).toBe(9999);
  });
  it("mulByRatio rounds deterministically (half away from zero)", () => {
    expect(mulByRatio(cents(100), 0.2)).toBe(20);
    // 20% of 281432 = 56286.4 → rounds to 56286
    expect(mulByRatio(cents(281432), 0.2)).toBe(56286);
  });
  it("multiplying large values stays exact and in safe range", () => {
    // $90M in cents is well within safe integer range
    expect(mulInt(cents(90_000_000_00), 2)).toBe(180_000_000_00);
  });
});

describe("divideIntoParts", () => {
  it("reconciles remainder exactly to front slices", () => {
    // 10 cents into 3 parts → 4,3,3 (remainder 1 goes to first)
    const parts = divideIntoParts(cents(10), 3);
    expect(parts).toEqual([4, 3, 3]);
    expect(sum(parts)).toBe(10);
  });
  it("divides exactly when clean", () => {
    const parts = divideIntoParts(cents(300), 3);
    expect(parts).toEqual([100, 100, 100]);
  });
  it("rejects zero parts", () => {
    expect(() => divideIntoParts(cents(10), 0)).toThrow(RangeError);
  });
});

describe("comparisons + helpers", () => {
  it("min/max/isZero/isNegative", () => {
    expect(min(cents(10), cents(5))).toBe(5);
    expect(max(cents(10), cents(5))).toBe(10);
    expect(isZero(ZERO)).toBe(true);
    expect(isZero(cents(1))).toBe(false);
    expect(isNegative(cents(-1))).toBe(true);
    expect(isNegative(ZERO)).toBe(false);
  });
  it("sum is exact", () => {
    expect(sum([cents(1), cents(2), cents(3)])).toBe(6);
  });
  it("neg flips sign", () => {
    expect(neg(cents(5))).toBe(-5);
    expect(neg(cents(-5))).toBe(5);
  });
});