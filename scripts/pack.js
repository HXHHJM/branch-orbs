'use strict';
// 离线打 vsix —— 本机没有 vsce（npm registry 不通），所以自己按 VSIX 规范手写 zip。
//
// VSIX 就是 zip，结构固定：
//   extension.vsixmanifest   ← 元数据（publisher/name/version/engines/main）
//   [Content_Types].xml      ← 声明各类文件的 MIME
//   extension/**             ← 插件本体
//
// 用法：node scripts/pack.js  → 产出 branch-orbs-<version>.vsix

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const ROOT = path.resolve(__dirname, '..');
const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
const OUT = path.join(ROOT, pkg.name + '-' + pkg.version + '.vsix');

// 与 .vscodeignore 等价
const IGNORE = [
  /^\.git\//,
  /^\.gitignore$/,
  /^\.vscodeignore$/,
  /^test\//,
  /^\.workbuddy\//,
  /^node_modules\//,
  /^scripts\//,
  /\.vsix$/,
];

function walk(dir, base, out) {
  for (const name of fs.readdirSync(dir)) {
    const abs = path.join(dir, name);
    const rel = base ? base + '/' + name : name;
    if (IGNORE.some((re) => re.test(rel))) continue;
    const st = fs.statSync(abs);
    if (st.isDirectory()) walk(abs, rel, out);
    else out.push({ rel, abs, size: st.size });
  }
  return out;
}

const CONTENT_TYPES = [
  '<?xml version="1.0" encoding="utf-8"?>',
  '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">',
  '<Default Extension=".json" ContentType="application/json"/>',
  '<Default Extension=".js" ContentType="application/javascript"/>',
  '<Default Extension=".md" ContentType="text/markdown"/>',
  '<Default Extension=".png" ContentType="image/png"/>',
  '<Default Extension=".svg" ContentType="image/svg+xml"/>',
  '<Default Extension=".html" ContentType="text/html"/>',
  '<Default Extension=".css" ContentType="text/css"/>',
  '<Default Extension=".vsixmanifest" ContentType="text/xml"/>',
  '<Default Extension=".txt" ContentType="text/plain"/>',
  // Python 辅助脚本（src/xwin.py、src/workarea.py）。
  // 漏声明不影响解压，但严格的 VSIX 校验器会拒包，顺手补上。
  '<Default Extension=".py" ContentType="text/x-python"/>',
  '</Types>',
].join('');

const MANIFEST = [
  '<?xml version="1.0" encoding="utf-8"?>',
  '<PackageManifest Version="2.0.0" xmlns="http://schemas.microsoft.com/developer/vsx-schema/2011" xmlns:d="http://schemas.microsoft.com/developer/vsx-schema-design/2011">',
  '  <Metadata>',
  '    <Identity Language="en-US" Id="' + pkg.name + '" Version="' + pkg.version + '" Publisher="' + pkg.publisher + '"/>',
  '    <DisplayName>' + (pkg.displayName || pkg.name) + '</DisplayName>',
  '    <Description xml:space="preserve">' + (pkg.description || '') + '</Description>',
  '    <Tags>git,branch,orb,dock,float</Tags>',
  '    <Categories>Other,Visualization</Categories>',
  '    <GalleryFlags>Public</GalleryFlags>',
  '    <Properties>',
  '      <Property Id="Microsoft.VisualStudio.Code.Engine" Value="' + pkg.engines.vscode + '"/>',
  '      <Property Id="Microsoft.VisualStudio.Services.Links.Source" Value="local"/>',
  '    </Properties>',
  '  </Metadata>',
  '  <Installation>',
  '    <InstallationTarget Id="Microsoft.VisualStudio.Code"/>',
  '  </Installation>',
  '  <Dependencies/>',
  '  <Assets>',
  '    <Asset Type="Microsoft.VisualStudio.Code.Manifest" Path="extension/package.json" Addressable="true"/>',
  '  </Assets>',
  '</PackageManifest>',
].join('\n');

// ── 最小 zip writer（deflate，无 zip64，够用）──
const CRC_TABLE = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return t;
})();

function crc32(buf) {
  let c = -1;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}

function dosTime(d) {
  const time = (d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1);
  const date = ((d.getFullYear() - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate();
  return { time, date };
}

function buildZip(entries) {
  const now = new Date();
  const { time, date } = dosTime(now);
  const locals = [];
  const centrals = [];
  let offset = 0;

  for (const e of entries) {
    const nameBuf = Buffer.from(e.rel.replace(/\\/g, '/'), 'utf8');
    const raw = e.data;
    const crc = crc32(raw);
    const deflated = zlib.deflateRawSync(raw, { level: 9 });
    // 只有压得动才用 deflate
    const useDeflate = deflated.length < raw.length;
    const body = useDeflate ? deflated : raw;
    const method = useDeflate ? 8 : 0;

    const lfh = Buffer.alloc(30);
    lfh.writeUInt32LE(0x04034b50, 0);
    lfh.writeUInt16LE(20, 4); // version needed
    lfh.writeUInt16LE(0, 6); // flags
    lfh.writeUInt16LE(method, 8);
    lfh.writeUInt16LE(time, 10);
    lfh.writeUInt16LE(date, 12);
    lfh.writeUInt32LE(crc, 14);
    lfh.writeUInt32LE(body.length, 18);
    lfh.writeUInt32LE(raw.length, 22);
    lfh.writeUInt16LE(nameBuf.length, 26);
    lfh.writeUInt16LE(0, 28);
    locals.push(lfh, nameBuf, body);

    const cdh = Buffer.alloc(46);
    cdh.writeUInt32LE(0x02014b50, 0);
    cdh.writeUInt16LE(20, 4); // version made by
    cdh.writeUInt16LE(20, 6); // version needed
    cdh.writeUInt16LE(0, 8);
    cdh.writeUInt16LE(method, 10);
    cdh.writeUInt16LE(time, 12);
    cdh.writeUInt16LE(date, 14);
    cdh.writeUInt32LE(crc, 16);
    cdh.writeUInt32LE(body.length, 20);
    cdh.writeUInt32LE(raw.length, 24);
    cdh.writeUInt16LE(nameBuf.length, 28);
    cdh.writeUInt16LE(0, 30); // extra
    cdh.writeUInt16LE(0, 32); // comment
    cdh.writeUInt16LE(0, 34); // disk
    cdh.writeUInt16LE(0, 36); // internal attr
    cdh.writeUInt32LE(0, 38); // external attr
    cdh.writeUInt32LE(offset, 42);
    centrals.push(cdh, nameBuf);

    offset += lfh.length + nameBuf.length + body.length;
  }

  const localBuf = Buffer.concat(locals);
  const centralBuf = Buffer.concat(centrals);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(0, 4);
  eocd.writeUInt16LE(0, 6);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(centralBuf.length, 12);
  eocd.writeUInt32LE(localBuf.length, 16);
  eocd.writeUInt16LE(0, 20);

  return Buffer.concat([localBuf, centralBuf, eocd]);
}

// ── 组装 ──
const files = walk(ROOT, '', []);
const entries = [
  { rel: 'extension.vsixmanifest', data: Buffer.from(MANIFEST, 'utf8') },
  { rel: '[Content_Types].xml', data: Buffer.from(CONTENT_TYPES, 'utf8') },
];

for (const f of files) {
  if (f.rel === 'extension.vsixmanifest' || f.rel === '[Content_Types].xml') continue;
  entries.push({ rel: 'extension/' + f.rel, data: fs.readFileSync(f.abs) });
}

fs.writeFileSync(OUT, buildZip(entries));

const kb = (fs.statSync(OUT).size / 1024).toFixed(2);
console.log('✅ ' + path.basename(OUT) + '  ' + entries.length + ' 个文件  ' + kb + ' KB');
for (const e of entries) console.log('   ' + e.rel + '  ' + e.data.length + 'B');
