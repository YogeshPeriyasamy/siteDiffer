import { writeToFile } from "../utils/fileWriter.js";

export function denoise(mask, width, height) {
    // const output = new Uint8Array(mask);

    const NEIGHBOR_OFFSETS = [[-1, -1], [0, -1], [1, -1], [-1, 0], [1, 0], [-1, 1], [0, 1], [1, 1]];

    function hasNeighbor(x, y) {
        for (const [dx, dy] of NEIGHBOR_OFFSETS) {
            const nx = x + dx;
            const ny = y + dy;
            if (nx >= 0 && nx < width && ny >= 0 && ny < height) {
                if (mask[ny * width + nx]) return true;
            }
        }
        return false;
    }

    for (let y = 0; y < height; y++) {
        for (let x = 0; x < width; x++) {
            const idx = y * width + x;

            if (mask[idx] && !hasNeighbor(x, y)) { //check whether the current pixel is different and has no neighboring pixels that are different
                mask[idx] = 0;
            }
        }
    }

    // writeToFile("denoisedData.json", { width, height, data: Array.from(mask) });
    return mask;
}