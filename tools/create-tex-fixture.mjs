import { mkdir, copyFile, writeFile } from "node:fs/promises";
import { buildTex } from "../public/export.js";

const out = new URL("../.artifacts/tex-smoke/", import.meta.url);
await mkdir(out, { recursive: true });
const brand = {
  institution: "青禾创新实验室",
  department: "测试与验证",
  presenter: "BrandBeamer",
  color: "#164c42",
};
const deck = {
  title: "中文与 English 演示验证",
  slides: [
    {
      type: "cover",
      title: "让好想法，自成一稿。",
      subtitle: "中文与 English 混排验证",
      notes: "这是讲稿，包含 50% 与 A&B。",
      seconds: 30,
    },
    {
      type: "bullets",
      title: "特殊字符与内容",
      subtitle: "安全转义",
      bullets: [
        "A&B 的进度是 50%",
        "price=$10, file_name #1",
        "文字命令不执行：\\input{evil}",
      ],
      notes: "",
      seconds: 60,
    },
    {
      type: "columns",
      title: "双栏页面",
      bullets: ["左侧内容", "右侧内容"],
      seconds: 60,
    },
    {
      type: "columns",
      title: "仅有一个要点",
      bullets: ["只有这一条"],
      seconds: 60,
    },
    { type: "bullets", title: "空白内容页仍可编译", bullets: [], seconds: 60 },
    {
      type: "closing",
      title: "谢谢 · Thank you",
      subtitle: "期待下一次分享",
      seconds: 30,
    },
  ],
};
function documentBody(tex) {
  const begin = tex.indexOf("\\begin{document}");
  const end = tex.lastIndexOf("\\end{document}");
  if (begin < 0 || end < begin) {
    throw new Error("Generated TeX is missing its document wrapper");
  }
  return tex.slice(begin + "\\begin{document}".length, end).trim();
}

const styleSources = ["expressive", "minimal", "editorial"].map((style) =>
  buildTex(deck, { ...brand, style }),
);
const firstSource = styleSources[0];
const documentStart = firstSource.slice(
  0,
  firstSource.indexOf("\\begin{document}") + "\\begin{document}".length,
);
const styledBodies = styleSources.map((source, index) => {
  const styleCommand =
    index === 0
      ? ""
      : `\\brandsetstyle{${["expressive", "minimal", "editorial"][index]}}\n`;
  return `${styleCommand}${documentBody(source)}`;
});
const fixture = `${documentStart}\n${styledBodies.join("\n\n")}\n\\end{document}\n`;
await writeFile(new URL("main.tex", out), fixture);
await copyFile(
  new URL("../templates/beamer/beamerthemeBrand.sty", import.meta.url),
  new URL("beamerthemeBrand.sty", out),
);
console.log(
  "Created .artifacts/tex-smoke/main.tex with expressive, minimal, and editorial variants",
);
