export async function scrollPage(page, config) {
  const { distance, delay, interval } = config;

  await page.evaluate(
    async ({ distance, delay, interval }) => {
      await new Promise((resolve) => {
        let totalHeight = 0;

        const timer = setInterval(() => {
          window.scrollBy(0, distance);
          totalHeight += distance;

          if (totalHeight > document.body.scrollHeight) {
            clearInterval(timer);
            window.scrollTo(0, 0);
            setTimeout(resolve, delay);
          }
        }, interval);
      });
    },
    { distance, delay, interval },
  );
}
