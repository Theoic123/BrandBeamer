import { createServer as createHttpServer } from "node:http";
import { readFileSync } from "node:fs";
import { readFile as readFileAsync, realpath, stat } from "node:fs/promises";
import {
  dirname,
  extname,
  isAbsolute,
  join,
  relative,
  resolve,
} from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const MODULE_DIR = dirname(fileURLToPath(import.meta.url));
const DEFAULT_PORT = 3000;
const DEFAULT_HOST = "127.0.0.1";
const DEFAULT_MODEL = "gpt-4o-mini";
const DEFAULT_AI_BASE_URL = "https://api.openai.com/v1/chat/completions";
const DEFAULT_AI_TIMEOUT_MS = 30_000;
const MAX_JSON_BYTES = 1024 * 1024;
const MAX_MATERIAL_LENGTH = 12_000;
const MAX_INSTRUCTION_LENGTH = 2_000;
const MAX_INPUT_TITLE_LENGTH = 80;
const MAX_INPUT_SUBTITLE_LENGTH = 180;
const MAX_INPUT_BULLET_LENGTH = 130;
const MAX_INPUT_NOTES_LENGTH = 1_500;
const MAX_SHORT_TEXT = 60;
const MAX_OUTPUT_SUBTITLE_LENGTH = 180;
const MAX_OUTPUT_BULLET_LENGTH = 130;
const MAX_OUTPUT_NOTES_LENGTH = 500;
const SLIDE_TYPES = new Set(["cover", "bullets", "columns", "closing"]);

const MIME_TYPES = {
  ".css": "text/css; charset=utf-8",
  ".gif": "image/gif",
  ".html": "text/html; charset=utf-8",
  ".ico": "image/x-icon",
  ".jpeg": "image/jpeg",
  ".jpg": "image/jpeg",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".sty": "text/plain; charset=utf-8",
  ".txt": "text/plain; charset=utf-8",
  ".webp": "image/webp",
};

const AI_SYSTEM_PROMPT = [
  "你是 BrandBeamer 的演示稿编辑器。",
  "你只能使用用户提交的材料、标题和品牌字段；不得补写、猜测或伪造事实、数字、机构信息、引用、链接或案例。",
  "如果材料不足，请明确写出“材料未提供”，不要用常识填充。",
  "请生成 6-8 页演示稿，并让所有页面的 seconds 为正整数且总和等于用户给出的目标时长（分钟乘 60）。",
  "只返回一个 JSON 对象，不要 Markdown、解释或 JSON 之外的文字。对象形状为：",
  '{"title":"...","slides":[{"id":"slide-1","type":"cover|bullets|columns|closing","title":"...","subtitle":"...","bullets":["..."],"notes":"...","seconds":30}]}.',
  "每页最多 5 条 bullets；每页 title 最多 60 个字符；notes 最多 500 个字符。",
].join("\n");

const REFINE_SYSTEM_PROMPT = [
  "你是 BrandBeamer 的演示稿编辑器。",
  "只根据当前 slide 和用户指令编辑，不得新增材料中没有的事实、数字、引用或机构信息。",
  '只返回一个 JSON 对象，形状为 {"slide":{...}}，slide 必须保留 type、title、subtitle、bullets、notes、seconds 字段。',
  "每页最多 5 条 bullets；title 最多 60 个字符；notes 最多 500 个字符。",
].join("\n");

class HttpError extends Error {
  constructor(status, message, headers = {}) {
    super(message);
    this.name = "HttpError";
    this.status = status;
    this.headers = headers;
  }
}

class ModelResponseError extends Error {
  constructor(message) {
    super(message);
    this.name = "ModelResponseError";
  }
}

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function clipText(value, max) {
  return String(value ?? "")
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, "")
    .trim()
    .slice(0, max);
}

function isNonEmptyString(value) {
  return typeof value === "string" && value.trim().length > 0;
}

function parseDotEnv(contents) {
  const values = {};
  for (const originalLine of String(contents)
    .replace(/^\uFEFF/, "")
    .split(/\r?\n/)) {
    const line = originalLine.trim();
    if (!line || line.startsWith("#")) continue;

    const match = line.match(
      /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/,
    );
    if (!match) continue;

    const key = match[1];
    let value = match[2].trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      const quote = value[0];
      value = value.slice(1, -1);
      if (quote === '"') {
        value = value
          .replace(/\\n/g, "\n")
          .replace(/\\r/g, "\r")
          .replace(/\\t/g, "\t")
          .replace(/\\"/g, '"')
          .replace(/\\\\/g, "\\");
      }
    } else {
      value = value.replace(/\s+#.*$/, "").trim();
    }
    values[key] = value;
  }
  return values;
}

function readDotEnv(envFile) {
  try {
    return parseDotEnv(readFileSync(envFile, "utf8"));
  } catch (error) {
    if (error?.code === "ENOENT") return {};
    return {};
  }
}

/**
 * Read the optional .env file without overriding process.env. Explicit
 * overrides are useful for tests and have the same precedence as process.env.
 */
export function loadEnv({
  envFile = join(process.cwd(), ".env"),
  overrides = {},
} = {}) {
  return {
    ...readDotEnv(envFile),
    ...process.env,
    ...overrides,
  };
}

function valueFromEnv(env, key, fallback = "") {
  const value = env?.[key];
  return value === undefined || value === null || String(value).trim() === ""
    ? fallback
    : String(value).trim();
}

function getRuntimeConfig(options = {}) {
  const envFile =
    options.envFile ?? join(options.rootDir ?? MODULE_DIR, ".env");
  const env = loadEnv({ envFile, overrides: options.env });
  return {
    env,
    model: valueFromEnv(env, "AI_MODEL", DEFAULT_MODEL),
    baseUrl: valueFromEnv(env, "AI_BASE_URL", DEFAULT_AI_BASE_URL),
    aiTimeoutMs: Number.isFinite(Number(options.aiTimeoutMs))
      ? Number(options.aiTimeoutMs)
      : DEFAULT_AI_TIMEOUT_MS,
    fetchImpl: options.fetchImpl ?? globalThis.fetch,
  };
}

function jsonResponse(res, status, body, headers = {}) {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    "cache-control": "no-store",
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(payload),
    ...headers,
  });
  res.end(payload);
}

function textResponse(
  res,
  status,
  body,
  contentType = "text/plain; charset=utf-8",
  headers = {},
) {
  const payload = Buffer.isBuffer(body) ? body : Buffer.from(String(body));
  res.writeHead(status, {
    "cache-control": "no-store",
    "content-type": contentType,
    "content-length": payload.byteLength,
    ...headers,
  });
  res.end(payload);
}

function sendError(res, error) {
  if (res.headersSent) {
    res.destroy();
    return;
  }
  const status = error instanceof HttpError ? error.status : 500;
  const message = error instanceof HttpError ? error.message : "服务器内部错误";
  const headers = error instanceof HttpError ? error.headers : {};
  jsonResponse(res, status, { error: message }, headers);
}

function readRequestBody(req, maxBytes) {
  const contentLength = Number(req.headers["content-length"]);
  if (Number.isFinite(contentLength) && contentLength > maxBytes) {
    req.resume();
    return Promise.reject(new HttpError(413, "请求体过大，最大支持 1MB"));
  }

  return new Promise((resolveBody, reject) => {
    const chunks = [];
    let total = 0;
    let settled = false;

    const finish = (callback, value) => {
      if (settled) return;
      settled = true;
      req.removeListener("data", onData);
      req.removeListener("end", onEnd);
      req.removeListener("error", onError);
      req.removeListener("aborted", onAborted);
      callback(value);
    };

    const onData = (chunk) => {
      total += chunk.length;
      if (total > maxBytes) {
        req.resume();
        finish(reject, new HttpError(413, "请求体过大，最大支持 1MB"));
        return;
      }
      chunks.push(chunk);
    };
    const onEnd = () =>
      finish(resolveBody, Buffer.concat(chunks).toString("utf8"));
    const onError = () => finish(reject, new HttpError(400, "读取请求体失败"));
    const onAborted = () => finish(reject, new HttpError(400, "请求已中断"));

    req.on("data", onData);
    req.once("end", onEnd);
    req.once("error", onError);
    req.once("aborted", onAborted);
  });
}

async function parseJsonRequest(req, maxBytes) {
  const raw = await readRequestBody(req, maxBytes);
  if (!raw.trim()) throw new HttpError(400, "请求体不能为空");
  try {
    return JSON.parse(raw);
  } catch {
    throw new HttpError(400, "请求 JSON 格式无效");
  }
}

function validateString(value, name, { required = true, max = 500 } = {}) {
  if (typeof value !== "string") {
    throw new HttpError(400, `${name}必须是字符串`);
  }
  const trimmed = value.trim();
  if (required && !trimmed) {
    throw new HttpError(400, `${name}不能为空`);
  }
  if (trimmed.length > max) {
    throw new HttpError(400, `${name}过长，最多 ${max} 个字符`);
  }
  return trimmed;
}

function validateGenerateInput(input) {
  if (!isRecord(input)) throw new HttpError(400, "请求体必须是 JSON 对象");

  const material = validateString(input.material, "material", {
    max: MAX_MATERIAL_LENGTH,
  });
  const title = validateString(input.title, "title", {
    max: MAX_INPUT_TITLE_LENGTH,
  });
  if (![3, 5, 10].includes(input.duration)) {
    throw new HttpError(400, "duration 必须是 3、5 或 10");
  }

  if (!isRecord(input.brand)) throw new HttpError(400, "brand 必须是对象");
  const brand = {};
  for (const key of ["institution", "department", "presenter", "color"]) {
    brand[key] = validateString(input.brand[key], `brand.${key}`, {
      required: false,
      max: 200,
    });
  }

  if (!["ai", "demo"].includes(input.mode)) {
    throw new HttpError(400, "mode 必须是 ai 或 demo");
  }

  return { material, title, duration: input.duration, brand, mode: input.mode };
}

function validateInstruction(value) {
  return validateString(value, "instruction", { max: MAX_INSTRUCTION_LENGTH });
}

function validateSlideInput(slide) {
  if (!isRecord(slide)) throw new HttpError(400, "slide 必须是对象");
  if (!SLIDE_TYPES.has(slide.type)) throw new HttpError(400, "slide.type 无效");
  const title = validateString(slide.title, "slide.title", {
    max: MAX_INPUT_TITLE_LENGTH,
  });
  const subtitle =
    slide.subtitle === undefined
      ? ""
      : validateString(slide.subtitle, "slide.subtitle", {
          required: false,
          max: MAX_INPUT_SUBTITLE_LENGTH,
        });
  const bullets = slide.bullets === undefined ? [] : slide.bullets;
  if (!Array.isArray(bullets))
    throw new HttpError(400, "slide.bullets 必须是数组");
  const safeBullets = bullets
    .slice(0, 5)
    .map((bullet, index) =>
      validateString(bullet, `slide.bullets[${index}]`, {
        max: MAX_INPUT_BULLET_LENGTH,
      }),
    );
  const notes =
    slide.notes === undefined
      ? ""
      : validateString(slide.notes, "slide.notes", {
          required: false,
          max: MAX_INPUT_NOTES_LENGTH,
        });
  const seconds = slide.seconds === undefined ? 30 : Number(slide.seconds);
  if (!Number.isFinite(seconds) || seconds <= 0)
    throw new HttpError(400, "slide.seconds 必须是正数");
  const id =
    slide.id === undefined
      ? "slide-1"
      : validateString(slide.id, "slide.id", { max: 100 });
  return {
    id,
    type: slide.type,
    title,
    subtitle,
    bullets: safeBullets,
    notes,
    seconds: Math.max(1, Math.round(seconds)),
  };
}

function normaliseModelSlide(slide, index) {
  if (!isRecord(slide))
    throw new ModelResponseError(`第 ${index + 1} 页不是对象`);
  if (!SLIDE_TYPES.has(slide.type))
    throw new ModelResponseError(`第 ${index + 1} 页 type 无效`);
  if (!isNonEmptyString(slide.title))
    throw new ModelResponseError(`第 ${index + 1} 页缺少 title`);
  if (slide.bullets !== undefined && !Array.isArray(slide.bullets)) {
    throw new ModelResponseError(`第 ${index + 1} 页 bullets 必须是数组`);
  }
  if (slide.notes !== undefined && typeof slide.notes !== "string") {
    throw new ModelResponseError(`第 ${index + 1} 页 notes 必须是字符串`);
  }
  const bullets = (slide.bullets ?? []).slice(0, 5).map((bullet) => {
    if (typeof bullet !== "string")
      throw new ModelResponseError(
        `第 ${index + 1} 页 bullets 必须是字符串数组`,
      );
    return clipText(bullet, MAX_OUTPUT_BULLET_LENGTH);
  });
  const seconds = Number(slide.seconds);
  return {
    id: isNonEmptyString(slide.id)
      ? clipText(slide.id, 100)
      : `slide-${index + 1}`,
    type: slide.type,
    title: clipText(slide.title, MAX_SHORT_TEXT),
    subtitle:
      typeof slide.subtitle === "string"
        ? clipText(slide.subtitle, MAX_OUTPUT_SUBTITLE_LENGTH)
        : "",
    bullets,
    notes:
      typeof slide.notes === "string"
        ? clipText(slide.notes, MAX_OUTPUT_NOTES_LENGTH)
        : "",
    seconds:
      Number.isFinite(seconds) && seconds > 0
        ? Math.max(1, Math.round(seconds))
        : 1,
  };
}

function fitSeconds(slides, targetSeconds) {
  if (!slides.length) return slides;
  const weights = slides.map((slide) =>
    Number.isFinite(slide.seconds) && slide.seconds > 0 ? slide.seconds : 1,
  );
  const totalWeight =
    weights.reduce((sum, value) => sum + value, 0) || slides.length;
  const result = weights.map((weight) =>
    Math.max(1, Math.floor((weight / totalWeight) * targetSeconds)),
  );
  let difference =
    targetSeconds - result.reduce((sum, value) => sum + value, 0);

  if (difference > 0) {
    let index = 0;
    while (difference > 0) {
      result[index % result.length] += 1;
      index += 1;
      difference -= 1;
    }
  } else if (difference < 0) {
    while (difference < 0) {
      const index = result.reduce(
        (best, value, current) => (value > result[best] ? current : best),
        0,
      );
      if (result[index] <= 1) break;
      result[index] -= 1;
      difference += 1;
    }
  }

  return slides.map((slide, index) => ({ ...slide, seconds: result[index] }));
}

function normaliseModelDeck(raw, input) {
  const deck = isRecord(raw?.deck) ? raw.deck : raw;
  if (!isRecord(deck) || !Array.isArray(deck.slides)) {
    throw new ModelResponseError("模型没有返回有效的 slides");
  }
  if (deck.slides.length < 4 || deck.slides.length > 12) {
    throw new ModelResponseError("slides 数量必须在 4 到 12 页之间");
  }

  const slides = deck.slides.map(normaliseModelSlide);
  const seenIds = new Set();
  for (let index = 0; index < slides.length; index += 1) {
    if (!slides[index].id || seenIds.has(slides[index].id))
      slides[index].id = `slide-${index + 1}`;
    seenIds.add(slides[index].id);
  }

  const title = isNonEmptyString(deck.title)
    ? clipText(deck.title, MAX_SHORT_TEXT)
    : clipText(input.title, MAX_SHORT_TEXT);
  return {
    title: title || input.title,
    slides: fitSeconds(slides, input.duration * 60),
  };
}

function splitMaterial(material) {
  const normalised = material.replace(/\r\n?/g, "\n").trim();
  const parts = normalised
    .split(/\n+|(?<=[。！？.!?；;])\s*/u)
    .map((part) => part.trim())
    .filter(Boolean);
  if (parts.length > 1) return parts;

  const chunks = [];
  for (let index = 0; index < normalised.length; index += 100)
    chunks.push(normalised.slice(index, index + 100));
  return chunks.length ? chunks : ["材料未提供"];
}

function demoDeck(input) {
  const pieces = splitMaterial(input.material);
  const source = (index, fallback) =>
    clipText(pieces[index % pieces.length] || fallback, 180);
  const slides = [
    {
      id: "slide-1",
      type: "cover",
      title: clipText(input.title, MAX_SHORT_TEXT),
      subtitle: `${input.duration} 分钟汇报 · 基于所提交材料整理`,
      bullets: [],
      notes: "演示模式：基于提交材料整理，未调用 AI。",
      seconds: 1,
    },
    {
      id: "slide-2",
      type: "bullets",
      title: "材料概览",
      subtitle: "来自提交材料的确定信息",
      bullets: [source(0, "材料未提供")],
      notes: `演示模式：材料摘录。${source(1, "")}`,
      seconds: 1,
    },
    {
      id: "slide-3",
      type: "columns",
      title: "重点摘录",
      subtitle: "按原文拆分展示",
      bullets: [
        source(1, "材料未提供"),
        source(2, "材料未提供"),
        source(3, "材料未提供"),
      ],
      notes: "演示模式：未对材料之外的信息作推断。",
      seconds: 1,
    },
    {
      id: "slide-4",
      type: "bullets",
      title: "可讨论方向",
      subtitle: "需要结合材料继续确认",
      bullets: [
        `依据材料：${source(0, "材料未提供")}`,
        `待确认信息：${source(4, "材料未提供")}`,
        "演示模式不会替代事实核验。",
      ],
      notes: "演示模式：此页只做结构化整理，不代表 AI 结论。",
      seconds: 1,
    },
    {
      id: "slide-5",
      type: "columns",
      title: "下一步提示",
      subtitle: "根据提交内容准备讨论",
      bullets: [
        `回看原文：${source(2, "材料未提供")}`,
        "补充缺失数据后再形成正式结论。",
        "保留品牌信息与演讲者说明。",
      ],
      notes: "演示模式：下一步提示由输入材料的存在性生成。",
      seconds: 1,
    },
    {
      id: "slide-6",
      type: "closing",
      title: "谢谢",
      subtitle: "演示模式｜请在发布前核对材料",
      bullets: [],
      notes: "演示模式：基于提交材料生成，未调用 AI。",
      seconds: 1,
    },
  ];
  return {
    title: clipText(input.title, MAX_SHORT_TEXT),
    slides: fitSeconds(slides, input.duration * 60),
  };
}

function shortenForDemo(value, max) {
  const compact = clipText(value, max).replace(/\s+/g, " ");
  return compact;
}

function demoRefine(slide, instruction) {
  const aggressive = /(短|精简|缩短|简洁|short|brief|concise)/iu.test(
    instruction,
  );
  const maxBullet = aggressive ? 80 : 160;
  const maxSubtitle = aggressive ? 100 : 200;
  const demoNote = "演示模式：本地整理，未调用 AI。";
  const notes = shortenForDemo(slide.notes, aggressive ? 260 : 420);
  return {
    ...slide,
    title: shortenForDemo(slide.title, MAX_SHORT_TEXT),
    subtitle: shortenForDemo(slide.subtitle, maxSubtitle),
    bullets: slide.bullets
      .slice(0, 5)
      .map((bullet) => shortenForDemo(bullet, maxBullet)),
    notes: clipText(notes ? `${notes} ${demoNote}` : demoNote, 500),
  };
}

function chatCompletionsUrl(baseUrl) {
  let url;
  try {
    url = new URL(baseUrl);
  } catch {
    throw new HttpError(502, "AI_BASE_URL 配置无效");
  }
  if (!/\/chat\/completions\/?$/iu.test(url.pathname)) {
    url.pathname = `${url.pathname.replace(/\/$/u, "")}/chat/completions`;
  }
  return url.toString();
}

async function requestAi({ config, messages }) {
  const apiKey = valueFromEnv(config.env, "AI_API_KEY");
  if (!apiKey) throw new HttpError(503, "AI 服务未配置，请设置 AI_API_KEY");
  if (typeof config.fetchImpl !== "function")
    throw new HttpError(503, "当前运行环境不支持 AI 请求");

  const url = chatCompletionsUrl(config.baseUrl);
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), config.aiTimeoutMs);
  try {
    let response;
    try {
      response = await config.fetchImpl(url, {
        method: "POST",
        headers: {
          authorization: `Bearer ${apiKey}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          model: config.model,
          messages,
          temperature: 0.2,
        }),
        signal: controller.signal,
      });
    } catch (error) {
      if (error?.name === "AbortError" || controller.signal.aborted)
        throw new HttpError(504, "AI 服务响应超时");
      throw new HttpError(502, "AI 服务请求失败");
    }

    let responseText = "";
    try {
      responseText =
        typeof response.text === "function"
          ? await response.text()
          : JSON.stringify(await response.json());
    } catch (error) {
      if (error?.name === "AbortError" || controller.signal.aborted)
        throw new HttpError(504, "AI 服务响应超时");
      throw new HttpError(502, "AI 服务返回内容无法读取");
    }
    const responseOk =
      response.ok === undefined
        ? !(
            Number.isFinite(Number(response.status)) &&
            Number(response.status) >= 400
          )
        : response.ok;
    if (!responseOk)
      throw new HttpError(502, `AI 服务返回错误（HTTP ${response.status}）`);

    try {
      return JSON.parse(responseText);
    } catch {
      throw new HttpError(502, "AI 服务返回的 JSON 无效");
    }
  } finally {
    clearTimeout(timeout);
  }
}

function responseContent(payload) {
  const content =
    payload?.choices?.[0]?.message?.content ?? payload?.choices?.[0]?.text;
  if (Array.isArray(content)) {
    return content
      .map((part) => (typeof part === "string" ? part : (part?.text ?? "")))
      .join("");
  }
  if (isRecord(content) && typeof content.text === "string")
    return content.text;
  if (typeof content !== "string")
    throw new ModelResponseError("AI 返回中缺少文本内容");
  return content;
}

function parseModelJson(text) {
  let candidate = String(text).trim();
  const fenced = candidate.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/iu);
  if (fenced) candidate = fenced[1].trim();
  else if (candidate.startsWith("```")) {
    const partialFence = candidate.match(/^```(?:json)?\s*([\s\S]*?)\s*```/iu);
    if (!partialFence) throw new ModelResponseError("AI 返回的代码块不完整");
    candidate = partialFence[1].trim();
  }

  try {
    return JSON.parse(candidate);
  } catch {
    throw new ModelResponseError("AI 返回的 JSON 无效");
  }
}

function redactSecret(text, secret) {
  if (!secret) return text;
  return String(text).split(secret).join("[已隐藏]");
}

function generationMessages(input) {
  return [
    { role: "system", content: AI_SYSTEM_PROMPT },
    {
      role: "user",
      content: JSON.stringify({
        title: input.title,
        durationMinutes: input.duration,
        targetSeconds: input.duration * 60,
        brand: input.brand,
        material: input.material,
      }),
    },
  ];
}

function refineMessages(slide, instruction) {
  return [
    { role: "system", content: REFINE_SYSTEM_PROMPT },
    { role: "user", content: JSON.stringify({ slide, instruction }) },
  ];
}

async function generate(input, config) {
  if (input.mode === "demo") return { deck: demoDeck(input), mode: "demo" };

  try {
    const payload = await requestAi({
      config,
      messages: generationMessages(input),
    });
    const modelText = redactSecret(
      responseContent(payload),
      valueFromEnv(config.env, "AI_API_KEY"),
    );
    const modelJson = parseModelJson(modelText);
    return { deck: normaliseModelDeck(modelJson, input), mode: "ai" };
  } catch (error) {
    if (error instanceof ModelResponseError)
      throw new HttpError(502, `AI 返回格式无效：${error.message}`);
    throw error;
  }
}

async function refine(input, config) {
  const instruction = validateInstruction(input.instruction);
  const slide = validateSlideInput(input.slide);
  const mode = input.mode ?? "ai";
  if (!["ai", "demo"].includes(mode))
    throw new HttpError(400, "mode 必须是 ai 或 demo");
  if (mode === "demo") return { slide: demoRefine(slide, instruction) };

  try {
    const payload = await requestAi({
      config,
      messages: refineMessages(slide, instruction),
    });
    const modelText = redactSecret(
      responseContent(payload),
      valueFromEnv(config.env, "AI_API_KEY"),
    );
    const modelJson = parseModelJson(modelText);
    const rawSlide = isRecord(modelJson?.slide) ? modelJson.slide : modelJson;
    const normalised = normaliseModelSlide(rawSlide, 0);
    return { slide: fitSeconds([normalised], slide.seconds)[0] };
  } catch (error) {
    if (error instanceof ModelResponseError)
      throw new HttpError(502, `AI 返回格式无效：${error.message}`);
    throw error;
  }
}

function isWithin(root, target) {
  const relativePath = relative(root, target);
  return (
    relativePath === "" ||
    (!relativePath.startsWith("..") && !isAbsolute(relativePath))
  );
}

function decodedPathname(req) {
  let pathname;
  try {
    pathname = decodeURIComponent(
      new URL(req.url ?? "/", "http://localhost").pathname,
    );
  } catch {
    throw new HttpError(400, "请求路径无效");
  }
  if (pathname.includes("\0")) throw new HttpError(400, "请求路径无效");
  return pathname;
}

function hasHiddenSegment(pathname) {
  return pathname.split("/").some((segment) => segment.startsWith("."));
}

async function safeStaticFile({ pathname, publicDir, templateDir }) {
  const templateRelative = {
    "/templates/beamer/beamerthemeBrand.sty": join(
      templateDir,
      "beamer",
      "beamerthemeBrand.sty",
    ),
    "/templates/beamer/LICENSE": join(templateDir, "beamer", "LICENSE"),
  };
  const templateTarget = templateRelative[pathname];
  const root = templateTarget ? templateDir : publicDir;
  const target =
    templateTarget ??
    resolve(publicDir, `.${pathname === "/" ? "/index.html" : pathname}`);
  if (!templateTarget && hasHiddenSegment(pathname)) return null;
  if (!isWithin(root, target)) return null;

  let resolvedRoot;
  let resolvedTarget;
  try {
    resolvedRoot = await realpath(root);
    resolvedTarget = await realpath(target);
  } catch (error) {
    if (error?.code === "ENOENT" || error?.code === "ENOTDIR") return null;
    throw error;
  }
  if (!isWithin(resolvedRoot, resolvedTarget)) return null;

  let fileStat;
  try {
    fileStat = await stat(resolvedTarget);
  } catch (error) {
    if (error?.code === "ENOENT" || error?.code === "ENOTDIR") return null;
    throw error;
  }
  if (!fileStat.isFile()) return null;
  const body = await readFileAsync(resolvedTarget);
  const contentType =
    pathname === "/templates/beamer/LICENSE"
      ? "text/plain; charset=utf-8"
      : (MIME_TYPES[extname(resolvedTarget).toLowerCase()] ??
        "application/octet-stream");
  return { body, contentType };
}

async function serveStatic(req, res, paths) {
  const pathname = decodedPathname(req);
  const file = await safeStaticFile({ pathname, ...paths });
  if (!file) {
    textResponse(res, 404, "未找到资源");
    return;
  }
  if (req.method === "HEAD") {
    res.writeHead(200, {
      "cache-control": "no-store",
      "content-type": file.contentType,
      "content-length": file.body.byteLength,
    });
    res.end();
    return;
  }
  textResponse(res, 200, file.body, file.contentType);
}

function routeAllowsMethod(req, res, method) {
  if (req.method === method) return true;
  jsonResponse(res, 405, { error: "请求方法不被支持" }, { allow: method });
  return false;
}

export function createServer(options = {}) {
  const rootDir = resolve(options.rootDir ?? MODULE_DIR);
  const publicDir = resolve(options.publicDir ?? join(rootDir, "public"));
  const templateDir = resolve(
    options.templateDir ?? join(rootDir, "templates"),
  );
  const config = getRuntimeConfig({ ...options, rootDir });
  const maxBodyBytes = Number.isFinite(Number(options.maxBodyBytes))
    ? Number(options.maxBodyBytes)
    : MAX_JSON_BYTES;

  const server = createHttpServer(async (req, res) => {
    try {
      const pathname = decodedPathname(req);
      if (pathname === "/api/health") {
        if (!routeAllowsMethod(req, res, "GET")) return;
        jsonResponse(res, 200, {
          aiConfigured: Boolean(valueFromEnv(config.env, "AI_API_KEY")),
          model: config.model,
          demoAvailable: true,
        });
        return;
      }

      if (pathname === "/api/generate") {
        if (!routeAllowsMethod(req, res, "POST")) return;
        const body = validateGenerateInput(
          await parseJsonRequest(req, maxBodyBytes),
        );
        jsonResponse(res, 200, await generate(body, config));
        return;
      }

      if (pathname === "/api/refine") {
        if (!routeAllowsMethod(req, res, "POST")) return;
        const body = await parseJsonRequest(req, maxBodyBytes);
        if (!isRecord(body)) throw new HttpError(400, "请求体必须是 JSON 对象");
        jsonResponse(res, 200, await refine(body, config));
        return;
      }

      if (pathname.startsWith("/api/")) {
        jsonResponse(res, 404, { error: "未找到 API 路径" });
        return;
      }

      if (req.method !== "GET" && req.method !== "HEAD") {
        jsonResponse(
          res,
          405,
          { error: "请求方法不被支持" },
          { allow: "GET, HEAD" },
        );
        return;
      }
      await serveStatic(req, res, { publicDir, templateDir });
    } catch (error) {
      sendError(res, error);
    }
  });

  server.requestTimeout = Number.isFinite(Number(options.requestTimeoutMs))
    ? Number(options.requestTimeoutMs)
    : 30_000;
  server.headersTimeout = Math.max(
    1_000,
    Math.min(server.requestTimeout, 30_000),
  );
  return server;
}

export const server = createServer();

function isMainModule() {
  if (!process.argv[1]) return false;
  try {
    return (
      pathToFileURL(resolve(process.argv[1])).href ===
      pathToFileURL(fileURLToPath(import.meta.url)).href
    );
  } catch {
    return false;
  }
}

if (isMainModule()) {
  const runtimeEnv = loadEnv({ envFile: join(MODULE_DIR, ".env") });
  const port = Number.parseInt(runtimeEnv.PORT || String(DEFAULT_PORT), 10);
  const host = valueFromEnv(runtimeEnv, "HOST", DEFAULT_HOST);
  server.listen(Number.isFinite(port) ? port : DEFAULT_PORT, host, () => {
    const address = server.address();
    const display =
      typeof address === "object" && address
        ? `${address.address}:${address.port}`
        : `${host}:${port}`;
    console.log(`BrandBeamer server listening on http://${display}`);
  });
}
