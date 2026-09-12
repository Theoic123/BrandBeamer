const DEFAULT_STYLE = "expressive";
const DARK_INK = "#172c25";
const WHITE = "#ffffff";
const MAX_PALETTE_COLORS = 5;

/**
 * The styles are deliberately data only. The app can use the same options for
 * controls and for the style recommendation without making this module depend
 * on the DOM or on a renderer.
 */
export const STYLE_OPTIONS = Object.freeze([
  Object.freeze({
    id: "expressive",
    name: "品牌表达",
    description: "强化品牌色与视觉层次，适合鲜明表达。",
  }),
  Object.freeze({
    id: "minimal",
    name: "简约留白",
    description: "保持克制配色与充足留白，让内容更清晰。",
  }),
  Object.freeze({
    id: "editorial",
    name: "经典报告",
    description: "采用稳重、结构化的报告式表达。",
  }),
]);

const STYLE_IDS = new Set(STYLE_OPTIONS.map(({ id }) => id));

function clampByte(value) {
  return Math.max(0, Math.min(255, Math.round(Number(value) || 0)));
}

function parseHex(hex) {
  if (typeof hex !== "string")
    throw new TypeError("Color must be a hexadecimal string.");
  const value = hex.trim();
  const match = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(value);
  if (!match)
    throw new TypeError("Color must be a 3- or 6-digit hexadecimal string.");
  const digits =
    match[1].length === 3
      ? match[1]
          .split("")
          .map((digit) => digit + digit)
          .join("")
      : match[1];
  return {
    r: Number.parseInt(digits.slice(0, 2), 16),
    g: Number.parseInt(digits.slice(2, 4), 16),
    b: Number.parseInt(digits.slice(4, 6), 16),
  };
}

function rgbToHex({ r, g, b }) {
  return `#${[r, g, b]
    .map((channel) => clampByte(channel).toString(16).padStart(2, "0"))
    .join("")}`;
}

function relativeLuminance({ r, g, b }) {
  const channel = (value) => {
    const normalized = clampByte(value) / 255;
    return normalized <= 0.03928
      ? normalized / 12.92
      : ((normalized + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
}

function chroma({ r, g, b }) {
  return Math.max(r, g, b) - Math.min(r, g, b);
}

function isChromatic(color) {
  const spread = chroma(color);
  const max = Math.max(color.r, color.g, color.b);
  return spread >= 18 && (max === 0 || spread / max >= 0.12);
}

function colorDistanceSquared(a, b) {
  const red = a.r - b.r;
  const green = a.g - b.g;
  const blue = a.b - b.b;
  return red * red + green * green + blue * blue;
}

function hsvInfo({ r, g, b }) {
  const red = r / 255;
  const green = g / 255;
  const blue = b / 255;
  const maximum = Math.max(red, green, blue);
  const minimum = Math.min(red, green, blue);
  const delta = maximum - minimum;
  let hue = 0;
  if (delta > 0) {
    if (maximum === red) hue = 60 * (((green - blue) / delta) % 6);
    else if (maximum === green) hue = 60 * ((blue - red) / delta + 2);
    else hue = 60 * ((red - green) / delta + 4);
    if (hue < 0) hue += 360;
  }
  return {
    hue,
    saturation: maximum === 0 ? 0 : delta / maximum,
    value: maximum,
  };
}

function hueDistance(first, second) {
  const distance = Math.abs(first - second);
  return Math.min(distance, 360 - distance);
}

function sameHueFamily(first, second) {
  const a = hsvInfo(first);
  const b = hsvInfo(second);
  // Hue is unstable for grayscale and nearly white colors. RGB distance and
  // population still handle those candidates, while this check collapses
  // antialiased shades of one genuinely chromatic mark.
  if (a.saturation < 0.08 || b.saturation < 0.08) return false;
  return (
    hueDistance(a.hue, b.hue) <= 18 &&
    Math.abs(a.saturation - b.saturation) <= 0.65
  );
}

function parseOptionNumber(value, fallback, minimum, maximum) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.max(minimum, Math.min(maximum, number));
}

function isNearWhite(color, threshold) {
  const minimum = Math.min(color.r, color.g, color.b);
  const maximum = Math.max(color.r, color.g, color.b);
  const average = (color.r + color.g + color.b) / 3;
  const softAverageThreshold = Math.max(220, threshold - 20);
  return (
    (minimum >= threshold && maximum - minimum <= 22) ||
    (average >= softAverageThreshold && maximum - minimum <= 30)
  );
}

function quantizeChannel(value, quantum) {
  return Math.floor(value / quantum);
}

/**
 * Extract a small, stable palette from RGBA pixels.
 *
 * The input is normally ImageData.data from a downsized canvas. Quantizing
 * before ranking makes the result stable for antialiased edges, while the
 * distance check keeps near-identical shades from filling the palette.
 */
export function extractPalette(pixels, options = {}) {
  if (!pixels || typeof pixels.length !== "number") return [];
  const config = options && typeof options === "object" ? options : {};

  const maxColors = Math.floor(
    parseOptionNumber(
      config.maxColors,
      MAX_PALETTE_COLORS,
      0,
      MAX_PALETTE_COLORS,
    ),
  );
  if (maxColors === 0) return [];

  const minAlpha = parseOptionNumber(config.minAlpha, 24, 0, 255);
  const whiteThreshold = parseOptionNumber(
    config.whiteThreshold,
    245,
    220,
    255,
  );
  const quantum = parseOptionNumber(config.quantum, 16, 4, 64);
  const minDistance = parseOptionNumber(config.minDistance, 26, 0, 255);
  const populationRatio = parseOptionNumber(config.populationRatio, 0.02, 0, 1);
  const buckets = new Map();

  for (let index = 0; index + 3 < pixels.length; index += 4) {
    const alpha = Number(pixels[index + 3]);
    if (!Number.isFinite(alpha) || alpha < minAlpha) continue;
    const color = {
      r: clampByte(pixels[index]),
      g: clampByte(pixels[index + 1]),
      b: clampByte(pixels[index + 2]),
    };
    if (isNearWhite(color, whiteThreshold)) continue;

    const qr = quantizeChannel(color.r, quantum);
    const qg = quantizeChannel(color.g, quantum);
    const qb = quantizeChannel(color.b, quantum);
    const key = `${qr},${qg},${qb}`;
    const bucket = buckets.get(key);
    if (bucket) {
      bucket.count++;
      bucket.r += color.r;
      bucket.g += color.g;
      bucket.b += color.b;
    } else {
      buckets.set(key, {
        count: 1,
        firstIndex: index,
        r: color.r,
        g: color.g,
        b: color.b,
        qr,
        qg,
        qb,
      });
    }
  }

  if (buckets.size === 0) return [];

  const candidates = [...buckets.values()].map((bucket) => {
    const color = {
      r: Math.round(bucket.r / bucket.count),
      g: Math.round(bucket.g / bucket.count),
      b: Math.round(bucket.b / bucket.count),
    };
    return {
      color,
      count: bucket.count,
      chromatic: isChromatic(color),
      key: [bucket.qr, bucket.qg, bucket.qb],
      firstIndex: bucket.firstIndex,
    };
  });
  const hasChromatic = candidates.some((candidate) => candidate.chromatic);
  const dominantCount = Math.max(...candidates.map(({ count }) => count));
  const populationFloor = Math.max(2, dominantCount * populationRatio);
  // A rare different hue can also be a subpixel antialias artifact, so require
  // meaningful coverage for every candidate rather than exempting accents.
  const substantiveCandidates = candidates.filter(
    (candidate) => candidate.count >= populationFloor,
  );

  // A small chromaticity boost prevents a large neutral margin or black wordmark
  // from displacing the meaningful color of an otherwise colorful logo. When
  // every candidate is neutral, frequency remains the only deciding signal.
  substantiveCandidates.sort((a, b) => {
    const scoreA = a.count * (hasChromatic && a.chromatic ? 1.35 : 1);
    const scoreB = b.count * (hasChromatic && b.chromatic ? 1.35 : 1);
    if (scoreA !== scoreB) return scoreB - scoreA;
    if (a.count !== b.count) return b.count - a.count;
    if (a.chromatic !== b.chromatic) return a.chromatic ? -1 : 1;
    if (a.firstIndex !== b.firstIndex) return a.firstIndex - b.firstIndex;
    for (let index = 0; index < a.key.length; index++) {
      if (a.key[index] !== b.key[index]) return a.key[index] - b.key[index];
    }
    return 0;
  });

  const selected = [];
  const minDistanceSquared = minDistance * minDistance;
  for (const candidate of substantiveCandidates) {
    if (
      selected.every(
        (other) =>
          colorDistanceSquared(candidate.color, other.color) >=
            minDistanceSquared && !sameHueFamily(candidate.color, other.color),
      )
    ) {
      selected.push(candidate);
      if (selected.length >= maxColors) break;
    }
  }

  return selected.map(({ color }) => rgbToHex(color));
}

/**
 * Return the WCAG 2 contrast ratio for two hexadecimal colors.
 */
export function contrastRatio(first, second) {
  const firstLuminance = relativeLuminance(parseHex(first));
  const secondLuminance = relativeLuminance(parseHex(second));
  const lighter = Math.max(firstLuminance, secondLuminance);
  const darker = Math.min(firstLuminance, secondLuminance);
  return (lighter + 0.05) / (darker + 0.05);
}

/**
 * Darken a color only as much as needed to make it usable as ink on white.
 */
export function readableInk(hex) {
  const source = parseHex(hex);
  if (contrastRatio(rgbToHex(source), WHITE) >= 4.5) return rgbToHex(source);

  let low = 0;
  let high = 1;
  for (let iteration = 0; iteration < 32; iteration++) {
    const factor = (low + high) / 2;
    const candidate = {
      r: Math.floor(source.r * factor),
      g: Math.floor(source.g * factor),
      b: Math.floor(source.b * factor),
    };
    if (contrastRatio(rgbToHex(candidate), WHITE) >= 4.5) low = factor;
    else high = factor;
  }

  let ink = {
    r: Math.floor(source.r * low),
    g: Math.floor(source.g * low),
    b: Math.floor(source.b * low),
  };
  // Integer channel rounding can leave a boundary candidate just below 4.5.
  // Decrementing the brightest channel keeps the hue close while guaranteeing
  // the promised minimum contrast.
  while (contrastRatio(rgbToHex(ink), WHITE) < 4.5) {
    const brightest = ["r", "g", "b"].reduce((best, channel) =>
      ink[channel] > ink[best] ? channel : best,
    );
    if (ink[brightest] === 0) return DARK_INK;
    ink = { ...ink, [brightest]: ink[brightest] - 1 };
  }
  return rgbToHex(ink);
}

/**
 * Pick the stronger of the two supported foreground colors for a background.
 */
export function foregroundFor(hex) {
  const whiteContrast = contrastRatio(WHITE, hex);
  const darkContrast = contrastRatio(DARK_INK, hex);
  if (Math.max(whiteContrast, darkContrast) >= 4.5)
    return whiteContrast > darkContrast ? WHITE : DARK_INK;
  // There is a narrow middle range where both preferred brand foregrounds
  // miss WCAG AA. Black is the strongest accessible fallback for that range.
  return "#000000";
}

export function normalizeStyle(value) {
  return typeof value === "string" && STYLE_IDS.has(value)
    ? value
    : DEFAULT_STYLE;
}

function styleColorInfo(value) {
  try {
    const color = parseHex(value);
    const spread = chroma(color);
    const saturation =
      Math.max(color.r, color.g, color.b) === 0
        ? 0
        : spread / Math.max(color.r, color.g, color.b);
    return { color, spread, saturation };
  } catch {
    return null;
  }
}

/**
 * Recommend a visual direction from color statistics only. This deliberately
 * makes no claim about the organization, topic, or meaning of a logo.
 */
export function recommendStyle(palette) {
  if (!Array.isArray(palette)) return "minimal";
  const colors = palette.map(styleColorInfo).filter(Boolean);
  if (colors.length === 0) return "minimal";

  const chromatic = colors.filter(
    ({ spread, saturation }) => spread >= 10 && saturation >= 0.08,
  );
  if (chromatic.length === 0) return "minimal";

  const averageSaturation =
    chromatic.reduce((sum, item) => sum + item.saturation, 0) /
    chromatic.length;
  const vividCount = chromatic.filter(
    ({ saturation }) => saturation >= 0.42,
  ).length;
  if (vividCount > 0 || averageSaturation >= 0.42) return "expressive";
  return "editorial";
}
