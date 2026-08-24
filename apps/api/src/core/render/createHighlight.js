import { writeToFile } from "../utils/fileWriter.js";

export function renderWithHighlight(img2, regions, width, height, mask) {

    // clone original image
    const output = new Uint8Array(img2);

    // const output = img2;// not copy now discarding the img2 data to save memory, we will only modify the diff pixels in place and keep the rest unchanged

    const cyan = [0, 255, 255]; // cyan
    const ALPHA = 0.3; // transparency for highlight

    // Apply highlight ONLY on actual diff pixels
    for (const region of regions) {
        for (let y = region.minY; y <= region.maxY; y++) {
            for (let x = region.minX; x <= region.maxX; x++) {
                const idx = y * width + x;

                // only highlight real diff pixels
                if (!mask[idx]) continue;

                const i = idx * 4;

                output[i] = img2[i] * (1 - ALPHA) + cyan[0] * ALPHA;
                output[i + 1] = img2[i + 1] * (1 - ALPHA) + cyan[1] * ALPHA;
                output[i + 2] = img2[i + 2] * (1 - ALPHA) + cyan[2] * ALPHA;
                output[i + 3] = 255;
            }
        }
    }

    // Draw rectangle borders
    for (const region of regions) {
        drawBorder(output, region, width);
    }

    // writeToFile("highlightedImage.json", { width, height, data: Array.from(output) });
    return output;
}

//helper function to draw border
function drawBorder(data, region, width) {
    const { minX, minY, maxX, maxY } = region;

    const color = [255, 0, 0]; // red border
    const thickness = 5; // border thickness

    for (let t = 0; t < thickness; t++) {

        // top & bottom
        for (let x = minX; x <= maxX; x++) {
            setPixel(data, x, minY + t, width, color);
            setPixel(data, x, maxY - t, width, color);
        }

        // left & right
        for (let y = minY + t + 1; y <= maxY - t - 1; y++) { //y = minY + t + 1; y <= maxY - t - 1; to avoid redrawing corners
            setPixel(data, minX + t, y, width, color);
            setPixel(data, maxX - t, y, width, color);
        }
    }
}

//helper function to set pixel color in the output image
function setPixel(data, x, y, width, color) {
    const i = (y * width + x) * 4;

    data[i] = color[0];
    data[i + 1] = color[1];
    data[i + 2] = color[2];
    data[i + 3] = 255;
}