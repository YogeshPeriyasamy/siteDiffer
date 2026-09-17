// ---------------------------------------------------------------------------
// measurePage — full document dimensions needed by pageStitcher
// ---------------------------------------------------------------------------
export async function measurePage(page, scrollRootSelector, scrollRootIsWindow) {
  return page.evaluate(
    ({ scrollRootSelector, scrollRootIsWindow }) => {
      const root = scrollRootIsWindow ? document.scrollingElement || document.documentElement : document.querySelector(scrollRootSelector);
      const maxScrollY = scrollRootIsWindow
        ? Math.max(0, root.scrollHeight - window.innerHeight)
        : Math.max(0, root.scrollHeight - root.clientHeight);
      return {
        width: Math.max(document.documentElement.scrollWidth, document.body?.scrollWidth || 0, window.innerWidth),
        height: Math.max(root.scrollHeight, document.documentElement.scrollHeight, document.body?.scrollHeight || 0, window.innerHeight),
        maxScrollY,
      };
    },
    { scrollRootSelector, scrollRootIsWindow },
  );
}
