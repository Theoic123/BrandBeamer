const DEFAULT_PRIMARY = '#2563EB';
export const MAX_LOGO_BYTES = 2 * 1024 * 1024;

const LATEX_ESCAPES = Object.freeze({
  '\\': '\\textbackslash{}',
  '&': '\\&',
  '%': '\\%',
  '$': '\\$',
  '#': '\\#',
  '_': '\\_',
  '{': '\\{',
  '}': '\\}',
  '~': '\\textasciitilde{}',
  '^': '\\textasciicircum{}',
});

const CRC32_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let index = 0; index < table.length; index += 1) {
    let value = index;
    for (let bit = 0; bit < 8; bit += 1) {
      value = value & 1 ? 0xEDB88320 ^ (value >>> 1) : value >>> 1;
    }
    table[index] = value >>> 0;
  }
  return table;
})();

function encodeUtf8(value) {
  const text = String(value);
  if (typeof TextEncoder !== 'undefined') {
    return new TextEncoder().encode(text);
  }

  // TextEncoder is available in supported browsers. This fallback keeps the
  // pure ZIP helper usable in older JavaScript runtimes as well.
  const encoded = unescape(encodeURIComponent(text));
  const bytes = new Uint8Array(encoded.length);
  for (let index = 0; index < encoded.length; index += 1) {
    bytes[index] = encoded.charCodeAt(index);
  }
  return bytes;
}

function asBytes(value) {
  if (typeof value === 'string') {
    return encodeUtf8(value);
  }
  if (value instanceof Uint8Array) {
    return value;
  }
  if (typeof ArrayBuffer !== 'undefined' && value instanceof ArrayBuffer) {
    return new Uint8Array(value);
  }
  if (typeof ArrayBuffer !== 'undefined' && ArrayBuffer.isView(value)) {
    return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
  }
  throw new TypeError('ZIP file data must be a string, Uint8Array, or ArrayBuffer');
}

function writeUint16(view, offset, value) {
  view.setUint16(offset, value, true);
}

function writeUint32(view, offset, value) {
  view.setUint32(offset, value >>> 0, true);
}

function normaliseZipName(name) {
  const normalised = String(name).replaceAll('\\', '/');
  if (
    normalised.length === 0 ||
    normalised.startsWith('/') ||
    normalised.includes('\0') ||
    normalised.split('/').some((part) => part === '..' || part === '.')
  ) {
    throw new Error(`Invalid ZIP entry name: ${name}`);
  }
  return normalised;
}

function normaliseZipEntries(files) {
  let entries;
  if (files instanceof Map) {
    entries = Array.from(files.entries()).map(([name, data]) => ({ name, data }));
  } else if (Array.isArray(files)) {
    entries = files.map((entry) => {
      if (Array.isArray(entry)) {
        return { name: entry[0], data: entry[1] };
      }
      return entry;
    });
  } else if (files && typeof files === 'object') {
    entries = Object.entries(files).map(([name, data]) => ({ name, data }));
  } else {
    throw new TypeError('ZIP files must be an object, Map, or entry array');
  }

  if (entries.length > 0xFFFF) {
    throw new Error('ZIP cannot contain more than 65535 files');
  }

  const seen = new Set();
  return entries.map((entry) => {
    if (!entry || typeof entry !== 'object') {
      throw new TypeError('ZIP entries must contain a name and data value');
    }
    const name = normaliseZipName(entry.name);
    if (seen.has(name)) {
      throw new Error(`Duplicate ZIP entry: ${name}`);
    }
    seen.add(name);
    const nameBytes = encodeUtf8(name);
    if (nameBytes.length > 0xFFFF) {
      throw new Error(`ZIP entry name is too long: ${name}`);
    }
    const data = asBytes(entry.data);
    if (data.length > 0xFFFFFFFF) {
      throw new Error(`ZIP entry is too large: ${name}`);
    }
    return { name, nameBytes, data, crc: crc32(data) };
  });
}

/**
 * Return the unsigned CRC-32 used by the ZIP format.
 */
export function crc32(value) {
  const bytes = asBytes(value);
  let checksum = 0xFFFFFFFF;
  for (let index = 0; index < bytes.length; index += 1) {
    checksum = CRC32_TABLE[(checksum ^ bytes[index]) & 0xFF] ^ (checksum >>> 8);
  }
  return (checksum ^ 0xFFFFFFFF) >>> 0;
}

/**
 * Build a deterministic, uncompressed ZIP archive.
 *
 * `files` may be an object, a Map, or an array of `{name, data}` entries.
 * Data may be UTF-8 text, Uint8Array, or ArrayBuffer. The result is a
 * Uint8Array so callers can choose how to persist or download it.
 */
export function buildZip(files) {
  const entries = normaliseZipEntries(files);
  const localParts = [];
  const centralParts = [];
  let localOffset = 0;

  for (const entry of entries) {
    const local = new Uint8Array(30 + entry.nameBytes.length + entry.data.length);
    const localView = new DataView(local.buffer);
    writeUint32(localView, 0, 0x04034B50);
    writeUint16(localView, 4, 20);
    writeUint16(localView, 6, 0x0800); // UTF-8 filenames.
    writeUint16(localView, 8, 0); // Store without compression.
    writeUint16(localView, 10, 0); // Deterministic DOS time.
    writeUint16(localView, 12, 0); // Deterministic DOS date.
    writeUint32(localView, 14, entry.crc);
    writeUint32(localView, 18, entry.data.length);
    writeUint32(localView, 22, entry.data.length);
    writeUint16(localView, 26, entry.nameBytes.length);
    writeUint16(localView, 28, 0);
    local.set(entry.nameBytes, 30);
    local.set(entry.data, 30 + entry.nameBytes.length);
    localParts.push(local);

    const central = new Uint8Array(46 + entry.nameBytes.length);
    const centralView = new DataView(central.buffer);
    writeUint32(centralView, 0, 0x02014B50);
    writeUint16(centralView, 4, 20); // Version made by: DOS/Windows, 2.0.
    writeUint16(centralView, 6, 20);
    writeUint16(centralView, 8, 0x0800);
    writeUint16(centralView, 10, 0);
    writeUint16(centralView, 12, 0);
    writeUint16(centralView, 14, 0);
    writeUint32(centralView, 16, entry.crc);
    writeUint32(centralView, 20, entry.data.length);
    writeUint32(centralView, 24, entry.data.length);
    writeUint16(centralView, 28, entry.nameBytes.length);
    writeUint16(centralView, 30, 0);
    writeUint16(centralView, 32, 0);
    writeUint16(centralView, 34, 0);
    writeUint16(centralView, 36, 0);
    writeUint32(centralView, 38, 0);
    writeUint32(centralView, 42, localOffset);
    central.set(entry.nameBytes, 46);
    centralParts.push(central);

    localOffset += local.length;
    if (localOffset > 0xFFFFFFFF) {
      throw new Error('ZIP archive is too large for the classic ZIP format');
    }
  }

  const centralOffset = localOffset;
  const centralSize = centralParts.reduce((total, part) => total + part.length, 0);
  if (centralSize > 0xFFFFFFFF || centralOffset > 0xFFFFFFFF) {
    throw new Error('ZIP archive is too large for the classic ZIP format');
  }

  const end = new Uint8Array(22);
  const endView = new DataView(end.buffer);
  writeUint32(endView, 0, 0x06054B50);
  writeUint16(endView, 4, 0);
  writeUint16(endView, 6, 0);
  writeUint16(endView, 8, entries.length);
  writeUint16(endView, 10, entries.length);
  writeUint32(endView, 12, centralSize);
  writeUint32(endView, 16, centralOffset);
  writeUint16(endView, 20, 0);

  const archive = new Uint8Array(localOffset + centralSize + end.length);
  let cursor = 0;
  for (const part of localParts) {
    archive.set(part, cursor);
    cursor += part.length;
  }
  for (const part of centralParts) {
    archive.set(part, cursor);
    cursor += part.length;
  }
  archive.set(end, cursor);
  return archive;
}

/**
 * Escape user-controlled text for insertion into LaTeX text arguments.
 * Control characters become spaces, while LaTeX's syntax characters are
 * rendered literally. Generated LaTeX commands are never taken from input.
 */
export function escapeLatex(value) {
  const input = value == null ? '' : String(value);
  let escaped = '';
  for (const character of input) {
    const codePoint = character.codePointAt(0);
    if (
      character === '\n' ||
      character === '\r' ||
      character === '\t' ||
      character === '\u2028' ||
      character === '\u2029' ||
      codePoint < 0x20 ||
      codePoint === 0x7F
    ) {
      escaped += ' ';
    } else {
      escaped += LATEX_ESCAPES[character] || character;
    }
  }
  return escaped;
}

function decodeBase64(value) {
  const compact = String(value).replace(/\s+/g, '');
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(compact) || compact.length % 4 === 1) {
    throw new Error('Logo data is not valid base64');
  }

  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
  const bytes = [];
  let buffer = 0;
  let bits = 0;
  for (const character of compact) {
    if (character === '=') {
      break;
    }
    const digit = alphabet.indexOf(character);
    if (digit < 0) {
      throw new Error('Logo data is not valid base64');
    }
    buffer = (buffer << 6) | digit;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      bytes.push((buffer >>> bits) & 0xFF);
    }
  }
  return Uint8Array.from(bytes);
}

function hasPngSignature(bytes) {
  const signature = [0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A];
  return bytes.length >= signature.length && signature.every((value, index) => bytes[index] === value);
}

function hasJpegSignature(bytes) {
  return bytes.length >= 3 && bytes[0] === 0xFF && bytes[1] === 0xD8 && bytes[2] === 0xFF;
}

/**
 * Validate and decode a data URL into the only two image formats accepted by
 * the export. The returned filename is fixed, so user input cannot become a
 * path in the ZIP archive or a LaTeX command.
 */
export function parseLogoDataUrl(dataUrl, maxBytes = MAX_LOGO_BYTES) {
  if (dataUrl == null || dataUrl === '') {
    return null;
  }
  if (typeof dataUrl !== 'string') {
    throw new TypeError('Logo must be a PNG or JPEG data URL');
  }

  const match = /^data:(image\/png|image\/jpeg);base64,([\s\S]*)$/i.exec(dataUrl.trim());
  if (!match) {
    throw new Error('Logo must be a PNG or JPEG base64 data URL');
  }

  const mime = match[1].toLowerCase();
  const payload = match[2].replace(/\s+/g, '');
  const maximumPayload = Math.ceil(maxBytes * 4 / 3) + 8;
  if (payload.length > maximumPayload) {
    throw new Error(`Logo exceeds the ${Math.floor(maxBytes / 1024 / 1024)} MiB size limit`);
  }

  const bytes = decodeBase64(payload);
  if (bytes.length > maxBytes) {
    throw new Error(`Logo exceeds the ${Math.floor(maxBytes / 1024 / 1024)} MiB size limit`);
  }

  const png = mime === 'image/png';
  const validSignature = png ? hasPngSignature(bytes) : hasJpegSignature(bytes);
  if (!validSignature) {
    throw new Error('Logo bytes do not match their PNG or JPEG MIME type');
  }

  return {
    bytes,
    filename: png ? 'logo.png' : 'logo.jpg',
    mime,
  };
}

function normaliseColor(value) {
  const candidate = typeof value === 'string' ? value.trim() : '';
  return /^#[0-9A-Fa-f]{6}$/.test(candidate) ? candidate.toUpperCase() : DEFAULT_PRIMARY;
}

function stringValue(value) {
  return value == null ? '' : String(value);
}

function normaliseSeconds(value) {
  if (value == null || value === '') {
    return '';
  }
  const seconds = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(seconds) || seconds <= 0) {
    return '';
  }
  const bounded = Math.min(seconds, 3600);
  return String(Math.round(bounded * 100) / 100);
}

function firstValue(object, keys) {
  for (const key of keys) {
    if (object && object[key] != null && object[key] !== '') {
      return object[key];
    }
  }
  return '';
}

function bulletText(value) {
  if (value == null) {
    return '';
  }
  if (typeof value === 'object' && !Array.isArray(value)) {
    const heading = stringValue(firstValue(value, ['heading', 'title', 'label']));
    const body = stringValue(firstValue(value, ['body', 'text', 'description', 'value']));
    if (heading && body) {
      return `\\textbf{${escapeLatex(heading)}}: ${escapeLatex(body)}`;
    }
    return escapeLatex(body || heading);
  }
  return escapeLatex(value);
}

function renderItems(items) {
  const rendered = items.map(bulletText).filter((item) => item.length > 0);
  if (rendered.length === 0) {
    return '';
  }
  return [
    '\\begin{itemize}',
    ...rendered.map((item) => `  \\item ${item}`),
    '\\end{itemize}',
  ].join('\n');
}

function renderFrameStart(title, subtitle) {
  const escapedTitle = escapeLatex(title);
  const escapedSubtitle = escapeLatex(subtitle);
  const lines = [escapedTitle ? `\\begin{frame}{${escapedTitle}}` : '\\begin{frame}'];
  if (escapedSubtitle) {
    lines.push(`  \\framesubtitle{${escapedSubtitle}}`);
  }
  return lines.join('\n');
}

function renderFrameMeta(slide) {
  const lines = [];
  const duration = normaliseSeconds(slide.seconds);
  const notes = escapeLatex(slide.notes);
  if (duration) {
    lines.push(`  \\transduration{${duration}}`);
  }
  if (notes) {
    lines.push(`  \\note{${notes}}`);
  }
  return lines;
}

function renderColumns(items) {
  const midpoint = Math.ceil(items.length / 2);
  const left = items.slice(0, midpoint);
  const right = items.slice(midpoint);
  return [
    '\\begin{columns}[T,onlytextwidth]',
    '  \\begin{column}{0.48\\textwidth}',
    renderItems(left).split('\n').map((line) => `    ${line}`).join('\n'),
    '  \\end{column}',
    '  \\begin{column}{0.48\\textwidth}',
    renderItems(right).split('\n').map((line) => `    ${line}`).join('\n'),
    '  \\end{column}',
    '\\end{columns}',
  ].join('\n');
}

function renderRegularSlide(slide) {
  const type = slide.type === 'columns' ? 'columns' : 'bullets';
  const items = Array.isArray(slide.bullets) ? slide.bullets : [];
  return [
    renderFrameStart(slide.title, slide.subtitle),
    type === 'columns' ? renderColumns(items) : renderItems(items),
    ...renderFrameMeta(slide),
    '\\end{frame}',
  ].join('\n');
}

function normaliseDeck(deck) {
  const input = deck && typeof deck === 'object' ? deck : {};
  const slides = Array.isArray(input.slides) ? input.slides : [];
  return {
    title: stringValue(input.title),
    slides: slides.map((slide) => (slide && typeof slide === 'object' ? slide : {})),
  };
}

function normaliseBrand(brand) {
  const input = brand && typeof brand === 'object' ? brand : {};
  return {
    institution: stringValue(input.institution),
    department: stringValue(input.department),
    presenter: stringValue(input.presenter),
    color: normaliseColor(input.color),
    logo: parseLogoDataUrl(input.logo),
  };
}

/**
 * Render the editable XeLaTeX source for a deck. All deck and brand text is
 * passed through escapeLatex before being placed in the source.
 */
export function buildTex(deck = {}, brand = {}) {
  const safeDeck = normaliseDeck(deck);
  const safeBrand = normaliseBrand(brand);
  const firstCover = safeDeck.slides.find((slide) => slide.type === 'cover');
  const documentTitle = safeDeck.title || stringValue(firstCover && firstCover.title) || 'Untitled presentation';
  const documentSubtitle = stringValue(firstCover && firstCover.subtitle);
  const institution = escapeLatex(safeBrand.institution);
  const department = escapeLatex(safeBrand.department);
  const presenter = escapeLatex(safeBrand.presenter);
  const institute = [institution, department].filter(Boolean).join('\\\\');
  const logoCommand = safeBrand.logo ? `\\brandsetlogo{${safeBrand.logo.filename}}` : '';

  const preamble = [
    '% Generated by BrandBeamer.',
    '% Compile with XeLaTeX. User content is escaped by public/export.js.',
    '\\documentclass[aspectratio=169,11pt,t]{beamer}',
    '\\usepackage[UTF8,fontset=fandol]{ctex}',
    '\\usepackage{xcolor}',
    `\\definecolor{BrandPrimary}{HTML}{${safeBrand.color.slice(1)}}`,
    '\\usetheme{Brand}',
    logoCommand,
    `\\title{${escapeLatex(documentTitle)}}`,
    `\\subtitle{${escapeLatex(documentSubtitle)}}`,
    `\\author{${presenter}}`,
    `\\institute{${institute}}`,
    '\\date{}',
    '',
    '\\begin{document}',
  ].filter((line) => line !== '').join('\n');

  const body = safeDeck.slides.map((slide) => {
    const title = stringValue(slide.title);
    const subtitle = stringValue(slide.subtitle);
    if (slide.type === 'cover') {
      return [
        `\\brandcoverwithmeta{${escapeLatex(title || documentTitle)}}{${escapeLatex(subtitle)}}{${presenter}}{${institution}}{${department}}{${escapeLatex(slide.notes)}}{${normaliseSeconds(slide.seconds)}}`,
      ].join('\n');
    }
    if (slide.type === 'closing') {
      return [
        `\\brandclosingwithmeta{${escapeLatex(title || 'Thank you')}}{${escapeLatex(subtitle)}}{${escapeLatex(slide.notes)}}{${normaliseSeconds(slide.seconds)}}`,
      ].join('\n');
    }
    return renderRegularSlide(slide);
  }).join('\n\n');

  return `${preamble}\n${body ? `${body}\n` : ''}\\end{document}\n`;
}

function safeDownloadName(value) {
  const name = stringValue(value)
    .trim()
    .replace(/[<>:"/\\|?*\u0000-\u001F]/g, '-')
    .replace(/\s+/g, ' ')
    .replace(/[. ]+$/g, '')
    .slice(0, 80);
  return name || 'brand-presentation';
}

function buildReadme() {
  return `# Brand Beamer export

This archive was generated by BrandBeamer. It contains an editable Beamer source file and a neutral theme whose backgrounds are drawn with TikZ at compile time.

Compile with XeLaTeX:

\`\`\`sh
xelatex main.tex
\`\`\`

The source uses ctex with the Fandol font set so English, Chinese, and mixed text can compile with a portable TeX Live installation. Keep \`main.tex\`, \`beamerthemeBrand.sty\`, and the optional logo file together.

The theme is a substantive neutral adaptation of the MIT-licensed CityU Beamer theme code. No CityU artwork, logos, previews, or source presentation are included. See LICENSE for the retained MIT terms.
`;
}

function triggerDownload(blob, filename) {
  if (typeof document === 'undefined' || typeof URL === 'undefined' || typeof URL.createObjectURL !== 'function') {
    return;
  }
  const objectUrl = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = objectUrl;
  anchor.download = filename;
  anchor.rel = 'noopener';
  anchor.style.display = 'none';
  if (document.body) {
    document.body.appendChild(anchor);
  }
  anchor.click();
  if (typeof anchor.remove === 'function') {
    anchor.remove();
  }
  if (typeof setTimeout === 'function') {
    setTimeout(() => URL.revokeObjectURL(objectUrl), 1000);
  } else {
    URL.revokeObjectURL(objectUrl);
  }
}

/**
 * Fetch the server-served theme and MIT license, assemble the ZIP, and start
 * a browser download. The returned Blob is useful to callers and tests.
 */
export async function downloadBeamer(deck = {}, brand = {}) {
  if (typeof fetch !== 'function') {
    throw new Error('BrandBeamer export requires fetch');
  }

  const [themeResponse, licenseResponse] = await Promise.all([
    fetch('/templates/beamer/beamerthemeBrand.sty', { cache: 'no-store' }),
    fetch('/templates/beamer/LICENSE', { cache: 'no-store' }),
  ]);
  if (!themeResponse.ok) {
    throw new Error(`Unable to load beamerthemeBrand.sty (HTTP ${themeResponse.status})`);
  }
  if (!licenseResponse.ok) {
    throw new Error(`Unable to load the Beamer license (HTTP ${licenseResponse.status})`);
  }

  const [theme, license] = await Promise.all([
    themeResponse.text(),
    licenseResponse.text(),
  ]);
  const logo = parseLogoDataUrl(brand && brand.logo);
  const files = {
    'main.tex': buildTex(deck, brand),
    'beamerthemeBrand.sty': theme,
    'README.md': buildReadme(),
    LICENSE: license,
  };
  if (logo) {
    files[logo.filename] = logo.bytes;
  }

  const blob = new Blob([buildZip(files)], { type: 'application/zip' });
  const filename = `${safeDownloadName(deck && deck.title)}-beamer.zip`;
  triggerDownload(blob, filename);
  return blob;
}
