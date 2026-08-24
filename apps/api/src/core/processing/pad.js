
export function padImage(image, targetWidth, targetHeight) {

  const { data, width, height } = image;

  const padded = Buffer.alloc(targetWidth * targetHeight * 4, 255);

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const srcIdx = (y * width + x) * 4;
      const dstIdx = (y * targetWidth + x) * 4;

      data.copy(padded, dstIdx, srcIdx, srcIdx + 4);
    }
  }

  return {
    data: padded,
  };
}