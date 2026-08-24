import path from "path";
import fs from "fs";
import { fileURLToPath } from "url";
import { json } from "stream/consumers";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const dataDir = path.join(__dirname, "..", "processedData");

//function to write data to a file
export function writeToFile(filename, data) {
    const appendPath = path.join(dataDir, "appendedData.json");
    const outputPath = path.join(dataDir, filename);
    fs.writeFileSync(outputPath, JSON.stringify(data));
    fs.appendFileSync(appendPath, "\n" + JSON.stringify(data)); // Add a newline after the JSON data for better readability    
    console.log(`Data written to ${outputPath}`);
}