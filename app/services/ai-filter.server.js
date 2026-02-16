import { fuzzyCorrectFilters } from "../utils/fuzzyMatch.js";

const OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY;
const LLM_TIMEOUT_MS = 8000;

const SYSTEM_PROMPT = `You map customer shopping queries to Shopify product filters using the apply_filters tool.

Filter types: productType, productVendor, tag, available (true/false), price ({min,max}), variantOption ({name,value}).

STRICT RULES:
1. ONLY use values that EXACTLY match the store catalog when provided. Never invent filter values.
2. If the customer's term is a substring or synonym of a catalog value, use the catalog value (e.g. "glasses" → "Sunglasses", "tee" → "T-Shirt").
3. Never add a price filter unless the customer explicitly mentions a price, budget, cost, or dollar amount. "under 100 dollars" → price {max:100}. "red shoes" → NO price filter.
4. Use searchQuery for descriptive terms that don't map to any filter (e.g. "cozy", "lightweight", "summer").
5. Capitalize filter values: "green" → "Green", "shorts" → "Shorts".
6. Explanation: 1 friendly sentence.
7. If no filters match at all, set filters to [] and put the full query in searchQuery.`;

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
        searchQuery: {
          type: "string",
          description: "Text search terms for Shopify search. Use for descriptive terms that don't map to any filter (e.g. 'cozy', 'lightweight'). Leave empty if all terms map to filters.",
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

/**
 * Sanitize filter values — ensure price is numeric, swap min/max if needed, remove empties.
 * @param {Array} filters
 * @param {object|null} taxonomyContext
 * @returns {Array}
 */
function sanitizeFilters(filters, taxonomyContext) {
  return filters
    .map((f) => {
      const cleaned = { ...f };

      if (cleaned.price) {
        let { min, max } = cleaned.price;
        min = typeof min === "string" ? parseFloat(min) : min;
        max = typeof max === "string" ? parseFloat(max) : max;

        if (isNaN(min)) min = undefined;
        if (isNaN(max)) max = undefined;

        // Swap if min > max
        if (min !== undefined && max !== undefined && min > max) {
          [min, max] = [max, min];
        }

        // If both are undefined, drop the price filter
        if (min === undefined && max === undefined) {
          delete cleaned.price;
        } else {
          cleaned.price = {};
          if (min !== undefined) cleaned.price.min = min;
          if (max !== undefined) cleaned.price.max = max;
        }
      }

      return cleaned;
    })
    .filter((f) => {
      // Remove filter objects that are effectively empty
      const keys = Object.keys(f);
      return keys.length > 0;
    });
}

/**
 * Merge multiple price filter objects into one (LLM sometimes splits {min} and {max}).
 * @param {Array} filters
 * @returns {Array}
 */
function mergeFilters(filters) {
  const priceFilters = [];
  const nonPriceFilters = [];

  for (const f of filters) {
    // A filter is "price-only" if price is its only meaningful key
    const keys = Object.keys(f).filter((k) => f[k] !== undefined && f[k] !== null);
    if (keys.length === 1 && keys[0] === "price") {
      priceFilters.push(f.price);
    } else if (f.price && keys.length > 1) {
      // Has price + other keys — keep as-is but collect price for merge
      priceFilters.push(f.price);
      const { price, ...rest } = f;
      nonPriceFilters.push(rest);
    } else {
      nonPriceFilters.push(f);
    }
  }

  if (priceFilters.length > 0) {
    // Merge all price objects into one
    const merged = {};
    for (const p of priceFilters) {
      if (p.min !== undefined && (merged.min === undefined || p.min < merged.min)) {
        merged.min = p.min;
      }
      if (p.max !== undefined && (merged.max === undefined || p.max > merged.max)) {
        merged.max = p.max;
      }
    }
    if (merged.min !== undefined || merged.max !== undefined) {
      nonPriceFilters.push({ price: merged });
    }
  }

  return nonPriceFilters;
}

/**
 * Build taxonomy context string for the LLM prompt.
 * @param {object} taxonomyContext
 * @returns {string}
 */
function buildTaxonomyPrompt(taxonomyContext) {
  if (!taxonomyContext) return "";

  const lines = ["STORE CATALOG (use ONLY these exact values when matching):"];

  if (taxonomyContext.productTypes?.length > 0) {
    lines.push(`- Product types: ${JSON.stringify(taxonomyContext.productTypes)}`);
  }
  if (taxonomyContext.vendors?.length > 0) {
    lines.push(`- Vendors: ${JSON.stringify(taxonomyContext.vendors)}`);
  }
  if (taxonomyContext.tags?.length > 0) {
    lines.push(`- Tags: ${JSON.stringify(taxonomyContext.tags)}`);
  }
  if (taxonomyContext.priceRange && (taxonomyContext.priceRange.min !== undefined || taxonomyContext.priceRange.max !== undefined)) {
    const { min = 0, max = 0, currency = "USD" } = taxonomyContext.priceRange;
    lines.push(`- Price range: ${min}–${max} ${currency}`);
  }
  if (taxonomyContext.variantOptions?.length > 0) {
    const optParts = taxonomyContext.variantOptions.map(
      (o) => `${o.name}: [${o.values.join(", ")}]`
    );
    lines.push(`- Variant options: ${optParts.join("; ")}`);
  }

  return lines.length > 1 ? lines.join("\n") : "";
}

/**
 * Call the AI model via OpenRouter to map a natural language query to Shopify product filters.
 *
 * @param {string} userQuery - The customer's natural language query
 * @param {object|null} taxonomyContext - Parsed taxonomy from the store
 * @param {Array} availableFilters - Filters available on the current collection page
 * @param {string} collectionHandle - The collection handle for context
 * @returns {Promise<{filters: Array, explanation: string, latencyMs: number}>}
 */
export async function mapQueryToFilters(
  userQuery,
  taxonomyContext,
  availableFilters,
  collectionHandle,
) {
  const hasFilters = availableFilters && availableFilters.length > 0;
  const taxonomyPrompt = buildTaxonomyPrompt(taxonomyContext);

  const userMessage = `Customer query: "${userQuery}"

Collection: ${collectionHandle || "all products"}

${taxonomyPrompt ? taxonomyPrompt + "\n\n" : ""}${hasFilters ? `Available filters on this page:\n${JSON.stringify(availableFilters)}\n\nUse matching values from the available filters when possible.` : "No filter list is available for this page. Generate standard Shopify filters based on the query (productType, variantOption, tag, price, available, productVendor)."}

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

    const { filters = [], explanation = "", searchQuery = "" } = JSON.parse(
      toolCall.function.arguments,
    );

    // Post-processing pipeline: sanitize → merge → fuzzy correct
    let processed = sanitizeFilters(filters, taxonomyContext);
    processed = mergeFilters(processed);
    processed = fuzzyCorrectFilters(processed, taxonomyContext);

    return {
      filters: processed,
      explanation,
      searchQuery: searchQuery || "",
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
