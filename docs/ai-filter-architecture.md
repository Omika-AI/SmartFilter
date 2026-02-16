# AI Filter System — Technical Architecture

A deep-dive into the full pipeline: user input → LLM → Shopify storefront filtering.

---

## 1. Architecture Overview

```
+---------------------+     +------------------------+     +---------------------+
|  Storefront Widget  |     |  DOM Filter Scraping   |     |  App Proxy POST     |
|  (Liquid Block)     | --> |  (Client JS)           | --> |  /apps/ai-filter/   |
|                     |     |  extractAvailableFilters|     |  query              |
+---------------------+     +------------------------+     +---------------------+
                                                                    |
                                                                    v
+---------------------+     +------------------------+     +---------------------+
|  URL Construction   |     |  LLM Call              |     |  Server Route       |
|  + Page Navigation  | <-- |  (OpenRouter/Gemini)   | <-- |  (cache/rate-limit) |
|  filter.* params    |     |  mapQueryToFilters()   |     |  api.proxy.$.jsx    |
+---------------------+     +------------------------+     +---------------------+
```

**Key insight:** The app never executes Shopify GraphQL product queries. Instead, it builds `filter.*` URL parameters and navigates the browser — Shopify's native storefront collection/search page handles the actual product querying and rendering.

### Data flow summary

1. **Liquid block** renders the `#ai-filter-root` container and loads client assets.
2. **Client JS** scrapes the DOM to discover what filter values the current page supports (product types, colors, prices, etc.).
3. **Client JS** POSTs `{ query, collectionHandle, availableFilters }` to the app proxy.
4. **Server route** authenticates via HMAC, checks rate limit and cache, then calls the LLM.
5. **LLM** (Gemini 2.5 Flash Lite via OpenRouter) returns structured filter objects using tool calling.
6. **Client JS** translates the filter objects into `filter.*` URL params and navigates the browser.

---

## 2. Step 1 — Storefront Entry Point (Liquid Block)

**File:** `extensions/ai-filter-block/blocks/ai-filter.liquid`

```liquid
{% if block.settings.enable %}
  <div
    id="ai-filter-root"
    data-collection-handle="{{ collection.handle }}"
    data-collection-id="{{ collection.id }}"
    data-proxy-path="/apps/ai-filter"
    data-button-text="{{ block.settings.button_text }}"
    data-placeholder="{{ block.settings.placeholder_text }}"
    data-accent-color="{{ block.settings.accent_color }}"
    data-button-text-color="{{ block.settings.button_text_color }}"
    style="
      --aif-accent: {{ block.settings.accent_color }};
      --aif-btn-text: {{ block.settings.button_text_color }};
    "
  ></div>

  {{ 'ai-filter.css' | asset_url | stylesheet_tag }}
  <script src="{{ 'ai-filter.js' | asset_url }}" defer></script>
{% endif %}

{% schema %}
{
  "name": "AI Product Filter",
  "target": "body",
  "settings": [
    {
      "type": "checkbox",
      "id": "enable",
      "label": "Enable AI Filter",
      "default": true
    },
    {
      "type": "text",
      "id": "button_text",
      "label": "Button text",
      "default": "AI Filter"
    },
    {
      "type": "text",
      "id": "placeholder_text",
      "label": "Input placeholder",
      "default": "Describe what you're looking for..."
    },
    {
      "type": "color",
      "id": "accent_color",
      "label": "Accent color",
      "default": "#6366f1"
    },
    {
      "type": "color",
      "id": "button_text_color",
      "label": "Button text color",
      "default": "#ffffff"
    }
  ]
}
{% endschema %}
```

The block renders a single `<div id="ai-filter-root">` with data attributes that the client JS reads at initialization. It is gated by the `enable` setting so merchants can turn it off from the theme editor.

### App Proxy Configuration

**File:** `shopify.app.toml`

```toml
[app_proxy]
url = "/api/proxy"
subpath = "ai-filter"
prefix = "apps"
```

This means any request to `https://{store}.myshopify.com/apps/ai-filter/*` is proxied by Shopify to the app's `/api/proxy/*` endpoint. Shopify appends HMAC query params for authentication.

---

## 3. Step 2 — DOM Filter Extraction (Client JS)

**File:** `extensions/ai-filter-block/assets/ai-filter.js`, `extractAvailableFilters()` (lines 42–178)

This function is the bridge between the theme's rendered filter sidebar and the LLM. It tells the model what filter values actually exist on the current page — product types, colors, sizes, vendors, price ranges, etc. Without this context, the LLM is guessing blindly.

### Three extraction strategies

1. **Parse `<details>` groups** (Dawn / OS 2.0 themes) — looks for `<details>` elements inside known filter form selectors, reads the `<summary>` text as the group name, then extracts checkbox/radio inputs and their labels.
2. **Parse price range `<input>` elements** — finds number inputs with names matching `filter.v.price` or `filter.p.price`.
3. **Fallback: scan all `<a href="...filter.*">` links** — if strategies 1 and 2 yield nothing, scans every link on the page that contains `filter.*` query params and groups them by parameter name.

The result is cached after the first extraction so subsequent queries in the same page session don't re-scan the DOM.

### Full function

```js
function extractAvailableFilters() {
  // Return cached result if already extracted
  if (cachedAvailableFilters !== null) return cachedAvailableFilters;

  const filters = [];

  // Strategy 1: Parse <details> groups with checkboxes (Dawn / common OS 2.0 themes)
  const detailsGroups = document.querySelectorAll(
    [
      "form[data-collection-filters] details",
      ".facets__form details",
      ".collection-filters details",
      "[data-filter-group]",
      ".filter-group",
    ].join(", "),
  );

  detailsGroups.forEach(function (group) {
    const summary = group.querySelector("summary");
    if (!summary) return;

    const groupName = summary.textContent.trim();
    const values = [];

    // Checkboxes and radio buttons
    const inputs = group.querySelectorAll(
      'input[type="checkbox"], input[type="radio"]',
    );
    inputs.forEach(function (input) {
      const label = group.querySelector('label[for="' + input.id + '"]');
      const labelText = label
        ? label.textContent.trim().replace(/\s*\(\d+\)\s*$/, "")
        : "";
      if (labelText && input.name) {
        values.push({
          label: labelText,
          value: input.value,
          paramName: input.name,
        });
      }
    });

    // Links (some themes use <a> instead of checkboxes)
    if (values.length === 0) {
      const links = group.querySelectorAll("a[href*='filter.']");
      links.forEach(function (link) {
        const text = link.textContent.trim().replace(/\s*\(\d+\)\s*$/, "");
        if (text) {
          try {
            var url = new URL(link.href, window.location.origin);
            url.searchParams.forEach(function (val, key) {
              if (key.startsWith("filter.")) {
                values.push({ label: text, value: val, paramName: key });
              }
            });
          } catch (e) {
            // skip malformed URLs
          }
        }
      });
    }

    if (values.length > 0) {
      filters.push({ name: groupName, values: values });
    }
  });

  // Strategy 2: Parse price range inputs
  var priceInputs = document.querySelectorAll(
    [
      'input[name*="filter.v.price"]',
      'input[name*="filter.p.price"]',
      ".price-filter input[type='number']",
      ".facets__price input[type='number']",
    ].join(", "),
  );

  if (priceInputs.length > 0) {
    var priceFilter = { name: "Price", type: "price_range", values: [] };
    priceInputs.forEach(function (input) {
      var label =
        input.placeholder ||
        input.getAttribute("aria-label") ||
        input.name ||
        "";
      priceFilter.values.push({
        label: label,
        paramName: input.name,
        min: input.min || "0",
        max: input.max || "",
      });
    });
    if (priceFilter.values.length > 0) {
      filters.push(priceFilter);
    }
  }

  // Strategy 3: Fallback — scan all filter.* params in any <a> tags on page
  if (filters.length === 0) {
    var filterLinks = document.querySelectorAll("a[href*='filter.']");
    var paramMap = {};

    filterLinks.forEach(function (link) {
      try {
        var url = new URL(link.href, window.location.origin);
        url.searchParams.forEach(function (val, key) {
          if (key.startsWith("filter.")) {
            if (!paramMap[key]) paramMap[key] = new Set();
            paramMap[key].add(val);
          }
        });
      } catch (e) {
        // skip
      }
    });

    Object.keys(paramMap).forEach(function (key) {
      var name = key
        .replace("filter.v.option.", "")
        .replace("filter.p.", "")
        .replace("filter.v.", "");
      name = name.charAt(0).toUpperCase() + name.slice(1);

      var values = [];
      paramMap[key].forEach(function (v) {
        values.push({ label: v, value: v, paramName: key });
      });

      if (values.length > 0) {
        filters.push({ name: name, values: values });
      }
    });
  }

  // Cache for subsequent calls
  cachedAvailableFilters = filters;
  return filters;
}
```

### Known issue

If the theme renders filters differently than Dawn (e.g., custom React components, non-standard markup), all three strategies may return an empty array. In that case the LLM receives no available filter context and must guess values from the query alone — significantly reducing accuracy.

---

## 4. Step 3 — Query Submission (Client JS → App Proxy)

**File:** `extensions/ai-filter-block/assets/ai-filter.js`, `handleSubmit()` (lines 287–367)

When the user types a query and hits Enter/Search:

1. Extracts available filters from the DOM (or returns cached).
2. Builds the payload: `{ query, collectionHandle, availableFilters }`.
3. POSTs to `/apps/ai-filter/query`.
4. On success, briefly shows the explanation text, then navigates via `applyFilters()`.

### Full function

```js
function handleSubmit(input, modal) {
  var query = input.value.trim();
  if (!query || isLoading) return;

  var resultsArea = modal.querySelector(".ai-filter__results");
  var submitBtn = modal.querySelector(".ai-filter__submit");

  // Show shimmer loading state
  isLoading = true;
  submitBtn.disabled = true;
  resultsArea.innerHTML =
    '<div class="ai-filter__loading">' +
    '<div class="ai-filter__shimmer-line" style="width:90%"></div>' +
    '<div class="ai-filter__shimmer-line" style="width:70%"></div>' +
    '<div class="ai-filter__shimmer-line" style="width:50%"></div>' +
    '<p class="ai-filter__loading-text">Analyzing your request\u2026</p>' +
    "</div>";

  var availableFilters = extractAvailableFilters();

  var payload = {
    query: query,
    collectionHandle: config.collectionHandle,
    availableFilters: availableFilters,
  };

  var fetchStart = performance.now();

  fetch(config.proxyPath + "/query", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  })
    .then(function (res) {
      return res.json();
    })
    .then(function (data) {
      var fetchEnd = performance.now();
      console.log("[AI Filter] Round-trip: " + Math.round(fetchEnd - fetchStart) + "ms");

      isLoading = false;
      submitBtn.disabled = false;

      if (data.error) {
        resultsArea.innerHTML =
          '<div class="ai-filter__error">' +
          escapeHtml(data.error) +
          "</div>";
        return;
      }

      if (!data.filters || data.filters.length === 0) {
        resultsArea.innerHTML =
          '<div class="ai-filter__error">' +
          "No matching filters found. Try a different description." +
          "</div>";
        return;
      }

      // Show explanation briefly, then navigate on next frame
      if (data.explanation) {
        resultsArea.innerHTML =
          '<div class="ai-filter__explanation">' +
          escapeHtml(data.explanation) +
          "</div>";
      }

      // Navigate after one paint so user sees the explanation
      requestAnimationFrame(function () {
        applyFilters(data.filters, query);
      });
    })
    .catch(function () {
      isLoading = false;
      submitBtn.disabled = false;
      resultsArea.innerHTML =
        '<div class="ai-filter__error">' +
        "Something went wrong. Please try again." +
        "</div>";
    });
}
```

---

## 5. Step 4 — Server Route Handler

**File:** `app/routes/api.proxy.$.jsx`

This is the Remix catch-all route that handles all app proxy requests. The key flow for `/query`:

1. **Authentication:** `authenticate.public.appProxy(request)` — Shopify validates the HMAC signature appended to the proxy URL.
2. **Rate limiting:** 10 requests per 60 seconds per shop (in-memory sliding window).
3. **Body parse + shop lookup:** Run in parallel via `Promise.all`.
4. **Validation:** Query must be a non-empty string, max 500 characters. Shop must exist and be enabled.
5. **Cache check:** LRU cache, 500 entries, 30-min TTL. Key format: `shop::collectionHandle::normalizedQuery`.
6. **On cache miss:** Calls `mapQueryToFilters()` (the LLM layer).
7. **Analytics:** Fire-and-forget Prisma writes to `AiFilterQuery` and `Shop.queryCount` — these don't block the response.

### Full `handleQueryRequest()` function

```js
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
      availableFilters || [],
      collectionHandle || "",
    );

    timings.llmCompleteMs = Date.now() - timings.start;

    // Store in cache
    if (result.filters.length > 0) {
      cacheSet(key, { filters: result.filters, explanation: result.explanation });
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
```

### Cache implementation

**File:** `app/utils/queryCache.js`

```js
const MAX_ENTRIES = 500;
const TTL_MS = 30 * 60 * 1000; // 30 minutes

const cache = new Map();

export function cacheKey(shop, collectionHandle, query) {
  return `${shop}::${collectionHandle || "all"}::${query.toLowerCase().trim()}`;
}

export function cacheGet(key) {
  const entry = cache.get(key);
  if (!entry) return undefined;

  if (Date.now() - entry.timestamp > TTL_MS) {
    cache.delete(key);
    return undefined;
  }

  // LRU: move to end
  cache.delete(key);
  cache.set(key, entry);

  return entry.value;
}

export function cacheSet(key, value) {
  // Delete first so re-set moves it to end
  cache.delete(key);

  // Evict oldest if at capacity
  if (cache.size >= MAX_ENTRIES) {
    const oldest = cache.keys().next().value;
    cache.delete(oldest);
  }

  cache.set(key, { value, timestamp: Date.now() });
}
```

### Rate limiter

**File:** `app/utils/rateLimiter.js`

```js
const windows = new Map();
const CLEANUP_INTERVAL = 60_000; // 1 minute

export function checkRateLimit(key, maxRequests, windowMs) {
  const now = Date.now();
  let entry = windows.get(key);

  if (!entry || now - entry.windowStart >= windowMs) {
    entry = { windowStart: now, count: 1 };
    windows.set(key, entry);
    return { allowed: true, remaining: maxRequests - 1 };
  }

  entry.count += 1;
  if (entry.count > maxRequests) {
    return { allowed: false, remaining: 0 };
  }

  return { allowed: true, remaining: maxRequests - entry.count };
}

// Periodically clean up expired entries to prevent memory leaks
setInterval(() => {
  const now = Date.now();
  for (const [key, entry] of windows) {
    if (now - entry.windowStart > 120_000) {
      windows.delete(key);
    }
  }
}, CLEANUP_INTERVAL);
```

---

## 6. Step 5 — LLM Call (The AI Layer)

**File:** `app/services/ai-filter.server.js`

- **Model:** `google/gemini-2.5-flash-lite` via OpenRouter
- **Timeout:** 8 seconds (via `AbortController`)
- **Max tokens:** 256
- **Structured output:** Forced tool calling (`tool_choice: { type: "function", function: { name: "apply_filters" } }`)

### System prompt

```
Map customer queries to Shopify product filters using the apply_filters tool.

Filter types: productType, productVendor, tag, available (true/false), price ({min,max}), variantOption ({name,value}).

Rules:
- Prefer values from available_filters when provided; otherwise generate standard filters.
- "red" -> Color "Red", "blue jacket" -> Color "Blue" + productType "Jacket".
- Capitalize values: "green" -> "Green", "shorts" -> "Shorts".
- Always produce at least one filter.
- Explanation: 1 friendly sentence.
```

### Tool definition (JSON Schema)

```js
const TOOL_DEFINITION = {
  type: "function",
  function: {
    name: "apply_filters",
    description:
      "Apply product filters based on the customer's query.",
    parameters: {
      type: "object",
      properties: {
        filters: {
          type: "array",
          description: "Array of filter objects to apply",
          items: {
            type: "object",
            properties: {
              productType: {
                type: "string",
                description: 'Product type, e.g. "Shoes", "Jacket"',
              },
              productVendor: {
                type: "string",
                description: 'Brand/vendor, e.g. "Nike"',
              },
              tag: {
                type: "string",
                description: 'Product tag, e.g. "sale"',
              },
              available: {
                type: "boolean",
                description: "true = in stock, false = out of stock",
              },
              price: {
                type: "object",
                description: "Price range filter",
                properties: {
                  min: { type: "number" },
                  max: { type: "number" },
                },
              },
              variantOption: {
                type: "object",
                description: 'Variant option, e.g. {name:"Color",value:"Red"}',
                properties: {
                  name: { type: "string" },
                  value: { type: "string" },
                },
                required: ["name", "value"],
              },
            },
          },
        },
        explanation: {
          type: "string",
          description: "Brief, friendly explanation (1 sentence)",
        },
      },
      required: ["filters", "explanation"],
    },
  },
};
```

### User message template

The user message sent to the LLM is constructed dynamically:

```js
const userMessage = `Customer query: "${userQuery}"

Collection: ${collectionHandle || "all products"}

${hasFilters
  ? `Available filters on this page:\n${JSON.stringify(availableFilters)}\n\nUse matching values from the available filters when possible.`
  : "No filter list is available for this page. Generate standard Shopify filters based on the query (productType, variantOption, tag, price, available, productVendor)."}

Use the apply_filters tool to return the structured filter parameters.`;
```

When `availableFilters` is present, the LLM gets a JSON dump of all filter groups and their values. When absent, the LLM must generate filters from general knowledge alone.

### Full `mapQueryToFilters()` function

```js
export async function mapQueryToFilters(
  userQuery,
  availableFilters,
  collectionHandle,
) {
  const hasFilters = availableFilters && availableFilters.length > 0;

  const userMessage = `Customer query: "${userQuery}"

Collection: ${collectionHandle || "all products"}

${hasFilters ? `Available filters on this page:\n${JSON.stringify(availableFilters)}\n\nUse matching values from the available filters when possible.` : "No filter list is available for this page. Generate standard Shopify filters based on the query (productType, variantOption, tag, price, available, productVendor)."}

Use the apply_filters tool to return the structured filter parameters.`;

  const startTime = Date.now();

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), LLM_TIMEOUT_MS);

  try {
    const res = await fetch("https://openrouter.ai/api/v1/chat/completions", {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${OPENROUTER_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: "google/gemini-2.5-flash-lite",
        max_tokens: 256,
        tools: [TOOL_DEFINITION],
        tool_choice: { type: "function", function: { name: "apply_filters" } },
        messages: [
          { role: "system", content: SYSTEM_PROMPT },
          { role: "user", content: userMessage },
        ],
      }),
      signal: controller.signal,
    });

    const response = await res.json();
    const latencyMs = Date.now() - startTime;

    const toolCall = response.choices?.[0]?.message?.tool_calls?.[0];

    if (!toolCall) {
      return {
        filters: [],
        explanation: "I couldn't process your request. Please try again.",
        latencyMs,
      };
    }

    const { filters = [], explanation = "" } = JSON.parse(
      toolCall.function.arguments,
    );

    return {
      filters,
      explanation,
      latencyMs,
    };
  } catch (error) {
    const latencyMs = Date.now() - startTime;

    if (error.name === "AbortError") {
      console.warn("[AI Filter] LLM timed out after " + latencyMs + "ms");
      return {
        filters: [],
        explanation: "The request took too long. Please try a simpler query.",
        latencyMs,
      };
    }

    throw error;
  } finally {
    clearTimeout(timer);
  }
}
```

---

## 7. Step 6 — Filter-to-URL Transformation (Client JS)

**File:** `extensions/ai-filter-block/assets/ai-filter.js`, `appendFilterParams()` (lines 373–422) and `applyFilters()` (lines 424–468)

### Mapping table

| AI Output Key | Shopify URL Parameter | Example URL Fragment |
|---|---|---|
| `productType: "Shorts"` | `filter.p.product_type=Shorts` | `?filter.p.product_type=Shorts` |
| `productVendor: "Nike"` | `filter.p.vendor=Nike` | `?filter.p.vendor=Nike` |
| `tag: "sale"` | `filter.p.tag=sale` | `?filter.p.tag=sale` |
| `available: true` | `filter.v.availability=1` | `?filter.v.availability=1` |
| `available: false` | `filter.v.availability=0` | `?filter.v.availability=0` |
| `price: {min: 10}` | `filter.v.price.gte=10` | `?filter.v.price.gte=10` |
| `price: {max: 100}` | `filter.v.price.lte=100` | `?filter.v.price.lte=100` |
| `variantOption: {name:"Color", value:"Red"}` | `filter.v.option.color=Red` | `?filter.v.option.color=Red` |

### `appendFilterParams()` — builds URL params from filter objects

```js
function appendFilterParams(url, filters) {
  filters.forEach(function (filter) {
    if (filter.productType) {
      url.searchParams.append(
        "filter.p.product_type",
        filter.productType,
      );
    }

    if (filter.productVendor) {
      url.searchParams.append("filter.p.vendor", filter.productVendor);
    }

    if (filter.tag) {
      url.searchParams.append("filter.p.tag", filter.tag);
    }

    if (filter.available === true) {
      url.searchParams.append("filter.v.availability", "1");
    } else if (filter.available === false) {
      url.searchParams.append("filter.v.availability", "0");
    }

    if (filter.price) {
      if (filter.price.min !== undefined && filter.price.min !== null) {
        url.searchParams.append(
          "filter.v.price.gte",
          String(filter.price.min),
        );
      }
      if (filter.price.max !== undefined && filter.price.max !== null) {
        url.searchParams.append(
          "filter.v.price.lte",
          String(filter.price.max),
        );
      }
    }

    if (filter.variantOption) {
      var optName = filter.variantOption.name;
      var optValue = filter.variantOption.value;
      if (optName && optValue) {
        url.searchParams.append(
          "filter.v.option." + optName.toLowerCase(),
          optValue,
        );
      }
    }
  });
}
```

### `applyFilters()` — navigation logic

Two paths depending on the current page:

- **Collection page** (`/collections/*`): Strips existing `filter.*` params from the current URL, appends the new ones, and navigates.
- **Non-collection page**: Builds a `/search?type=product&q=...` URL using structured values from the filters (product types, vendors, tags, variant values), then appends `filter.*` params for themes that support search filtering.

```js
function applyFilters(filters, query) {
  var isCollectionPage = /\/collections\//.test(window.location.pathname);

  if (!isCollectionPage) {
    var searchUrl = new URL('/search', window.location.origin);
    searchUrl.searchParams.set('type', 'product');

    // Build search query from structured filter values (more reliable than raw input)
    var searchTerms = [];
    filters.forEach(function (filter) {
      if (filter.productType) searchTerms.push(filter.productType);
      if (filter.productVendor) searchTerms.push(filter.productVendor);
      if (filter.tag) searchTerms.push(filter.tag);
      if (filter.variantOption && filter.variantOption.value) {
        searchTerms.push(filter.variantOption.value);
      }
    });
    searchUrl.searchParams.set('q', searchTerms.length > 0 ? searchTerms.join(' ') : query);

    // Also append filter params (works if theme supports search filtering)
    appendFilterParams(searchUrl, filters);

    window.location.href = searchUrl.toString();
    return;
  }

  // On collection pages: keep current filter-param behavior
  var url = new URL(window.location.href);

  // Clear existing filter.* params
  var keysToDelete = [];
  url.searchParams.forEach(function (_, key) {
    if (key.startsWith("filter.")) {
      keysToDelete.push(key);
    }
  });
  keysToDelete.forEach(function (key) {
    url.searchParams.delete(key);
  });

  appendFilterParams(url, filters);

  // Navigate to the filtered URL
  window.location.href = url.toString();
}
```

---

## 8. Database Schema

**File:** `prisma/schema.prisma`

```prisma
model Shop {
  id         String          @id @default(cuid())
  domain     String          @unique
  enabled    Boolean         @default(true)
  queryCount Int             @default(0)
  createdAt  DateTime        @default(now())
  updatedAt  DateTime        @updatedAt
  queries    AiFilterQuery[]
}

model AiFilterQuery {
  id              String   @id @default(cuid())
  shopId          String
  shop            Shop     @relation(fields: [shopId], references: [id], onDelete: Cascade)
  userQuery       String
  filtersReturned String?
  productCount    Int      @default(0)
  latencyMs       Int      @default(0)
  createdAt       DateTime @default(now())

  @@index([shopId, createdAt])
}
```

- **`Shop`**: One row per store. `enabled` gates whether AI Filter is active. `queryCount` is a denormalized counter incremented on every query (including cache hits).
- **`AiFilterQuery`**: Logs every query. `filtersReturned` is the JSON-stringified filter array. `latencyMs` records the LLM round-trip time (0 for cache hits). `productCount` is defined but currently always 0 — it's a placeholder for future result-count tracking.

---

## 9. Known Quality Issues (Discussion Points)

### "under 100 dollars" — shows only 1 product

The LLM correctly maps this to `{ price: { max: 100 } }`, which becomes `filter.v.price.lte=100` in the URL. If Shopify shows only 1 product when nearly all are under $100, possible causes:

1. **The LLM is generating additional unintended filters alongside the price filter.** For example, if it also returns `productType: "Dollars"` or a tag, those extra filters narrow the results dramatically. To verify: check the `filtersReturned` column in the `AiFilterQuery` table for these queries and inspect the full filter array.

2. **Shopify price filtering uses the variant price, not the displayed price.** If products have multiple variants with different prices, the `filter.v.price.lte` parameter filters against variant prices. A product displayed at "$49.99" might have a variant at "$149.99" and still be excluded, or vice versa.

3. **Currency/format mismatch.** If the store uses a non-USD currency, `100` may not mean what the customer expects. The LLM has no awareness of the store's currency.

4. **The `filter.v.price` parameter expects values in the store's base currency units.** Some Shopify setups use cents (i.e., `10000` for $100). If the theme's price range inputs reveal a `max` attribute in cents, the LLM's `100` would actually filter for products under $1.

**Investigation steps:**
- Query the `AiFilterQuery` table for "under 100 dollars" queries and inspect `filtersReturned` for unexpected extra filters.
- Manually construct the URL `?filter.v.price.lte=100` on the collection page and verify the result count.
- Check the theme's price filter inputs for `min`/`max` attributes to determine the expected unit (dollars vs. cents).

### "glasses" — doesn't match "sunglasses"

Shopify's `filter.p.product_type` is an **exact string match**. If products are categorized as "Sunglasses" and the LLM returns `productType: "Glasses"`, zero results will match.

**Root cause analysis:**

1. **Without available filters:** The LLM has no knowledge of the store's actual product types. It reasonably guesses "Glasses" but the store uses "Sunglasses". This is a fundamental limitation of generating filters without context.

2. **With available filters:** If the DOM extraction successfully finds "Sunglasses" as an available product type value, the LLM *should* match it — the system prompt says "Prefer values from available_filters when provided." But the LLM might not recognize "glasses" as a substring match for "Sunglasses", especially with a fast/lite model.

**Possible fixes:**

1. **Improve the system prompt:** Add a rule like *"When the customer's query is a substring or synonym of an available filter value, use the available value. Example: 'glasses' should match 'Sunglasses'."*

2. **Use available filters more aggressively:** In the user message, explicitly call out potential matches — e.g., pre-filter the available values list to only include entries that are textually similar to the query.

3. **Fall back to search-based filtering:** For non-collection pages, the app already builds a `/search?q=...` URL. On collection pages, a similar approach could be: if the LLM's confidence is low or no exact match exists, redirect to `/search?q=glasses&type=product` instead of applying `filter.p.product_type=Glasses`.

4. **Client-side fuzzy matching:** Before sending to the LLM, the client JS could do a simple substring check against available filter values and highlight likely matches in the payload.

---

## 10. File Reference Table

| File | Role |
|---|---|
| `extensions/ai-filter-block/blocks/ai-filter.liquid` | Liquid theme block — entry point, renders `#ai-filter-root` |
| `extensions/ai-filter-block/assets/ai-filter.js` | Client JS — DOM filter scraping, modal UI, API call, URL construction |
| `extensions/ai-filter-block/assets/ai-filter.css` | Client CSS — modal styles, shimmer loading, responsive layout |
| `app/routes/api.proxy.$.jsx` | Server route — HMAC auth, rate limit, cache, orchestration |
| `app/services/ai-filter.server.js` | AI service — LLM call via OpenRouter, tool-call parsing |
| `app/utils/queryCache.js` | In-memory LRU cache (500 entries, 30-min TTL) |
| `app/utils/rateLimiter.js` | In-memory sliding-window rate limiter |
| `prisma/schema.prisma` | Database schema (Shop, AiFilterQuery, Session) |
| `shopify.app.toml` | App configuration — proxy, webhooks, scopes |
