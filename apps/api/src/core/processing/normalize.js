import sharp from "sharp";

export async function normalizeImage(imagePath) {

    console.log("Normalizing image:", imagePath);
    // Implementation for normalizing image data
    const { data, info } = await sharp(imagePath).ensureAlpha().raw().toBuffer({ resolveWithObject: true });

    return {
        data: data,
        width: info.width,
        height: info.height,
        channel: info.channels
    };
}