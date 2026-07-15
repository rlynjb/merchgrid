import Decimal from "decimal.js";
import type { Money } from "@merchgrid/catalog-core";

export function lt(a: Money, b: Money): boolean {
  return new Decimal(a).lt(new Decimal(b));
}

export function lte(a: Money, b: Money): boolean {
  return new Decimal(a).lte(new Decimal(b));
}

export function eq(a: Money, b: Money): boolean {
  return new Decimal(a).eq(new Decimal(b));
}

export function gt(a: Money, b: Money): boolean {
  return new Decimal(a).gt(new Decimal(b));
}

export function sub(a: Money, b: Money): string {
  return new Decimal(a).minus(new Decimal(b)).toString();
}

export function mul(a: Money, b: Money): string {
  return new Decimal(a).times(new Decimal(b)).toString();
}

export function median(values: Money[]): string {
  const sorted = [...values].map((v) => new Decimal(v)).sort((a, b) => a.comparedTo(b));
  const mid = Math.floor(sorted.length / 2);

  if (sorted.length % 2 === 1) {
    return sorted[mid]!.toString();
  }

  return sorted[mid - 1]!.plus(sorted[mid]!).dividedBy(2).toString();
}

export function marginAmount(price: Money, cost: Money): string {
  return new Decimal(price).minus(new Decimal(cost)).toString();
}

export function formatMoney(value: Money, decimalPlaces = 2): string {
  return new Decimal(value).toFixed(decimalPlaces, Decimal.ROUND_HALF_UP);
}

export function marginPercent(price: Money, cost: Money | null): number | null {
  if (cost === null) return null;

  const priceDecimal = new Decimal(price);
  if (priceDecimal.lte(0)) return null;

  const costDecimal = new Decimal(cost);
  return priceDecimal.minus(costDecimal).dividedBy(priceDecimal).times(100).toNumber();
}
