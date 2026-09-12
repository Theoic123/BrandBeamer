import { downloadBeamer } from "./export.js";
import {
  extractPalette,
  foregroundFor,
  readableInk,
  normalizeStyle,
  recommendStyle,
  STYLE_OPTIONS,
} from "./brand-style.js";

const $ = (id) => document.getElementById(id);
const key = "brandbeamer.draft.v1";
const types = {
  cover: "封面",
  bullets: "要点",
  columns: "双栏",
  closing: "结束页",
};
const esc = (value = "") =>
  String(value).replace(
    /[&<>"']/g,
    (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        c
      ],
  );
const uid = () => crypto.randomUUID();
const sampleMaterial = `校园里，毕业季闲置物品集中产生，而新生又需要低成本购置生活用品。现有二手群信息分散，物品状态不透明，交易双方往往需要反复沟通。\n我们的“校园循环计划”连接毕业生与新生，为闲置物品建立统一的信息卡：照片、成色、价格和校内取货点。\n第一阶段从书籍、小型生活用品切入，在一个学院内试点。用户发布物品后，可以按类别浏览并预约取货。\n团队已经完成需求访谈提纲和产品原型，下一步将邀请学生志愿者测试发布与预约流程。\n试点关注三个指标：成功流转的物品数量、从发布到预约的时间，以及参与者的满意度。具体目标将在收集首轮数据后确定。\n我们希望与学生组织合作，建立固定的线下交接点，让闲置物品找到下一位主人。`;
const initialBrand = {
  institution: "青禾创新实验室",
  department: "校园可持续创新计划",
  presenter: "项目团队",
  color: "#164c42",
  logo: null,
  style: "expressive",
};
const exampleSlides = [
  {
    type: "cover",
    title: "让闲置，\n遇见下一种可能。",
    subtitle: "校园循环计划 · 从一次转手，到一种可持续的生活方式",
    bullets: [],
    notes:
      "开场从一个熟悉的场景讲起：毕业生打包离校，新生却在购买同样的生活用品。今天介绍的校园循环计划，希望连接这两种需求。",
    seconds: 25,
  },
  {
    type: "bullets",
    title: "一边闲置，一边需要。",
    subtitle: "供需都在校园里，连接却还不够顺畅。",
    bullets: [
      "毕业季产生闲置物品，新生需要低成本购置用品",
      "二手群信息分散，寻找合适物品费时",
      "物品状态不透明，交易需要反复沟通",
    ],
    notes:
      "先描述真实存在的两端需求，再指出交易过程中的摩擦。这里不编造规模数据，先把问题说清楚。",
    seconds: 55,
  },
  {
    type: "columns",
    title: "让每一次转手，都更简单。",
    subtitle: "用统一的信息和清晰的交接流程连接供需。",
    bullets: [
      "统一物品卡：照片、成色、价格与取货点",
      "按类别浏览，快速找到需要的物品",
      "预约校内取货，减少沟通成本",
      "从书籍和小型生活用品开始试点",
    ],
    notes:
      "按照用户路径介绍方案：发布、发现、预约、交接。强调先从有限品类切入，让流程能够真正跑通。",
    seconds: 65,
  },
  {
    type: "bullets",
    title: "从一个学院，迈出第一步。",
    subtitle: "先验证完整流程，再考虑扩大规模。",
    bullets: [
      "已完成：需求访谈提纲和产品原型",
      "下一步：邀请学生志愿者测试发布与预约",
      "寻求合作：与学生组织建立线下交接点",
    ],
    notes:
      "清楚区分已完成的工作与未来计划。展示原型与下一步测试安排，避免把计划表述为既有成果。",
    seconds: 60,
  },
  {
    type: "columns",
    title: "用真实反馈，衡量改变。",
    subtitle: "先收集首轮数据，再设定量化目标。",
    bullets: [
      "流转数量：有多少物品找到新主人",
      "预约效率：从发布到预约需要多久",
      "用户反馈：参与者对流程是否满意",
    ],
    notes:
      "说明三类指标分别反映使用量、效率与体验。目前尚无试点数据，所以不预设未经验证的提升比例。",
    seconds: 65,
  },
  {
    type: "closing",
    title: "下一次循环，\n从我们开始。",
    subtitle: "期待与你一起，让校园里的好物继续发光。",
    bullets: [],
    notes:
      "邀请学生组织和志愿者加入试点。以具体行动结束：一起测试原型、协助设置交接点并收集用户反馈。",
    seconds: 30,
  },
].map((s) => ({ ...s, id: uid() }));
let state = {
  brand: { ...initialBrand },
  deck: { title: "校园循环计划", slides: exampleSlides },
  material: sampleMaterial,
  topic: "校园循环计划",
  duration: 5,
  mode: "demo",
  deckMode: "example",
  current: 0,
};
let busy = false,
  draftBrand,
  toastTimer,
  saveTimer,
  aiConfigured = false,
  logoSequence = 0;
let logoPalette = [];

function normalizeDraft(raw) {
  if (
    !raw ||
    typeof raw !== "object" ||
    !raw.deck ||
    !Array.isArray(raw.deck.slides) ||
    raw.deck.slides.length < 1 ||
    raw.deck.slides.length > 20
  )
    throw Error("草稿需包含 1–20 页幻灯片。");
  const b = raw.brand || {};
  const string = (value, max) =>
    typeof value === "string" ? value.slice(0, max) : "";
  const logo =
    typeof b.logo === "string" &&
    /^data:image\/(png|jpeg);base64,[A-Za-z0-9+/=]+$/.test(b.logo) &&
    b.logo.length < 2800000
      ? b.logo
      : null;
  return {
    brand: {
      institution: string(b.institution, 70),
      department: string(b.department, 70),
      presenter: string(b.presenter, 50),
      color: /^#[0-9a-f]{6}$/i.test(b.color) ? b.color : initialBrand.color,
      style: normalizeStyle(b.style),
      logo,
    },
    deck: {
      title: string(raw.deck.title, 80) || "未命名演示稿",
      slides: raw.deck.slides.map((s) => {
        if (!s || typeof s !== "object") throw Error("草稿包含无效页面。");
        return {
          id: uid(),
          type: Object.hasOwn(types, s.type) ? s.type : "bullets",
          title: string(s.title, 80),
          subtitle: string(s.subtitle, 180),
          bullets: Array.isArray(s.bullets)
            ? s.bullets
                .filter((x) => typeof x === "string")
                .slice(0, 5)
                .map((x) => x.slice(0, 130))
            : [],
          notes: string(s.notes, 1500),
          seconds: Math.min(
            600,
            Math.max(5, Math.round(Number(s.seconds) || 30)),
          ),
        };
      }),
    },
    material: string(raw.material, 12000),
    topic: string(raw.topic, 80),
    duration: [3, 5, 10].includes(Number(raw.duration))
      ? Number(raw.duration)
      : 5,
    mode: raw.mode === "ai" ? "ai" : "demo",
    deckMode: ["ai", "demo", "example"].includes(raw.deckMode)
      ? raw.deckMode
      : "demo",
    current: 0,
  };
}
try {
  const saved = localStorage.getItem(key);
  if (saved) state = normalizeDraft(JSON.parse(saved));
} catch {
  /* A bad or blocked local draft must not stop startup. */
}
function notify(message, error = false) {
  clearTimeout(toastTimer);
  $("toast").textContent = message;
  $("toast").classList.toggle("error", error);
  $("toast").hidden = false;
  toastTimer = setTimeout(
    () => ($("toast").hidden = true),
    error ? 8000 : 4000,
  );
}
function save() {
  $("save-status").textContent = "正在保存…";
  clearTimeout(saveTimer);
  saveTimer = setTimeout(persistDraft, 350);
}
function persistDraft() {
  clearTimeout(saveTimer);
  try {
    localStorage.setItem(key, JSON.stringify(state));
    $("save-status").textContent = "草稿已保存至本机";
  } catch {
    $("save-status").textContent = "本机存储不可用，请导出草稿";
  }
}
window.addEventListener("pagehide", persistDraft);
function slideHTML(slide, index, brand = state.brand) {
  const special = ["cover", "closing"].includes(slide.type);
  const brandHTML = `${brand.logo ? `<img class="slide-logo" src="${esc(brand.logo)}" alt="机构 Logo">` : '<span class="slide-brand-symbol">◈</span>'}<span>${esc(brand.institution || "YOUR BRAND")}</span>`;
  const footer = `${brand.presenter}${brand.presenter && brand.department ? " · " : ""}${brand.department}`;
  const bullets = (slide.bullets || [])
    .map(
      (b, i) =>
        `<li><span class="bullet-number">${String(i + 1).padStart(2, "0")}</span><span>${esc(b)}</span></li>`,
    )
    .join("");
  return `${special ? '<div class="cover-art"></div><div class="cover-spark">✳</div>' : ""}<div class="slide-inner"><div class="slide-brand">${brandHTML}</div>${special ? `<div class="slide-main">${slide.type === "cover" ? '<div class="slide-kicker">IDEAS INTO IMPACT</div>' : ""}<h2>${esc(slide.title)}</h2><p class="slide-subtitle">${esc(slide.subtitle)}</p></div>` : `<h2>${esc(slide.title)}</h2>${slide.subtitle ? `<p class="slide-subtitle">${esc(slide.subtitle)}</p>` : ""}<ul class="slide-bullets">${bullets}</ul>`}<div class="slide-footer"><span>${esc(footer || state.deck.title)}</span><span>${String(index + 1).padStart(2, "0")} / ${String(state.deck.slides.length).padStart(2, "0")}</span></div></div>`;
}
function fitSlide(el) {
  if (!el.isConnected || el.getBoundingClientRect().width === 0) return;
  const targets = [
    ...el.querySelectorAll(
      "h2, .slide-subtitle, .slide-bullets, .slide-bullets li, .bullet-number, .slide-brand, .slide-footer",
    ),
  ];
  const properties = [
    "font-size",
    "line-height",
    "margin-top",
    "margin-bottom",
    "row-gap",
    "column-gap",
    "padding-top",
    "padding-bottom",
  ];
  for (const target of targets)
    for (const property of properties) target.style.removeProperty(property);
  const metrics = targets.map((target) => {
    const computed = getComputedStyle(target);
    return {
      target,
      values: properties
        .map((property) => [property, computed.getPropertyValue(property)])
        .filter(([, value]) => /^\d+(\.\d+)?px$/.test(value))
        .map(([property, value]) => [property, parseFloat(value)]),
    };
  });
  const inner = el.querySelector(".slide-inner");
  const footer = el.querySelector(".slide-footer");
  const fits = () =>
    footer.getBoundingClientRect().bottom <=
      el.getBoundingClientRect().bottom -
        parseFloat(getComputedStyle(inner).paddingBottom) +
        1 && inner.scrollHeight <= inner.clientHeight + 1;
  let scale = 1;
  while (!fits() && scale > 0.35) {
    scale *= 0.9;
    for (const { target, values } of metrics)
      for (const [property, value] of values)
        target.style.setProperty(property, `${value * scale}px`);
  }
  el.dataset.fit = scale.toFixed(3);
}

function paintSlide(el, slide, index, brand = state.brand) {
  el.className = `slide style-${normalizeStyle(brand.style)} slide-${slide.type} ${["bullets", "columns"].includes(slide.type) ? "slide-content" : ""} ${slide.bullets.join("").length > 230 || slide.title.length > 36 ? "slide-dense" : ""}`;
  el.style.setProperty("--brand", brand.color);
  el.style.setProperty("--brand-ink", readableInk(brand.color));
  el.style.setProperty("--on-brand", foregroundFor(brand.color));
  el.innerHTML = slideHTML(slide, index, brand);
  el.querySelectorAll("img").forEach((img) =>
    img.addEventListener("load", () => fitSlide(el), { once: true }),
  );
  requestAnimationFrame(() => fitSlide(el));
}
function renderThumbs() {
  $("thumbnails").innerHTML = state.deck.slides
    .map(
      (s, i) =>
        `<button class="thumbnail ${i === state.current ? "active" : ""}" data-index="${i}" aria-label="第 ${i + 1} 页：${esc(s.title)}" ${i === state.current ? 'aria-current="true"' : ""}><div class="thumb-preview style-${normalizeStyle(state.brand.style)} is-${s.type}" style="--brand:${state.brand.color};--brand-ink:${readableInk(state.brand.color)};--on-brand:${foregroundFor(state.brand.color)}"><div class="thumb-title">${esc(s.title)}</div><div class="thumb-line"></div><div class="thumb-line short"></div></div><div class="thumb-meta"><span>${String(i + 1).padStart(2, "0")}</span><span>${esc(s.title)}</span></div></button>`,
    )
    .join("");
}
function renderMeta() {
  $("deck-name").textContent = state.deck.title;
  $("deck-mode").textContent = {
    example: "示例稿",
    demo: "演示模式",
    ai: "AI 生成",
  }[state.deckMode];
  const n = state.deck.slides.length,
    total = state.deck.slides.reduce((sum, s) => sum + s.seconds, 0);
  $("page-count").textContent = `${n} 页`;
  $("film-count").textContent = String(n).padStart(2, "0");
  $("time-count").textContent =
    `${Math.floor(total / 60)} 分 ${total % 60} 秒 / 目标 ${state.duration} 分钟`;
  $("page-position").textContent =
    `${String(state.current + 1).padStart(2, "0")} / ${String(n).padStart(2, "0")}`;
  $("presentation-position").textContent = `${state.current + 1} / ${n}`;
  $("brand-swatch").style.backgroundColor = state.brand.color;
  $("brand-institution").textContent = state.brand.institution || "未设置机构";
  $("prev-slide").disabled = $("presentation-prev").disabled =
    state.current === 0;
  $("next-slide").disabled = $("presentation-next").disabled =
    state.current === n - 1;
  $("move-up").disabled = state.current === 0 || busy;
  $("move-down").disabled = state.current === n - 1 || busy;
  $("delete-slide").disabled = n === 1 || busy;
  $("add-slide").disabled = n >= 20 || busy;
}
function renderCurrent(fill = true) {
  const slide = state.deck.slides[state.current];
  paintSlide($("slide"), slide, state.current);
  if (!$("presentation").hidden)
    paintSlide($("presentation-slide"), slide, state.current);
  $("slide-kind").textContent = types[slide.type];
  $("edit-index").textContent = String(state.current + 1).padStart(2, "0");
  $("slide-time").textContent = `建议讲述 ${slide.seconds} 秒`;
  if (fill) {
    $("slide-title").value = slide.title;
    $("slide-subtitle").value = slide.subtitle;
    $("slide-bullets").value = slide.bullets.join("\n");
    $("notes").value = slide.notes;
    $("layout").value = slide.type;
    $("seconds").value = slide.seconds;
  }
  const special = ["cover", "closing"].includes(slide.type);
  $("slide-bullets").disabled = special || busy;
  const dense = slide.title.length > 36 || slide.bullets.join("").length > 230;
  $("density-hint").textContent = special
    ? "封面与结束页展示标题和副标题。"
    : dense
      ? "这一页内容偏多，建议精简或拆成两页。"
      : "每行一个要点，最多 5 条，每条 130 字。";
  $("density-hint").classList.toggle("warning", dense);
  renderMeta();
}
function render() {
  renderThumbs();
  renderCurrent();
}
function setSource() {
  $("topic").value = state.topic;
  $("material").value = state.material;
  $("mode").value = state.mode;
  $("char-count").textContent = `${state.material.length} / 12000`;
  document.querySelectorAll("[data-duration]").forEach((b) => {
    const active = Number(b.dataset.duration) === state.duration;
    b.classList.toggle("selected", active);
    b.setAttribute("aria-pressed", String(active));
  });
  modeNote();
}
function modeNote() {
  $("mode-note").textContent =
    state.mode === "demo"
      ? "演示模式按规则整理材料，不调用 AI。"
      : aiConfigured
        ? "AI 接口已配置，将发送正文材料生成演示稿。"
        : "尚未配置 AI。请填写本地 .env 后重启服务。";
}
function setBusy(value) {
  busy = value;
  document.body.classList.toggle("busy", value);
  [
    "generate",
    "refine",
    "load-example",
    "topic",
    "material",
    "mode",
    "slide-title",
    "slide-subtitle",
    "slide-bullets",
    "notes",
    "layout",
    "seconds",
    "import-json",
  ].forEach((id) => ($(id).disabled = value));
  document
    .querySelectorAll("[data-duration]")
    .forEach((b) => (b.disabled = value));
  $("generate-label").textContent = value
    ? "正在整理你的想法…"
    : "生成我的演示稿";
  renderCurrent(false);
}
async function api(path, payload) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 75000);
  try {
    const response = await fetch(path, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
      signal: controller.signal,
    });
    const data = await response.json();
    if (!response.ok) throw Error(data.error || "请求失败，请稍后重试。");
    return data;
  } catch (e) {
    if (e.name === "AbortError")
      throw Error("生成超时，材料和现有稿件已保留，请重试。");
    throw e;
  } finally {
    clearTimeout(timer);
  }
}
function select(index) {
  state.current = Math.max(0, Math.min(index, state.deck.slides.length - 1));
  render();
}
$("thumbnails").addEventListener("click", (e) => {
  const b = e.target.closest("[data-index]");
  if (b) select(Number(b.dataset.index));
});
$("prev-slide").onclick = $("presentation-prev").onclick = () =>
  select(state.current - 1);
$("next-slide").onclick = $("presentation-next").onclick = () =>
  select(state.current + 1);
$("topic").oninput = () => {
  state.topic = $("topic").value;
  save();
};
$("material").oninput = () => {
  state.material = $("material").value;
  $("char-count").textContent = `${state.material.length} / 12000`;
  save();
};
document.querySelectorAll("[data-duration]").forEach(
  (b) =>
    (b.onclick = () => {
      state.duration = Number(b.dataset.duration);
      setSource();
      renderMeta();
      save();
    }),
);
$("mode").onchange = () => {
  state.mode = $("mode").value;
  modeNote();
  save();
};
$("load-example").onclick = () => {
  state.topic = "校园循环计划";
  state.material = sampleMaterial;
  setSource();
  save();
  notify("示例材料已填入。点击生成，体验完整流程。");
};
$("generate").onclick = async () => {
  if (busy) return;
  if (state.material.trim().length < 30)
    return notify("请先输入至少 30 个字的材料，让内容更完整。", true);
  setBusy(true);
  try {
    const result = await api("/api/generate", {
      material: state.material,
      title: state.topic,
      duration: state.duration,
      brand: { ...state.brand, logo: undefined },
      mode: state.mode,
    });
    const parsed = normalizeDraft({
      ...state,
      deck: result.deck,
      deckMode: result.mode,
    });
    state.deck = parsed.deck;
    state.current = 0;
    state.deckMode = result.mode === "ai" ? "ai" : "demo";
    render();
    save();
    notify(
      state.deckMode === "ai"
        ? "演示稿已生成。现在可以逐页调整。"
        : "演示稿已生成：本次为规则演示，未调用 AI。",
    );
  } catch (e) {
    notify(e.message, true);
  } finally {
    setBusy(false);
  }
};
for (const [id, field] of [
  ["slide-title", "title"],
  ["slide-subtitle", "subtitle"],
  ["notes", "notes"],
  ["layout", "type"],
  ["seconds", "seconds"],
  ["slide-bullets", "bullets"],
]) {
  $(id).addEventListener(id === "layout" ? "change" : "input", () => {
    const slide = state.deck.slides[state.current];
    const value = $(id).value;
    if (field === "bullets") {
      const lines = value
        .split("\n")
        .map((x) => x.trim())
        .filter(Boolean);
      if (lines.length > 5 || lines.some((x) => x.length > 130)) {
        $(id).value = slide.bullets.join("\n");
        notify(
          "每页最多 5 条要点，每条最多 130 字。请添加新页容纳更多内容。",
          true,
        );
        return;
      }
    }
    slide[field] =
      field === "bullets"
        ? value
            .split("\n")
            .map((x) => x.trim())
            .filter(Boolean)
            .slice(0, 5)
            .map((x) => x.slice(0, 130))
        : field === "seconds"
          ? Math.max(5, Math.min(600, Number(value) || 5))
          : value;
    renderThumbs();
    renderCurrent(false);
    save();
  });
}
$("seconds").addEventListener("blur", () => {
  $("seconds").value = state.deck.slides[state.current].seconds;
});
$("refine").onclick = async () => {
  if (busy) return;
  const selectedId = state.deck.slides[state.current].id;
  const slide = structuredClone(state.deck.slides[state.current]);
  setBusy(true);
  try {
    const result = await api("/api/refine", {
      slide,
      instruction: "精简文字，保留已有事实，让这一页适合口头汇报。",
      mode: state.mode,
    });
    const index = state.deck.slides.findIndex((s) => s.id === selectedId);
    if (index >= 0) {
      const clean = normalizeDraft({
        ...state,
        deck: { title: state.deck.title, slides: [result.slide] },
      }).deck.slides[0];
      state.deck.slides[index] = { ...clean, id: selectedId };
      render();
      save();
      notify(
        state.mode === "demo"
          ? "已按规则精简文字（演示模式）。"
          : "AI 已精简这一页。",
      );
    }
  } catch (e) {
    notify(e.message, true);
  } finally {
    setBusy(false);
  }
};
$("add-slide").onclick = () => {
  if (busy || state.deck.slides.length >= 20) return;
  state.deck.slides.splice(state.current + 1, 0, {
    id: uid(),
    type: "bullets",
    title: "一个值得分享的想法",
    subtitle: "",
    bullets: ["在右侧编辑你的内容"],
    notes: "",
    seconds: 30,
  });
  state.current++;
  render();
  save();
};
$("delete-slide").onclick = () => {
  if (busy || state.deck.slides.length === 1) return;
  if (!confirm("删除当前页面？此操作不可撤销。")) return;
  state.deck.slides.splice(state.current, 1);
  state.current = Math.min(state.current, state.deck.slides.length - 1);
  render();
  save();
};
for (const [id, offset] of [
  ["move-up", -1],
  ["move-down", 1],
])
  $(id).onclick = () => {
    if (busy) return;
    const next = state.current + offset;
    if (next < 0 || next >= state.deck.slides.length) return;
    [state.deck.slides[next], state.deck.slides[state.current]] = [
      state.deck.slides[state.current],
      state.deck.slides[next],
    ];
    state.current = next;
    render();
    save();
  };
function logoPreview() {
  $("logo-preview").innerHTML = draftBrand.logo
    ? `<img src="${esc(draftBrand.logo)}" alt="上传的 Logo">`
    : "◈";
}
async function paletteFromLogo(data) {
  const image = new Image();
  image.src = data;
  await image.decode();
  const canvas = document.createElement("canvas");
  const ratio = Math.min(
    1,
    96 / Math.max(image.naturalWidth, image.naturalHeight),
  );
  canvas.width = Math.max(1, Math.round(image.naturalWidth * ratio));
  canvas.height = Math.max(1, Math.round(image.naturalHeight * ratio));
  const context = canvas.getContext("2d", { willReadFrequently: true });
  context.drawImage(image, 0, 0, canvas.width, canvas.height);
  return extractPalette(
    context.getImageData(0, 0, canvas.width, canvas.height).data,
  );
}
function renderBrandDesign() {
  const focusedStyle = document.activeElement?.dataset.brandStyle;
  const focusedColor = document.activeElement?.dataset.logoColor;
  $("brand-color").value = draftBrand.color;
  $("color-hex").textContent = draftBrand.color.toUpperCase();
  $("logo-colors").innerHTML = logoPalette
    .map(
      (color) =>
        `<button type="button" class="logo-color ${color === draftBrand.color ? "selected" : ""}" data-logo-color="${color}" aria-label="使用 Logo 颜色 ${color}" aria-pressed="${color === draftBrand.color}" style="--swatch:${color}"><span></span>${color.toUpperCase()}</button>`,
    )
    .join("");
  $("logo-palette-note").textContent = logoPalette.length
    ? "从 Logo 中提取的颜色，点击即可预览。"
    : draftBrand.logo
      ? "未检测到明显色彩，可使用下方预设或手动选择。"
      : "上传 Logo 后推荐配色与风格，也可以直接手动选择。";
  $("apply-logo-style").disabled = logoPalette.length === 0;
  const recommended = logoPalette.length ? recommendStyle(logoPalette) : null;
  $("style-options").innerHTML = STYLE_OPTIONS.map(
    (option) =>
      `<button type="button" class="style-option ${option.id === draftBrand.style ? "selected" : ""}" data-brand-style="${option.id}" aria-pressed="${option.id === draftBrand.style}"><span class="style-card-art style-${option.id}" style="--brand:${draftBrand.color};--on-brand:${foregroundFor(draftBrand.color)};--brand-ink:${readableInk(draftBrand.color)}"><span class="style-card-mark">◈</span><span class="style-card-title">YOUR NEXT IDEA</span><span class="style-card-line"></span></span><strong>${esc(option.name)}${recommended === option.id ? "<em>推荐</em>" : ""}</strong><small>${esc(option.description)}</small></button>`,
  ).join("");
  const index = Math.max(
    0,
    state.deck.slides.findIndex((slide) => slide.type === "cover"),
  );
  const preview = { ...state.deck.slides[index], type: "cover" };
  paintSlide($("brand-slide-preview"), preview, index, draftBrand);
  if (focusedStyle)
    $("style-options")
      .querySelector(`[data-brand-style="${normalizeStyle(focusedStyle)}"]`)
      ?.focus({ preventScroll: true });
  if (focusedColor && logoPalette.includes(focusedColor))
    $("logo-colors")
      .querySelector(`[data-logo-color="${focusedColor}"]`)
      ?.focus({ preventScroll: true });
}
function openBrand() {
  const sequence = ++logoSequence;
  draftBrand = { ...state.brand };
  draftBrand.style = normalizeStyle(draftBrand.style);
  logoPalette = [];
  ["institution", "department", "presenter"].forEach(
    (id) => ($(id).value = draftBrand[id]),
  );
  $("brand-color").value = draftBrand.color;
  $("color-hex").textContent = draftBrand.color.toUpperCase();
  $("logo-file").value = "";
  logoPreview();
  $("brand-dialog").showModal();
  renderBrandDesign();
  if (draftBrand.logo)
    paletteFromLogo(draftBrand.logo)
      .then((colors) => {
        if (sequence !== logoSequence || !$("brand-dialog").open) return;
        logoPalette = colors;
        renderBrandDesign();
      })
      .catch(() => {});
}
$("brand-open").onclick = $("brand-edit").onclick = openBrand;
$("brand-close").onclick = () => $("brand-dialog").close();
$("brand-dialog").addEventListener("close", () => {
  logoSequence++;
});
$("brand-color").oninput = () => {
  draftBrand.color = $("brand-color").value;
  renderBrandDesign();
};
document.querySelectorAll("[data-color]").forEach(
  (b) =>
    (b.onclick = () => {
      $("brand-color").value = draftBrand.color = b.dataset.color;
      renderBrandDesign();
    }),
);
$("logo-remove").onclick = () => {
  logoSequence++;
  draftBrand.logo = null;
  logoPalette = [];
  $("logo-file").value = "";
  logoPreview();
  renderBrandDesign();
};
$("logo-file").onchange = async () => {
  const sequence = ++logoSequence;
  const file = $("logo-file").files[0];
  if (!file) return;
  if (
    !["image/png", "image/jpeg"].includes(file.type) ||
    file.size > 2 * 1024 * 1024
  ) {
    $("logo-file").value = "";
    return notify("请选择不超过 2 MB 的 PNG 或 JPG 图片。", true);
  }
  try {
    const data = await new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result);
      reader.onerror = reject;
      reader.readAsDataURL(file);
    });
    await new Promise((resolve, reject) => {
      const img = new Image();
      img.onload = resolve;
      img.onerror = reject;
      img.src = data;
    });
    if (!$("brand-dialog").open || sequence !== logoSequence) return;
    draftBrand.logo = data;
    logoPalette = [];
    logoPreview();
    renderBrandDesign();
    const colors = await paletteFromLogo(data);
    if (!$("brand-dialog").open || sequence !== logoSequence) return;
    logoPalette = colors;
    renderBrandDesign();
  } catch {
    if (sequence === logoSequence)
      notify("图片无法读取，请选择有效的 PNG 或 JPG。", true);
  }
};
$("logo-colors").onclick = (event) => {
  const button = event.target.closest("[data-logo-color]");
  if (!button) return;
  draftBrand.color = button.dataset.logoColor;
  renderBrandDesign();
};
$("style-options").onclick = (event) => {
  const button = event.target.closest("[data-brand-style]");
  if (!button) return;
  draftBrand.style = normalizeStyle(button.dataset.brandStyle);
  renderBrandDesign();
};
$("apply-logo-style").onclick = () => {
  if (!logoPalette.length) return;
  draftBrand.color = logoPalette[0];
  draftBrand.style = recommendStyle(logoPalette);
  renderBrandDesign();
};
["institution", "department", "presenter"].forEach((id) =>
  $(id).addEventListener("input", () => {
    draftBrand[id] = $(id).value.trim();
    renderBrandDesign();
  }),
);
$("brand-form").onsubmit = (e) => {
  e.preventDefault();
  ["institution", "department", "presenter"].forEach(
    (id) => (draftBrand[id] = $(id).value.trim()),
  );
  state.brand = { ...draftBrand };
  $("brand-dialog").close();
  render();
  persistDraft();
  notify("品牌设置已应用到全部页面。");
};
$("export-toggle").onclick = () => {
  $("export-menu").hidden = !$("export-menu").hidden;
  $("export-toggle").setAttribute(
    "aria-expanded",
    String(!$("export-menu").hidden),
  );
};
document.addEventListener("click", (e) => {
  if (!e.target.closest(".export-wrap")) {
    $("export-menu").hidden = true;
    $("export-toggle").setAttribute("aria-expanded", "false");
  }
});
function closeExport() {
  $("export-menu").hidden = true;
  $("export-toggle").setAttribute("aria-expanded", "false");
}
function download(data, name, type) {
  const url = URL.createObjectURL(new Blob([data], { type }));
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1500);
}
$("export-json").onclick = () => {
  closeExport();
  download(
    JSON.stringify({ ...state, version: 1 }, null, 2),
    "brandbeamer-draft.json",
    "application/json",
  );
  notify("可编辑草稿已下载。");
};
$("import-json").onclick = () => {
  if (!busy) {
    closeExport();
    $("json-file").click();
  }
};
$("json-file").onchange = async () => {
  const file = $("json-file").files[0];
  if (!file) return;
  try {
    if (file.size > 4 * 1024 * 1024) throw Error("草稿文件不得超过 4 MB。");
    const incoming = normalizeDraft(JSON.parse(await file.text()));
    if (!confirm("导入将替换当前草稿，是否继续？")) return;
    state = incoming;
    setSource();
    render();
    save();
    notify("草稿已导入。");
  } catch (e) {
    notify(`无法导入：${e.message}`, true);
  } finally {
    $("json-file").value = "";
  }
};
function preparePrint() {
  $("print-deck").dataset.measuring = "true";
  $("print-deck").replaceChildren();
  state.deck.slides.forEach((slide, i) => {
    const page = document.createElement("div");
    page.className = "print-page";
    const el = document.createElement("div");
    paintSlide(el, slide, i);
    page.append(el);
    $("print-deck").append(page);
  });
  $("print-deck").querySelectorAll(".slide").forEach(fitSlide);
  delete $("print-deck").dataset.measuring;
}
window.addEventListener("beforeprint", preparePrint);
$("export-pdf").onclick = async () => {
  closeExport();
  preparePrint();
  await Promise.all(
    [...$("print-deck").querySelectorAll("img")].map((img) =>
      img.decode().catch(() => {}),
    ),
  );
  window.print();
};
$("export-tex").onclick = async () => {
  closeExport();
  try {
    await downloadBeamer(state.deck, state.brand);
    notify("Beamer 源码已下载。使用 XeLaTeX 编译，说明在 ZIP 内。");
  } catch (e) {
    notify(`导出失败：${e.message}`, true);
  }
};
$("present").onclick = () => {
  $("presentation").hidden = false;
  document.body.style.overflow = "hidden";
  paintSlide(
    $("presentation-slide"),
    state.deck.slides[state.current],
    state.current,
  );
  renderMeta();
  $("presentation-exit").focus();
};
function exitPresentation() {
  $("presentation").hidden = true;
  document.body.style.overflow = "";
  $("present").focus();
}
$("presentation-exit").onclick = exitPresentation;
document.addEventListener("keydown", (e) => {
  if (!$("presentation").hidden) {
    if (e.key === "Escape") exitPresentation();
    if (["ArrowRight", "PageDown", " "].includes(e.key)) {
      e.preventDefault();
      select(state.current + 1);
    }
    if (["ArrowLeft", "PageUp"].includes(e.key)) {
      e.preventDefault();
      select(state.current - 1);
    }
  }
});
setSource();
render();
const slideResizeObserver = new ResizeObserver((entries) =>
  entries.forEach(({ target }) => fitSlide(target)),
);
slideResizeObserver.observe($("slide"));
slideResizeObserver.observe($("presentation-slide"));
slideResizeObserver.observe($("brand-slide-preview"));
fetch("/api/health")
  .then((r) => r.json())
  .then((data) => {
    aiConfigured = Boolean(data.aiConfigured);
    modeNote();
  })
  .catch(() => notify("未连接到本地服务。编辑与草稿仍可使用。", true));
