import assert from "node:assert/strict";
import { test } from "node:test";

import { classifyIp, createAiService, getAiConfig } from "../ai-service.mjs";
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

async function jsonFetch(base, pathname, init = {}) {
  const response = await fetch(`${base}${pathname}`, {
    ...init,
    headers: {
      "content-type": "application/json",
      ...(init.headers ?? {}),
    },
  });
  return { response, body: await response.json() };
}

function responseFor(url) {
  if (url.includes("generativelanguage.googleapis.com")) {
    return {
      candidates: [{ content: { parts: [{ text: "Reply OK" }] } }],
    };
  }
  if (url.includes("anthropic")) return { content: [{ text: "Reply OK" }] };
  return { choices: [{ message: { content: "Reply OK" } }] };
}

test("AI config is fixed-shape and never exposes site credentials", () => {
  const config = getAiConfig({
    AI_API_KEY: "legacy-secret",
    OPENAI_API_KEY: "openai-secret",
    OPENAI_MODEL: "site-model",
  });
  assert.deepEqual(
    config.providers.map((provider) => provider.id),
    ["openai", "anthropic", "qwen", "gemini", "compatible"],
  );
  assert.deepEqual(
    config.siteProfiles.map((profile) => profile.id),
    ["default", "openai", "anthropic", "qwen", "gemini"],
  );
  assert.equal(
    config.siteProfiles.find((profile) => profile.id === "default").configured,
    true,
  );
  assert.equal(
    config.siteProfiles.find((profile) => profile.id === "openai").model,
    "site-model",
  );
  assert.equal(config.personalEnabled, true);
  assert.doesNotMatch(JSON.stringify(config), /legacy-secret|openai-secret/);
  for (const provider of config.providers) {
    assert.ok(Array.isArray(provider.models));
    assert.ok(provider.defaultBaseUrl.startsWith("https://"));
  }
});

test("native provider requests use their documented endpoint and response shape", async () => {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url, init, body: JSON.parse(init.body) });
    return {
      ok: true,
      status: 200,
      text: async () => JSON.stringify(responseFor(url)),
    };
  };
  const service = createAiService({ fetchImpl, trustedFetch: true, env: {} });

  await service.infer({
    ai: {
      source: "personal",
      provider: "openai",
      baseUrl: "https://example.test/v1",
      model: "gpt-5.4",
      apiKey: "openai-secret",
    },
    messages: [{ role: "user", content: "Reply OK" }],
    test: true,
  });
  await service.infer({
    ai: {
      source: "personal",
      provider: "anthropic",
      baseUrl: "https://anthropic.example/v1",
      model: "claude-sonnet-5",
      apiKey: "claude-secret",
    },
    messages: [
      { role: "system", content: "System" },
      { role: "user", content: "Reply OK" },
    ],
    test: true,
  });
  await service.infer({
    ai: {
      source: "personal",
      provider: "gemini",
      baseUrl: "https://gemini.example/v1beta",
      model: "gemini-3.8-flash",
      apiKey: "gemini-secret",
    },
    messages: [{ role: "user", content: "Reply OK" }],
    test: true,
  });

  assert.equal(calls[0].url, "https://example.test/v1/chat/completions");
  assert.equal(calls[0].init.headers.authorization, "Bearer openai-secret");
  assert.equal(calls[0].body.max_completion_tokens, 1024);
  assert.equal(calls[0].body.reasoning_effort, "none");

  assert.equal(calls[1].url, "https://anthropic.example/v1/messages");
  assert.equal(calls[1].init.headers["x-api-key"], "claude-secret");
  assert.equal(calls[1].body.max_tokens, 1024);
  assert.equal(calls[1].body.system, "System");

  assert.equal(
    calls[2].url,
    "https://gemini.example/v1beta/models/gemini-3.8-flash:generateContent",
  );
  assert.equal(calls[2].init.headers["x-goog-api-key"], "gemini-secret");
  assert.equal(calls[2].body.generationConfig.maxOutputTokens, 1024);
});

test("completion options match the selected model family", async () => {
  const bodies = [];
  const service = createAiService({
    env: {},
    trustedFetch: true,
    fetchImpl: async (_url, init) => {
      bodies.push(JSON.parse(init.body));
      return {
        ok: true,
        status: 200,
        text: async () =>
          JSON.stringify({ choices: [{ message: { content: "Reply OK" } }] }),
      };
    },
  });
  await service.infer({
    ai: {
      source: "personal",
      provider: "openai",
      baseUrl: "https://openai.example/v1",
      model: "gpt-4o",
      apiKey: "a",
    },
    messages: [{ role: "user", content: "Reply OK" }],
    test: true,
  });
  await service.infer({
    ai: {
      source: "personal",
      provider: "compatible",
      baseUrl: "https://proxy.example/v1",
      model: "gpt-5.4",
      apiKey: "b",
    },
    messages: [{ role: "user", content: "Reply OK" }],
    test: true,
  });
  await service.infer({
    ai: {
      source: "personal",
      provider: "compatible",
      baseUrl: "https://proxy.example/v1",
      model: "some-model",
      apiKey: "c",
    },
    messages: [{ role: "user", content: "Reply OK" }],
    test: true,
  });
  assert.equal(bodies[0].max_completion_tokens, 1024);
  assert.equal(bodies[0].reasoning_effort, undefined);
  assert.equal(bodies[1].max_completion_tokens, 1024);
  assert.equal(bodies[1].reasoning_effort, "none");
  assert.equal(bodies[1].temperature, undefined);
  assert.equal(bodies[2].max_tokens, 1024);
  assert.equal(bodies[2].reasoning_effort, undefined);
  assert.equal(bodies[2].temperature, undefined);
});

test("personal URL policy rejects private, reserved, and non-HTTPS destinations before fetch", async () => {
  let calls = 0;
  const service = createAiService({
    env: {},
    trustedFetch: true,
    fetchImpl: async () => {
      calls += 1;
      return {
        ok: true,
        status: 200,
        text: async () =>
          JSON.stringify({ choices: [{ message: { content: "ok" } }] }),
      };
    },
  });
  for (const baseUrl of [
    "http://example.test/v1",
    "https://127.0.0.1/v1",
    "https://[::1]/v1",
    "https://[::ffff:127.0.0.1]/v1",
    "https://10.0.0.1/v1",
    "https://example.test/v1?redirect=evil",
    "https://user:pass@example.test/v1",
  ]) {
    await assert.rejects(
      service.infer({
        ai: {
          source: "personal",
          provider: "compatible",
          baseUrl,
          model: "model",
          apiKey: "secret",
        },
        messages: [{ role: "user", content: "Reply OK" }],
        test: true,
      }),
      (error) => error.status === 400,
    );
  }
  assert.equal(calls, 0);
  assert.equal(classifyIp("2002:7f00:1::").blocked, true);
  assert.equal(
    classifyIp("2001:0000:4136:e378:8000:63bf:3fff:fdd2").blocked,
    true,
  );
  assert.equal(classifyIp("100::1").blocked, true);
  assert.equal(classifyIp("8.8.8.8").blocked, false);
});

test("site profile selection ignores request credential, URL, and model overrides", async () => {
  const calls = [];
  const app = createServer({
    env: {
      OPENAI_API_KEY: "site-secret",
      OPENAI_BASE_URL: "https://site.example/v1",
      OPENAI_MODEL: "site-model",
    },
    fetchImpl: async (url, init) => {
      calls.push({ url, init, body: JSON.parse(init.body) });
      const slides = Array.from({ length: 4 }, (_, index) => ({
        type: index === 0 ? "cover" : index === 3 ? "closing" : "bullets",
        title: `Slide ${index + 1}`,
        subtitle: "",
        bullets: [],
        notes: "",
        seconds: 30,
      }));
      return {
        ok: true,
        status: 200,
        text: async () =>
          JSON.stringify({
            choices: [{ message: { content: JSON.stringify({ slides }) } }],
          }),
      };
    },
  });
  const base = await listen(app);
  try {
    const result = await jsonFetch(base, "/api/generate", {
      method: "POST",
      body: JSON.stringify({
        material: "Material",
        title: "Title",
        duration: 3,
        brand: {
          institution: "I",
          department: "D",
          presenter: "P",
          color: "#123456",
        },
        mode: "ai",
        ai: {
          source: "site",
          profileId: "openai",
          apiKey: "attacker-secret",
          baseUrl: "https://attacker.example/v1",
          model: "attacker-model",
        },
      }),
    });
    assert.equal(result.response.status, 200);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].url, "https://site.example/v1/chat/completions");
    assert.equal(calls[0].init.headers.authorization, "Bearer site-secret");
    assert.equal(calls[0].body.model, "site-model");
    assert.doesNotMatch(
      JSON.stringify(result.body),
      /site-secret|attacker-secret/,
    );
  } finally {
    await close(app);
  }
});

test("AI test endpoint is origin protected, uses a tiny prompt, and reports safe metadata", async () => {
  let call;
  const app = createServer({
    env: {
      AI_API_KEY: "legacy-secret",
      AI_BASE_URL: "https://site.example/v1",
      AI_MODEL: "site-model",
    },
    fetchImpl: async (url, init) => {
      call = { url, init, body: JSON.parse(init.body) };
      return {
        ok: true,
        status: 200,
        text: async () =>
          JSON.stringify({ choices: [{ message: { content: "Reply OK" } }] }),
      };
    },
  });
  const base = await listen(app);
  try {
    const crossSite = await jsonFetch(base, "/api/ai/test", {
      method: "POST",
      headers: { origin: "https://attacker.example" },
      body: JSON.stringify({ ai: { source: "site", profileId: "default" } }),
    });
    assert.equal(crossSite.response.status, 403);
    assert.equal(call, undefined);

    const result = await jsonFetch(base, "/api/ai/test", {
      method: "POST",
      body: JSON.stringify({ ai: { source: "site", profileId: "default" } }),
    });
    assert.equal(result.response.status, 200);
    assert.deepEqual(result.body, {
      ok: true,
      provider: "compatible",
      model: "site-model",
      message: "连接成功",
    });
    assert.equal(call.url, "https://site.example/v1/chat/completions");
    assert.equal(JSON.parse(call.init.body).messages[0].content, "Reply OK");
    assert.equal(JSON.parse(call.init.body).max_tokens, 1024);
    assert.doesNotMatch(JSON.stringify(result.body), /legacy-secret/);
  } finally {
    await close(app);
  }
});

test("upstream auth and rate-limit statuses stay actionable without reflecting credentials", async () => {
  for (const status of [401, 429]) {
    const secret = `status-secret-${status}`;
    const app = createServer({
      fetchImpl: async () => ({
        ok: false,
        status,
        text: async () => JSON.stringify({ error: { message: secret } }),
      }),
      env: {
        AI_API_KEY: secret,
        AI_BASE_URL: "https://status.example/v1",
        AI_MODEL: "status-model",
      },
    });
    const base = await listen(app);
    try {
      const result = await jsonFetch(base, "/api/ai/test", {
        method: "POST",
        body: JSON.stringify({ ai: { source: "site", profileId: "default" } }),
      });
      assert.equal(result.response.status, status);
      assert.doesNotMatch(JSON.stringify(result.body), new RegExp(secret));
      assert.match(result.body.error, status === 401 ? /凭证/ : /频繁/);
    } finally {
      await close(app);
    }
  }
});

test("personal generate and refine share the same request-local provider selection", async () => {
  const calls = [];
  const app = createServer({
    env: {},
    fetchImpl: async (url, init) => {
      const body = JSON.parse(init.body);
      calls.push({ url, init, body });
      if (body.messages?.[1]?.content?.includes('"instruction"')) {
        return {
          ok: true,
          status: 200,
          text: async () =>
            JSON.stringify({
              choices: [
                {
                  message: {
                    content: JSON.stringify({
                      slide: {
                        type: "bullets",
                        title: "Refined",
                        bullets: [],
                        subtitle: "",
                        notes: "",
                        seconds: 30,
                      },
                    }),
                  },
                },
              ],
            }),
        };
      }
      const slides = Array.from({ length: 4 }, (_, index) => ({
        type: index === 0 ? "cover" : index === 3 ? "closing" : "bullets",
        title: `Slide ${index + 1}`,
        subtitle: "",
        bullets: [],
        notes: "",
        seconds: 30,
      }));
      return {
        ok: true,
        status: 200,
        text: async () =>
          JSON.stringify({
            choices: [{ message: { content: JSON.stringify({ slides }) } }],
          }),
      };
    },
    aiTimeoutMs: 1_000,
  });
  const base = await listen(app);
  const ai = {
    source: "personal",
    provider: "compatible",
    baseUrl: "https://personal.example/v1",
    model: "personal-model",
    apiKey: "personal-secret",
  };
  try {
    const generate = await jsonFetch(base, "/api/generate", {
      method: "POST",
      body: JSON.stringify({
        material: "Material",
        title: "Title",
        duration: 3,
        brand: {
          institution: "I",
          department: "D",
          presenter: "P",
          color: "#123456",
        },
        mode: "ai",
        ai,
      }),
    });
    assert.equal(generate.response.status, 200);
    const refine = await jsonFetch(base, "/api/refine", {
      method: "POST",
      body: JSON.stringify({
        slide: {
          type: "bullets",
          title: "Title",
          subtitle: "",
          bullets: [],
          notes: "",
          seconds: 30,
        },
        instruction: "shorten",
        ai,
      }),
    });
    assert.equal(refine.response.status, 200);
    assert.equal(calls.length, 2);
    assert.ok(
      calls.every(
        ({ url }) => url === "https://personal.example/v1/chat/completions",
      ),
    );
    assert.ok(
      calls.every(
        ({ init }) => init.headers.authorization === "Bearer personal-secret",
      ),
    );
    assert.deepEqual(
      [generate.body.provider, refine.body.provider],
      ["compatible", "compatible"],
    );
  } finally {
    await close(app);
  }
});

test("personal credentials stay request-scoped across concurrent inferences", async () => {
  const seen = [];
  const service = createAiService({
    trustedFetch: true,
    env: {},
    fetchImpl: async (_url, init) => {
      seen.push(init.headers.authorization);
      await new Promise((resolve) => setTimeout(resolve, 1));
      return {
        ok: true,
        status: 200,
        text: async () =>
          JSON.stringify({ choices: [{ message: { content: "Reply OK" } }] }),
      };
    },
  });
  await Promise.all([
    service.infer({
      ai: {
        source: "personal",
        provider: "compatible",
        baseUrl: "https://a.example/v1",
        model: "a",
        apiKey: "key-a",
      },
      messages: [{ role: "user", content: "Reply OK" }],
      test: true,
    }),
    service.infer({
      ai: {
        source: "personal",
        provider: "compatible",
        baseUrl: "https://b.example/v1",
        model: "b",
        apiKey: "key-b",
      },
      messages: [{ role: "user", content: "Reply OK" }],
      test: true,
    }),
  ]);
  assert.deepEqual(new Set(seen), new Set(["Bearer key-a", "Bearer key-b"]));
});
