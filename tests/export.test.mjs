import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import { test } from "node:test";

import {
  MAX_LOGO_BYTES,
  buildTex,
  buildZip,
  crc32,
  downloadBeamer,
  escapeLatex,
  parseLogoDataUrl,
} from "../public/export.js";

function readUint16(bytes, offset) {
  return new DataView(
    bytes.buffer,
    bytes.byteOffset,
    bytes.byteLength,
  ).getUint16(offset, true);
}

function readUint32(bytes, offset) {
  return new DataView(
    bytes.buffer,
    bytes.byteOffset,
    bytes.byteLength,
  ).getUint32(offset, true);
}

function findEndOfCentralDirectory(bytes) {
  for (let offset = bytes.length - 22; offset >= 0; offset -= 1) {
    if (readUint32(bytes, offset) === 0x06054b50) {
      return offset;
    }
  }
  throw new Error("ZIP end-of-central-directory record not found");
}

function parseStoredZip(bytes) {
  const endOffset = findEndOfCentralDirectory(bytes);
  const entryCount = readUint16(bytes, endOffset + 10);
  const centralSize = readUint32(bytes, endOffset + 12);
  const centralOffset = readUint32(bytes, endOffset + 16);
  assert.equal(
    centralOffset + centralSize,
    endOffset,
    "central directory must end at EOCD",
  );

  const decoder = new TextDecoder();
  const entries = [];
  let cursor = centralOffset;
  for (let index = 0; index < entryCount; index += 1) {
    assert.equal(
      readUint32(bytes, cursor),
      0x02014b50,
      "central directory signature",
    );
    const flags = readUint16(bytes, cursor + 8);
    const method = readUint16(bytes, cursor + 10);
    const crc = readUint32(bytes, cursor + 16);
    const compressedSize = readUint32(bytes, cursor + 20);
    const uncompressedSize = readUint32(bytes, cursor + 24);
    const nameLength = readUint16(bytes, cursor + 28);
    const extraLength = readUint16(bytes, cursor + 30);
    const commentLength = readUint16(bytes, cursor + 32);
    const localOffset = readUint32(bytes, cursor + 42);
    const name = decoder.decode(
      bytes.slice(cursor + 46, cursor + 46 + nameLength),
    );
    assert.equal(method, 0, `${name} must use ZIP store mode`);
    assert.equal(
      flags,
      0x0800,
      `${name} must declare UTF-8 names without a data descriptor`,
    );
    assert.equal(
      compressedSize,
      uncompressedSize,
      `${name} must not be compressed`,
    );

    assert.equal(
      readUint32(bytes, localOffset),
      0x04034b50,
      `${name} local header signature`,
    );
    const localNameLength = readUint16(bytes, localOffset + 26);
    const localExtraLength = readUint16(bytes, localOffset + 28);
    const localName = decoder.decode(
      bytes.slice(localOffset + 30, localOffset + 30 + localNameLength),
    );
    assert.equal(localName, name, `${name} local and central names must agree`);
    const dataStart = localOffset + 30 + localNameLength + localExtraLength;
    const data = bytes.slice(dataStart, dataStart + compressedSize);
    assert.equal(
      readUint32(bytes, localOffset + 14),
      crc,
      `${name} local CRC must match central CRC`,
    );
    assert.equal(
      readUint32(bytes, localOffset + 18),
      compressedSize,
      `${name} local size`,
    );
    assert.equal(
      readUint32(bytes, localOffset + 22),
      uncompressedSize,
      `${name} local size`,
    );
    entries.push({ name, data, crc, localOffset });

    cursor += 46 + nameLength + extraLength + commentLength;
  }
  assert.equal(
    cursor,
    endOffset,
    "central directory must have exactly the advertised length",
  );
  return entries;
}

function referenceCrc32(value) {
  const bytes =
    typeof value === "string" ? new TextEncoder().encode(value) : value;
  let checksum = 0xffffffff;
  for (const byte of bytes) {
    checksum ^= byte;
    for (let bit = 0; bit < 8; bit += 1) {
      checksum = checksum & 1 ? (checksum >>> 1) ^ 0xedb88320 : checksum >>> 1;
    }
  }
  return (checksum ^ 0xffffffff) >>> 0;
}

test("crc32 matches standard vectors and an independent bitwise implementation", () => {
  assert.equal(crc32(""), 0x00000000);
  assert.equal(crc32("123456789"), 0xcbf43926);

  const unicode = new TextEncoder().encode("品牌 Beamer 演示稿");
  assert.equal(crc32(unicode), referenceCrc32(unicode));
  assert.equal(crc32(unicode.buffer), referenceCrc32(unicode));
  assert.equal(crc32(new DataView(unicode.buffer)), referenceCrc32(unicode));
});

test("buildZip emits deterministic UTF-8 stored entries with valid CRCs and offsets", () => {
  const logo = Uint8Array.from([
    0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
  ]);
  const files = new Map([
    ["main.tex", "\\documentclass{beamer}\n中文内容\n"],
    ["assets/logo.png", logo],
  ]);
  const archive = buildZip(files);
  assert.deepEqual(
    archive,
    buildZip(files),
    "same input should produce byte-for-byte deterministic output",
  );

  const entries = parseStoredZip(archive);
  assert.deepEqual(
    entries.map((entry) => entry.name),
    ["main.tex", "assets/logo.png"],
  );
  assert.equal(
    new TextDecoder().decode(entries[0].data),
    "\\documentclass{beamer}\n中文内容\n",
  );
  assert.deepEqual(entries[1].data, logo);
  for (const entry of entries) {
    assert.equal(
      entry.crc,
      referenceCrc32(entry.data),
      `${entry.name} CRC must match an independent implementation`,
    );
  }

  assert.throws(
    () => buildZip({ "../outside.txt": "x" }),
    /Invalid ZIP entry name/,
  );
  assert.throws(
    () => buildZip({ "/absolute.txt": "x" }),
    /Invalid ZIP entry name/,
  );
  assert.throws(
    () =>
      buildZip([
        ["same.txt", "a"],
        ["same.txt", "b"],
      ]),
    /Duplicate ZIP entry/,
  );
});

test("escapeLatex protects syntax and control characters, including generated TeX source", () => {
  const escaped = escapeLatex("\\&%$#_{}~^\n\t\u0001\u007f中");
  assert.equal(
    escaped,
    "\\textbackslash{}\\&\\%\\$\\#\\_\\{\\}\\textasciitilde{}\\textasciicircum{}    中",
  );
  assert.equal(escapeLatex(null), "");
  assert.equal(escapeLatex(undefined), "");

  const tex = buildTex(
    {
      title: "Deck \\input{evil} & 50%",
      slides: [
        {
          type: "cover",
          title: "Cover #_{}",
          subtitle: "Sub $",
          notes: "note ~^",
          seconds: 5,
        },
        {
          type: "bullets",
          title: "Page &",
          subtitle: "sub",
          bullets: ["item_1", { heading: "H&", body: "B%" }],
          notes: "line\nnext",
          seconds: 12.34,
        },
      ],
    },
    {
      institution: "School & Co",
      department: "Dept_%",
      presenter: "Jane #",
      color: "#abc123",
    },
  );

  assert.match(
    tex,
    /\\title\{Deck \\textbackslash\{\}input\\\{evil\\\} \\& 50\\%\}/,
  );
  assert.ok(
    tex.includes("\\brandcoverwithmeta{Cover \\#\\_\\{\\}}{Sub \\$}{Jane \\#}"),
  );
  assert.match(tex, /\\item item\\_1/);
  assert.match(tex, /\\textbf\{H\\&\}: B\\%/);
  assert.match(tex, /\\transduration\{12\.34\}/);
  assert.doesNotMatch(
    tex,
    /\\input\{evil\}/,
    "user text must not become an executable TeX command",
  );
  assert.match(tex, /\\definecolor\{BrandPrimary\}\{HTML\}\{ABC123\}/);
});

test("buildTex renders sparse bullet layouts without empty itemize environments", () => {
  const tex = buildTex({
    title: "Sparse deck",
    slides: [
      { type: "bullets", title: "Empty", bullets: [] },
      { type: "columns", title: "One", bullets: ["only item"] },
    ],
  });
  const emptyFrame = tex.match(
    /\\begin\{frame\}\{Empty\}[\s\S]*?\\end\{frame\}/,
  )?.[0];
  const oneColumnFrame = tex.match(
    /\\begin\{frame\}\{One\}[\s\S]*?\\end\{frame\}/,
  )?.[0];
  assert.ok(emptyFrame, "empty bullet frame should be rendered");
  assert.ok(oneColumnFrame, "one-item columns frame should be rendered");

  assert.doesNotMatch(emptyFrame, /\\begin\{itemize\}/);
  assert.doesNotMatch(emptyFrame, /\\end\{itemize\}/);

  assert.match(oneColumnFrame, /\\begin\{columns\}/);
  assert.match(oneColumnFrame, /\\item only item/);
  assert.equal((oneColumnFrame.match(/\\begin\{itemize\}/g) ?? []).length, 1);
  assert.equal((oneColumnFrame.match(/\\end\{itemize\}/g) ?? []).length, 1);
  assert.doesNotMatch(oneColumnFrame, /\\begin\{itemize\}\s*\\end\{itemize\}/);
});

test("parseLogoDataUrl accepts signed PNG/JPEG bytes and rejects unsafe or malformed data", () => {
  const png = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const jpeg = Uint8Array.from([0xff, 0xd8, 0xff, 0xe0, 0x00]);
  const pngPayload = Buffer.from(png).toString("base64");
  const jpegPayload = Buffer.from(jpeg).toString("base64");

  const parsedPng = parseLogoDataUrl(`data:image/png;base64,${pngPayload}`);
  assert.deepEqual(parsedPng, {
    bytes: png,
    filename: "logo.png",
    mime: "image/png",
  });

  const parsedJpeg = parseLogoDataUrl(
    ` data:image/JPEG;base64,\n ${jpegPayload.slice(0, 4)}\n${jpegPayload.slice(4)} `,
  );
  assert.deepEqual(parsedJpeg, {
    bytes: jpeg,
    filename: "logo.jpg",
    mime: "image/jpeg",
  });
  assert.equal(parseLogoDataUrl(null), null);
  assert.equal(parseLogoDataUrl(""), null);

  assert.throws(
    () => parseLogoDataUrl(`data:image/jpeg;base64,${pngPayload}`),
    /do not match/,
  );
  assert.throws(
    () => parseLogoDataUrl("data:image/gif;base64,AAAA"),
    /PNG or JPEG/,
  );
  assert.throws(
    () => parseLogoDataUrl("data:image/png;base64,%%%%"),
    /not valid base64/,
  );
  assert.throws(
    () => parseLogoDataUrl(`data:image/png;base64,${pngPayload}`, 7),
    /size limit/,
  );
  assert.throws(
    () =>
      parseLogoDataUrl(
        `data:image/png;base64,${Buffer.from([0]).toString("base64")}`,
      ),
    /do not match/,
  );
  assert.equal(MAX_LOGO_BYTES, 2 * 1024 * 1024);
});

test("downloadBeamer assembles the theme, license, source, and validated logo into a ZIP", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url) => {
    if (url.endsWith("beamerthemeBrand.sty")) {
      return { ok: true, status: 200, text: async () => "% test theme" };
    }
    if (url.endsWith("LICENSE")) {
      return { ok: true, status: 200, text: async () => "MIT test license" };
    }
    throw new Error(`unexpected URL: ${url}`);
  };

  try {
    const logo = Uint8Array.from([
      0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
    ]);
    const logoDataUrl = `data:image/png;base64,${Buffer.from(logo).toString("base64")}`;
    const blob = await downloadBeamer(
      {
        title: "导出测试",
        slides: [
          {
            type: "cover",
            title: "标题",
            subtitle: "",
            notes: "",
            seconds: 30,
          },
        ],
      },
      {
        institution: "机构",
        department: "",
        presenter: "演示者",
        color: "#123456",
        logo: logoDataUrl,
      },
    );
    assert.equal(blob.type, "application/zip");
    const entries = parseStoredZip(new Uint8Array(await blob.arrayBuffer()));
    const byName = new Map(entries.map((entry) => [entry.name, entry.data]));
    assert.deepEqual(
      [...byName.keys()],
      ["main.tex", "beamerthemeBrand.sty", "README.md", "LICENSE", "logo.png"],
    );
    assert.match(
      new TextDecoder().decode(byName.get("main.tex")),
      /\\brandsetlogo\{logo\.png\}/,
    );
    assert.equal(
      new TextDecoder().decode(byName.get("beamerthemeBrand.sty")),
      "% test theme",
    );
    assert.equal(
      new TextDecoder().decode(byName.get("LICENSE")),
      "MIT test license",
    );
    assert.deepEqual(byName.get("logo.png"), logo);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
