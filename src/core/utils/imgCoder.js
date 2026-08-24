import { PNG } from "pngjs";
import fs from "fs";


export function encoder(data, width, height) {
    try {
        const png = new PNG({ width, height });
        png.data = Buffer.from(data);

        return PNG.sync.write(png);
    } catch (error) {
        console.error("Error encoding image:", error);
        throw error;
    }
}

export async function decoder(path) {
    try {
        const data = fs.readFileSync(path);
        const png = PNG.sync.read(data);

        // console.log("Decoded image:", { width: png.width, height: png.height, data: png.data });
        return { data: png.data, width: png.width, height: png.height };
    }
    catch (error) {
        console.error("Error decoding image:", error);
        throw error;
    }
}