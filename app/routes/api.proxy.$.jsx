import { authenticate, unauthenticated } from "../shopify.server";
import prisma from "../db.server";
import { mapQueryToFilters } from "../services/ai-filter.server";
import { isTaxonomyStale, syncTaxonomy, parseTaxonomy } from "../services/taxonomy-sync.server";
import { checkRateLimit } from "../utils/rateLimiter";
import { cacheKey, cacheGet, cacheSet, cacheFlushShop } from "../utils/queryCache";

const AI_RATE_LIMIT = 10;
const RATE_WINDOW_MS = 60_000;

const isDev = process.env.NODE_ENV !== "production";

function jsonResponse(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "Content-Type": "application/json",
      "Cache-Control": "no-store",
    },
  });
}

export const loader = async ({ request }) => {
  const { session } = await authenticate.public.appProxy(request);
  const shop = session?.shop;

  if (!shop) {
    return jsonResponse({ error: "Unauthorized", filters: null }, 200);
  }

  const url = new URL(request.url);
  const path = url.pathname.replace(/^\/api\/proxy\/?/, "");

  if (path === "settings") {
    return handleSettingsRequest(shop);
  }

  return jsonResponse({ error: "Not found" }, 404);
};

export const action = async ({ request }) => {
  const { session } = await authenticate.public.appProxy(request);
  const shop = session?.shop;

  if (!shop) {
    return jsonResponse({ error: "Unauthorized", filters: null }, 200);
  }

  const url = new URL(request.url);
  const path = url.pathname.replace(/^\/api\/proxy\/?/, "");

  if (path === "query") {
    const { allowed } = checkRateLimit(
      `ai:${shop}`,
      AI_RATE_LIMIT,
      RATE_WINDOW_MS,
    );
    if (!allowed) {
      return jsonResponse({
        error: "Too many requests. Please wait a moment and try again.",
        filters: null,
        explanation: null,
      });
    }
    return handleQueryRequest(request, shop);
  }

  return jsonResponse({ error: "Not found" }, 404);
};

async function handleQueryRequest(request, shop) {
  const timings = { start: Date.now() };

  // Parallelize body parse + shop lookup
  let body, shopRecord;
  try {
    [body, shopRecord] = await Promise.all([
      request.json().catch(() => null),
      prisma.shop.findUnique({ where: { domain: shop } }),
    ]);
  } catch {
    return jsonResponse({
      error: "Invalid request body",
      filters: null,
      explanation: null,
    });
  }

  timings.bodyAndShopMs = Date.now() - timings.start;

  if (!body) {
    return jsonResponse({
      error: "Invalid request body",
      filters: null,
      explanation: null,
    });
  }

  const { query, collectionHandle, availableFilters } = body;

  if (!query || typeof query !== "string" || query.trim().length === 0) {
    return jsonResponse({
      error: "Please enter a search query",
      filters: null,
      explanation: null,
    });
  }

  if (query.length > 500) {
    return jsonResponse({
      error: "Query is too long. Please keep it under 500 characters.",
      filters: null,
      explanation: null,
    });
  }

  // Ensure or create shop record
  if (!shopRecord) {
    shopRecord = await prisma.shop.create({
      data: { domain: shop },
    });
  }

  if (!shopRecord.enabled) {
    return jsonResponse({
      error: "AI Filter is currently disabled for this store.",
      filters: null,
      explanation: null,
    });
  }

  // --- Taxonomy: lazy sync if stale ---
  let taxonomyContext = null;
  if (isTaxonomyStale(shopRecord)) {
    if (!shopRecord.taxonomySyncedAt) {
      // Never synced — block and sync now so we have data
      try {
        const { admin } = await unauthenticated.admin(shop);
        await syncTaxonomy(admin, shop);
        cacheFlushShop(shop);
        // Reload shop record with fresh taxonomy
        shopRecord = await prisma.shop.findUnique({ where: { domain: shop } });
      } catch (err) {
        console.error("[AI Filter] Inline taxonomy sync failed:", err);
        // Continue without taxonomy — degrade gracefully
      }
    } else {
      // Stale but has data — fire-and-forget background sync
      (async () => {
        try {
          const { admin } = await unauthenticated.admin(shop);
          await syncTaxonomy(admin, shop);
          cacheFlushShop(shop);
        } catch (err) {
          console.error("[AI Filter] Background taxonomy sync failed:", err);
        }
      })();
    }
  }

  taxonomyContext = parseTaxonomy(shopRecord);
  timings.taxonomyMs = Date.now() - timings.start;

  // Check cache
  const key = cacheKey(shop, collectionHandle, query);
  const cached = cacheGet(key);

  timings.cacheCheckMs = Date.now() - timings.start;

  if (cached) {
    console.log("[AI Filter] Cache HIT:", key);

    // Fire-and-forget analytics for cache hits
    Promise.all([
      prisma.aiFilterQuery.create({
        data: {
          shopId: shopRecord.id,
          userQuery: query.trim().slice(0, 500),
          filtersReturned: JSON.stringify(cached.filters),
          latencyMs: 0,
        },
      }),
      prisma.shop.update({
        where: { id: shopRecord.id },
        data: { queryCount: { increment: 1 } },
      }),
    ]).catch((err) =>
      console.error("[AI Filter] Analytics write error (cache hit):", err),
    );

    const responseData = {
      filters: cached.filters,
      explanation: cached.explanation,
      searchQuery: cached.searchQuery || null,
      error: null,
    };

    if (isDev) {
      responseData._debug = { ...timings, cacheHit: true, totalMs: Date.now() - timings.start };
    }

    return jsonResponse(responseData);
  }

  console.log("[AI Filter] Cache MISS:", key);

  try {
    const result = await mapQueryToFilters(
      query.trim(),
      taxonomyContext,
      availableFilters || [],
      collectionHandle || "",
    );

    timings.llmCompleteMs = Date.now() - timings.start;

    // Store in cache
    if (result.filters.length > 0 || result.searchQuery) {
      cacheSet(key, {
        filters: result.filters,
        explanation: result.explanation,
        searchQuery: result.searchQuery || null,
      });
    }

    // Fire-and-forget DB writes — don't block the response
    Promise.all([
      prisma.aiFilterQuery.create({
        data: {
          shopId: shopRecord.id,
          userQuery: query.trim().slice(0, 500),
          filtersReturned: JSON.stringify(result.filters),
          latencyMs: result.latencyMs || 0,
        },
      }),
      prisma.shop.update({
        where: { id: shopRecord.id },
        data: { queryCount: { increment: 1 } },
      }),
    ]).catch((err) =>
      console.error("[AI Filter] Analytics write error:", err),
    );

    timings.responseReadyMs = Date.now() - timings.start;

    const responseData = {
      filters: result.filters,
      explanation: result.explanation,
      searchQuery: result.searchQuery || null,
      error: null,
    };

    if (isDev) {
      responseData._debug = { ...timings, cacheHit: false, llmLatencyMs: result.latencyMs };
    }

    console.log("[AI Filter] Timings:", timings);

    return jsonResponse(responseData);
  } catch (error) {
    console.error("[AI Filter] Error processing query:", error);
    return jsonResponse({
      error: "Something went wrong. Please try again.",
      filters: null,
      explanation: null,
    });
  }
}

async function handleSettingsRequest(shop) {
  const shopRecord = await prisma.shop.findUnique({ where: { domain: shop } });
  if (!shopRecord) {
    return jsonResponse({ enabled: true });
  }

  return jsonResponse({
    enabled: shopRecord.enabled,
  });
}
