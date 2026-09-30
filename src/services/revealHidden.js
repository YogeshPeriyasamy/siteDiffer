export async function showAccordions(page) {
  let totalPanelsOpened = 0;
  let logs = [];
  let passes = 0;
  let previousRemainingClosed = -1;
  let maxPasses = 3;
  let settleMs = 1000;

  for (let pass = 0; pass < maxPasses; pass++) {
    passes++;

    // All DOM access must be inside page.evaluate — document does not exist in Node.js
    const result = await page.evaluate(
      ({ passNum }) => {
        let panelsOpened = 0;
        const logs = [];

        // =============================================================================
        // helpers
        // =============================================================================
        function hasMuiCollapseSibling(el) {
          const next = el.nextElementSibling;
          return !!(next && next.classList.contains("MuiCollapse-root"));
        }

        function query(selector) {
          try {
            return Array.from(document.querySelectorAll(selector));
          } catch (_) {
            return [];
          }
        }

        function getById(id) {
          return id ? document.getElementById(id) : null;
        }

        function getEffectiveDisplay(el) {
          const cs = getComputedStyle(el);
          if (cs.display === "none") {
            return el.dataset.originalDisplay || "block";
          }
          return cs.display;
        }

        function isPanelHidden(el) {
          if (!(el instanceof Element)) return false;
          if (el.hidden) return true;
          if (el.getAttribute("aria-hidden") === "true") return true;

          const cs = getComputedStyle(el);
          if (cs.display === "none") return true;
          if (cs.visibility === "hidden") return true;
          if (parseFloat(cs.opacity) === 0) return true;

          // MUI collapse hidden class — catches overflow:visible edge case
          if (el.classList.contains("MuiCollapse-hidden")) return true;
          if (el.classList.contains("MuiCollapse-entering")) return true; // mid-transition

          // Common library hidden classes
          if (el.classList.contains("collapsed")) return true;
          if (el.classList.contains("is-hidden")) return true;

          // height/max-height collapse pattern
          const h = parseFloat(cs.height);
          const mh = parseFloat(cs.maxHeight);
          if (!isNaN(h) && h === 0 && cs.overflow !== "visible") return true;
          if (!isNaN(mh) && mh === 0 && cs.overflow !== "visible") return true;

          return false;
        }

        function isAccordionTrigger(trigger) {
          if (!(trigger instanceof Element)) return false;

          //if it is carousel elementwhich is swiper
          const carouselAncestor = trigger.closest('[class*="carousel"], [class*="slick"], [class*="swiper"], [class*="splide"]');
          if (carouselAncestor) return false;

          const tag = trigger.tagName.toLowerCase();
          const role = (trigger.getAttribute("role") || "").toLowerCase();

          // Check for MUI collapse sibling BEFORE the isInteractive check
          // so it can be used as part of that condition
          const nextSibling = trigger.nextElementSibling;
          const hasMuiCollapseSibling = !!(
            nextSibling &&
            (nextSibling.classList.contains("MuiCollapse-root") ||
              nextSibling.classList.contains("MuiCollapse-hidden") ||
              nextSibling.classList.contains("MuiCollapse-entered"))
          );

          const isInteractive = tag === "button" || tag === "summary" || role === "button" || role === "tab" || hasMuiCollapseSibling;
          if (!isInteractive) return false;

          if (trigger.hasAttribute("aria-controls")) return true;
          if (trigger.hasAttribute("data-bs-target")) return true;
          if (trigger.hasAttribute("data-target")) return true;
          if (trigger.getAttribute("data-bs-toggle") === "collapse") return true;
          if (trigger.getAttribute("data-toggle") === "collapse") return true;
          if (tag === "summary" && trigger.closest("details")) return true;

          // MUI accordion: div trigger with MuiCollapse sibling IS the relationship signal
          if (hasMuiCollapseSibling) return true;

          const href = trigger.getAttribute("href");
          if (href && href.startsWith("#") && href.length > 1) return true;

          if (trigger.hasAttribute("aria-expanded")) {
            const next = trigger.nextElementSibling;
            if (next && isPanelHidden(next)) return true;
          }

          return false;
        }

        function resolvePanels(trigger) {
          const panels = new Set();

          const ctrl = trigger.getAttribute("aria-controls");
          if (ctrl) {
            ctrl
              .split(/\s+/)
              .filter(Boolean)
              .forEach((id) => {
                const el = getById(id);
                if (el) panels.add(el);
              });
          }

          const sel = trigger.getAttribute("data-bs-target") || trigger.getAttribute("data-target");
          if (sel) {
            query(sel).forEach((el) => panels.add(el));
          }

          const href = trigger.getAttribute("href");
          if (href && href.startsWith("#") && href.length > 1) {
            const el = getById(href.slice(1));
            if (el) panels.add(el);
          }

          if (panels.size === 0 && trigger.hasAttribute("aria-expanded")) {
            const next = trigger.nextElementSibling;
            if (next && isPanelHidden(next)) panels.add(next);
          }

          if (panels.size === 0) {
            const item = trigger.closest(".accordion-item, [data-accordion-item], [data-accordion]");
            if (item) {
              query(".accordion-collapse, .accordion-content, .accordion-panel, .collapse").forEach((el) => {
                if (item.contains(el)) panels.add(el);
              });
            }
          }

          //MUI: next sibling is the collapse panel
          if (panels.size === 0) {
            const next = trigger.nextElementSibling;
            if (
              next &&
              (next.classList.contains("MuiCollapse-root") ||
                next.classList.contains("MuiCollapse-hidden") ||
                next.classList.contains("MuiCollapse-entered"))
            ) {
              panels.add(next);
            }
          }

          return [...panels];
        }

        // Bug fix: forceOpen was incomplete — added all forcing logic
        function forceOpen(panel) {
          if (!(panel instanceof HTMLElement)) return false;

          const wasHidden = isPanelHidden(panel);

          if (!panel.dataset.originalDisplay) {
            const cs = getComputedStyle(panel);
            if (cs.display !== "none") {
              panel.dataset.originalDisplay = cs.display;
            }
          }

          const displayValue = getEffectiveDisplay(panel);

          panel.removeAttribute("hidden");
          panel.removeAttribute("inert");
          if (panel.getAttribute("aria-hidden") === "true") {
            panel.setAttribute("aria-hidden", "false");
          }

          panel.style.setProperty("display", displayValue, "important");
          panel.style.setProperty("visibility", "visible", "important");
          panel.style.setProperty("opacity", "1", "important");
          panel.style.setProperty("height", "auto", "important");
          panel.style.setProperty("max-height", "none", "important");
          panel.style.setProperty("overflow", "visible", "important");

          // Bootstrap: swap classes
          panel.classList.remove("collapse", "collapsing");
          panel.classList.add("show");

          return wasHidden;
        }

        // =============================================================================
        // main
        // =============================================================================

        // 0. Remove exclusivity restrictions before opening anything
        query("details[name]").forEach((details) => details.removeAttribute("name"));

        query("[data-bs-parent], [data-parent]").forEach((el) => {
          el.removeAttribute("data-bs-parent");
          el.removeAttribute("data-parent");
        });

        // 1. Open all native <details> accordions
        query("details:not([open])").forEach((detail) => {
          detail.open = true;
          detail.removeAttribute("name");
          panelsOpened++;
          logs.push(`accordion ${detail.id || detail.className || ""} opened`);
        });

        // 2. Build trigger→panel pairs
        // Bug fix: '[role="button"]' and '[role="tab"]' — was 'role["button"]' (invalid CSS)
        const triggerAttributes = [
          "button",
          "summary",
          '[role="button"]',
          '[role="tab"]',
          '[data-bs-toggle="collapse"]',
          '[data-toggle="collapse"]',
        ].join(",");

        const pairs = [];
        const seenPanels = new Set();

        query(triggerAttributes).forEach((trigger) => {
          if (!isAccordionTrigger(trigger)) return;

          resolvePanels(trigger).forEach((panel) => {
            pairs.push({ trigger, panel });
            seenPanels.add(panel);
          });
        });

        logs.push(`pass ${passNum}: ${pairs.length} trigger→panel pairs`);

        //3. MUI uses plain div triggers — not button/role/aria — so triggerQuery misses them.
        // Find MuiCollapse panels directly and walk back to their trigger sibling.
        query(".MuiCollapse-root").forEach((panel) => {
          const trigger = panel.previousElementSibling;
          if (!trigger) return;
          if (!hasMuiCollapseSibling(trigger)) return; // sanity: trigger→panel confirmed
          if (seenPanels.has(panel)) return; // already found via normal path
          pairs.push({ trigger, panel });
          seenPanels.add(panel);
        });

        logs.push(`pass ${passNum}: ${pairs.length} trigger→panel pairs (after MUI pass)`);

        // 4. Force all panels open before clicking
        for (const { trigger, panel } of pairs) {
          if (trigger.hasAttribute("aria-expanded")) {
            trigger.setAttribute("aria-expanded", "true");
          }
          const opened = forceOpen(panel);
          if (opened) panelsOpened++;
        }

        // 5. Click JS-driven triggers to fire framework handlers
        const clickedTriggers = new Set();

        for (const { trigger, panel } of pairs) {
          if (clickedTriggers.has(trigger)) continue;

          const tag = trigger.tagName.toLowerCase();
          const role = (trigger.getAttribute("role") || "").toLowerCase();

          if (tag !== "button" && role !== "button" && role !== "tab" && !hasMuiCollapseSibling(trigger)) continue;

          const stillClosed = isPanelHidden(panel) || trigger.getAttribute("aria-expanded") === "false";
          if (!stillClosed) continue;

          try {
            trigger.click();
            clickedTriggers.add(trigger);
            logs.push(`clicked: ${trigger.id || trigger.textContent?.trim().slice(0, 40)}`);
          } catch (_) {}
        }

        // 6. Re-force all panels open (counters exclusive JS accordion logic)
        for (const { trigger, panel } of pairs) {
          if (trigger.hasAttribute("aria-expanded")) {
            trigger.setAttribute("aria-expanded", "true");
          }
          forceOpen(panel);
        }

        // Count remaining closed (unique panels only — not per-pair)
        let remainingClosed = 0;
        seenPanels.forEach((panel) => {
          if (isPanelHidden(panel)) remainingClosed++;
        });

        return { panelsOpened, remainingClosed, logs };
      },
      { passNum: pass + 1 },
    );

    totalPanelsOpened += result.panelsOpened;
    logs.push(...result.logs);

    await page.waitForTimeout(settleMs);

    // Early exit: nothing left to open
    if (result.remainingClosed === 0 && result.panelsOpened === 0) break;

    // Early exit: stuck — not improving between passes
    if (result.remainingClosed === previousRemainingClosed && result.panelsOpened === 0) break;

    previousRemainingClosed = result.remainingClosed;
  }

  // Final verification
  const remainingClosed = await page.evaluate(() => {
    function isPanelHidden(el) {
      if (el.hidden) return true;
      if (el.getAttribute("aria-hidden") === "true") return true;
      const cs = getComputedStyle(el);
      if (cs.display === "none") return true;
      if (cs.visibility === "hidden") return true;
      if (parseFloat(cs.opacity) === 0) return true;
      const h = parseFloat(cs.height);
      const mh = parseFloat(cs.maxHeight);
      if (!isNaN(h) && h === 0 && cs.overflow !== "visible") return true;
      if (!isNaN(mh) && mh === 0 && cs.overflow !== "visible") return true;
      return false;
    }

    let count = 0;
    const seen = new Set();

    document.querySelectorAll("[aria-controls],[data-bs-target],[data-target]").forEach((trigger) => {
      const ctrl = trigger.getAttribute("aria-controls");
      if (ctrl)
        ctrl
          .split(/\s+/)
          .filter(Boolean)
          .forEach((id) => {
            const el = document.getElementById(id);
            if (el && !seen.has(el)) {
              seen.add(el);
              if (isPanelHidden(el)) count++;
            }
          });
    });

    return count;
  });

  return { passes, panelsOpened: totalPanelsOpened, remainingClosed, logs };
}
