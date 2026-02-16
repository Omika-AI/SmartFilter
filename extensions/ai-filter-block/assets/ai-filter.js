(function () {
  "use strict";

  /* =============================================
     AI Filter — Storefront JavaScript
     Vanilla JS IIFE, no dependencies
     ============================================= */

  var root = document.getElementById("ai-filter-root");
  if (!root) return;

  // --- Configuration from data attributes ---
  var config = {
    collectionHandle: root.dataset.collectionHandle || "",
    collectionId: root.dataset.collectionId || "",
    proxyPath: root.dataset.proxyPath || "/apps/ai-filter",
    buttonText: root.dataset.buttonText || "AI Filter",
    placeholder:
      root.dataset.placeholder || "Describe what you're looking for...",
    accentColor: root.dataset.accentColor || "#6366f1",
    buttonTextColor: root.dataset.buttonTextColor || "#ffffff",
    sectionId: root.dataset.sectionId || "",
    gridSelector: root.dataset.gridSelector || "",
  };

  // --- SVG Icons ---
  var sparkleIcon =
    '<svg class="ai-filter__trigger-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3l1.912 5.813a2 2 0 0 0 1.275 1.275L21 12l-5.813 1.912a2 2 0 0 0-1.275 1.275L12 21l-1.912-5.813a2 2 0 0 0-1.275-1.275L3 12l5.813-1.912a2 2 0 0 0 1.275-1.275L12 3z"/></svg>';

  var closeIcon =
    '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>';

  var searchIcon =
    '<svg class="ai-filter__search-icon" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="11" cy="11" r="8"/><path d="m21 21-4.3-4.3"/></svg>';

  var spinnerIcon =
    '<svg class="ai-filter__spinner" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 12a9 9 0 1 1-6.219-8.56"/></svg>';

  var checkCircleIcon =
    '<svg class="ai-filter__alert-icon" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"/><path d="m9 11 3 3L22 4"/></svg>';

  var alertCircleIcon =
    '<svg class="ai-filter__alert-icon" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/></svg>';

  var infoIcon =
    '<svg class="ai-filter__alert-icon" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><path d="M12 16v-4"/><path d="M12 8h.01"/></svg>';

  var searchXIcon =
    '<svg class="ai-filter__empty-icon" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="11" cy="11" r="8"/><path d="m21 21-4.3-4.3"/><path d="m8.5 8.5 5 5"/><path d="m13.5 8.5-5 5"/></svg>';

  var lightbulbIcon =
    '<svg class="ai-filter__hint-icon" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M15 14c.2-1 .7-1.7 1.5-2.5 1-.9 1.5-2.2 1.5-3.5A6 6 0 0 0 6 8c0 1 .2 2.2 1.5 3.5.7.7 1.3 1.5 1.5 2.5"/><path d="M9 18h6"/><path d="M10 22h4"/></svg>';

  // --- State ---
  var isOpen = false;
  var isLoading = false;

  // --- Cached DOM filters (extracted once on first submit) ---
  var cachedAvailableFilters = null;

  // --- Section rendering config (detected once) ---
  var sectionConfig = null;

  // =============================================
  // 1. Extract available filters from DOM
  // =============================================

  function extractAvailableFilters() {
    if (cachedAvailableFilters !== null) return cachedAvailableFilters;

    var filters = [];

    // Strategy 1: Parse <details> groups with checkboxes (Dawn / common OS 2.0 themes)
    var detailsGroups = document.querySelectorAll(
      [
        "form[data-collection-filters] details",
        ".facets__form details",
        ".collection-filters details",
        "[data-filter-group]",
        ".filter-group",
      ].join(", "),
    );

    detailsGroups.forEach(function (group) {
      var summary = group.querySelector("summary");
      if (!summary) return;

      var groupName = summary.textContent.trim();
      var values = [];

      var inputs = group.querySelectorAll(
        'input[type="checkbox"], input[type="radio"]',
      );
      inputs.forEach(function (input) {
        var label = group.querySelector('label[for="' + input.id + '"]');
        var labelText = label
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

      if (values.length === 0) {
        var links = group.querySelectorAll("a[href*='filter.']");
        links.forEach(function (link) {
          var text = link.textContent.trim().replace(/\s*\(\d+\)\s*$/, "");
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

    cachedAvailableFilters = filters;
    return filters;
  }

  // =============================================
  // 2. Section rendering detection
  // =============================================

  function detectSectionConfig() {
    if (sectionConfig) return sectionConfig;

    // Check for configured override first
    var overrideSectionId = config.sectionId;
    var overrideGridSelector = config.gridSelector;

    // Common product grid container selectors
    var gridSelectors = [
      "#ProductGridContainer",
      "#product-grid",
      ".collection-product-list",
      ".products-grid",
      "[data-product-grid]",
      ".collection__products",
      "#CollectionProductGrid",
      "#main-collection-product-grid",
    ];

    // Use override grid selector if provided
    if (overrideGridSelector) {
      gridSelectors.unshift(overrideGridSelector);
    }

    var gridContainer = null;
    var gridSelector = null;

    for (var i = 0; i < gridSelectors.length; i++) {
      var el = document.querySelector(gridSelectors[i]);
      if (el) {
        gridContainer = el;
        gridSelector = gridSelectors[i];
        break;
      }
    }

    if (!gridContainer) {
      sectionConfig = { supported: false };
      return sectionConfig;
    }

    // Find the parent shopify section wrapper
    var detectedSectionId = overrideSectionId;
    if (!detectedSectionId) {
      var parent = gridContainer;
      while (parent && parent !== document.body) {
        if (parent.id && parent.id.indexOf("shopify-section-") === 0) {
          detectedSectionId = parent.id.replace("shopify-section-", "");
          break;
        }
        parent = parent.parentElement;
      }
    }

    if (!detectedSectionId) {
      sectionConfig = { supported: false };
      return sectionConfig;
    }

    sectionConfig = {
      supported: true,
      sectionId: detectedSectionId,
      gridSelector: gridSelector,
      gridContainer: gridContainer,
    };

    console.log("[AI Filter] Section rendering config:", {
      sectionId: detectedSectionId,
      gridSelector: gridSelector,
    });

    return sectionConfig;
  }

  // =============================================
  // 3. Render trigger button
  // =============================================

  function renderTriggerButton() {
    var btn = document.createElement("button");
    btn.className = "ai-filter__trigger";
    btn.type = "button";
    btn.innerHTML = sparkleIcon + " " + escapeHtml(config.buttonText);
    btn.addEventListener("click", openModal);
    root.appendChild(btn);
  }

  // =============================================
  // 4. Modal UI
  // =============================================

  function openModal() {
    if (isOpen) return;
    isOpen = true;

    var overlay = document.createElement("div");
    overlay.className = "ai-filter__overlay";
    overlay.id = "ai-filter-overlay";

    var modal = document.createElement("div");
    modal.className = "ai-filter__modal";
    modal.setAttribute("role", "dialog");
    modal.setAttribute("aria-modal", "true");
    modal.setAttribute("aria-label", "Find products with AI");

    modal.innerHTML =
      '<div class="ai-filter__header">' +
      '<h2 class="ai-filter__title">Find products with AI</h2>' +
      '<button class="ai-filter__close" aria-label="Close" type="button">' +
      closeIcon +
      "</button>" +
      "</div>" +
      '<div class="ai-filter__body">' +
      '<div class="ai-filter__search-area">' +
      '<div class="ai-filter__input-wrapper">' +
      searchIcon +
      '<input class="ai-filter__input" type="text" placeholder="' +
      escapeAttr(config.placeholder) +
      '" autocomplete="off" autofocus />' +
      '<kbd class="ai-filter__kbd">\u23CE</kbd>' +
      "</div>" +
      '<button class="ai-filter__submit" type="button">Search</button>' +
      '<div class="ai-filter__hint">' +
      lightbulbIcon +
      '<span>Try: \u201Cred shoes under $50\u201D or \u201Cwarm winter jacket in size L\u201D</span>' +
      "</div>" +
      "</div>" +
      '<div class="ai-filter__results"></div>' +
      "</div>";

    // Position popover above the trigger button
    var triggerBtn = root.querySelector(".ai-filter__trigger");
    var triggerRect = triggerBtn.getBoundingClientRect();
    var gap = 12;
    modal.style.bottom = (window.innerHeight - triggerRect.top + gap) + "px";
    modal.style.right = (window.innerWidth - triggerRect.right) + "px";
    var maxH = triggerRect.top - gap - 16;
    modal.style.maxHeight = Math.max(maxH, 260) + "px";

    overlay.appendChild(modal);
    document.body.appendChild(overlay);

    var closeBtn = modal.querySelector(".ai-filter__close");
    var input = modal.querySelector(".ai-filter__input");
    var submitBtn = modal.querySelector(".ai-filter__submit");

    closeBtn.addEventListener("click", closeModal);

    overlay.addEventListener("click", function (e) {
      if (e.target === overlay) closeModal();
    });

    document.addEventListener("keydown", handleEscape);

    submitBtn.addEventListener("click", function () {
      handleSubmit(input, modal);
    });

    input.addEventListener("keydown", function (e) {
      if (e.key === "Enter") {
        e.preventDefault();
        handleSubmit(input, modal);
      }
    });

    setTimeout(function () {
      input.focus();
    }, 100);
  }

  function closeModal() {
    isOpen = false;
    document.removeEventListener("keydown", handleEscape);

    var overlay = document.getElementById("ai-filter-overlay");
    if (overlay) {
      overlay.remove();
    }
  }

  function handleEscape(e) {
    if (e.key === "Escape") closeModal();
  }

  // --- Reposition popover on resize ---
  function repositionPopover() {
    if (!isOpen) return;
    var overlay = document.getElementById("ai-filter-overlay");
    if (!overlay) return;
    var modal = overlay.querySelector(".ai-filter__modal");
    var triggerBtn = root.querySelector(".ai-filter__trigger");
    if (!modal || !triggerBtn) return;

    var triggerRect = triggerBtn.getBoundingClientRect();
    var gap = 12;
    modal.style.bottom = (window.innerHeight - triggerRect.top + gap) + "px";
    modal.style.right = (window.innerWidth - triggerRect.right) + "px";
    var maxH = triggerRect.top - gap - 16;
    modal.style.maxHeight = Math.max(maxH, 260) + "px";
  }

  window.addEventListener("resize", repositionPopover);

  // =============================================
  // 5. Submit query
  // =============================================

  function handleSubmit(input, modal) {
    var query = input.value.trim();
    if (!query || isLoading) return;

    var resultsArea = modal.querySelector(".ai-filter__results");
    var submitBtn = modal.querySelector(".ai-filter__submit");

    isLoading = true;
    submitBtn.disabled = true;
    resultsArea.innerHTML =
      '<div class="ai-filter__loading">' +
      spinnerIcon +
      '<p class="ai-filter__loading-text">Analyzing your request<span class="ai-filter__loading-dots"></span></p>' +
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
        console.log(
          "[AI Filter] Round-trip: " +
            Math.round(fetchEnd - fetchStart) +
            "ms",
        );

        isLoading = false;
        submitBtn.disabled = false;

        if (data.error) {
          resultsArea.innerHTML =
            '<div class="ai-filter__alert ai-filter__alert--error">' +
            alertCircleIcon +
            "<span>" + escapeHtml(data.error) + "</span>" +
            "</div>";
          return;
        }

        var hasFilters = data.filters && data.filters.length > 0;
        var hasSearchQuery = data.searchQuery && data.searchQuery.trim().length > 0;

        if (!hasFilters && !hasSearchQuery) {
          resultsArea.innerHTML =
            '<div class="ai-filter__alert ai-filter__alert--error">' +
            alertCircleIcon +
            "<span>No matching filters found. Try a different description.</span>" +
            "</div>";
          return;
        }

        if (data.explanation) {
          resultsArea.innerHTML =
            '<div class="ai-filter__alert ai-filter__alert--success">' +
            checkCircleIcon +
            "<span>" + escapeHtml(data.explanation) + "</span>" +
            "</div>";
        }

        requestAnimationFrame(function () {
          applyFilters(data.filters || [], query, data.searchQuery || null);
        });
      })
      .catch(function () {
        isLoading = false;
        submitBtn.disabled = false;
        resultsArea.innerHTML =
          '<div class="ai-filter__alert ai-filter__alert--error">' +
          alertCircleIcon +
          "<span>Something went wrong. Please try again.</span>" +
          "</div>";
      });
  }

  // =============================================
  // 6. Apply filters — build URL and navigate/AJAX
  // =============================================

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

  function applyFilters(filters, query, searchQuery) {
    var isCollectionPage = /\/collections\//.test(window.location.pathname);
    var hasFilters = filters && filters.length > 0;

    // --- searchQuery-only (no filters): redirect to search ---
    if (!hasFilters && searchQuery) {
      var searchUrl = new URL("/search", window.location.origin);
      searchUrl.searchParams.set("type", "product");
      searchUrl.searchParams.set("q", searchQuery);
      window.location.href = searchUrl.toString();
      return;
    }

    // --- Non-collection pages: always navigate ---
    if (!isCollectionPage) {
      var navUrl = new URL("/search", window.location.origin);
      navUrl.searchParams.set("type", "product");

      // Build search query from structured filter values
      var searchTerms = [];
      filters.forEach(function (filter) {
        if (filter.productType) searchTerms.push(filter.productType);
        if (filter.productVendor) searchTerms.push(filter.productVendor);
        if (filter.tag) searchTerms.push(filter.tag);
        if (filter.variantOption && filter.variantOption.value) {
          searchTerms.push(filter.variantOption.value);
        }
      });

      var qVal = searchQuery || (searchTerms.length > 0 ? searchTerms.join(" ") : query);
      navUrl.searchParams.set("q", qVal);
      appendFilterParams(navUrl, filters);

      window.location.href = navUrl.toString();
      return;
    }

    // --- Collection page: try AJAX first, fallback to navigation ---
    var sc = detectSectionConfig();

    if (sc.supported) {
      applyFiltersViaAjax(filters, query, sc);
    } else {
      applyFiltersViaNavigation(filters, query);
    }
  }

  function applyFiltersViaNavigation(filters, query) {
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
    window.location.href = url.toString();
  }

  function applyFiltersViaAjax(filters, query, sc, relaxationAttempt) {
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

    // Build section rendering URL
    var sectionUrl = new URL(url.toString());
    sectionUrl.searchParams.set("sections", sc.sectionId);

    // Add loading state to grid
    if (sc.gridContainer) {
      sc.gridContainer.classList.add("ai-filter__grid-loading");
    }

    fetch(sectionUrl.toString())
      .then(function (res) {
        return res.json();
      })
      .then(function (sections) {
        var html = sections[sc.sectionId];
        if (!html) {
          // Fallback to navigation if section rendering fails
          applyFiltersViaNavigation(filters, query);
          return;
        }

        // Count products in returned HTML
        var productCount = countProductsInHtml(html);

        // Zero results handling (Phase 5)
        if (productCount === 0 && !relaxationAttempt) {
          var relaxations = relaxFilters(filters);
          if (relaxations.length > 0) {
            // Auto-try first relaxation
            applyFiltersViaAjax(relaxations[0].filters, query, sc, {
              attempt: 1,
              removedLabels: relaxations[0].removedLabels,
              originalFilters: filters,
            });
            return;
          }
        }

        if (productCount === 0 && relaxationAttempt && relaxationAttempt.attempt < 2) {
          var relaxations2 = relaxFilters(relaxationAttempt.attempt === 1 ? filters : relaxationAttempt.originalFilters);
          // Try next relaxation that's different from current
          var nextIdx = relaxationAttempt.attempt;
          if (nextIdx < relaxations2.length) {
            applyFiltersViaAjax(relaxations2[nextIdx].filters, query, sc, {
              attempt: relaxationAttempt.attempt + 1,
              removedLabels: relaxations2[nextIdx].removedLabels,
              originalFilters: relaxationAttempt.originalFilters || filters,
            });
            return;
          }
        }

        // Swap grid content
        var parser = new DOMParser();
        var doc = parser.parseFromString(html, "text/html");
        var newGrid = doc.querySelector(sc.gridSelector);

        if (newGrid && sc.gridContainer) {
          sc.gridContainer.innerHTML = newGrid.innerHTML;
          sc.gridContainer.classList.remove("ai-filter__grid-loading");
        } else if (sc.gridContainer) {
          // Fallback: replace the entire section content
          var sectionWrapper = document.getElementById("shopify-section-" + sc.sectionId);
          if (sectionWrapper) {
            sectionWrapper.innerHTML = html;
            // Re-detect grid container
            var freshGrid = document.querySelector(sc.gridSelector);
            if (freshGrid) {
              sc.gridContainer = freshGrid;
            }
          }
        }

        // Show relaxation notice if filters were relaxed
        if (relaxationAttempt && relaxationAttempt.removedLabels && productCount > 0) {
          showRelaxationNotice(relaxationAttempt.removedLabels, productCount);
        }

        // If still 0 after all auto-attempts, show interactive options in modal
        if (productCount === 0 && relaxationAttempt && relaxationAttempt.attempt >= 2) {
          showZeroResultsInModal(filters, query, sc);
        }

        // Update browser URL (without section param)
        url.searchParams.delete("sections");
        history.pushState({ aiFilter: true, filters: filters }, "", url.toString());

        // Close modal and scroll to grid
        closeModal();
        if (sc.gridContainer) {
          sc.gridContainer.scrollIntoView({ behavior: "smooth", block: "start" });
        }
      })
      .catch(function () {
        if (sc.gridContainer) {
          sc.gridContainer.classList.remove("ai-filter__grid-loading");
        }
        // Fallback to full navigation
        applyFiltersViaNavigation(filters, query);
      });
  }

  // =============================================
  // 7. Product count detection
  // =============================================

  function countProductsInHtml(html) {
    var parser = new DOMParser();
    var doc = parser.parseFromString(html, "text/html");

    // Try multiple common product card selectors
    var selectors = [
      ".product-card",
      ".grid__item .card",
      ".grid-product",
      ".product-grid-item",
      "[data-product-card]",
      ".collection-product-card",
      ".product-item",
      ".grid__item[data-product-id]",
      "li.grid__item",
      ".productgrid--item",
    ];

    for (var i = 0; i < selectors.length; i++) {
      var items = doc.querySelectorAll(selectors[i]);
      if (items.length > 0) return items.length;
    }

    // Heuristic: check for "no products" messages
    var noResultsSelectors = [
      ".collection--empty",
      ".no-results",
      "[data-no-results]",
      ".collection-empty",
    ];
    for (var j = 0; j < noResultsSelectors.length; j++) {
      if (doc.querySelector(noResultsSelectors[j])) return 0;
    }

    return -1; // Unknown
  }

  // =============================================
  // 8. Filter relaxation (Phase 5)
  // =============================================

  function relaxFilters(filters) {
    // Priority order for removal: variantOption → tag → price → vendor → productType
    var relaxations = [];
    var filterTypes = ["variantOption", "tag", "price", "productVendor", "productType"];

    for (var t = 0; t < filterTypes.length; t++) {
      var type = filterTypes[t];
      var hasType = false;
      var relaxed = [];
      var removedLabel = "";

      for (var i = 0; i < filters.length; i++) {
        var f = filters[i];
        if (f[type] !== undefined && f[type] !== null) {
          hasType = true;
          // Build removed label
          if (type === "price") {
            var pMin = f.price.min !== undefined ? f.price.min : "";
            var pMax = f.price.max !== undefined ? f.price.max : "";
            removedLabel = "price range" + (pMin || pMax ? " (" + pMin + "–" + pMax + ")" : "");
          } else if (type === "variantOption") {
            removedLabel = (f.variantOption.name || "") + ": " + (f.variantOption.value || "");
          } else {
            removedLabel = type.replace("product", "").toLowerCase() + ' "' + f[type] + '"';
          }
          // Remove this filter property
          var copy = {};
          for (var key in f) {
            if (key !== type) copy[key] = f[key];
          }
          // Only add if the copy still has meaningful properties
          if (Object.keys(copy).length > 0) {
            relaxed.push(copy);
          }
        } else {
          relaxed.push(f);
        }
      }

      if (hasType && relaxed.length > 0) {
        relaxations.push({
          filters: relaxed,
          removedLabels: removedLabel,
        });
      }
    }

    return relaxations;
  }

  function showRelaxationNotice(removedLabels, count) {
    // Remove any existing notice
    var existing = document.querySelector(".ai-filter__alert--warning");
    if (existing) existing.remove();

    var notice = document.createElement("div");
    notice.className = "ai-filter__alert ai-filter__alert--warning";
    notice.innerHTML =
      infoIcon +
      "<span>We broadened your search by removing " +
      escapeHtml(removedLabels) +
      ". Showing " +
      count +
      " result" +
      (count !== 1 ? "s" : "") +
      ".</span>";

    var sc = detectSectionConfig();
    if (sc.gridContainer && sc.gridContainer.parentNode) {
      sc.gridContainer.parentNode.insertBefore(notice, sc.gridContainer);
    }
  }

  function showZeroResultsInModal(originalFilters, query, sc) {
    var overlay = document.getElementById("ai-filter-overlay");
    if (!overlay) {
      openModal();
      overlay = document.getElementById("ai-filter-overlay");
    }
    if (!overlay) return;

    var resultsArea = overlay.querySelector(".ai-filter__results");
    if (!resultsArea) return;

    var relaxations = relaxFilters(originalFilters);

    var html =
      '<div class="ai-filter__empty">' +
      searchXIcon +
      '<p class="ai-filter__empty-title">No exact matches found</p>' +
      '<p class="ai-filter__empty-description">Try broadening your search by removing a filter.</p>' +
      '<div class="ai-filter__empty-actions">';

    for (var i = 0; i < relaxations.length; i++) {
      html +=
        '<button class="ai-filter__btn ai-filter__btn--outline" data-relax-idx="' +
        i +
        '">' +
        "Remove " +
        escapeHtml(relaxations[i].removedLabels) +
        "</button>";
    }

    html +=
      '<button class="ai-filter__btn ai-filter__btn--default" data-search-all="true">' +
      "Search all products instead" +
      "</button>";

    html += "</div></div>";

    resultsArea.innerHTML = html;

    // Bind relaxation button events
    var buttons = resultsArea.querySelectorAll(".ai-filter__btn");
    buttons.forEach(function (btn) {
      btn.addEventListener("click", function () {
        if (btn.dataset.searchAll) {
          var searchUrl = new URL("/search", window.location.origin);
          searchUrl.searchParams.set("type", "product");
          searchUrl.searchParams.set("q", query);
          window.location.href = searchUrl.toString();
          return;
        }

        var idx = parseInt(btn.dataset.relaxIdx, 10);
        if (relaxations[idx]) {
          closeModal();
          applyFiltersViaAjax(relaxations[idx].filters, query, sc);
        }
      });
    });
  }

  // =============================================
  // 9. History popstate handler
  // =============================================

  window.addEventListener("popstate", function (e) {
    if (!e.state || !e.state.aiFilter) return;

    var sc = detectSectionConfig();
    if (!sc.supported) {
      // Fallback: just reload
      window.location.reload();
      return;
    }

    // Re-fetch section for the restored URL
    var restoredUrl = new URL(window.location.href);
    restoredUrl.searchParams.set("sections", sc.sectionId);

    if (sc.gridContainer) {
      sc.gridContainer.classList.add("ai-filter__grid-loading");
    }

    fetch(restoredUrl.toString())
      .then(function (res) {
        return res.json();
      })
      .then(function (sections) {
        var html = sections[sc.sectionId];
        if (!html) {
          window.location.reload();
          return;
        }

        var parser = new DOMParser();
        var doc = parser.parseFromString(html, "text/html");
        var newGrid = doc.querySelector(sc.gridSelector);

        if (newGrid && sc.gridContainer) {
          sc.gridContainer.innerHTML = newGrid.innerHTML;
          sc.gridContainer.classList.remove("ai-filter__grid-loading");
        } else {
          window.location.reload();
        }
      })
      .catch(function () {
        window.location.reload();
      });
  });

  // =============================================
  // Utilities
  // =============================================

  function escapeHtml(str) {
    var div = document.createElement("div");
    div.appendChild(document.createTextNode(str));
    return div.innerHTML;
  }

  function escapeAttr(str) {
    return str
      .replace(/&/g, "&amp;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#39;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;");
  }

  // =============================================
  // Initialize
  // =============================================

  renderTriggerButton();
})();
