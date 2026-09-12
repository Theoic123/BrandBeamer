import assert from "node:assert/strict";
import { createServer as createHttpServer } from "node:http";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { createServer } from "../server.mjs";

async function listen(server) {
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  return `http://127.0.0.1:${address.port}`;
}

async function close(server) {
  if (!server.listening) return;
  await new Promise((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );
}

async function withFixture(callback) {
  const root = await mkdtemp(join(tmpdir(), "brandbeamer-"));
  const publicDir = join(root, "public");
  const templateDir = join(root, "templates");
  await mkdir(join(publicDir, "nested"), { recursive: true });
  await mkdir(join(templateDir, "beamer"), { recursive: true });
  await writeFile(
    join(publicDir, "index.html"),
    "<!doctype html><title>BrandBeamer</title>",
  );
  await writeFile(join(publicDir, "nested", "asset.txt"), "safe asset");
  await writeFile(join(root, ".env"), "AI_API_KEY=should-not-be-served\n");
  await writeFile(
    join(templateDir, "beamer", "beamerthemeBrand.sty"),
    "% BrandBeamer theme",
  );
  await writeFile(join(templateDir, "beamer", "LICENSE"), "template license");
  try {
    return await callback({ root, publicDir, templateDir });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

async function jsonFetch(base, pathname, init = {}) {
  const response = await fetch(`${base}${pathname}`, {
    ...init,
    headers: {
      "content-type": "application/json",
      ...(init.headers ?? {}),
    },
  });
  const body = await response.json();
  return { response, body };
}

const sampleGenerate = {
  material:
    "学校正在推进绿色校园计划。项目先从能源审计开始，再逐步优化照明和空调。",
  title: "绿色校园计划",
  duration: 3,
  brand: {
    institution: "示例大学",
    department: "可持续发展办公室",
    presenter: "李老师",
    color: "#123456",
  },
};

test("health, deterministic demo generation, validation, and missing AI configuration", async () => {
  await withFixture(async ({ root, publicDir, templateDir }) => {
    const app = createServer({
      rootDir: root,
      publicDir,
      templateDir,
      env: { AI_API_KEY: "", AI_MODEL: "test-model" },
    });
    const base = await listen(app);
    try {
      const health = await fetch(`${base}/api/health`);
      assert.equal(health.status, 200);
      assert.deepEqual(await health.json(), {
        aiConfigured: false,
        model: "test-model",
        demoAvailable: true,
      });

      const first = await jsonFetch(base, "/api/generate", {
        method: "POST",
        body: JSON.stringify({ ...sampleGenerate, mode: "demo" }),
      });
      const second = await jsonFetch(base, "/api/generate", {
        method: "POST",
        body: JSON.stringify({ ...sampleGenerate, mode: "demo" }),
      });
      assert.equal(first.response.status, 200);
      assert.deepEqual(
        first.body,
        second.body,
        "demo output should be deterministic",
      );
      assert.equal(first.body.mode, "demo");
      assert.equal(first.body.deck.slides.length, 6);
      assert.equal(
        first.body.deck.slides.reduce((sum, slide) => sum + slide.seconds, 0),
        180,
      );
      assert.match(first.body.deck.slides[0].subtitle, /基于所提交材料整理/);
      for (const slide of first.body.deck.slides) {
        assert.ok(
          ["cover", "bullets", "columns", "closing"].includes(slide.type),
        );
        assert.ok(slide.bullets.length <= 5);
        assert.ok(slide.title.length <= 60);
        assert.ok(slide.notes.length <= 500);
      }

      const invalid = await jsonFetch(base, "/api/generate", {
        method: "POST",
        body: JSON.stringify({ ...sampleGenerate, mode: "unknown" }),
      });
      assert.equal(invalid.response.status, 400);
      assert.match(invalid.body.error, /mode/);

      const uiBoundary = await jsonFetch(base, "/api/generate", {
        method: "POST",
        body: JSON.stringify({
          ...sampleGenerate,
          material: "m".repeat(12_000),
          title: "t".repeat(80),
          mode: "demo",
        }),
      });
      assert.equal(uiBoundary.response.status, 200);
      assert.equal(uiBoundary.body.deck.title.length, 60);

      const materialTooLong = await jsonFetch(base, "/api/generate", {
        method: "POST",
        body: JSON.stringify({
          ...sampleGenerate,
          material: "m".repeat(12_001),
          mode: "demo",
        }),
      });
      assert.equal(materialTooLong.response.status, 400);
      assert.match(materialTooLong.body.error, /material/);

      const titleTooLong = await jsonFetch(base, "/api/generate", {
        method: "POST",
        body: JSON.stringify({
          ...sampleGenerate,
          title: "t".repeat(81),
          mode: "demo",
        }),
      });
      assert.equal(titleTooLong.response.status, 400);
      assert.match(titleTooLong.body.error, /title/);

      const unavailable = await jsonFetch(base, "/api/generate", {
        method: "POST",
        body: JSON.stringify({ ...sampleGenerate, mode: "ai" }),
      });
      assert.equal(unavailable.response.status, 503);
      assert.match(unavailable.body.error, /AI/);
      assert.doesNotMatch(
        JSON.stringify(unavailable.body),
        /should-not-be-served/,
      );
    } finally {
      await close(app);
    }
  });
});

test("static files and Beamer allowlist are safe", async () => {
  await withFixture(async ({ root, publicDir, templateDir }) => {
    const app = createServer({
      rootDir: root,
      publicDir,
      templateDir,
      env: {},
    });
    const base = await listen(app);
    try {
      const index = await fetch(`${base}/`);
      assert.equal(index.status, 200);
      assert.match(await index.text(), /BrandBeamer/);

      const asset = await fetch(`${base}/nested/asset.txt`);
      assert.equal(asset.status, 200);
      assert.equal(await asset.text(), "safe asset");

      const theme = await fetch(
        `${base}/templates/beamer/beamerthemeBrand.sty`,
      );
      assert.equal(theme.status, 200);
      assert.match(await theme.text(), /BrandBeamer/);

      const license = await fetch(`${base}/templates/beamer/LICENSE`);
      assert.equal(license.status, 200);
      assert.equal(await license.text(), "template license");

      const dotEnv = await fetch(`${base}/.env`);
      assert.equal(dotEnv.status, 404);
      const traversal = await fetch(`${base}/%2e%2e/server.mjs`);
      assert.equal(traversal.status, 404);
    } finally {
      await close(app);
    }
  });
});

test("AI generation sends a bounded prompt and normalises a fenced response", async () => {
  await withFixture(async ({ root, publicDir, templateDir }) => {
    let request;
    const upstream = createHttpServer((req, res) => {
      const chunks = [];
      req.on("data", (chunk) => chunks.push(chunk));
      req.on("end", () => {
        request = {
          authorization: req.headers.authorization,
          body: JSON.parse(Buffer.concat(chunks).toString("utf8")),
        };
        const slides = Array.from({ length: 4 }, (_, index) => ({
          id: `model-${index + 1}`,
          type: index === 0 ? "cover" : index === 3 ? "closing" : "bullets",
          title:
            "这是一个超过六十字符的标题这是一个超过六十字符的标题这是一个超过六十字符的标题",
          subtitle: "副标题",
          bullets: ["一", "二", "三", "四", "五", "六"],
          notes: "n".repeat(600),
          seconds: 10,
        }));
        const content = `\`\`\`json\n${JSON.stringify({ title: sampleGenerate.title, slides })}\n\`\`\``;
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ choices: [{ message: { content } }] }));
      });
    });
    const upstreamBase = await listen(upstream);
    const app = createServer({
      rootDir: root,
      publicDir,
      templateDir,
      env: {
        AI_API_KEY: "secret-test-key",
        AI_BASE_URL: upstreamBase,
        AI_MODEL: "mock-model",
      },
    });
    const base = await listen(app);
    try {
      const result = await jsonFetch(base, "/api/generate", {
        method: "POST",
        body: JSON.stringify({ ...sampleGenerate, mode: "ai" }),
      });
      assert.equal(result.response.status, 200);
      assert.equal(result.body.mode, "ai");
      assert.equal(result.body.deck.slides.length, 4);
      assert.equal(
        result.body.deck.slides.reduce((sum, slide) => sum + slide.seconds, 0),
        180,
      );
      assert.ok(
        result.body.deck.slides.every((slide) => slide.bullets.length <= 5),
      );
      assert.ok(
        result.body.deck.slides.every((slide) => slide.title.length <= 60),
      );
      assert.ok(
        result.body.deck.slides.every((slide) => slide.notes.length <= 500),
      );
      assert.equal(request.authorization, "Bearer secret-test-key");
      assert.equal(request.body.model, "mock-model");
      assert.match(request.body.messages[0].content, /不得补写/);
      assert.match(request.body.messages[0].content, /6-8/);
      assert.doesNotMatch(JSON.stringify(result.body), /secret-test-key/);
    } finally {
      await close(app);
      await close(upstream);
    }
  });
});

test("demo refine shortens locally and AI refine remains explicit", async () => {
  await withFixture(async ({ root, publicDir, templateDir }) => {
    const app = createServer({
      rootDir: root,
      publicDir,
      templateDir,
      env: { AI_API_KEY: "" },
    });
    const base = await listen(app);
    const slide = {
      id: "slide-2",
      type: "bullets",
      title: "一个需要精简的标题",
      subtitle: "副标题",
      bullets: ["这是一条非常长的材料内容。".repeat(8)],
      notes: "原始备注",
      seconds: 30,
    };
    try {
      const demo = await jsonFetch(base, "/api/refine", {
        method: "POST",
        body: JSON.stringify({ slide, instruction: "请精简", mode: "demo" }),
      });
      assert.equal(demo.response.status, 200);
      assert.ok(demo.body.slide.bullets[0].length < slide.bullets[0].length);
      assert.match(demo.body.slide.notes, /演示模式/);

      const unavailable = await jsonFetch(base, "/api/refine", {
        method: "POST",
        body: JSON.stringify({ slide, instruction: "请精简" }),
      });
      assert.equal(unavailable.response.status, 503);
    } finally {
      await close(app);
    }
  });
});

test("refine accepts frontend-sized input while constraining the generated slide", async () => {
  await withFixture(async ({ root, publicDir, templateDir }) => {
    let latestRequest;
    const fetchImpl = async (_url, init) => {
      latestRequest = JSON.parse(init.body);
      const content = JSON.stringify({
        slide: {
          id: "slide-1",
          type: "bullets",
          title: "o".repeat(80),
          subtitle: "s".repeat(180),
          bullets: ["b".repeat(140)],
          notes: "n".repeat(1_500),
          seconds: 30,
        },
      });
      return {
        ok: true,
        status: 200,
        text: async () =>
          JSON.stringify({ choices: [{ message: { content } }] }),
      };
    };
    const app = createServer({
      rootDir: root,
      publicDir,
      templateDir,
      env: { AI_API_KEY: "refine-test-key" },
      fetchImpl,
    });
    const base = await listen(app);
    try {
      for (const notesLength of [500, 1_000, 1_001, 1_500]) {
        const slide = {
          id: "slide-1",
          type: "bullets",
          title: "t".repeat(80),
          subtitle: "s".repeat(180),
          bullets: ["b".repeat(130)],
          notes: "n".repeat(notesLength),
          seconds: 30,
        };
        const result = await jsonFetch(base, "/api/refine", {
          method: "POST",
          body: JSON.stringify({ slide, instruction: "请精简", mode: "ai" }),
        });
        assert.equal(result.response.status, 200);
        const userPayload = JSON.parse(latestRequest.messages[1].content);
        assert.equal(userPayload.slide.title.length, 80);
        assert.equal(userPayload.slide.subtitle.length, 180);
        assert.equal(userPayload.slide.bullets[0].length, 130);
        assert.equal(userPayload.slide.notes.length, notesLength);
        assert.ok(result.body.slide.title.length <= 60);
        assert.ok(result.body.slide.subtitle.length <= 180);
        assert.ok(result.body.slide.bullets[0].length <= 130);
        assert.ok(result.body.slide.notes.length <= 500);
      }

      const tooLong = await jsonFetch(base, "/api/refine", {
        method: "POST",
        body: JSON.stringify({
          slide: {
            id: "slide-1",
            type: "bullets",
            title: "t".repeat(80),
            subtitle: "",
            bullets: [],
            notes: "n".repeat(1_501),
            seconds: 30,
          },
          instruction: "请精简",
          mode: "ai",
        }),
      });
      assert.equal(tooLong.response.status, 400);
      assert.match(tooLong.body.error, /notes/);
    } finally {
      await close(app);
    }
  });
});

test("AI timeout remains active while reading the response body", async () => {
  await withFixture(async ({ root, publicDir, templateDir }) => {
    let bodyAborted = false;
    const fetchImpl = async (_url, { signal }) => ({
      ok: true,
      status: 200,
      text: () =>
        new Promise((resolve, reject) => {
          const timer = setTimeout(() => resolve("not json"), 200);
          signal.addEventListener(
            "abort",
            () => {
              clearTimeout(timer);
              bodyAborted = true;
              const error = new Error("body aborted");
              error.name = "AbortError";
              reject(error);
            },
            { once: true },
          );
        }),
    });
    const app = createServer({
      rootDir: root,
      publicDir,
      templateDir,
      env: { AI_API_KEY: "timeout-test-key" },
      fetchImpl,
      aiTimeoutMs: 25,
    });
    const base = await listen(app);
    try {
      const result = await jsonFetch(base, "/api/generate", {
        method: "POST",
        body: JSON.stringify({ ...sampleGenerate, mode: "ai" }),
      });
      assert.equal(result.response.status, 504);
      assert.match(result.body.error, /超时/);
      assert.equal(bodyAborted, true);
    } finally {
      await close(app);
    }
  });
});
