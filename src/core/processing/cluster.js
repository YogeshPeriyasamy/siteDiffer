import { writeToFile } from "../utils/fileWriter.js";

export function findRegions(mask, width, height) {
    const visited = new Uint8Array(width * height);
    const regions = [];

    function floodFill(startX, startY) {
        const stack = [startX + startY * width]; // store flat index

        let minX = startX, maxX = startX;
        let minY = startY, maxY = startY;

        while (stack.length) {
            const idx = stack.pop();
            const x = idx % width;
            const y = Math.floor(idx / width);

            if (visited[idx]) continue;
            visited[idx] = 1;

            if (!mask[idx]) continue;

            minX = Math.min(minX, x);
            maxX = Math.max(maxX, x);
            minY = Math.min(minY, y);
            maxY = Math.max(maxY, y);

            const neighbors = [
                [x + 1, y], [x - 1, y], [x, y + 1], [x, y - 1],
                [x + 1, y + 1], [x - 1, y - 1], [x + 1, y - 1], [x - 1, y + 1]
            ];

            for (const [nx, ny] of neighbors) {
                if (nx >= 0 && nx < width && ny >= 0 && ny < height) {
                    const nIdx = ny * width + nx;
                    if (!visited[nIdx]) {
                        stack.push(nIdx);
                    }
                }
            }
        }

        return { minX, minY, maxX, maxY };
    }

    for (let y = 0; y < height; y++) {
        for (let x = 0; x < width; x++) {
            const idx = y * width + x;

            if (!visited[idx] && mask[idx]) {
                const region = floodFill(x, y);

                const area =
                    (region.maxX - region.minX) *
                    (region.maxY - region.minY);

                if (area > 20) {
                    regions.push(region);
                }
            }
        }
    }

    // writeToFile("regions.json", { width, height, data: regions });

    return regions;
}


// Merges nearby regions into a single region if they are within a certain padding distance
export function mergeRegions(regions, padding = 20) {
    let merged = regions.map(r => ({ ...r }));
    // Sort spatially so nearby regions are adjacent — minimizes passes needed
    merged.sort((a, b) => a.minX - b.minX || a.minY - b.minY);
    let changed = true;

    while (changed) {
        changed = false;
        const result = [];

        for (const region of merged) {
            let mergedIntoExisting = false;

            for (const existing of result) {
                const overlap =
                    region.minX <= existing.maxX + padding &&
                    region.maxX >= existing.minX - padding &&
                    region.minY <= existing.maxY + padding &&
                    region.maxY >= existing.minY - padding;

                if (overlap) {
                    existing.minX = Math.min(existing.minX, region.minX);
                    existing.minY = Math.min(existing.minY, region.minY);
                    existing.maxX = Math.max(existing.maxX, region.maxX);
                    existing.maxY = Math.max(existing.maxY, region.maxY);
                    mergedIntoExisting = true;
                    changed = true; // a merge happened, need another pass
                    break;
                }
            }

            if (!mergedIntoExisting) result.push({ ...region });
        }

        merged = result;
    }

    return merged;
}


// Expands a region by a certain padding, ensuring it stays within image bounds
export function expandRegion(region, width, height, pad = 8) {
    return {
        minX: Math.max(0, region.minX - pad),
        minY: Math.max(0, region.minY - pad),
        maxX: Math.min(width - 1, region.maxX + pad),
        maxY: Math.min(height - 1, region.maxY + pad),
    };
}