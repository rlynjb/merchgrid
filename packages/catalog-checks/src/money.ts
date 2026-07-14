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

export function marginPercent(price: Money, cost: Money | null): number | null {
  if (cost === null) return null;

  const priceDecimal = new Decimal(price);
  if (priceDecimal.lte(0)) return null;

  const costDecimal = new Decimal(cost);
  return priceDecimal.minus(costDecimal).dividedBy(priceDecimal).times(100).toNumber();
}
