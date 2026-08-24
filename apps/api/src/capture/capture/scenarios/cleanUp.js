export async function cleanUp(page) {
  let isContentHidden = false;

  // wait for delayed popups that appear after page load
  await page.waitForTimeout(1500);

  //, button:has-text("Yes")
  const btns = await page.$$(
    'button:has-text("Accept All"), button:has-text("Accept All Cookies") , button:has-text("Accept Cookies") , button:has-text("I Agree") , button:has-text("Allow All"), button:has-text("Got It"), button:has-text("Yes, I Agree"), button:has-text("Accept")',
  );
  //accept cookies if the button exists
  for (const btn of btns) {
    if (await btn.isVisible()) {
      await btn.click();
      await page.waitForTimeout(800);
      isContentHidden = true;
    }
  }

  await removeBlockingPopups(page);
  async function removeBlockingPopups(page, options = {}) {
    const { retries = 3, delay = 700, debug = false } = options;

    // Common popup/modal selectors
    const KNOWN_SELECTORS = [
      '[role="dialog"]',
      '[aria-modal="true"]',

      '[class*="modal"]',
      '[class*="popup"]',
      '[class*="overlay"]',
      '[class*="backdrop"]',
      '[class*="cookie"]',
      '[class*="consent"]',

      '[id*="modal"]',
      '[id*="popup"]',
      '[id*="overlay"]',
      '[id*="cookie"]',
      '[id*="consent"]',
    ].join(",");

    for (let attempt = 0; attempt < retries; attempt++) {
      if (debug) {
        console.log(`Popup cleanup attempt ${attempt + 1}`);
      }

      await page.evaluate(
        ({ KNOWN_SELECTORS, debug }) => {
          const hiddenElements = new Set();

          const hideElement = (el, reason) => {
            if (!el || hiddenElements.has(el)) return;

            hiddenElements.add(el);

            if (debug) {
              console.log("Hiding:", reason, el);
            }

            // safer than remove()
            el.style.setProperty("display", "none", "important");
            el.style.setProperty("visibility", "hidden", "important");
            el.style.setProperty("pointer-events", "none", "important");
          };

          //  Remove known popup selectors

          document.querySelectorAll(KNOWN_SELECTORS).forEach((el) => {
            hideElement(el, "known-selector");
          });

          // Detect blockers at center of screen

          const centerX = window.innerWidth / 2;
          const centerY = window.innerHeight / 2;

          const centerElements = document.elementsFromPoint(centerX, centerY);

          centerElements.forEach((el) => {
            try {
              if (!el || el === document.body || el === document.documentElement) {
                return;
              }

              const s = getComputedStyle(el);
              const rect = el.getBoundingClientRect();

              const z = parseInt(s.zIndex) || 0;

              const isFixed = s.position === "fixed" || s.position === "sticky";

              const largeEnough = rect.width > window.innerWidth * 0.25 && rect.height > window.innerHeight * 0.15;

              const visuallyVisible = s.display !== "none" && s.visibility !== "hidden" && s.opacity !== "0";

              const blocksClicks = s.pointerEvents !== "none";

              const highZ = z > 50;

              const modalLike = /modal|popup|overlay|dialog|cookie|consent|backdrop/i.test((el.className || "") + " " + (el.id || ""));

              const shouldHide = visuallyVisible && blocksClicks && ((isFixed && highZ && largeEnough) || modalLike);

              if (shouldHide) {
                hideElement(el, "center-blocker");
              }
            } catch {}
          });

          // Restore page scrolling

          document.body.style.setProperty("overflow", "auto", "important");

          document.documentElement.style.setProperty("overflow", "auto", "important");
        },
        { KNOWN_SELECTORS, debug },
      );

      // wait for delayed popups
      await page.waitForTimeout(delay);
    }
  }

  return isContentHidden;
}
