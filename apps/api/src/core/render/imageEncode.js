import sharp from "sharp";

export async function encoder(rawBuffer, width, height) {
    return await sharp(rawBuffer, {
        raw: {
            width,
            height,
            channels: 4
        }
    })
        .png()
        .toBuffer();
}