function normalizeSectionName(name) {
  const parts = String(name).split(":");
  const cleaned = [];

  for (let i = 0; i < parts.length; i++) {
    const token = parts[i];

    // Keep state:0 / state:1 because these are meaningful
    if (token === "state" && i + 1 < parts.length) {
      cleaned.push(token, parts[i + 1]);
      i++;
      continue;
    }

    const isLast = i === parts.length - 1;
    const isBeforeState = parts[i + 1] === "state";

    // Remove random generated suffix tokens
    const looksRandom = /^[a-z0-9]{5,10}$/i.test(token) && /[a-z]/i.test(token) && !token.includes("_") && !token.includes("-");

    if (looksRandom && (isLast || isBeforeState)) {
      continue;
    }

    cleaned.push(token);
  }

  

  return cleaned.join(":");
}

function levenshteinDistance(a, b) {
  const dp = Array.from({ length: a.length + 1 }, () => Array(b.length + 1).fill(0));

  for (let i = 0; i <= a.length; i++) dp[i][0] = i;
  for (let j = 0; j <= b.length; j++) dp[0][j] = j;

  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;

      dp[i][j] = Math.min(dp[i - 1][j] + 1, dp[i][j - 1] + 1, dp[i - 1][j - 1] + cost);
    }
  }

  return dp[a.length][b.length];
}

function similarity(a, b) {
  const left = normalizeSectionName(a).toLowerCase();
  const right = normalizeSectionName(b).toLowerCase();

  if (left === right) return 1;

  const maxLen = Math.max(left.length, right.length);
  if (maxLen === 0) return 0;

  const distance = levenshteinDistance(left, right);
  return 1 - distance / maxLen;
}

export function mapCapturedBuffers(liveBuffers, stagedBuffers, options = {}) {
  const threshold = options.threshold ?? 0.75;

  const stagedPageMap = new Map();

  for (const stagedPage of stagedBuffers) {
    const pageKey = `${stagedPage.path}|||${stagedPage.scenario}`;
    stagedPageMap.set(pageKey, stagedPage);
  }

  return liveBuffers.map((livePage) => {
    const pageKey = `${livePage.path}|||${livePage.scenario}`;
    const stagedPage = stagedPageMap.get(pageKey);

    const result = {
      path: livePage.path,
      scenario: livePage.scenario,
      sections: [],
    };

    const liveSections = Object.entries(livePage.sections || {});
    const stagedSections = Object.entries(stagedPage?.sections || {});

    const usedStagedKeys = new Set();

    for (const [liveKey, liveSection] of liveSections) {
      let bestMatch = null;
      let bestScore = 0;

      for (const [stagedKey, stagedSection] of stagedSections) {
        if (usedStagedKeys.has(stagedKey)) continue;

        const score = similarity(liveKey, stagedKey);

        if (score > bestScore) {
          bestScore = score;
          bestMatch = {
            stagedKey,
            stagedSection,
            score,
          };
        }
      }

      if (bestMatch && bestScore >= threshold) {
        usedStagedKeys.add(bestMatch.stagedKey);

        result.sections.push({
          normalizedName: normalizeSectionName(liveKey),
          liveKey,
          stagedKey: bestMatch.stagedKey,
          liveSection,
          stagedSection: bestMatch.stagedSection,
          matchScore: Number(bestMatch.score.toFixed(3)),
        });
      } else {
        result.sections.push({
          normalizedName: normalizeSectionName(liveKey),
          liveKey,
          stagedKey: null,
          liveSection,
          stagedSection: null,
          matchScore: 0,
        });
      }
    }

    // Add staged-only sections which were not matched with any live section
    for (const [stagedKey, stagedSection] of stagedSections) {
      if (!usedStagedKeys.has(stagedKey)) {
        result.sections.push({
          normalizedName: normalizeSectionName(stagedKey),
          liveKey: null,
          stagedKey,
          liveSection: null,
          stagedSection,
          matchScore: 0,
        });
      }
    }

    return result;
  });
}
