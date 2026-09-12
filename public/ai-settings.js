const ALLOWED_PROVIDER_IDS = Object.freeze([
  "openai",
  "anthropic",
  "qwen",
  "gemini",
  "compatible",
]);
const ALLOWED_PROVIDERS = new Set(ALLOWED_PROVIDER_IDS);
const MAX_CONFIG_BYTES = 16 * 1024;
const MAX_MODEL_LENGTH = 160;
const MAX_BASE_URL_LENGTH = 500;
const MAX_API_KEY_LENGTH = 2_000;

export { ALLOWED_PROVIDER_IDS, MAX_CONFIG_BYTES };

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function textValue(value, max = 240) {
  if (typeof value !== "string") return "";
  return value
    .replace(/[\u0000-\u001f\u007f]/g, " ")
    .trim()
    .slice(0, max);
}

function validUrl(value) {
  if (typeof value !== "string" || value.length > MAX_BASE_URL_LENGTH) {
    return false;
  }
  const candidate = textValue(value, MAX_BASE_URL_LENGTH);
  if (!candidate || candidate.length > MAX_BASE_URL_LENGTH) return false;
  try {
    const url = new URL(candidate);
    return (
      url.protocol === "https:" &&
      !url.username &&
      !url.password &&
      !url.search &&
      !url.hash
    );
  } catch {
    return false;
  }
}

function validModel(value) {
  return (
    typeof value === "string" &&
    value.length <= MAX_MODEL_LENGTH &&
    !/[\u0000-\u001f\u007f]/.test(value) &&
    textValue(value, MAX_MODEL_LENGTH).length > 0
  );
}

function providerCatalogEntry(raw) {
  if (!isRecord(raw) || !ALLOWED_PROVIDERS.has(raw.id)) return null;
  const models = Array.isArray(raw.models)
    ? raw.models
        .filter((model) => isRecord(model))
        .map((model) => ({
          id: textValue(model.id, MAX_MODEL_LENGTH),
          label: textValue(model.label, MAX_MODEL_LENGTH),
        }))
        .filter((model) => model.id && model.label)
    : [];
  return {
    id: raw.id,
    label: textValue(raw.label, 100) || raw.id,
    defaultBaseUrl: textValue(raw.defaultBaseUrl, MAX_BASE_URL_LENGTH),
    defaultModel: textValue(raw.defaultModel, MAX_MODEL_LENGTH),
    models,
  };
}

function normaliseCatalog(raw) {
  if (!isRecord(raw)) throw Error("AI 配置目录格式无效。");
  const providers = Array.isArray(raw.providers)
    ? raw.providers.map(providerCatalogEntry).filter(Boolean)
    : [];
  const profiles = Array.isArray(raw.siteProfiles)
    ? raw.siteProfiles
        .filter(
          (profile) =>
            isRecord(profile) &&
            textValue(profile.id, 120) &&
            ALLOWED_PROVIDERS.has(profile.provider),
        )
        .map((profile) => ({
          id: textValue(profile.id, 120),
          label: textValue(profile.label, 160) || textValue(profile.id, 120),
          provider: profile.provider,
          model: textValue(profile.model, MAX_MODEL_LENGTH),
          configured: Boolean(profile.configured),
        }))
        .filter((profile) => profile.model)
    : [];
  return {
    providers,
    siteProfiles: profiles,
    personalEnabled: raw.personalEnabled !== false,
  };
}

function cloneConfig(config) {
  if (!config) return null;
  return config.source === "site"
    ? { source: "site", profileId: config.profileId }
    : {
        source: "personal",
        provider: config.provider,
        baseUrl: config.baseUrl,
        model: config.model,
        apiKey: config.apiKey,
      };
}

function validPersonalConfig(config) {
  return (
    isRecord(config) &&
    config.source === "personal" &&
    ALLOWED_PROVIDERS.has(config.provider) &&
    validUrl(config.baseUrl) &&
    validModel(config.model) &&
    typeof config.apiKey === "string" &&
    config.apiKey.length > 0 &&
    config.apiKey.length <= MAX_API_KEY_LENGTH &&
    !/[\u0000-\u001f\u007f]/.test(config.apiKey)
  );
}

function validImportedConfig(value) {
  if (!isRecord(value)) throw Error("配置文件必须是 JSON 对象。");
  const allowedKeys = new Set(["provider", "baseUrl", "model", "apiKey"]);
  if (Object.keys(value).some((key) => !allowedKeys.has(key))) {
    throw Error("配置文件包含不支持的字段。");
  }
  if (!ALLOWED_PROVIDERS.has(value.provider)) {
    throw Error("配置文件中的服务商不在允许列表中。");
  }
  if (
    typeof value.baseUrl !== "string" ||
    !validUrl(value.baseUrl) ||
    !validModel(value.model)
  ) {
    throw Error("配置文件需要有效的 Base URL 和模型名称。");
  }
  if (
    value.apiKey != null &&
    (typeof value.apiKey !== "string" ||
      value.apiKey.length > MAX_API_KEY_LENGTH ||
      /[\u0000-\u001f\u007f]/.test(value.apiKey))
  ) {
    throw Error("配置文件中的 API key 无效。");
  }
  return {
    source: "personal",
    provider: value.provider,
    baseUrl: textValue(value.baseUrl, MAX_BASE_URL_LENGTH),
    model: textValue(value.model, MAX_MODEL_LENGTH),
    apiKey: value.apiKey || "",
  };
}

function option(value, label) {
  const element = document.createElement("option");
  element.value = value;
  element.textContent = label;
  return element;
}

/**
 * Own the in-memory AI configuration dialog. Secrets remain in this module's
 * closures and are only copied into the short-lived request body returned by
 * getRequestConfig(). No state, storage, export, or prompt code receives them.
 */
export function createAiSettings({
  onApply = () => {},
  onChange = () => {},
  notify = () => {},
  isBusy = () => false,
} = {}) {
  const dialog = document.getElementById("ai-dialog");
  const form = document.getElementById("ai-form");
  const closeButton = document.getElementById("ai-close");
  const source = document.getElementById("ai-source");
  const siteSection = document.getElementById("ai-site-settings");
  const personalSection = document.getElementById("ai-personal-settings");
  const profile = document.getElementById("ai-profile");
  const provider = document.getElementById("ai-provider");
  const baseUrl = document.getElementById("ai-base-url");
  const model = document.getElementById("ai-model");
  const apiKey = document.getElementById("ai-key");
  const keyToggle = document.getElementById("ai-key-toggle");
  const clearButton = document.getElementById("ai-clear");
  const testButton = document.getElementById("ai-test");
  const status = document.getElementById("ai-status");
  const catalogStatus = document.getElementById("ai-catalog-status");
  const catalogRetry = document.getElementById("ai-catalog-retry");
  const configFile = document.getElementById("ai-config-file");
  const importStatus = document.getElementById("ai-import-status");
  const baseUrlList = document.getElementById("ai-base-url-list");
  const modelList = document.getElementById("ai-model-list");
  const openButton = document.getElementById("ai-config-open");

  if (
    !dialog ||
    !form ||
    !closeButton ||
    !source ||
    !siteSection ||
    !personalSection ||
    !profile ||
    !provider ||
    !baseUrl ||
    !model ||
    !apiKey ||
    !keyToggle ||
    !clearButton ||
    !testButton ||
    !status ||
    !catalogStatus ||
    !catalogRetry ||
    !configFile ||
    !importStatus ||
    !baseUrlList ||
    !modelList ||
    !openButton
  ) {
    throw Error("AI 设置界面缺少必要元素。");
  }

  let catalog = { providers: [], siteProfiles: [], personalEnabled: true };
  let catalogState = "loading";
  let active = null;
  let draft = null;
  let testController = null;
  let testVersion = 0;
  let testBusy = false;
  let catalogController = null;
  let importVersion = 0;

  function invalidateImport() {
    importVersion += 1;
  }

  function selectedProvider() {
    return catalog.providers.find((entry) => entry.id === draft?.provider);
  }

  function defaultDraft() {
    if (catalogState === "loading" && !catalog.providers.length) {
      return { source: "site", profileId: "" };
    }
    const configuredProfile = catalog.siteProfiles.find(
      (entry) => entry.configured,
    );
    if (configuredProfile) {
      return { source: "site", profileId: configuredProfile.id };
    }
    const firstProvider = catalog.providers[0];
    return {
      source: catalog.personalEnabled ? "personal" : "site",
      profileId: catalog.siteProfiles[0]?.id || "",
      provider: firstProvider?.id || "openai",
      baseUrl: firstProvider?.defaultBaseUrl || "",
      model: firstProvider?.defaultModel || "",
      apiKey: "",
    };
  }

  function setStatus(message, error = false) {
    status.textContent = message;
    status.classList.toggle("error", error);
  }

  function invalidateTest(message = "测试结果已失效，请重新测试。") {
    testVersion += 1;
    testController?.abort();
    testController = null;
    testBusy = false;
    testButton.disabled = false;
    setStatus(message, false);
  }

  function renderCatalogStatus() {
    catalogStatus.classList.remove("error");
    if (catalogState === "loading") {
      catalogStatus.textContent = "正在加载可用的 AI 配置…";
      catalogRetry.hidden = true;
    } else if (catalogState === "error") {
      catalogStatus.textContent = "AI 配置目录加载失败，请重试。";
      catalogStatus.classList.add("error");
      catalogRetry.hidden = false;
    } else {
      catalogStatus.textContent = "目录已更新，模型名称来自本地服务配置。";
      catalogRetry.hidden = false;
    }
  }

  function renderProfiles() {
    const selected = draft?.profileId || "";
    profile.replaceChildren();
    for (const entry of catalog.siteProfiles) {
      const label = `${entry.label} · ${entry.model}${
        entry.configured ? "" : "（暂不可用）"
      }`;
      const element = option(entry.id, label);
      element.disabled = !entry.configured;
      profile.append(element);
    }
    if (
      selected &&
      !catalog.siteProfiles.some((entry) => entry.id === selected)
    ) {
      const unavailable = option(selected, `${selected}（目录中不可用）`);
      unavailable.disabled = true;
      profile.append(unavailable);
    }
    profile.value = selected;
    const available = catalog.siteProfiles.some((entry) => entry.configured);
    profile.disabled = catalogState !== "ready" || !available;
    const note = document.getElementById("ai-profile-note");
    if (note) {
      note.textContent = available
        ? "不可用的站点配置会保留在目录中，但不能应用。"
        : "当前没有可用的网站配置，请切换到“我的 API”。";
    }
  }

  function renderProviders() {
    const selected = draft?.provider || "";
    provider.replaceChildren();
    for (const entry of catalog.providers) {
      provider.append(option(entry.id, entry.label));
    }
    if (selected && !catalog.providers.some((entry) => entry.id === selected)) {
      const unavailable = option(selected, `${selected}（目录中不可用）`);
      unavailable.disabled = true;
      provider.append(unavailable);
    }
    provider.value = selected;
    provider.disabled = catalogState !== "ready" || !catalog.personalEnabled;
    baseUrl.disabled = !catalog.personalEnabled;
    model.disabled = !catalog.personalEnabled;
    apiKey.disabled = !catalog.personalEnabled;
    clearButton.disabled = !catalog.personalEnabled;
  }

  function renderDatalists() {
    baseUrlList.replaceChildren();
    modelList.replaceChildren();
    const entry = selectedProvider();
    if (entry?.defaultBaseUrl) {
      baseUrlList.append(option(entry.defaultBaseUrl, entry.defaultBaseUrl));
    }
    for (const item of entry?.models || []) {
      modelList.append(option(item.id, item.label));
    }
  }

  function renderDraft() {
    if (!draft) return;
    source.value = draft.source;
    const personalOption = [...source.options].find(
      (entry) => entry.value === "personal",
    );
    if (personalOption) personalOption.disabled = !catalog.personalEnabled;
    siteSection.hidden = draft.source !== "site";
    personalSection.hidden = draft.source !== "personal";
    profile.value = draft.profileId || "";
    provider.value = draft.provider || "";
    baseUrl.value = draft.baseUrl || "";
    model.value = draft.model || "";
    apiKey.value = draft.apiKey || "";
    renderProfiles();
    renderProviders();
    renderDatalists();
    renderCatalogStatus();
  }

  function validation(config) {
    if (!config || config.source === "site") {
      const entry = catalog.siteProfiles.find(
        (profileEntry) => profileEntry.id === config?.profileId,
      );
      if (!entry) return { error: "请选择一个网站提供的 AI 配置。" };
      if (!entry.configured) {
        return { error: "当前网站配置暂不可用，请选择其他配置。" };
      }
      return { value: { source: "site", profileId: entry.id } };
    }
    if (!catalog.personalEnabled) {
      return { error: "当前服务未开启我的 API 配置。" };
    }
    if (!validPersonalConfig(config)) {
      if (!ALLOWED_PROVIDERS.has(config.provider)) {
        return { error: "请选择允许的服务商。" };
      }
      if (!validUrl(config.baseUrl)) {
        return { error: "请输入 https 开头且不含查询参数的 Base URL。" };
      }
      if (!validModel(config.model)) {
        return { error: "请输入模型名称。" };
      }
      return { error: "请输入有效的 API key。" };
    }
    return {
      value: {
        source: "personal",
        provider: config.provider,
        baseUrl: config.baseUrl.trim(),
        model: config.model.trim(),
        apiKey: config.apiKey,
      },
    };
  }

  function summaryFor(config) {
    const checked = validation(config);
    if (!checked.value) return "未配置 AI";
    if (checked.value.source === "site") {
      const entry = catalog.siteProfiles.find(
        (profileEntry) => profileEntry.id === checked.value.profileId,
      );
      return `网站提供 · ${entry?.label || checked.value.profileId}${
        entry?.model ? ` · ${entry.model}` : ""
      }`;
    }
    const entry = catalog.providers.find(
      (providerEntry) => providerEntry.id === checked.value.provider,
    );
    return `我的 API · ${entry?.label || checked.value.provider} · ${checked.value.model}`;
  }

  function notifyChange() {
    onChange({
      configured: Boolean(active && validation(active).value),
      summary: summaryFor(active),
    });
  }

  function open() {
    if (isBusy() || dialog.open) return false;
    invalidateImport();
    draft = cloneConfig(active) || defaultDraft();
    importStatus.textContent = "";
    invalidateTest("尚未测试当前配置。");
    renderDraft();
    dialog.showModal();
    apiKey.value = draft.apiKey || "";
    return true;
  }

  function close() {
    if (dialog.open) dialog.close();
  }

  function apply() {
    const checked = validation(draft);
    if (!checked.value) {
      setStatus(checked.error, true);
      return false;
    }
    active = checked.value;
    notifyChange();
    onApply({ summary: summaryFor(active) });
    notify("AI 设置已应用。请注意，AI 请求可能产生费用。");
    close();
    return true;
  }

  async function loadCatalog() {
    catalogController?.abort();
    const controller = new AbortController();
    catalogController = controller;
    catalogState = "loading";
    renderCatalogStatus();
    try {
      const response = await fetch("/api/ai/config", {
        method: "GET",
        cache: "no-store",
        signal: controller.signal,
      });
      const data = await response.json();
      if (!response.ok) throw Error(data.error || "AI 配置目录加载失败。");
      catalog = normaliseCatalog(data);
      catalogState = "ready";
      if (dialog.open) {
        if (
          !draft ||
          (!active && draft.source === "site" && !draft.profileId)
        ) {
          draft = cloneConfig(active) || defaultDraft();
        }
        renderDraft();
      }
      renderCatalogStatus();
      notifyChange();
    } catch (error) {
      if (controller.signal.aborted) return;
      catalogState = "error";
      renderCatalogStatus();
      if (dialog.open)
        setStatus(error.message || "AI 配置目录加载失败。", true);
    } finally {
      if (catalogController === controller) catalogController = null;
    }
  }

  async function testConnection() {
    if (testBusy) return;
    const checked = validation(draft);
    if (!checked.value) {
      setStatus(checked.error, true);
      return;
    }
    const requestVersion = testVersion;
    const controller = new AbortController();
    testController = controller;
    testBusy = true;
    testButton.disabled = true;
    setStatus("正在测试连接…");
    const timer = setTimeout(() => controller.abort(), 30_000);
    try {
      const response = await fetch("/api/ai/test", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ai: checked.value }),
        signal: controller.signal,
      });
      const data = await response.json();
      if (requestVersion !== testVersion || !dialog.open) return;
      if (!response.ok || !data.ok) {
        setStatus(data.message || data.error || "连接测试失败。", true);
        return;
      }
      const target = [data.provider, data.model].filter(Boolean).join(" · ");
      setStatus(
        `${data.message || "连接成功。"}${target ? `（${target}）` : ""}`,
      );
    } catch (error) {
      if (requestVersion !== testVersion || !dialog.open) return;
      setStatus(
        error.name === "AbortError" ? "连接测试超时，请重试。" : error.message,
        true,
      );
    } finally {
      clearTimeout(timer);
      if (requestVersion === testVersion) {
        testBusy = false;
        if (testController === controller) testController = null;
        testButton.disabled = false;
      }
    }
  }

  function personalFieldChanged() {
    if (!draft) return;
    invalidateImport();
    draft.provider = provider.value;
    draft.baseUrl = baseUrl.value;
    draft.model = model.value;
    draft.apiKey = apiKey.value;
    invalidateTest();
  }

  source.addEventListener("change", () => {
    if (!draft) return;
    invalidateImport();
    draft.source = source.value === "personal" ? "personal" : "site";
    invalidateTest();
    renderDraft();
  });
  profile.addEventListener("change", () => {
    if (!draft) return;
    invalidateImport();
    draft.profileId = profile.value;
    invalidateTest();
  });
  provider.addEventListener("change", () => {
    if (!draft) return;
    invalidateImport();
    draft.provider = provider.value;
    const entry = selectedProvider();
    draft.baseUrl = entry?.defaultBaseUrl || "";
    draft.model = entry?.defaultModel || entry?.models[0]?.id || "";
    draft.apiKey = "";
    apiKey.value = "";
    baseUrl.value = draft.baseUrl;
    model.value = draft.model;
    renderDatalists();
    invalidateTest();
  });
  baseUrl.addEventListener("input", personalFieldChanged);
  model.addEventListener("input", personalFieldChanged);
  apiKey.addEventListener("input", personalFieldChanged);
  clearButton.addEventListener("click", () => {
    if (!draft) return;
    invalidateImport();
    draft.apiKey = "";
    apiKey.value = "";
    invalidateTest();
    setStatus("API key 已清除，请填写新的 key 后再测试。", false);
  });
  keyToggle.addEventListener("click", () => {
    const visible = apiKey.type === "text";
    apiKey.type = visible ? "password" : "text";
    keyToggle.textContent = visible ? "显示" : "隐藏";
  });
  testButton.addEventListener("click", testConnection);
  closeButton.addEventListener("click", close);
  form.addEventListener("submit", (event) => {
    event.preventDefault();
    apply();
  });
  dialog.addEventListener("close", () => {
    invalidateImport();
    invalidateTest();
    draft = null;
    apiKey.value = "";
    apiKey.type = "password";
    keyToggle.textContent = "显示";
    configFile.value = "";
    importStatus.textContent = "";
    notifyChange();
  });
  catalogRetry.addEventListener("click", loadCatalog);
  configFile.addEventListener("change", async () => {
    const file = configFile.files?.[0];
    if (!file) return;
    const requestVersion = ++importVersion;
    try {
      if (file.size > MAX_CONFIG_BYTES) {
        throw Error("配置文件不得超过 16 KB。");
      }
      const contents = await file.text();
      let parsed;
      try {
        parsed = JSON.parse(contents);
      } catch {
        throw Error("JSON 格式无效，请检查配置文件。");
      }
      const imported = validImportedConfig(parsed);
      if (requestVersion !== importVersion || !dialog.open) return;
      draft = imported;
      source.value = "personal";
      renderDraft();
      invalidateTest("配置已载入草稿，请先测试或应用。\n不会自动发送请求。");
      importStatus.textContent =
        "配置已载入当前窗口草稿，请点击“应用配置”后使用。";
      importStatus.classList.remove("error");
      notify("配置已载入草稿，尚未应用。");
    } catch (error) {
      if (requestVersion !== importVersion || !dialog.open) return;
      importStatus.textContent = `无法导入：${error.message}`;
      importStatus.classList.add("error");
    } finally {
      if (requestVersion === importVersion) configFile.value = "";
    }
  });
  openButton.addEventListener("click", open);

  renderCatalogStatus();
  loadCatalog();

  return Object.freeze({
    open,
    close,
    apply,
    setBusy(value) {
      openButton.disabled = Boolean(value);
    },
    hasConfig() {
      return Boolean(active && validation(active).value);
    },
    getRequestConfig() {
      return active && validation(active).value ? cloneConfig(active) : null;
    },
    getSummary() {
      return summaryFor(active);
    },
    refreshCatalog: loadCatalog,
  });
}
