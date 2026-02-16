import prisma from "../db.server";

const MAX_AGE_MS = 6 * 60 * 60 * 1000; // 6 hours
const MAX_ENTRIES_PER_TYPE = 1000;

/**
 * Check if the shop's taxonomy data is stale or missing.
 * @param {object} shopRecord - The Shop record from DB
 * @param {number} maxAgeMs - Max age in ms before considered stale
 * @returns {boolean}
 */
export function isTaxonomyStale(shopRecord, maxAgeMs = MAX_AGE_MS) {
  if (!shopRecord.taxonomySyncedAt) return true;
  return Date.now() - new Date(shopRecord.taxonomySyncedAt).getTime() > maxAgeMs;
}

/**
 * Parse stored JSON taxonomy strings into a structured object.
 * @param {object} shopRecord - The Shop record from DB
 * @returns {{ productTypes: string[], vendors: string[], tags: string[], priceRange: {min?:number, max?:number, currency?:string}, variantOptions: {name:string, values:string[]}[] }}
 */
export function parseTaxonomy(shopRecord) {
  try {
    return {
      productTypes: JSON.parse(shopRecord.productTypes || "[]"),
      vendors: JSON.parse(shopRecord.vendors || "[]"),
      tags: JSON.parse(shopRecord.tags || "[]"),
      priceRange: JSON.parse(shopRecord.priceRange || "{}"),
      variantOptions: JSON.parse(shopRecord.variantOptions || "[]"),
    };
  } catch (err) {
    console.error("[Taxonomy] Failed to parse taxonomy JSON:", err);
    return {
      productTypes: [],
      vendors: [],
      tags: [],
      priceRange: {},
      variantOptions: [],
    };
  }
}

/**
 * Fetch all pages of a paginated GraphQL list.
 * @param {object} admin - Shopify admin API client
 * @param {function} queryFn - Function(cursor) that returns { items, hasNextPage, endCursor }
 * @returns {Promise<string[]>}
 */
async function fetchAllPages(admin, queryFn) {
  const all = [];
  let cursor = null;
  let hasNext = true;

  while (hasNext && all.length < MAX_ENTRIES_PER_TYPE) {
    const result = await queryFn(cursor);
    all.push(...result.items);
    hasNext = result.hasNextPage;
    cursor = result.endCursor;
  }

  return all.slice(0, MAX_ENTRIES_PER_TYPE);
}

/**
 * Sync taxonomy data from Shopify Admin GraphQL API and persist to DB.
 * @param {object} admin - Shopify admin API client (from authenticate.admin or unauthenticated.admin)
 * @param {string} shopDomain - e.g. "myshop.myshopify.com"
 */
export async function syncTaxonomy(admin, shopDomain) {
  console.log(`[Taxonomy] Starting sync for ${shopDomain}`);
  const startTime = Date.now();

  try {
    // 1. Fetch product types (paginated)
    const productTypes = await fetchAllPages(admin, async (cursor) => {
      const afterClause = cursor ? `, after: "${cursor}"` : "";
      const response = await admin.graphql(`{
        productTypes(first: 250${afterClause}) {
          edges { node }
          pageInfo { hasNextPage endCursor }
        }
      }`);
      const data = await response.json();
      const connection = data.data.productTypes;
      return {
        items: connection.edges.map((e) => e.node).filter(Boolean),
        hasNextPage: connection.pageInfo.hasNextPage,
        endCursor: connection.pageInfo.endCursor,
      };
    });

    // 2. Fetch vendors (paginated)
    const vendors = await fetchAllPages(admin, async (cursor) => {
      const afterClause = cursor ? `, after: "${cursor}"` : "";
      const response = await admin.graphql(`{
        shop {
          productVendors(first: 250${afterClause}) {
            edges { node }
            pageInfo { hasNextPage endCursor }
          }
        }
      }`);
      const data = await response.json();
      const connection = data.data.shop.productVendors;
      return {
        items: connection.edges.map((e) => e.node).filter(Boolean),
        hasNextPage: connection.pageInfo.hasNextPage,
        endCursor: connection.pageInfo.endCursor,
      };
    });

    // 3. Fetch tags (paginated)
    const tags = await fetchAllPages(admin, async (cursor) => {
      const afterClause = cursor ? `, after: "${cursor}"` : "";
      const response = await admin.graphql(`{
        productTags(first: 250${afterClause}) {
          edges { node }
          pageInfo { hasNextPage endCursor }
        }
      }`);
      const data = await response.json();
      const connection = data.data.productTags;
      return {
        items: connection.edges.map((e) => e.node).filter(Boolean),
        hasNextPage: connection.pageInfo.hasNextPage,
        endCursor: connection.pageInfo.endCursor,
      };
    });

    // 4. Fetch price range + currency
    const priceResponse = await admin.graphql(`{
      shop { currencyCode }
      cheapest: products(first: 1, sortKey: PRICE, reverse: false) {
        edges { node { priceRangeV2 { minVariantPrice { amount } } } }
      }
      expensive: products(first: 1, sortKey: PRICE, reverse: true) {
        edges { node { priceRangeV2 { maxVariantPrice { amount } } } }
      }
    }`);
    const priceData = await priceResponse.json();
    const currency = priceData.data.shop.currencyCode || "USD";
    const minPrice = parseFloat(
      priceData.data.cheapest?.edges?.[0]?.node?.priceRangeV2?.minVariantPrice?.amount || "0"
    );
    const maxPrice = parseFloat(
      priceData.data.expensive?.edges?.[0]?.node?.priceRangeV2?.maxVariantPrice?.amount || "0"
    );
    const priceRange = { min: minPrice, max: maxPrice, currency };

    // 5. Fetch variant options (sample 100 products, deduplicate)
    const optionsResponse = await admin.graphql(`{
      products(first: 100) {
        edges {
          node {
            options { name values }
          }
        }
      }
    }`);
    const optionsData = await optionsResponse.json();
    const optionMap = new Map(); // name -> Set of values

    for (const edge of optionsData.data.products.edges) {
      for (const option of edge.node.options) {
        if (!optionMap.has(option.name)) {
          optionMap.set(option.name, new Set());
        }
        const valSet = optionMap.get(option.name);
        for (const v of option.values) {
          if (valSet.size < MAX_ENTRIES_PER_TYPE) {
            valSet.add(v);
          }
        }
      }
    }

    const variantOptions = [];
    for (const [name, valSet] of optionMap) {
      // Skip "Title" — Shopify's default single-variant placeholder
      if (name === "Title" && valSet.size === 1 && valSet.has("Default Title")) continue;
      variantOptions.push({ name, values: [...valSet] });
    }

    // Persist to DB
    await prisma.shop.update({
      where: { domain: shopDomain },
      data: {
        productTypes: JSON.stringify(productTypes),
        vendors: JSON.stringify(vendors),
        tags: JSON.stringify(tags),
        priceRange: JSON.stringify(priceRange),
        variantOptions: JSON.stringify(variantOptions),
        taxonomySyncedAt: new Date(),
      },
    });

    const elapsed = Date.now() - startTime;
    console.log(
      `[Taxonomy] Sync complete for ${shopDomain} in ${elapsed}ms — ` +
      `${productTypes.length} types, ${vendors.length} vendors, ${tags.length} tags, ` +
      `price ${priceRange.min}–${priceRange.max} ${currency}, ${variantOptions.length} option groups`
    );
  } catch (err) {
    console.error(`[Taxonomy] Sync failed for ${shopDomain}:`, err);
    throw err;
  }
}
