import assert from "node:assert/strict";
import { test } from "node:test";

import {
  STYLE_OPTIONS,
  contrastRatio,
  extractPalette,
  foregroundFor,
  normalizeStyle,
  readableInk,
  recommendStyle,
} from "../public/brand-style.js";

function rgba(...pixels) {
  return Uint8ClampedArray.from(pixels.flatMap((pixel) => pixel));
}

test("extractPalette ignores transparent and near-white pixels", () => {
  const pixels = rgba(
    [255, 255, 255, 255],
    [250, 249, 248, 255],
    [245, 245, 245, 0],
    [24, 98, 81, 255],
    [24, 98, 81, 255],
  );

  assert.deepEqual(extractPalette(pixels), ["#186251"]);
  assert.deepEqual(extractPalette(rgba([0, 0, 0, 0])), []);
});

test("extractPalette is deterministic, bounded, and keeps diverse colors", () => {
  const pixels = rgba(
    ...Array.from({ length: 20 }, () => [220, 45, 54, 255]),
    ...Array.from({ length: 10 }, () => [28, 70, 125, 255]),
    ...Array.from({ length: 8 }, () => [30, 31, 31, 255]),
    ...Array.from({ length: 4 }, () => [221, 46, 53, 255]),
  );
  const palette = extractPalette(pixels);

  assert.deepEqual(palette, extractPalette(pixels));
  assert.ok(palette.length <= 5);
  assert.equal(palette[0], "#dc2d36");
  assert.ok(palette.includes("#1c467d"));
  assert.ok(palette.includes("#1e1f1f"));
});

test("extractPalette retains grayscale when the source is monochrome", () => {
  const pixels = rgba(
    ...Array.from({ length: 8 }, () => [48, 48, 48, 255]),
    ...Array.from({ length: 5 }, () => [153, 153, 153, 255]),
    ...Array.from({ length: 2 }, () => [218, 218, 218, 255]),
  );

  assert.deepEqual(extractPalette(pixels), ["#303030", "#999999", "#dadada"]);
  assert.equal(recommendStyle(["#303030", "#999999"]), "minimal");
});

test("extractPalette suppresses low-population antialias shades while keeping equal colors", () => {
  const logoLike = rgba(
    ...Array.from({ length: 100 }, () => [22, 76, 66, 255]),
    ...Array.from({ length: 2 }, () => [43, 92, 83, 255]),
    ...Array.from({ length: 1 }, () => [164, 187, 183, 255]),
    ...Array.from({ length: 1 }, () => [228, 234, 233, 255]),
    [234, 204, 161, 255],
    [186, 230, 251, 255],
    ...Array.from({ length: 60 }, () => [255, 255, 255, 255]),
  );
  assert.deepEqual(extractPalette(logoLike), ["#164c42"]);

  const twoColors = rgba(
    ...Array.from({ length: 20 }, () => [220, 45, 54, 255]),
    ...Array.from({ length: 20 }, () => [28, 70, 125, 255]),
  );
  assert.deepEqual(extractPalette(twoColors), ["#dc2d36", "#1c467d"]);
});

test("contrast helpers return WCAG ratios and choose the stronger foreground", () => {
  assert.equal(contrastRatio("#000000", "#ffffff"), 21);
  assert.ok(contrastRatio("#777777", "#ffffff") < 4.5);
  assert.equal(foregroundFor("#000000"), "#ffffff");
  assert.equal(foregroundFor("#ffffff"), "#172c25");
  assert.equal(foregroundFor("#777777"), "#000000");
  assert.ok(contrastRatio(foregroundFor("#777777"), "#777777") >= 4.5);
  assert.ok(contrastRatio(foregroundFor("#e63946"), "#e63946") >= 4.5);
  assert.ok(contrastRatio(readableInk("#f4b183"), "#ffffff") >= 4.5);
  assert.ok(contrastRatio(readableInk("#164c42"), "#ffffff") >= 4.5);
  for (let level = 0; level <= 255; level++) {
    const hex = "#" + level.toString(16).padStart(2, "0").repeat(3);
    assert.ok(contrastRatio(foregroundFor(hex), hex) >= 4.5, hex);
  }
});

test("contrast helpers reject malformed colors", () => {
  assert.throws(() => contrastRatio("not-a-color", "#ffffff"), TypeError);
  assert.throws(() => readableInk("#12"), TypeError);
  assert.throws(() => foregroundFor("rgb(0, 0, 0)"), TypeError);
});

test("style options, normalization, and color-only recommendations are deterministic", () => {
  assert.deepEqual(
    STYLE_OPTIONS.map(({ id, name }) => ({ id, name })),
    [
      { id: "expressive", name: "品牌表达" },
      { id: "minimal", name: "简约留白" },
      { id: "editorial", name: "经典报告" },
    ],
  );
  assert.ok(STYLE_OPTIONS.every((option) => option.description.length > 0));
  assert.equal(normalizeStyle("minimal"), "minimal");
  assert.equal(normalizeStyle("editorial"), "editorial");
  assert.equal(normalizeStyle("unknown"), "expressive");
  assert.equal(normalizeStyle(undefined), "expressive");

  assert.equal(recommendStyle(["#e63946", "#1d3557"]), "expressive");
  assert.equal(recommendStyle(["#87958d", "#9a887f"]), "editorial");
  assert.equal(recommendStyle([]), "minimal");
  assert.equal(recommendStyle(["#ffffff", "bad"]), "minimal");
});
