export async function disableAnimations(page) {
  // Disable CSS animations and transitions
  await page.addStyleTag({
    content: `
      *,
      *::before,
      *::after {
        animation: none !important;
        transition: none !important;
      }

      // Specifically target videos to prevent any dynamic content from playing
      video {
      animation: none !important;
      transition: none !important;
      }
    `,
  });

  //handle the videos or dynamic media
  await page.evaluate(() => {
    function pauseAndResetVideo(vid) {
      try {
        vid.pause();
        vid.autoplay = false;
        vid.loop = false;
        vid.removeAttribute("autoplay");
        vid.removeAttribute("loop");

        const resetAndPause = () => {
          try {
            vid.pause();
            vid.autoplay = false;
            vid.loop = false;
            if (vid.readyState > 0 || vid.currentTime > 0) {
              {
                vid.currentTime = 5;
              }
            }
          } catch {}
        };

        resetAndPause();

        vid.addEventListener("play", resetAndPause);
        vid.addEventListener("loadedmetadata", resetAndPause);
      } catch {}
    }
    document.querySelectorAll("video").forEach((video) => pauseAndResetVideo(video));
  });
}
