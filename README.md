# BrandBeamer · 智稿

**让好想法，自成一稿。** 把汇报材料变成可编辑、符合机构品牌、适合指定讲述时长的演示稿。

BrandBeamer 是基于 [cityu-beamer](https://github.com/inscripoem/cityu-beamer) 改造的轻量演示稿工作台，适合学校项目汇报、实验室分享和企业内部提案。网页编辑器与 Beamer 导出共用结构化内容。

> **当前默认是无需密钥的规则演示模式。** 它按输入材料提取和组织内容，不调用 AI，也不会冒充 AI 输出。真实 AI 生成和单页精简接口已实现；配置服务端 `.env` 后可使用。模型质量取决于所配置的服务与模型。

## 三步运行

需要 **Node.js 24 或更新版本**。无第三方运行依赖，无需安装包或构建。

```bash
git clone https://github.com/Theoic123/BrandBeamer.git
cd BrandBeamer
npm start
```

浏览器打开 **http://127.0.0.1:3000**。首次打开自带可编辑的中文示例稿。

## 已实现

- 输入汇报材料与主题，选择 3、5 或 10 分钟。
- 明确区分规则演示模式与真实 AI 模式。
- PNG/JPG Logo 上传（最大 2 MB）、机构、部门、汇报人和主题色定制，全稿同步应用。
- 封面、要点、双栏、结束页四种版式，16:9 实时预览。
- 逐页编辑标题、副标题、要点、讲稿和建议讲述秒数。
- 单页精简、页面添加、删除、上下移动。
- 全屏幕覆盖式演示，方向键、空格和 Esc 控制。
- 浏览器打印 / 保存 PDF；Beamer `.tex`、主题、Logo 和许可证 ZIP 下载。
- JSON 草稿导出与导入，浏览器本地自动保存。
- 桌面和手机响应式布局，不加载第三方字体或分析脚本。

## 使用流程

1. 点击 **试试示例**，或粘贴自己的材料（30–12000 字）。
2. 选择汇报时长，保持 **演示模式**，点击 **生成我的演示稿**。
3. 在 **品牌设置** 中上传 Logo、修改机构名称和主色。仓库的 `public/demo/qinghe-logo.png` 是可用于试用的自制 Logo，青禾机构名称为虚构示例。
4. 从左侧页面列表选页，在右侧修改内容；讲稿位于画布下方。
5. 点击 **演示** 翻页，或通过 **导出演示稿** 保存 PDF、Beamer 源码和 JSON 草稿。

生成会替换当前演示稿。重要版本建议先导出 JSON 草稿；品牌信息独立于内容保存。

## 配置真实 AI

复制 `.env.example` 为 `.env`（Windows PowerShell：`Copy-Item .env.example .env`），填写：

```dotenv
AI_API_KEY=your-provider-key
AI_BASE_URL=https://your-provider.example/v1
AI_MODEL=your-provider-model
PORT=3000
HOST=127.0.0.1
```

`AI_BASE_URL` 支持兼容 Chat Completions 的服务地址，程序会补充 `/chat/completions`，也支持完整的该端点地址。填写你所用服务实际支持的模型。修改后重启服务，再在页面中选择 **AI 生成**。

密钥只由 Node 服务读取；浏览器请求只携带材料、文本配置和必要的页面内容。Logo 不会发送给模型。`.env` 被 Git 忽略，也不会被静态服务器提供。

接口错误、超时和未配置密钥都会给出提示，不会悄悄切换到规则演示。AI 输出需经结构与长度校验，讲述秒数会调整至目标总时长。使用前仍应核对内容事实；提示词约束无法保证模型绝不出错。

## PDF 与 Beamer

**浏览器 PDF**：选择“打印 / 保存为 PDF”，在浏览器打印界面保存。模板设置为 320 × 180 mm、每张幻灯片一页。建议关闭浏览器页眉页脚并启用背景图形；若浏览器不采用自定义纸张，请选择横向、零边距并检查预览。

**Beamer**：解压 ZIP 后，用带有 `beamer`、`ctex`、Fandol、`fontspec`、TikZ、Latin Modern 和 TeX Gyre 字体的 XeLaTeX 环境编译。具体命令见 ZIP 内的 README。文本中的 LaTeX 特殊字符会转义，用户输入不会作为原始 LaTeX 命令执行。

网页和 Beamer 使用两种排版引擎，导出内容一致，视觉布局不保证像素级相同。当前环境未安装 XeLaTeX，本地编译尚未验证；ZIP 格式与生成代码通过自动化测试验证。

## 验证

```bash
npm run check
npm test
```

测试使用 Node 内置测试框架，并关闭测试进程隔离以兼容受限 Windows 环境。覆盖请求校验、演示生成、模拟 AI 上游、错误处理、静态文件边界、ZIP 结构与 CRC、Logo 校验及 LaTeX 转义。真实付费模型调用不属于离线测试。

## 项目结构

```text
server.mjs                 Node HTTP 服务、AI/演示生成、校验
public/index.html          工作台结构
public/styles.css          品牌预览、响应式与打印样式
public/app.js              编辑状态、交互、草稿和演示
public/export.js           Beamer 源码与无依赖 ZIP 打包
templates/beamer/          通用品牌主题与上游许可证
tests/                     Node 自动化测试
docs/DEMO.md               比赛演示脚本与验收清单
```

## 范围与后续计划

此版本适合本地使用与 hackathon 演示：无账号、多租户隔离、数据库或协作服务。草稿及 Logo 存在当前浏览器 localStorage；清除站点数据会清除草稿。建议通过 JSON 导出保存重要版本。

默认仅监听本机。若将 `HOST` 改为 `0.0.0.0` 对外提供服务，应在部署入口增加认证和调用限额，避免公开消耗模型额度。GitHub 仓库提供源码；它本身不是运行 Node 服务的网站托管。

下一阶段：配置真实模型并用真实材料评估、进一步校验长内容排版、完成 XeLaTeX 编译验证。随后再考虑文档解析、PPTX 和协作。

## 开源与致谢

本项目使用 MIT 许可证。Beamer 主题改造自 `inscripoem/cityu-beamer` 的 MIT 代码，保留上游版权声明，详见 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)。公开项目未附带上游 CityU 校徽、背景图、含品牌素材的 PDF 或预览。通用网页背景与主题图形为本项目实现；上传素材由使用者自行确保有权使用。本项目与 CityU 或示例机构无官方关联。
