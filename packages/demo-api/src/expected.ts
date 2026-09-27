/**
 * Ground truth for the end-to-end suite, computed in plain JavaScript straight from the seed.
 *
 * The point is independence: the workbench reaches these numbers by introspecting the schema,
 * generating GraphQL, paginating, shredding JSON into DuckDB and running SQL. This file reaches
 * them with a for-loop. If the two agree, the whole pipeline is correct -- and because nothing is
 * hardcoded, the seed can evolve without invalidating the assertions.
 */
import { dataset, type Order } from './seed.ts';

const round2 = (n: number): number => Math.round(n * 100) / 100;

export interface CountryRevenueRow {
  country: string;
  orders: number;
  revenue: number;
  biggest: number;
}

/** Revenue by country over PAID orders, joining orders to users on the unmodelled userId. */
export function revenueByCountry(status: Order['status'] = 'PAID'): CountryRevenueRow[] {
  const byCountry = new Map<string, CountryRevenueRow>();
  for (const order of dataset.orders) {
    if (order.status !== status) continue;
    const user = dataset.usersById.get(order.userId);
    if (!user) continue;
    const row = byCountry.get(user.country) ?? { country: user.country, orders: 0, revenue: 0, biggest: 0 };
    row.orders += 1;
    row.revenue += order.total;
    row.biggest = Math.max(row.biggest, order.total);
    byCountry.set(user.country, row);
  }
  return [...byCountry.values()]
    .map((row) => ({ ...row, revenue: round2(row.revenue), biggest: round2(row.biggest) }))
    .sort((a, b) => b.revenue - a.revenue || a.country.localeCompare(b.country));
}

export interface CategoryQtyRow {
  category: string;
  units: number;
  gross: number;
}

/** Units and gross by category, which needs the order-items child table joined to products. */
export function unitsByCategory(status?: Order['status']): CategoryQtyRow[] {
  const byCategory = new Map<string, CategoryQtyRow>();
  for (const order of dataset.orders) {
    if (status && order.status !== status) continue;
    for (const item of order.items) {
      const product = dataset.productsById.get(item.productId);
      if (!product) continue;
      const row = byCategory.get(product.category) ?? { category: product.category, units: 0, gross: 0 };
      row.units += item.qty;
      row.gross += item.qty * item.unitPrice;
      byCategory.set(product.category, row);
    }
  }
  return [...byCategory.values()]
    .map((row) => ({ ...row, gross: round2(row.gross) }))
    .sort((a, b) => b.gross - a.gross || a.category.localeCompare(b.category));
}

/** Aggregates a SQL statement must reproduce exactly. */
export function orderTotals(status?: Order['status']) {
  const rows = status ? dataset.orders.filter((o) => o.status === status) : dataset.orders;
  const sum = rows.reduce((s, o) => s + o.total, 0);
  return {
    count: rows.length,
    sum: round2(sum),
    max: rows.length ? round2(Math.max(...rows.map((o) => o.total))) : null,
    min: rows.length ? round2(Math.min(...rows.map((o) => o.total))) : null,
    avg: rows.length ? round2(sum / rows.length) : null,
  };
}

/** Users matching filters the 'auto' pushdown profile can map onto arguments. */
export function userCount(filter: { country?: string; active?: boolean; role?: string }): number {
  return dataset.users.filter(
    (u) =>
      (filter.country === undefined || u.country === filter.country) &&
      (filter.active === undefined || u.active === filter.active) &&
      (filter.role === undefined || u.role === filter.role),
  ).length;
}

/** Null shapes the shredder must survive, asserted so the seed cannot drift into hiding them. */
export const nullProfile = {
  usersWithoutAddress: dataset.users.filter((u) => u.address === null).length,
  usersWithoutPostcode: dataset.users.filter((u) => u.address?.postcode === null).length,
  usersWithoutTags: dataset.users.filter((u) => u.tags.length === 0).length,
  usersWithoutLegacyName: dataset.users.filter((u) => u.legacyName === null).length,
  productsWithoutRating: dataset.products.filter((p) => p.rating === null).length,
  usersWithManager: dataset.users.filter((u) => u.managerId !== null).length,
};
