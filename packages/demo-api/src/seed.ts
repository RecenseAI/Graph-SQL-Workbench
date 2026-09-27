/**
 * Deterministic seed data. A tiny LCG replaces Math.random so every run of the demo API --
 * and therefore every end-to-end assertion about SUM and MAX -- produces identical numbers.
 */

function lcg(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    // Numerical Recipes constants; plenty for fixture data.
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 0x100000000;
  };
}

const rand = lcg(20260927);
const pick = <T>(items: readonly T[]): T => items[Math.floor(rand() * items.length)] as T;
const intBetween = (lo: number, hi: number): number => lo + Math.floor(rand() * (hi - lo + 1));
const money = (lo: number, hi: number): number => Math.round((lo + rand() * (hi - lo)) * 100) / 100;

export type Role = 'ADMIN' | 'CUSTOMER' | 'GUEST';
export type OrderStatus = 'PENDING' | 'PAID' | 'SHIPPED' | 'CANCELLED' | 'REFUNDED';

export interface Address {
  line1: string;
  city: string;
  country: string;
  postcode: string | null;
}

export interface User {
  __typename: 'User';
  id: string;
  email: string;
  name: string;
  role: Role;
  country: string;
  signedUpAt: string;
  lifetimeValue: number;
  active: boolean;
  address: Address | null;
  tags: string[];
  legacyName: string | null;
  managerId: string | null;
}

export interface OrderItem {
  __typename: 'OrderItem';
  sku: string;
  productId: string;
  qty: number;
  unitPrice: number;
}

export interface Order {
  __typename: 'Order';
  id: string;
  userId: string;
  status: OrderStatus;
  total: number;
  placedAt: string;
  currency: string;
  channel: string;
  items: OrderItem[];
}

export interface Product {
  __typename: 'Product';
  id: string;
  sku: string;
  title: string;
  category: string;
  price: number;
  stock: number;
  rating: number | null;
}

const COUNTRIES = ['US', 'GB', 'DE', 'FR', 'IN', 'JP', 'BR', 'CA', 'AU', 'NL'] as const;
const CITIES: Record<string, string> = {
  US: 'Austin', GB: 'Manchester', DE: 'Leipzig', FR: 'Lyon', IN: 'Pune',
  JP: 'Osaka', BR: 'Recife', CA: 'Calgary', AU: 'Perth', NL: 'Utrecht',
};
const CURRENCY: Record<string, string> = {
  US: 'USD', GB: 'GBP', DE: 'EUR', FR: 'EUR', IN: 'INR',
  JP: 'JPY', BR: 'BRL', CA: 'CAD', AU: 'AUD', NL: 'EUR',
};
const ROLES: Role[] = ['ADMIN', 'CUSTOMER', 'CUSTOMER', 'CUSTOMER', 'CUSTOMER', 'GUEST'];
const STATUSES: OrderStatus[] = ['PENDING', 'PAID', 'PAID', 'PAID', 'SHIPPED', 'SHIPPED', 'CANCELLED', 'REFUNDED'];
const CHANNELS = ['web', 'ios', 'android', 'partner', 'phone'] as const;
const CATEGORIES = ['Audio', 'Laptops', 'Displays', 'Keyboards', 'Storage', 'Cameras'] as const;
const TAG_POOL = ['beta', 'vip', 'newsletter', 'churn-risk', 'reseller', 'internal'] as const;
const FIRST = ['Ada', 'Grace', 'Alan', 'Katherine', 'Linus', 'Radia', 'Barbara', 'Edsger', 'Margaret', 'Dennis', 'Sophie', 'Tomas', 'Ines', 'Yuki', 'Omar', 'Priya'] as const;
const LAST = ['Lovelace', 'Hopper', 'Turing', 'Johnson', 'Torvalds', 'Perlman', 'Liskov', 'Dijkstra', 'Hamilton', 'Ritchie', 'Wilson', 'Novak', 'Duarte', 'Sato', 'Haddad', 'Nair'] as const;

/** Days-since-epoch helper so timestamps are stable regardless of when the demo runs. */
function isoAt(dayOffset: number, hour: number, minute: number): string {
  const base = Date.UTC(2024, 0, 1, hour, minute, 0);
  return new Date(base + dayOffset * 86_400_000).toISOString();
}

export interface Dataset {
  users: User[];
  orders: Order[];
  products: Product[];
  usersById: Map<string, User>;
  productsById: Map<string, Product>;
}

function build(): Dataset {
  const products: Product[] = [];
  for (let i = 0; i < 300; i += 1) {
    const category = pick(CATEGORIES);
    products.push({
      __typename: 'Product',
      id: `p-${String(i + 1).padStart(4, '0')}`,
      sku: `${category.slice(0, 3).toUpperCase()}-${String(1000 + i)}`,
      title: `${category} Model ${String.fromCharCode(65 + (i % 26))}${i}`,
      category,
      price: money(19, 2400),
      stock: intBetween(0, 500),
      // A deliberately nullable numeric so grid NULL rendering and AVG have something to chew on.
      rating: rand() < 0.12 ? null : Math.round((3 + rand() * 2) * 10) / 10,
    });
  }

  const users: User[] = [];
  for (let i = 0; i < 800; i += 1) {
    const country = pick(COUNTRIES);
    const first = pick(FIRST);
    const last = pick(LAST);
    const tagCount = intBetween(0, 3);
    const tags: string[] = [];
    for (let t = 0; t < tagCount; t += 1) {
      const tag = pick(TAG_POOL);
      if (!tags.includes(tag)) tags.push(tag);
    }
    users.push({
      __typename: 'User',
      id: `u-${String(i + 1).padStart(4, '0')}`,
      email: `${first.toLowerCase()}.${last.toLowerCase()}${i}@example.com`,
      name: `${first} ${last}`,
      role: pick(ROLES),
      country,
      signedUpAt: isoAt(intBetween(0, 700), intBetween(0, 23), intBetween(0, 59)),
      lifetimeValue: money(0, 18_000),
      active: rand() < 0.82,
      // Nullable nested object: some users have no address at all.
      address: rand() < 0.1 ? null : {
        line1: `${intBetween(1, 220)} ${pick(['Oak', 'Cedar', 'Kingsway', 'Rua Alegre', 'Hauptstrasse'])} St`,
        city: CITIES[country] ?? 'Unknown',
        country,
        postcode: rand() < 0.15 ? null : `${intBetween(10_000, 99_999)}`,
      },
      tags,
      legacyName: rand() < 0.3 ? `${first}_${last}`.toLowerCase() : null,
      managerId: null,
    });
  }
  // A shallow management chain, so cycle detection in the catalog builder has something real to stop on.
  for (let i = 20; i < users.length; i += 1) {
    const user = users[i] as User;
    if (rand() < 0.6) user.managerId = (users[i % 20] as User).id;
  }

  const orders: Order[] = [];
  for (let i = 0; i < 4000; i += 1) {
    const user = pick(users);
    const itemCount = intBetween(1, 4);
    const items: OrderItem[] = [];
    let total = 0;
    for (let k = 0; k < itemCount; k += 1) {
      const product = pick(products);
      const qty = intBetween(1, 5);
      const unitPrice = product.price;
      total += qty * unitPrice;
      items.push({ __typename: 'OrderItem', sku: product.sku, productId: product.id, qty, unitPrice });
    }
    orders.push({
      __typename: 'Order',
      id: `o-${String(i + 1).padStart(5, '0')}`,
      // The join key the schema deliberately does not expose as a relation.
      userId: user.id,
      status: pick(STATUSES),
      total: Math.round(total * 100) / 100,
      placedAt: isoAt(intBetween(0, 700), intBetween(0, 23), intBetween(0, 59)),
      currency: CURRENCY[user.country] ?? 'USD',
      channel: pick(CHANNELS),
      items,
    });
  }

  return {
    users,
    orders,
    products,
    usersById: new Map(users.map((u) => [u.id, u])),
    productsById: new Map(products.map((p) => [p.id, p])),
  };
}

export const dataset: Dataset = build();

export const datasetSummary = {
  users: dataset.users.length,
  orders: dataset.orders.length,
  products: dataset.products.length,
  orderItems: dataset.orders.reduce((sum, o) => sum + o.items.length, 0),
};
