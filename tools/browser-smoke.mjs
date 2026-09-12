import assert from "node:assert/strict";
import { mkdir, readFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import { chromium } from "../.artifacts/browser/node_modules/playwright/index.mjs";

const out = new URL("../.artifacts/browser-validation/", import.meta.url);
await mkdir(out, { recursive: true });
const server = spawn(process.execPath, ["server.mjs"], {
  env: { ...process.env, PORT: "3210", HOST: "127.0.0.1", AI_API_KEY: "" },
  stdio: "inherit",
});
let browser;
try {
  for (let i = 0; i < 50; i++) {
    try {
      if ((await fetch("http://127.0.0.1:3210/api/health")).ok) break;
    } catch {}
    await new Promise((r) => setTimeout(r, 100));
  }
  browser = await chromium.launch();
  const context = await browser.newContext({
    viewport: { width: 1440, height: 1000 },
    deviceScaleFactor: 1,
  });
  const page = await context.newPage();
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto("http://127.0.0.1:3210");
  await page.locator("#slide h2").waitFor();
  await page.screenshot({
    path: new URL("workbench.png", out).pathname,
    fullPage: true,
  });
  await page.locator("#brand-open").click();
  await page.locator("#logo-file").setInputFiles("public/demo/qinghe-logo.png");
  await page.locator("#logo-preview img").waitFor();
  await page.locator("#logo-colors button").first().waitFor();
  assert.equal(
    await page.locator("#logo-colors button").count(),
    1,
    "Ignore colored antialias fringes on the monochrome sample logo",
  );
  await page.locator("#apply-logo-style").click();
  assert.equal(
    await page.locator("#style-options [aria-pressed=true]").count(),
    1,
  );
  await page.locator('[data-brand-style="minimal"]').click();
  await page.locator("#institution").fill("测试品牌");
  await page.locator('[data-color="#284d97"]').click();
  await page.locator("#brand-form button[type=submit]").click();
  assert.equal(await page.locator("#slide .slide-logo").count(), 1);
  assert.match(
    await page.locator("#slide").getAttribute("class"),
    /style-minimal/,
  );
  await page.locator("#brand-open").click();
  const stalePage = await page.context().newPage();
  await stalePage.goto("http://127.0.0.1:3210");
  await stalePage.locator("#slide.style-minimal h2").waitFor();
  await page.locator('[data-brand-style="editorial"]').click();
  await page.locator("#brand-form button[type=submit]").click();
  assert.match(
    await page.locator("#slide").getAttribute("class"),
    /style-editorial/,
  );
  await stalePage.reload();
  await stalePage.locator("#slide.style-editorial h2").waitFor();
  await stalePage.close();
  await page.reload();
  await page.locator("#slide.style-editorial h2").waitFor();
  await page.screenshot({
    path: new URL("style-editorial.png", out).pathname,
    fullPage: true,
  });
  await page.locator('[data-duration="3"]').click();
  await page.locator("#generate").click();
  await page.waitForFunction(
    () => document.getElementById("deck-mode").textContent === "演示模式",
  );
  assert.match(await page.locator("#time-count").innerText(), /3 分 0 秒/);
  await page.locator("#next-slide").click();
  await page.locator("#slide-title").fill("已经编辑的标题");
  assert.equal(await page.locator("#slide h2").innerText(), "已经编辑的标题");
  await page.reload();
  await page.locator("#slide h2").waitFor();
  await page.locator("#next-slide").click();
  assert.equal(await page.locator("#slide h2").innerText(), "已经编辑的标题");
  await page.locator("#notes").fill("完整讲稿".repeat(300));
  await page.locator("#refine").click();
  await page.waitForFunction(() => !document.getElementById("refine").disabled);
  assert.match(await page.locator("#toast").innerText(), /已按规则精简/);
  await page.locator("#present").click();
  await page.keyboard.press("ArrowRight");
  assert.equal(
    await page.locator("#presentation-position").innerText(),
    "3 / 6",
  );
  await page.keyboard.press("Escape");
  assert.equal(await page.locator("#presentation").isVisible(), false);
  for (const [selector, filename] of [
    ["#export-tex", "deck.zip"],
    ["#export-json", "draft.json"],
  ]) {
    await page.locator("#export-toggle").click();
    const downloadPromise = page.waitForEvent("download");
    await page.locator(selector).click();
    await (await downloadPromise).saveAs(new URL(filename, out).pathname);
  }
  const draft = JSON.parse(await readFile(new URL("draft.json", out), "utf8"));
  assert.equal(draft.brand.institution, "测试品牌");
  assert.equal(draft.brand.style, "editorial");
  assert.ok(draft.brand.logo.startsWith("data:image/png;"));
  assert.equal(draft.deck.slides.length, 6);
  await page.locator("#export-toggle").click();
  await page.locator("#import-json").click();
  page.once("dialog", (dialog) => dialog.accept());
  await page
    .locator("#json-file")
    .setInputFiles(new URL("draft.json", out).pathname);
  await page.waitForFunction(
    () => document.getElementById("toast").textContent === "草稿已导入。",
  );
  await page.locator("#mode").selectOption("ai");
  await page.locator("#generate").click();
  await page.waitForFunction(
    () => !document.getElementById("generate").disabled,
  );
  assert.match(await page.locator("#toast").innerText(), /未配置/);
  assert.equal(await page.locator("#thumbnails .thumbnail").count(), 6);
  if (await page.locator("#ai-dialog").evaluate((dialog) => dialog.open)) {
    await page.locator("#ai-close").click();
  }
  await page.locator("#mode").selectOption("demo");
  await page.locator("#export-toggle").click();
  await page.locator("#export-pdf").click();
  assert.equal(await page.locator("#print-deck .print-page").count(), 6);
  await page.emulateMedia({ media: "print" });
  const overflowPages = await page
    .locator("#print-deck .slide")
    .evaluateAll((slides) =>
      slides.flatMap((slide, index) => {
        const frame = slide.getBoundingClientRect();
        const footer = slide
          .querySelector(".slide-footer")
          .getBoundingClientRect();
        const items = [...slide.querySelectorAll(".slide-bullets li")];
        return footer.bottom > frame.bottom + 1 ||
          items.some(
            (item) => item.getBoundingClientRect().bottom > footer.top + 1,
          )
          ? [index + 1]
          : [];
      }),
    );
  assert.deepEqual(
    overflowPages,
    [],
    "Every printed slide must contain all bullets and its footer",
  );
  await page.pdf({
    path: new URL("browser-print.pdf", out).pathname,
    printBackground: true,
    preferCSSPageSize: true,
  });
  await page.emulateMedia({ media: "screen" });
  await page.setViewportSize({ width: 390, height: 844 });
  assert.ok(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth,
    ),
  );
  await page.screenshot({
    path: new URL("mobile.png", out).pathname,
    fullPage: true,
  });
  assert.deepEqual(errors, []);
  console.log(
    "Browser smoke passed: branding, generation, refinement, presentation, downloads, draft roundtrip, missing AI, print and mobile.",
  );
} finally {
  await browser?.close();
  server.kill();
}
