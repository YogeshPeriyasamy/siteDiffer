import { normalizeImage } from "./normalize.js";
import { padImage } from "./pad.js";

export async function preprocessImage(liveImagePath, stagedImagePath) {
    try {

        // console.log("Preprocessing images:", { liveImagePath, stagedImagePath });
        // Normalize the image data to ensure consistent comparison
        const liveImage = await normalizeImage(liveImagePath);
        const stagedImage = await normalizeImage(stagedImagePath);

        // Pad the images to the same dimensions
        const maxWidth = Math.max(liveImage.width, stagedImage.width);
        const maxHeight = Math.max(liveImage.height, stagedImage.height);

        // console.log("Max dimensions for padding:", { maxWidth, maxHeight });

        let paddedLiveImage;
        let paddedStagedImage;

        if (liveImage.width !== stagedImage.width || liveImage.height !== stagedImage.height) {
            paddedLiveImage = await padImage(liveImage, maxWidth, maxHeight);
            paddedStagedImage = await padImage(stagedImage, maxWidth, maxHeight);
        }
        return {
            width: maxWidth,
            height: maxHeight,
            liveImage: paddedLiveImage ? paddedLiveImage.data : liveImage.data,
            stagedImage: paddedStagedImage ? paddedStagedImage.data : stagedImage.data
        };
    } catch (error) {
        console.error("Error preprocessing images:", error);
        throw error;
    }
}