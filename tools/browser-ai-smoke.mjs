import assert from "node:assert/strict";
import { mkdir, readFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import { chromium } from "../.artifacts/browser/node_modules/playwright/index.mjs";

// UI contracts use deterministic route fixtures; native provider protocols and
// upstream failures are covered independently by the Node integration tests.
const out = new URL("../.artifacts/browser-validation/", import.meta.url);
await mkdir(out, { recursive: true });
const server = spawn(process.execPath, ["server.mjs"], {
  env: { ...process.env, PORT: "3211", HOST: "127.0.0.1", AI_API_KEY: "" },
  stdio: "inherit",
});
const base = "http://127.0.0.1:3211";
const secret = "browser-fixture-key-never-a-real-credential";
let browser;
try {
  for (let i = 0; i < 50; i++) {
    try {
      if ((await fetch(`${base}/api/health`)).ok) break;
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  const demo = await (
    await fetch(`${base}/api/generate`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        mode: "demo",
        title: "接口测试",
        duration: 3,
        brand: {
          institution: "测试",
          department: "",
          presenter: "",
          color: "#164c42",
        },
        material:
          "这是模型接入的自动化验证材料。项目帮助团队整理演示内容，支持品牌定制与可编辑草稿导出。",
      }),
    })
  ).json();
  assert.ok(demo.deck);
  browser = await chromium.launch();
  const context = await browser.newContext({
    viewport: { width: 1440, height: 1000 },
  });
  const page = await context.newPage();
  await page.addInitScript(() => {
    const readText = File.prototype.text;
    File.prototype.text = function () {
      if (this.name !== "slow-config.json") return readText.call(this);
      const file = this;
      return new Promise((resolve) => {
        window.__releaseAiImport = async () =>
          resolve(await readText.call(file));
      });
    };
  });
  const errors = [];
  const calls = [];
  let delayNextTest = false;
  let releaseTest;
  page.on("pageerror", (error) => errors.push(error.message));
  const ids = ["openai", "anthropic", "qwen", "gemini", "compatible"];
  const catalog = {
    providers: ids.map((id) => ({
      id,
      label: id,
      defaultBaseUrl: `https://${id}.example/v1`,
      defaultModel: `${id}-fixture`,
      models: [{ id: `${id}-fixture`, label: `${id} fixture` }],
    })),
    siteProfiles: [
      {
        id: "qwen",
        label: "网站 Qwen",
        provider: "qwen",
        model: "qwen-site-fixture",
        configured: true,
      },
    ],
    personalEnabled: true,
  };
  await page.route("**/api/ai/config", (route) =>
    route.fulfill({ json: catalog }),
  );
  await page.route("**/api/ai/test", async (route) => {
    const body = route.request().postDataJSON();
    calls.push({ kind: "test", body });
    if (delayNextTest) {
      delayNextTest = false;
      await new Promise((resolve) => {
        releaseTest = resolve;
      });
    }
    if (body.ai.apiKey === "invalid-fixture-key") {
      return route.fulfill({
        status: 401,
        json: { error: "API 密钥无效或没有访问权限" },
      });
    }
    return route.fulfill({
      json: {
        ok: true,
        provider: body.ai.provider || "qwen",
        model: body.ai.model || "qwen-site-fixture",
        message: "连接成功",
      },
    });
  });
  await page.route("**/api/generate", async (route) => {
    const body = route.request().postDataJSON();
    calls.push({ kind: "generate", body });
    await new Promise((resolve) => setTimeout(resolve, 150));
    await route.fulfill({ json: { mode: "ai", deck: demo.deck } });
  });
  await page.route("**/api/refine", async (route) => {
    const body = route.request().postDataJSON();
    calls.push({ kind: "refine", body });
    await route.fulfill({
      json: { slide: { ...body.slide, title: "AI 精简验证" } },
    });
  });
  await page.goto(base);
  await page.locator("#slide h2").waitFor();
  await page.locator("#ai-config-open").click();
  await page.locator("#ai-source").selectOption("personal");
  for (const id of ids) {
    await page.locator("#ai-provider").selectOption(id);
    assert.equal(await page.locator("#ai-model").inputValue(), `${id}-fixture`);
  }
  await page.locator("#ai-key").fill("discarded-key");
  await page.locator("#ai-provider").selectOption("openai");
  assert.equal(
    await page.locator("#ai-key").inputValue(),
    "",
    "Changing providers clears keys",
  );
  await page.locator("#ai-key").fill("invalid-fixture-key");
  await page.locator("#ai-test").click();
  await page.waitForFunction(() =>
    document.getElementById("ai-status").textContent.includes("密钥无效"),
  );
  const config = {
    provider: "compatible",
    baseUrl: "https://gateway.example/v1",
    model: "my-custom-model",
    apiKey: secret,
  };
  const countBeforeImport = calls.length;
  await page.locator("#ai-config-file").setInputFiles({
    name: "malformed-config.json",
    mimeType: "application/json",
    buffer: Buffer.from(secret),
  });
  await page.waitForFunction(() =>
    document
      .getElementById("ai-import-status")
      .textContent.includes("JSON 格式无效"),
  );
  assert.ok(
    !(await page.locator("#ai-import-status").innerText()).includes(secret),
  );
  await page.locator("#ai-config-file").setInputFiles({
    name: "personal-config.json",
    mimeType: "application/json",
    buffer: Buffer.from(JSON.stringify(config)),
  });
  await page.waitForFunction(
    () => document.getElementById("ai-model").value === "my-custom-model",
  );
  assert.equal(
    calls.length,
    countBeforeImport,
    "Import must never call a provider automatically",
  );
  await page.locator("#ai-test").click();
  await page.waitForFunction(() =>
    document.getElementById("ai-status").textContent.includes("成功"),
  );
  await page.screenshot({
    path: new URL("ai-settings.png", out).pathname,
    fullPage: true,
  });
  await page.locator("#ai-form button[type=submit]").click();
  assert.equal(
    await page.locator("#ai-dialog").evaluate((el) => el.open),
    false,
  );
  assert.equal(
    await page.locator("#ai-key").inputValue(),
    "",
    "Closed form must not retain secret DOM values",
  );
  await page.locator("#mode").selectOption("ai");
  await page.locator("#generate").click();
  await page.waitForFunction(
    () => !document.getElementById("generate").disabled,
  );
  assert.deepEqual(calls.find((call) => call.kind === "generate").body.ai, {
    source: "personal",
    ...config,
  });
  await page.locator("#refine").click();
  await page.waitForFunction(() => !document.getElementById("refine").disabled);
  assert.equal(await page.locator("#slide h2").innerText(), "AI 精简验证");
  assert.deepEqual(calls.find((call) => call.kind === "refine").body.ai, {
    source: "personal",
    ...config,
  });
  await page.locator("#ai-config-open").click();
  delayNextTest = true;
  const pendingRequest = page.waitForRequest("**/api/ai/test");
  await page.locator("#ai-test").click();
  await pendingRequest;
  await page.locator("#ai-close").click();
  await page.locator("#ai-config-open").click();
  assert.equal(
    await page.locator("#ai-test").isDisabled(),
    false,
    "Cancelling a connection test must not leave testing locked",
  );
  releaseTest();
  await page.locator("#ai-config-file").setInputFiles({
    name: "slow-config.json",
    mimeType: "application/json",
    buffer: Buffer.from(
      JSON.stringify({
        ...config,
        model: "stale-import-model",
        apiKey: "stale-import-key",
      }),
    ),
  });
  await page.waitForFunction(
    () => typeof window.__releaseAiImport === "function",
  );
  await page.locator("#ai-close").click();
  await page.locator("#ai-config-open").click();
  await page.evaluate(() => window.__releaseAiImport());
  assert.equal(
    await page.locator("#ai-model").inputValue(),
    "my-custom-model",
    "A cancelled import cannot overwrite a new dialog session",
  );
  assert.equal(await page.locator("#ai-key").inputValue(), secret);
  await page.locator("#ai-key").fill("cancelled-change");
  await page.locator("#ai-close").click();
  await page.locator("#generate").click();
  await page.waitForFunction(
    () => !document.getElementById("generate").disabled,
  );
  assert.equal(
    calls.filter((call) => call.kind === "generate").at(-1).body.ai.apiKey,
    secret,
  );
  const downloadPromise = page.waitForEvent("download");
  await page.locator("#export-toggle").click();
  await page.locator("#export-json").click();
  const download = await downloadPromise;
  const serialized = await readFile(await download.path(), "utf8");
  assert.ok(!serialized.includes(secret) && !serialized.includes('"apiKey"'));
  const stored = await page.evaluate(() =>
    JSON.stringify({ ...localStorage, ...sessionStorage }),
  );
  assert.ok(!stored.includes(secret) && !stored.includes('"apiKey"'));
  await page.reload();
  await page.locator("#ai-config-open").click();
  await page.locator("#ai-source").selectOption("personal");
  assert.equal(
    await page.locator("#ai-key").inputValue(),
    "",
    "Refresh clears credentials",
  );
  await page.locator("#ai-base-url").fill("not-a-url");
  await page.locator("#ai-source").selectOption("site");
  await page.locator("#ai-profile").selectOption("qwen");
  await page.locator("#ai-form button[type=submit]").click();
  await page.locator("#generate").click();
  await page.waitForFunction(
    () => !document.getElementById("generate").disabled,
  );
  assert.deepEqual(
    calls.filter((call) => call.kind === "generate").at(-1).body.ai,
    { source: "site", profileId: "qwen" },
  );
  await page.setViewportSize({ width: 390, height: 844 });
  await page.locator("#ai-config-open").click();
  await page.locator("#ai-source").selectOption("personal");
  assert.ok(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  );
  const bounds = await page.locator("#ai-dialog").boundingBox();
  assert.ok(bounds.width <= 390 && bounds.height <= 844);
  await page.screenshot({
    path: new URL("ai-settings-mobile.png", out).pathname,
    fullPage: true,
  });
  assert.deepEqual(errors, []);
  console.log(
    "AI browser contracts passed: provider presets, import, testing errors, apply/cancel, generate/refine routing, credential non-persistence and mobile.",
  );
} finally {
  await browser?.close();
  server.kill();
}
