export async function removeAdds(page) {

  await page.evaluate(() => {
    document
      .querySelectorAll("[data-random], .ads, iframe")
      .forEach((el) => el.remove());
  });
  
}
