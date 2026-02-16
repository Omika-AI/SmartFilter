import { useLoaderData } from "react-router";
import { authenticate } from "../shopify.server";
import prisma from "../db.server";
import { isTaxonomyStale, syncTaxonomy } from "../services/taxonomy-sync.server";
import { cacheFlushShop } from "../utils/queryCache";

export const loader = async ({ request }) => {
  const { session, admin } = await authenticate.admin(request);
  const shop = session.shop;

  let shopRecord = await prisma.shop.findUnique({
    where: { domain: shop },
  });

  if (!shopRecord) {
    shopRecord = await prisma.shop.create({
      data: { domain: shop },
    });
  }

  // Fire-and-forget taxonomy sync if stale
  if (isTaxonomyStale(shopRecord)) {
    syncTaxonomy(admin, shop)
      .then(() => cacheFlushShop(shop))
      .catch((err) => console.error("[Dashboard] Taxonomy sync failed:", err));
  }

  // Get total queries
  const totalQueries = shopRecord.queryCount;

  // Get average latency
  const latencyResult = await prisma.aiFilterQuery.aggregate({
    where: { shopId: shopRecord.id },
    _avg: { latencyMs: true },
  });
  const avgLatency = Math.round(latencyResult._avg.latencyMs || 0);

  // Get queries today
  const todayStart = new Date();
  todayStart.setHours(0, 0, 0, 0);
  const queriesToday = await prisma.aiFilterQuery.count({
    where: {
      shopId: shopRecord.id,
      createdAt: { gte: todayStart },
    },
  });

  // Get recent queries (last 20)
  const recentQueries = await prisma.aiFilterQuery.findMany({
    where: { shopId: shopRecord.id },
    orderBy: { createdAt: "desc" },
    take: 20,
    select: {
      id: true,
      userQuery: true,
      filtersReturned: true,
      latencyMs: true,
      createdAt: true,
    },
  });

  // Get top queries (most common)
  const allQueries = await prisma.aiFilterQuery.findMany({
    where: { shopId: shopRecord.id },
    select: { userQuery: true },
  });

  const queryCounts = {};
  for (const q of allQueries) {
    const normalized = q.userQuery.toLowerCase().trim();
    queryCounts[normalized] = (queryCounts[normalized] || 0) + 1;
  }

  const topQueries = Object.entries(queryCounts)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 10)
    .map(([query, count]) => ({ query, count }));

  return {
    totalQueries,
    avgLatency,
    queriesToday,
    recentQueries: recentQueries.map((q) => ({
      ...q,
      createdAt: q.createdAt.toISOString(),
    })),
    topQueries,
    enabled: shopRecord.enabled,
  };
};

export default function Dashboard() {
  const {
    totalQueries,
    avgLatency,
    queriesToday,
    recentQueries,
    topQueries,
    enabled,
  } = useLoaderData();

  return (
    <s-page title="AI Filter Dashboard">
      {!enabled && (
        <s-banner tone="warning">
          AI Filter is currently disabled. Enable it in Settings to start
          processing customer queries.
        </s-banner>
      )}

      <s-layout>
        <s-layout-section>
          <div className="aif-kpi-grid">
            <div className="aif-kpi-card">
              <span className="aif-kpi-label">Total Queries</span>
              <span className="aif-kpi-value">
                {totalQueries.toLocaleString()}
              </span>
            </div>
            <div className="aif-kpi-card">
              <span className="aif-kpi-label">Today</span>
              <span className="aif-kpi-value">
                {queriesToday.toLocaleString()}
              </span>
            </div>
            <div className="aif-kpi-card">
              <span className="aif-kpi-label">Avg Latency</span>
              <span className="aif-kpi-value">{avgLatency}ms</span>
            </div>
          </div>
        </s-layout-section>

        {topQueries.length > 0 && (
          <s-layout-section>
            <s-card>
              <s-text variant="headingMd">Top Queries</s-text>
              <table className="aif-table">
                <thead>
                  <tr>
                    <th>Query</th>
                    <th>Count</th>
                  </tr>
                </thead>
                <tbody>
                  {topQueries.map((item, i) => (
                    <tr key={i}>
                      <td>{item.query}</td>
                      <td>{item.count}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </s-card>
          </s-layout-section>
        )}

        <s-layout-section>
          <s-card>
            <s-text variant="headingMd">Recent Queries</s-text>
            {recentQueries.length === 0 ? (
              <s-text tone="subdued">
                No queries yet. Once customers start using the AI Filter, their
                searches will appear here.
              </s-text>
            ) : (
              <table className="aif-table">
                <thead>
                  <tr>
                    <th>Query</th>
                    <th>Filters</th>
                    <th>Latency</th>
                    <th>Time</th>
                  </tr>
                </thead>
                <tbody>
                  {recentQueries.map((q) => {
                    let filterCount = 0;
                    try {
                      const parsed = JSON.parse(q.filtersReturned || "[]");
                      filterCount = parsed.length;
                    } catch {
                      // ignore
                    }
                    return (
                      <tr key={q.id}>
                        <td>{q.userQuery}</td>
                        <td>
                          {filterCount} filter{filterCount !== 1 ? "s" : ""}
                        </td>
                        <td>{q.latencyMs}ms</td>
                        <td>
                          {new Date(q.createdAt).toLocaleString()}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            )}
          </s-card>
        </s-layout-section>
      </s-layout>
    </s-page>
  );
}
