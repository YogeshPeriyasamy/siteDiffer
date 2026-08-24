// import { writeToFile } from "../utils/fileWriter.js";

// export function applyThreshold(diffData, threshold) {

//     const thresholdedData = new Uint8Array(diffData.length);
//     // Implementation for applying threshold to the diff data
//     for (let i = 0; i < diffData.length; i++) {
//         if (diffData[i] > threshold) {
//             thresholdedData[i] = 1; // Mark as different
//         }
//     }

//     // writeToFile("thresholdedDiffData.json", { data: Array.from(thresholdedData) });

//     return thresholdedData;
// }