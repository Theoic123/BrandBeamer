import { lookup as dnsLookup } from "node:dns/promises";
import { isIP } from "node:net";
import { request as httpsRequest } from "node:https";

const DEFAULT_MODEL = "gpt-4o-mini";
const DEFAULT_AI_BASE_URL = "https://api.openai.com/v1/chat/completions";
const DEFAULT_AI_TIMEOUT_MS = 75_000;
const MAX_UPSTREAM_BODY_BYTES = 2 * 1024 * 1024;
const MAX_PROVIDER_MODEL_LENGTH = 200;
const MAX_PERSONAL_BASE_URL_LENGTH = 2_048;
const MAX_PERSONAL_API_KEY_LENGTH = 4_096;

const PROVIDER_DEFINITIONS = Object.freeze({
  openai: Object.freeze({
    id: "openai",
    label: "OpenAI",
    defaultBaseUrl: "https://api.openai.com/v1",
    defaultModel: "gpt-5.4",
    models: Object.freeze([
      Object.freeze({ id: "gpt-5.4", label: "GPT-5.4" }),
      Object.freeze({ id: "gpt-5.4-mini", label: "GPT-5.4 mini" }),
    ]),
    protocol: "chat-completions",
  }),
  anthropic: Object.freeze({
    id: "anthropic",
    label: "Anthropic Claude",
    defaultBaseUrl: "https://api.anthropic.com/v1/messages",
    defaultModel: "claude-sonnet-5",
    models: Object.freeze([
      Object.freeze({ id: "claude-sonnet-5", label: "Claude Sonnet 5" }),
      Object.freeze({ id: "claude-opus-5", label: "Claude Opus 5" }),
    ]),
    protocol: "anthropic-messages",
  }),
  qwen: Object.freeze({
    id: "qwen",
    label: "通义千问",
    defaultBaseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1",
    defaultModel: "qwen-plus",
    models: Object.freeze([
      Object.freeze({ id: "qwen-plus", label: "Qwen Plus" }),
      Object.freeze({ id: "qwen3.8-max", label: "Qwen3.8 Max" }),
    ]),
    protocol: "chat-completions",
  }),
  gemini: Object.freeze({
    id: "gemini",
    label: "Google Gemini",
    defaultBaseUrl: "https://generativelanguage.googleapis.com/v1beta",
    defaultModel: "gemini-3.8-flash",
    models: Object.freeze([
      Object.freeze({ id: "gemini-3.8-flash", label: "Gemini 3.8 Flash" }),
    ]),
    protocol: "gemini-generate-content",
  }),
  compatible: Object.freeze({
    id: "compatible",
    label: "OpenAI 兼容服务",
    defaultBaseUrl: "https://api.openai.com/v1",
    defaultModel: DEFAULT_MODEL,
    models: Object.freeze([
      Object.freeze({ id: DEFAULT_MODEL, label: "兼容模型" }),
    ]),
    protocol: "chat-completions",
  }),
});

const SITE_PROFILE_DEFINITIONS = Object.freeze([
  Object.freeze({
    id: "default",
    label: "服务器默认",
    provider: "compatible",
    key: "AI_API_KEY",
    baseUrl: "AI_BASE_URL",
    model: "AI_MODEL",
    legacy: true,
  }),
  Object.freeze({
    id: "openai",
    label: "OpenAI",
    provider: "openai",
    key: "OPENAI_API_KEY",
    baseUrl: "OPENAI_BASE_URL",
    model: "OPENAI_MODEL",
  }),
  Object.freeze({
    id: "anthropic",
    label: "Anthropic Claude",
    provider: "anthropic",
    key: "ANTHROPIC_API_KEY",
    baseUrl: "ANTHROPIC_BASE_URL",
    model: "ANTHROPIC_MODEL",
  }),
  Object.freeze({
    id: "qwen",
    label: "通义千问",
    provider: "qwen",
    key: "QWEN_API_KEY",
    baseUrl: "QWEN_BASE_URL",
    model: "QWEN_MODEL",
  }),
  Object.freeze({
    id: "gemini",
    label: "Google Gemini",
    provider: "gemini",
    key: "GEMINI_API_KEY",
    baseUrl: "GEMINI_BASE_URL",
    model: "GEMINI_MODEL",
  }),
]);

const SITE_PROFILE_BY_ID = new Map(
  SITE_PROFILE_DEFINITIONS.map((profile) => [profile.id, profile]),
);
const PROVIDER_BY_ID = new Map(
  Object.values(PROVIDER_DEFINITIONS).map((provider) => [
    provider.id,
    provider,
  ]),
);

export const AI_PROVIDER_IDS = Object.freeze([
  "openai",
  "anthropic",
  "qwen",
  "gemini",
  "compatible",
]);

export const AI_SITE_PROFILE_IDS = Object.freeze(
  SITE_PROFILE_DEFINITIONS.map((profile) => profile.id),
);

export { DEFAULT_AI_BASE_URL, DEFAULT_AI_TIMEOUT_MS, DEFAULT_MODEL };

class AiHttpError extends Error {
  constructor(status, message, options = {}) {
    super(message);
    this.name = "AiHttpError";
    this.status = status;
    this.code = options.code;
    this.headers = options.headers ?? {};
  }
}

class AiResponseError extends Error {
  constructor(message) {
    super(message);
    this.name = "AiResponseError";
  }
}

class UpstreamBodyTooLargeError extends Error {
  constructor() {
    super("AI 服务返回内容过大");
    this.name = "UpstreamBodyTooLargeError";
  }
}

class UpstreamTimeoutError extends Error {
  constructor() {
    super("AI 服务响应超时");
    this.name = "UpstreamTimeoutError";
  }
}

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function valueFromEnv(env, key, fallback = "") {
  const value = env?.[key];
  return value === undefined || value === null || String(value).trim() === ""
    ? fallback
    : String(value).trim();
}

function isNonEmptyString(value) {
  return typeof value === "string" && value.trim().length > 0;
}

function clip(value, max) {
  return String(value ?? "")
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, "")
    .trim()
    .slice(0, max);
}

function redactSecret(value, secret) {
  if (!secret) return String(value ?? "");
  return String(value ?? "")
    .split(secret)
    .join("[已隐藏]");
}

function validModel(value, name = "model") {
  if (!isNonEmptyString(value)) throw new AiHttpError(400, `${name}不能为空`);
  const model = clip(value, MAX_PROVIDER_MODEL_LENGTH);
  if (!model || model.length !== value.trim().length)
    throw new AiHttpError(400, `${name}无效`);
  if (/[\u0000-\u001f\u007f]/u.test(model))
    throw new AiHttpError(400, `${name}无效`);
  return model;
}

function parseUrl(value, name, { personal = false } = {}) {
  if (!isNonEmptyString(value)) throw new AiHttpError(400, `${name}不能为空`);
  if (value.length > MAX_PERSONAL_BASE_URL_LENGTH)
    throw new AiHttpError(400, `${name}过长`);
  let url;
  try {
    url = new URL(value.trim());
  } catch {
    throw new AiHttpError(400, `${name}无效`);
  }
  if (personal) {
    if (url.protocol !== "https:")
      throw new AiHttpError(400, "个人 AI 地址必须使用 HTTPS");
    const authority = value
      .trim()
      .replace(/^https:\/\//iu, "")
      .split(/[/?#]/u)[0];
    if (url.username || url.password || authority.includes("@"))
      throw new AiHttpError(400, "个人 AI 地址不能包含用户信息");
    if (url.search || url.hash)
      throw new AiHttpError(400, "个人 AI 地址不能包含查询参数或片段");
    if (!url.hostname) throw new AiHttpError(400, "个人 AI 地址缺少主机名");
    if (isBlockedHostname(url.hostname))
      throw new AiHttpError(400, "个人 AI 地址不能指向本机或保留网络");
  }
  return url;
}

function normaliseHost(hostname) {
  return String(hostname ?? "")
    .replace(/^\[/u, "")
    .replace(/\]$/u, "")
    .replace(/\.$/u, "")
    .toLowerCase();
}

function isBlockedHostname(hostname) {
  const host = normaliseHost(hostname);
  if (!host) return true;
  if (isIP(host)) return isBlockedIp(host);
  if (
    host === "localhost" ||
    host.endsWith(".localhost") ||
    host === "localhost.localdomain" ||
    host === "ip6-localhost" ||
    host === "ip6-loopback" ||
    host.endsWith(".local") ||
    host.endsWith(".internal") ||
    host.endsWith(".home.arpa") ||
    host === "metadata.google.internal" ||
    host === "metadata.google.com"
  ) {
    return true;
  }
  // Hostnames are parsed as DNS names by URL, so control characters and
  // malformed labels should never make it to a resolver or Host header.
  if (
    !/^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)*[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/iu.test(
      host,
    )
  ) {
    return true;
  }
  return false;
}

function ipv4Parts(address) {
  const parts = String(address).split(".");
  if (parts.length !== 4 || parts.some((part) => !/^\d+$/u.test(part)))
    return null;
  const numbers = parts.map(Number);
  if (numbers.some((part) => part < 0 || part > 255)) return null;
  return numbers;
}

function ipv6Bytes(address) {
  let value = normaliseHost(address);
  const mapped = value.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/iu);
  if (mapped) {
    const parts = ipv4Parts(mapped[1]);
    if (!parts) return null;
    return Uint8Array.from([
      0,
      0,
      0,
      0,
      0,
      0,
      0,
      0,
      0,
      0,
      0xff,
      0xff,
      ...parts,
    ]);
  }
  if (value.includes(".")) {
    const lastColon = value.lastIndexOf(":");
    const parts = ipv4Parts(value.slice(lastColon + 1));
    if (!parts) return null;
    value = `${value.slice(0, lastColon)}:${((parts[0] << 8) | parts[1]).toString(16)}:${((parts[2] << 8) | parts[3]).toString(16)}`;
  }
  const sections = value.split("::");
  if (sections.length > 2) return null;
  const left = sections[0] ? sections[0].split(":") : [];
  const right =
    sections.length === 2 && sections[1] ? sections[1].split(":") : [];
  if (
    left.some((part) => !/^[0-9a-f]{1,4}$/iu.test(part)) ||
    right.some((part) => !/^[0-9a-f]{1,4}$/iu.test(part))
  )
    return null;
  const missing = 8 - left.length - right.length;
  if ((sections.length === 1 && missing !== 0) || missing < 0) return null;
  const words = [
    ...left,
    ...Array.from({ length: missing }, () => "0"),
    ...right,
  ].map((part) => Number.parseInt(part || "0", 16));
  if (words.length !== 8) return null;
  const result = new Uint8Array(16);
  words.forEach((word, index) => {
    result[index * 2] = word >> 8;
    result[index * 2 + 1] = word & 0xff;
  });
  return result;
}

function startsWithBytes(bytes, prefix, bits) {
  const whole = Math.floor(bits / 8);
  for (let index = 0; index < whole; index += 1) {
    if (bytes[index] !== (prefix[index] ?? 0)) return false;
  }
  const remainder = bits % 8;
  if (!remainder) return true;
  const mask = (0xff << (8 - remainder)) & 0xff;
  return (bytes[whole] & mask) === ((prefix[whole] ?? 0) & mask);
}

function isBlockedIp(address) {
  const ipVersion = isIP(address);
  if (ipVersion === 4) {
    const parts = ipv4Parts(address);
    if (!parts) return true;
    const ranges = [
      [[0, 0, 0, 0], 8],
      [[10, 0, 0, 0], 8],
      [[100, 64, 0, 0], 10],
      [[127, 0, 0, 0], 8],
      [[169, 254, 0, 0], 16],
      [[172, 16, 0, 0], 12],
      [[192, 0, 0, 0], 24],
      [[192, 0, 2, 0], 24],
      [[192, 88, 99, 0], 24],
      [[192, 168, 0, 0], 16],
      [[198, 18, 0, 0], 15],
      [[198, 51, 100, 0], 24],
      [[203, 0, 113, 0], 24],
      [[224, 0, 0, 0], 4],
      [[240, 0, 0, 0], 4],
    ];
    return ranges.some(([start, bits]) => {
      const mask = bits === 0 ? 0 : (0xffffffff << (32 - bits)) | 0;
      const value =
        ((parts[0] << 24) | (parts[1] << 16) | (parts[2] << 8) | parts[3]) >>>
        0;
      const network =
        ((start[0] << 24) | (start[1] << 16) | (start[2] << 8) | start[3]) >>>
        0;
      return (value & mask) >>> 0 === (network & mask) >>> 0;
    });
  }
  if (ipVersion === 6) {
    const bytes = ipv6Bytes(address);
    if (!bytes) return true;
    // IPv4-mapped IPv6 literals are another spelling of an IPv4 destination;
    // classify the embedded address with the same private/reserved ranges.
    if (
      bytes.slice(0, 10).every((value) => value === 0) &&
      bytes[10] === 0xff &&
      bytes[11] === 0xff
    ) {
      return isBlockedIp(Array.from(bytes.slice(12)).join("."));
    }
    return [
      [[0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0], 128],
      [[0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1], 128],
      [[0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0], 96],
      [[0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0xff], 96],
      [[0, 0x64, 0xff, 0x9b], 96],
      [[0, 0x64, 0xff, 0x9b, 0, 1], 48],
      [[0x01, 0x00, 0, 0, 0, 0, 0, 0], 64],
      [[0xfc, 0, 0], 7],
      [[0xfe, 0x80], 10],
      [[0xfe, 0xc0], 10],
      [[0xff], 8],
      [[0x20, 0x01, 0], 32],
      [[0x20, 0x01, 0, 0x01], 32],
      [[0x20, 0x01, 0x0d, 0xb8], 32],
      [[0x20, 0x01, 0x00, 0x02], 48],
      [[0x20, 0x01, 0x00, 0x10], 28],
      [[0x20, 0x01, 0x00, 0x20], 28],
      [[0x20, 0x02], 16],
      [[0x3f, 0xff], 20],
      [[0x5f, 0], 16],
    ].some(([prefix, bits]) => startsWithBytes(bytes, prefix, bits));
  }
  return true;
}

function chatCompletionsUrl(baseUrl) {
  const url =
    baseUrl instanceof URL ? new URL(baseUrl) : parseUrl(baseUrl, "AI 地址");
  if (!/\/chat\/completions\/?$/iu.test(url.pathname)) {
    url.pathname = `${url.pathname.replace(/\/$/u, "")}/chat/completions`;
  }
  return url;
}

function anthropicUrl(baseUrl) {
  const url =
    baseUrl instanceof URL ? new URL(baseUrl) : parseUrl(baseUrl, "AI 地址");
  if (!/\/messages\/?$/iu.test(url.pathname)) {
    url.pathname = `${url.pathname.replace(/\/$/u, "")}/messages`;
  }
  return url;
}

function geminiUrl(baseUrl, model) {
  const url =
    baseUrl instanceof URL ? new URL(baseUrl) : parseUrl(baseUrl, "AI 地址");
  const suffix = `/models/${encodeURIComponent(model)}:generateContent`;
  if (!/\/models\/[^/]+:generateContent\/?$/iu.test(url.pathname)) {
    url.pathname = `${url.pathname.replace(/\/$/u, "")}${suffix}`;
  }
  return url;
}

function providerFor(id) {
  const provider = PROVIDER_BY_ID.get(id);
  if (!provider) throw new AiHttpError(400, "provider 无效");
  return provider;
}

function profileEnv(env, definition) {
  const provider = providerFor(definition.provider);
  const fallbackBaseUrl = definition.legacy
    ? DEFAULT_AI_BASE_URL
    : provider.defaultBaseUrl;
  return {
    id: definition.id,
    label: definition.label,
    provider: provider.id,
    protocol: provider.protocol,
    apiKey: valueFromEnv(env, definition.key),
    baseUrl: valueFromEnv(env, definition.baseUrl, fallbackBaseUrl),
    model: valueFromEnv(env, definition.model, provider.defaultModel),
    legacy: Boolean(definition.legacy),
  };
}

function publicProvider(provider) {
  return {
    id: provider.id,
    label: provider.label,
    defaultBaseUrl: provider.defaultBaseUrl,
    defaultModel: provider.defaultModel,
    models: provider.models.map(({ id, label }) => ({ id, label })),
  };
}

function publicSiteProfile(env, definition) {
  const profile = profileEnv(env, definition);
  return {
    id: profile.id,
    label: profile.label,
    provider: profile.provider,
    model: profile.model,
    configured: Boolean(profile.apiKey),
  };
}

export function getAiConfig(env = process.env) {
  return {
    providers: AI_PROVIDER_IDS.map((id) =>
      publicProvider(PROVIDER_DEFINITIONS[id]),
    ),
    siteProfiles: SITE_PROFILE_DEFINITIONS.map((definition) =>
      publicSiteProfile(env, definition),
    ),
    personalEnabled: true,
  };
}

function validateApiKey(value) {
  if (!isNonEmptyString(value)) throw new AiHttpError(400, "apiKey不能为空");
  const apiKey = String(value).trim();
  if (apiKey.length > MAX_PERSONAL_API_KEY_LENGTH)
    throw new AiHttpError(400, "apiKey过长");
  if (/[\u0000-\u001f\u007f]/u.test(apiKey))
    throw new AiHttpError(400, "apiKey无效");
  return apiKey;
}

function resolveAiSelection(env, ai) {
  if (ai === undefined) {
    const profile = profileEnv(env, SITE_PROFILE_DEFINITIONS[0]);
    return {
      ...profile,
      source: "site",
      securePersonal: false,
    };
  }
  if (!isRecord(ai)) throw new AiHttpError(400, "ai 必须是对象");

  if (ai.source === "site") {
    if (!isNonEmptyString(ai.profileId))
      throw new AiHttpError(400, "ai.profileId不能为空");
    const definition = SITE_PROFILE_BY_ID.get(ai.profileId.trim());
    if (!definition) throw new AiHttpError(400, "ai.profileId无效");
    const profile = profileEnv(env, definition);
    if (!profile.apiKey)
      throw new AiHttpError(503, `AI 服务未配置，请设置 ${definition.key}`);
    // Deliberately resolve every transport field from the server profile.
    // Unknown properties on a site selection cannot override credentials or URL.
    return {
      ...profile,
      source: "site",
      securePersonal: false,
    };
  }

  if (ai.source !== "personal")
    throw new AiHttpError(400, "ai.source 必须是 site 或 personal");
  const provider = providerFor(ai.provider);
  const baseUrl = parseUrl(ai.baseUrl, "ai.baseUrl", { personal: true });
  const model = validModel(ai.model, "ai.model");
  const apiKey = validateApiKey(ai.apiKey);
  return {
    id: "personal",
    label: "个人配置",
    provider: provider.id,
    protocol: provider.protocol,
    apiKey,
    baseUrl: baseUrl.toString(),
    model,
    source: "personal",
    securePersonal: true,
  };
}

export function resolveAiRequest(env, ai) {
  const selection = resolveAiSelection(env, ai);
  // Do not return the secret from this public helper. The service keeps it only
  // in its request-local selection while constructing a single upstream call.
  return {
    source: selection.source,
    provider: selection.provider,
    model: selection.model,
    baseUrl: selection.baseUrl,
    protocol: selection.protocol,
  };
}

async function resolvePinnedAddress(hostname, signal) {
  const host = normaliseHost(hostname);
  if (isBlockedHostname(host))
    throw new AiHttpError(400, "个人 AI 地址不能指向本机或保留网络");
  if (isIP(host)) {
    if (isBlockedIp(host))
      throw new AiHttpError(400, "个人 AI 地址不能指向本机或保留网络");
    return host;
  }
  if (signal?.aborted) throw new UpstreamTimeoutError();
  let records;
  try {
    records = await dnsLookup(host, { all: true, verbatim: true });
  } catch {
    if (signal?.aborted) throw new UpstreamTimeoutError();
    throw new AiHttpError(400, "个人 AI 地址无法解析");
  }
  if (signal?.aborted) throw new UpstreamTimeoutError();
  if (
    !Array.isArray(records) ||
    !records.length ||
    records.some((record) => isBlockedIp(record.address))
  )
    throw new AiHttpError(400, "个人 AI 地址解析到本机或保留网络");
  const selected = records.find((record) => !isBlockedIp(record.address));
  if (!selected) throw new AiHttpError(400, "个人 AI 地址解析到本机或保留网络");
  return selected.address;
}

function abortError() {
  const error = new Error("AI 服务响应超时");
  error.name = "AbortError";
  return error;
}

function nodeResponse(res, signal) {
  let onAbort;
  const cleanup = () => {
    if (signal && onAbort) signal.removeEventListener("abort", onAbort);
  };
  const cancel = () => {
    cleanup();
    res.destroy();
  };
  onAbort = () => cancel();
  if (signal) {
    if (signal.aborted) cancel();
    else signal.addEventListener("abort", onAbort, { once: true });
  }
  return {
    status: res.statusCode ?? 0,
    ok: (res.statusCode ?? 500) >= 200 && (res.statusCode ?? 500) < 300,
    cancel,
    text: () =>
      new Promise((resolve, reject) => {
        const chunks = [];
        let total = 0;
        let settled = false;
        const finish = (callback, value) => {
          if (settled) return;
          settled = true;
          cleanup();
          res.removeListener("data", onData);
          res.removeListener("end", onEnd);
          res.removeListener("error", onError);
          res.removeListener("close", onClose);
          callback(value);
        };
        const onData = (chunk) => {
          total += chunk.length;
          if (total > MAX_UPSTREAM_BODY_BYTES) {
            res.destroy();
            finish(reject, new UpstreamBodyTooLargeError());
            return;
          }
          chunks.push(chunk);
        };
        const onEnd = () =>
          finish(resolve, Buffer.concat(chunks).toString("utf8"));
        const onError = (error) => finish(reject, error);
        const onClose = () =>
          finish(
            reject,
            signal?.aborted ? abortError() : new Error("response closed"),
          );
        res.on("data", onData);
        res.once("end", onEnd);
        res.once("error", onError);
        res.once("close", onClose);
      }),
  };
}

function releaseResponse(response) {
  try {
    if (typeof response?.cancel === "function") {
      response.cancel();
      return;
    }
    if (typeof response?.body?.cancel === "function") {
      void response.body.cancel();
      return;
    }
    if (typeof response?.body?.resume === "function") response.body.resume();
  } catch {
    // The upstream status is already being converted to a generic API error.
  }
}

async function pinnedHttpsRequest(url, init, signal) {
  const address = await resolvePinnedAddress(url.hostname, signal);
  return await new Promise((resolve, reject) => {
    let settled = false;
    let onAbort;
    const cleanup = () => {
      if (signal && onAbort) signal.removeEventListener("abort", onAbort);
    };
    const request = httpsRequest(
      {
        protocol: "https:",
        hostname: address,
        port: url.port || 443,
        path: `${url.pathname || "/"}${url.search || ""}`,
        method: init.method ?? "POST",
        headers: {
          ...(init.headers ?? {}),
          // Keep TLS SNI and the HTTP Host header on the user supplied public
          // hostname while connecting to the pinned DNS address.
          host: url.host,
        },
        servername: url.hostname,
        rejectUnauthorized: true,
      },
      (response) => {
        settled = true;
        cleanup();
        resolve(nodeResponse(response, signal));
      },
    );
    onAbort = () => {
      request.destroy(abortError());
      cleanup();
      if (!settled) reject(new UpstreamTimeoutError());
    };
    if (signal) {
      if (signal.aborted) {
        onAbort();
        return;
      }
      signal.addEventListener("abort", onAbort, { once: true });
    }
    request.once("error", (error) => {
      cleanup();
      if (!settled) reject(error);
    });
    request.end(init.body);
  });
}

function responseOk(response) {
  if (!response) return false;
  if (response.ok !== undefined) return Boolean(response.ok);
  return !(
    Number.isFinite(Number(response.status)) && Number(response.status) >= 400
  );
}

async function responseText(response) {
  if (!response) throw new Error("missing response");
  let text;
  if (typeof response.text === "function") text = await response.text();
  else if (typeof response.json === "function")
    text = JSON.stringify(await response.json());
  else text = "";
  if (Buffer.byteLength(String(text), "utf8") > MAX_UPSTREAM_BODY_BYTES)
    throw new UpstreamBodyTooLargeError();
  return String(text);
}

function upstreamError(status) {
  if (status === 401)
    return new AiHttpError(401, "AI 凭证无效或已过期，请检查 API key");
  if (status === 403)
    return new AiHttpError(403, "AI 服务拒绝了请求，请检查权限或模型访问权");
  if (status === 408 || status === 504)
    return new AiHttpError(504, "AI 服务响应超时，请稍后重试");
  if (status === 429)
    return new AiHttpError(429, "AI 服务请求过于频繁，请稍后重试");
  if (status >= 500)
    return new AiHttpError(502, `AI 服务暂时不可用（HTTP ${status}）`);
  return new AiHttpError(502, `AI 服务返回错误（HTTP ${status}）`);
}

function buildRequest(selection, messages, { test = false } = {}) {
  const provider = providerFor(selection.provider);
  const maxOutputTokens = test ? 1_024 : 8_192;
  const isGpt54Model = /^gpt-5\.4(?:[-.].*)?$/iu.test(selection.model);
  const prompt = messages
    .map((message) => `${message.role}: ${message.content}`)
    .join("\n\n");
  if (provider.protocol === "anthropic-messages") {
    const system = messages
      .filter((message) => message.role === "system")
      .map((message) => message.content)
      .join("\n\n");
    const userMessages = messages
      .filter((message) => message.role !== "system")
      .map((message) => ({
        role: message.role === "assistant" ? "assistant" : "user",
        content: String(message.content),
      }));
    return {
      url: anthropicUrl(selection.baseUrl),
      headers: {
        "content-type": "application/json",
        "x-api-key": selection.apiKey,
        "anthropic-version": "2023-06-01",
      },
      body: {
        model: selection.model,
        max_tokens: maxOutputTokens,
        ...(system ? { system } : {}),
        messages: userMessages.length
          ? userMessages
          : [{ role: "user", content: prompt }],
      },
    };
  }
  if (provider.protocol === "gemini-generate-content") {
    const system = messages
      .filter((message) => message.role === "system")
      .map((message) => message.content)
      .join("\n\n");
    const userPrompt = messages
      .filter((message) => message.role !== "system")
      .map((message) => `${message.role}: ${message.content}`)
      .join("\n\n");
    return {
      url: geminiUrl(selection.baseUrl, selection.model),
      headers: {
        "content-type": "application/json",
        // Gemini accepts x-goog-api-key, which keeps the credential out of the
        // URL and therefore out of common access logs and redirect locations.
        "x-goog-api-key": selection.apiKey,
      },
      body: {
        ...(system ? { systemInstruction: { parts: [{ text: system }] } } : {}),
        contents: [{ role: "user", parts: [{ text: userPrompt || prompt }] }],
        generationConfig: {
          maxOutputTokens,
          ...(test ? {} : { responseMimeType: "application/json" }),
        },
      },
    };
  }
  const compatibleBody = {
    model: selection.model,
    messages,
    ...(provider.id === "openai" ||
    (provider.id === "compatible" && isGpt54Model)
      ? { max_completion_tokens: maxOutputTokens }
      : { max_tokens: maxOutputTokens }),
  };
  const supportsReasoningEffort =
    isGpt54Model && (provider.id === "openai" || provider.id === "compatible");
  if (supportsReasoningEffort) compatibleBody.reasoning_effort = "none";
  return {
    url: chatCompletionsUrl(selection.baseUrl),
    headers: {
      authorization: `Bearer ${selection.apiKey}`,
      "content-type": "application/json",
    },
    body: compatibleBody,
  };
}

function extractText(payload, providerId) {
  if (providerId === "anthropic") {
    const content = payload?.content;
    if (Array.isArray(content)) {
      return content
        .map((part) => (typeof part === "string" ? part : (part?.text ?? "")))
        .join("");
    }
    if (typeof content === "string") return content;
  }
  if (providerId === "gemini") {
    const parts = payload?.candidates?.[0]?.content?.parts;
    if (Array.isArray(parts))
      return parts.map((part) => part?.text ?? "").join("");
  }
  const content =
    payload?.choices?.[0]?.message?.content ?? payload?.choices?.[0]?.text;
  if (Array.isArray(content))
    return content
      .map((part) => (typeof part === "string" ? part : (part?.text ?? "")))
      .join("");
  if (isRecord(content) && typeof content.text === "string")
    return content.text;
  if (typeof content === "string") return content;
  throw new AiResponseError("AI 返回中缺少文本内容");
}

async function performRequest({
  selection,
  messages,
  fetchImpl,
  trustedFetch,
  aiTimeoutMs,
  test,
}) {
  const request = buildRequest(selection, messages, { test });
  const controller = new AbortController();
  const timeoutMs =
    Number.isFinite(Number(aiTimeoutMs)) && Number(aiTimeoutMs) > 0
      ? Number(aiTimeoutMs)
      : DEFAULT_AI_TIMEOUT_MS;
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    let response;
    try {
      if (selection.securePersonal && !trustedFetch) {
        response = await pinnedHttpsRequest(
          request.url,
          {
            method: "POST",
            headers: request.headers,
            body: JSON.stringify(request.body),
          },
          controller.signal,
        );
      } else {
        if (typeof fetchImpl !== "function")
          throw new AiHttpError(503, "当前运行环境不支持 AI 请求");
        response = await fetchImpl(request.url.toString(), {
          method: "POST",
          headers: request.headers,
          body: JSON.stringify(request.body),
          signal: controller.signal,
          ...(selection.securePersonal ? { redirect: "error" } : {}),
        });
      }
    } catch (error) {
      if (error instanceof AiHttpError) throw error;
      if (
        error instanceof UpstreamTimeoutError ||
        error instanceof UpstreamBodyTooLargeError ||
        error?.name === "AbortError" ||
        controller.signal.aborted
      ) {
        if (error instanceof UpstreamBodyTooLargeError)
          throw new AiHttpError(502, "AI 服务返回内容过大");
        throw new AiHttpError(504, "AI 服务响应超时");
      }
      throw new AiHttpError(502, "AI 服务请求失败");
    }
    const status = Number(response?.status) || 0;
    if (!responseOk(response)) {
      releaseResponse(response);
      throw upstreamError(status);
    }
    let text;
    try {
      text = await responseText(response);
    } catch (error) {
      if (error instanceof UpstreamBodyTooLargeError)
        throw new AiHttpError(502, "AI 服务返回内容过大");
      if (error?.name === "AbortError" || controller.signal.aborted)
        throw new AiHttpError(504, "AI 服务响应超时");
      throw new AiHttpError(502, "AI 服务返回内容无法读取");
    }
    let payload;
    try {
      payload = JSON.parse(text);
    } catch {
      throw new AiHttpError(502, "AI 服务返回的 JSON 无效");
    }
    const safeText = redactSecret(
      extractText(payload, selection.provider),
      selection.apiKey,
    );
    if (!safeText.trim()) throw new AiResponseError("AI 返回中缺少文本内容");
    return {
      text: safeText,
      provider: selection.provider,
      model: selection.model,
    };
  } finally {
    clearTimeout(timeout);
  }
}

function requireConfigured(selection) {
  if (!selection.apiKey) {
    const definition = SITE_PROFILE_DEFINITIONS.find(
      (item) => item.id === selection.id,
    );
    throw new AiHttpError(
      503,
      `AI 服务未配置，请设置 ${definition?.key ?? "AI_API_KEY"}`,
    );
  }
}

function normaliseMessages(messages) {
  if (!Array.isArray(messages) || !messages.length)
    throw new AiHttpError(400, "AI 请求消息不能为空");
  return messages.map((message) => {
    if (!isRecord(message) || !isNonEmptyString(message.role))
      throw new AiHttpError(400, "AI 请求消息无效");
    if (!isNonEmptyString(message.content))
      throw new AiHttpError(400, "AI 请求消息内容不能为空");
    return {
      role: clip(message.role, 20),
      content: clip(message.content, 30_000),
    };
  });
}

export function createAiService({
  env = process.env,
  fetchImpl = globalThis.fetch,
  trustedFetch = false,
  aiTimeoutMs = DEFAULT_AI_TIMEOUT_MS,
} = {}) {
  const runtimeEnv = env ?? {};
  return Object.freeze({
    getConfig() {
      return getAiConfig(runtimeEnv);
    },
    resolve(ai) {
      return resolveAiRequest(runtimeEnv, ai);
    },
    async infer({ ai, messages, test = false } = {}) {
      const selection = resolveAiSelection(runtimeEnv, ai);
      requireConfigured(selection);
      try {
        return await performRequest({
          selection,
          messages: normaliseMessages(messages),
          fetchImpl,
          trustedFetch,
          aiTimeoutMs,
          test,
        });
      } catch (error) {
        if (error instanceof AiResponseError)
          throw new AiHttpError(502, `AI 返回格式无效：${error.message}`);
        if (error instanceof AiHttpError) {
          error.message = redactSecret(error.message, selection.apiKey);
          throw error;
        }
        throw new AiHttpError(502, "AI 服务请求失败");
      }
    },
  });
}

export function isPersonalAi(ai) {
  return isRecord(ai) && ai.source === "personal";
}

export function validatePersonalBaseUrl(value) {
  return parseUrl(value, "ai.baseUrl", { personal: true }).toString();
}

export function classifyIp(address) {
  return { ipVersion: isIP(address), blocked: isBlockedIp(address) };
}
