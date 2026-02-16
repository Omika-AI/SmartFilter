import { Searcher } from "fast-fuzzy";

const DEFAULT_THRESHOLD = 0.8;

/**
 * Check if one string is a substring of another (case-insensitive).
 * @param {string} a
 * @param {string} b
 * @returns {boolean}
 */
function isSubstringMatch(a, b) {
  const al = a.toLowerCase();
  const bl = b.toLowerCase();
  return al.length >= 3 && (bl.includes(al) || al.includes(bl));
}

/**
 * Find the best fuzzy match for a value against a list of known values.
 * Returns the known value if matched above threshold or substring match, otherwise original.
 * @param {string} value - The LLM-generated value
 * @param {string[]} knownValues - Store's actual values
 * @param {number} threshold - Minimum similarity (0-1)
 * @returns {string} Best match or original value
 */
export function fuzzyMatchValue(value, knownValues, threshold = DEFAULT_THRESHOLD) {
  if (!value || !knownValues || knownValues.length === 0) return value;

  // Exact match (case-insensitive)
  const exactMatch = knownValues.find(
    (v) => v.toLowerCase() === value.toLowerCase()
  );
  if (exactMatch) return exactMatch;

  // Substring match: "glasses" matches "Sunglasses"
  for (const known of knownValues) {
    if (isSubstringMatch(value, known)) {
      return known;
    }
  }

  // Fuzzy match
  const searcher = new Searcher(knownValues, {
    threshold,
    returnMatchData: false,
  });
  const results = searcher.search(value);
  if (results.length > 0) {
    return results[0];
  }

  return value;
}

/**
 * Build pre-constructed Searcher instances from taxonomy data for repeated use.
 * @param {{ productTypes: string[], vendors: string[], tags: string[], variantOptions: {name: string, values: string[]}[] }} taxonomy
 * @returns {object}
 */
export function buildSearchers(taxonomy) {
  return {
    productTypes: taxonomy.productTypes?.length > 0
      ? new Searcher(taxonomy.productTypes, { threshold: DEFAULT_THRESHOLD })
      : null,
    vendors: taxonomy.vendors?.length > 0
      ? new Searcher(taxonomy.vendors, { threshold: DEFAULT_THRESHOLD })
      : null,
    tags: taxonomy.tags?.length > 0
      ? new Searcher(taxonomy.tags, { threshold: DEFAULT_THRESHOLD })
      : null,
    variantOptionNames: taxonomy.variantOptions?.length > 0
      ? new Searcher(taxonomy.variantOptions.map((o) => o.name), { threshold: DEFAULT_THRESHOLD })
      : null,
    variantOptionValues: taxonomy.variantOptions?.reduce((acc, opt) => {
      acc[opt.name.toLowerCase()] = {
        name: opt.name,
        values: opt.values,
        searcher: new Searcher(opt.values, { threshold: DEFAULT_THRESHOLD }),
      };
      return acc;
    }, {}) || {},
  };
}

/**
 * Post-process all filter string values against known taxonomy values.
 * Corrects near-misses like "glasses" → "Sunglasses".
 * @param {Array} filters - Array of filter objects from LLM
 * @param {{ productTypes: string[], vendors: string[], tags: string[], variantOptions: {name: string, values: string[]}[] }} taxonomy
 * @returns {Array} Corrected filters
 */
export function fuzzyCorrectFilters(filters, taxonomy) {
  if (!taxonomy || !filters || filters.length === 0) return filters;

  return filters.map((filter) => {
    const corrected = { ...filter };

    // Correct productType
    if (corrected.productType && taxonomy.productTypes?.length > 0) {
      corrected.productType = fuzzyMatchValue(
        corrected.productType,
        taxonomy.productTypes
      );
    }

    // Correct productVendor
    if (corrected.productVendor && taxonomy.vendors?.length > 0) {
      corrected.productVendor = fuzzyMatchValue(
        corrected.productVendor,
        taxonomy.vendors
      );
    }

    // Correct tag
    if (corrected.tag && taxonomy.tags?.length > 0) {
      corrected.tag = fuzzyMatchValue(corrected.tag, taxonomy.tags);
    }

    // Correct variantOption name and value
    if (corrected.variantOption && taxonomy.variantOptions?.length > 0) {
      const optNames = taxonomy.variantOptions.map((o) => o.name);
      const matchedName = fuzzyMatchValue(
        corrected.variantOption.name,
        optNames
      );
      corrected.variantOption = { ...corrected.variantOption, name: matchedName };

      // Find the matching option group and correct the value
      const optionGroup = taxonomy.variantOptions.find(
        (o) => o.name.toLowerCase() === matchedName.toLowerCase()
      );
      if (optionGroup && corrected.variantOption.value) {
        corrected.variantOption.value = fuzzyMatchValue(
          corrected.variantOption.value,
          optionGroup.values
        );
      }
    }

    return corrected;
  });
}
