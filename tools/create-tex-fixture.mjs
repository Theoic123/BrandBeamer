import { mkdir, copyFile, writeFile } from 'node:fs/promises';
import { buildTex } from '../public/export.js';

const out = new URL('../.artifacts/tex-smoke/', import.meta.url);
await mkdir(out, { recursive: true });
const brand = { institution: '青禾创新实验室', department: '测试与验证', presenter: 'BrandBeamer', color: '#164c42' };
const deck = { title: '中文与 English 演示验证', slides: [
  { type: 'cover', title: '让好想法，自成一稿。', subtitle: '中文与 English 混排验证', notes: '这是讲稿，包含 50% 与 A&B。', seconds: 30 },
  { type: 'bullets', title: '特殊字符与内容', subtitle: '安全转义', bullets: ['A&B 的进度是 50%', 'price=$10, file_name #1', '文字命令不执行：\\input{evil}'], notes: '', seconds: 60 },
  { type: 'columns', title: '双栏页面', bullets: ['左侧内容', '右侧内容'], seconds: 60 },
  { type: 'columns', title: '仅有一个要点', bullets: ['只有这一条'], seconds: 60 },
  { type: 'bullets', title: '空白内容页仍可编译', bullets: [], seconds: 60 },
  { type: 'closing', title: '谢谢 · Thank you', subtitle: '期待下一次分享', seconds: 30 }
] };
await writeFile(new URL('main.tex', out), buildTex(deck, brand));
await copyFile(new URL('../templates/beamer/beamerthemeBrand.sty', import.meta.url), new URL('beamerthemeBrand.sty', out));
console.log('Created .artifacts/tex-smoke/main.tex');
