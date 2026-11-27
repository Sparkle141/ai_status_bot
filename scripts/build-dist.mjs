import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import zlib from 'node:zlib';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const DIST_DIR = path.join(ROOT, 'dist');
const VERSION_PATH = path.join(ROOT, 'version.json');

// CRC32 lookup table
const CRC_TABLE = new Uint32Array(256);
for (let i = 0; i < 256; i++) {
  let c = i;
  for (let k = 0; k < 8; k++) {
    c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
  }
  CRC_TABLE[i] = c >>> 0;
}

function crc32(buf) {
  let crc = 0xffffffff;
  for (let i = 0; i < buf.length; i++) {
    crc = CRC_TABLE[(crc ^ buf[i]) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function dosTimeDate(date) {
  const d = date instanceof Date ? date : new Date();
  const year = Math.max(1980, d.getFullYear());
  const dosTime = ((d.getHours() & 0x1f) << 11) | ((d.getMinutes() & 0x3f) << 5) | ((d.getSeconds() >> 1) & 0x1f);
  const dosDate = (((year - 1980) & 0x7f) << 9) | (((d.getMonth() + 1) & 0x0f) << 5) | (d.getDate() & 0x1f);
  return { dosTime, dosDate };
}

function buildZip(entries, { unixMode = false } = {}) {
  const localParts = [];
  const centralParts = [];
  let offset = 0;

  for (const ent of entries) {
    const nameBuf = Buffer.from(ent.zipPath.replace(/\\/g, '/'), 'utf8');
    const data = ent.data;
    const uncompressedSize = data.length;
    const crc = crc32(data);
    const compressed = data.length > 0 ? zlib.deflateRawSync(data, { level: 9 }) : Buffer.alloc(0);
    const method = compressed.length < data.length ? 8 : 0;
    const payload = method === 8 ? compressed : data;
    const compressedSize = payload.length;
    const { dosTime, dosDate } = dosTimeDate(ent.mtime);

    const flags = 0x0800; // UTF-8 filename flag
    const versionNeeded = 20;
    const versionMadeBy = unixMode ? ((3 << 8) | 20) : 20;
    const externalAttr = unixMode
      ? (((ent.executable ? 0o100755 : 0o100644) << 16) >>> 0)
      : 0;

    // Local file header (30 bytes + filename)
    const lh = Buffer.alloc(30);
    lh.writeUInt32LE(0x04034b50, 0);
    lh.writeUInt16LE(versionNeeded, 4);
    lh.writeUInt16LE(flags, 6);
    lh.writeUInt16LE(method, 8);
    lh.writeUInt16LE(dosTime, 10);
    lh.writeUInt16LE(dosDate, 12);
    lh.writeUInt32LE(crc, 14);
    lh.writeUInt32LE(compressedSize, 18);
    lh.writeUInt32LE(uncompressedSize, 22);
    lh.writeUInt16LE(nameBuf.length, 26);
    lh.writeUInt16LE(0, 28);

    localParts.push(lh, nameBuf, payload);

    // Central directory header (46 bytes + filename)
    const cd = Buffer.alloc(46);
    cd.writeUInt32LE(0x02014b50, 0);
    cd.writeUInt16LE(versionMadeBy, 4);
    cd.writeUInt16LE(versionNeeded, 6);
    cd.writeUInt16LE(flags, 8);
    cd.writeUInt16LE(method, 10);
    cd.writeUInt16LE(dosTime, 12);
    cd.writeUInt16LE(dosDate, 14);
    cd.writeUInt32LE(crc, 16);
    cd.writeUInt32LE(compressedSize, 20);
    cd.writeUInt32LE(uncompressedSize, 24);
    cd.writeUInt16LE(nameBuf.length, 28);
    cd.writeUInt16LE(0, 30);
    cd.writeUInt16LE(0, 32);
    cd.writeUInt16LE(0, 34);
    cd.writeUInt16LE(0, 36);
    cd.writeUInt32LE(externalAttr, 38);
    cd.writeUInt32LE(offset, 42);

    centralParts.push(cd, nameBuf);
    offset += lh.length + nameBuf.length + payload.length;
  }

  const centralDirBuf = Buffer.concat(centralParts);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(0, 4);
  eocd.writeUInt16LE(0, 6);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(centralDirBuf.length, 12);
  eocd.writeUInt32LE(offset, 16);
  eocd.writeUInt16LE(0, 20);

  return Buffer.concat([...localParts, centralDirBuf, eocd]);
}

function collectDirFiles(absDir, zipPrefix, { normalizeLf = false } = {}) {
  const out = [];
  const walk = (dir, relBase) => {
    for (const ent of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const full = path.join(dir, ent.name);
      const rel = relBase ? `${relBase}/${ent.name}` : ent.name;
      if (ent.isDirectory()) {
        walk(full, rel);
      } else {
        out.push(makeEntry(full, `${zipPrefix}/${rel}`, { normalizeLf }));
      }
    }
  };
  walk(absDir, '');
  return out;
}

function makeEntry(absPath, zipPath, { normalizeLf = false } = {}) {
  const st = fs.statSync(absPath);
  let data = fs.readFileSync(absPath);
  const ext = path.extname(absPath).toLowerCase();
  if (normalizeLf && ['.mjs', '.js', '.jxa', '.html', '.sh', '.command', '.md', '.json', '.txt'].includes(ext)) {
    const str = data.toString('utf8').replace(/\r\n/g, '\n');
    data = Buffer.from(str, 'utf8');
  }
  const executable = ext === '.command' || ext === '.sh';
  return {
    zipPath,
    data,
    mtime: st.mtime,
    executable
  };
}

function makeBufferEntry(buf, zipPath, mtime = new Date()) {
  return {
    zipPath,
    data: buf,
    mtime,
    executable: false
  };
}

function parseArgs(argv) {
  let channel = '';
  let version = '';
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--channel' && argv[i + 1]) {
      channel = argv[++i].toLowerCase();
    } else if (argv[i] === '--version' && argv[i + 1]) {
      version = argv[++i];
    }
  }
  return { channel, version };
}

function loadDefaultManifest() {
  const def = { version: '1.1.0', channel: 'stable', releasedAt: new Date().toISOString().slice(0, 10) };
  try {
    if (fs.existsSync(VERSION_PATH)) {
      const obj = JSON.parse(fs.readFileSync(VERSION_PATH, 'utf8'));
      return { ...def, ...obj };
    }
  } catch {}
  return def;
}

function main() {
  const manifest = loadDefaultManifest();
  const cli = parseArgs(process.argv.slice(2));
  const channel = cli.channel === 'beta' ? 'beta' : (cli.channel === 'stable' ? 'stable' : (manifest.channel === 'beta' ? 'beta' : 'stable'));
  const version = (cli.version || manifest.version || '1.1.0').replace(/^v/i, '');
  const releasedAt = manifest.releasedAt || new Date().toISOString().slice(0, 10);

  // Verify Windows AiDeskPet.ps1 has UTF-8 BOM before packing
  const ps1Path = path.join(ROOT, 'widget', 'AiDeskPet.ps1');
  const ps1Bytes = fs.readFileSync(ps1Path);
  if (ps1Bytes[0] !== 0xef || ps1Bytes[1] !== 0xbb || ps1Bytes[2] !== 0xbf) {
    throw new Error('widget/AiDeskPet.ps1 is missing UTF-8 BOM (EF BB BF).');
  }

  const pkgVersionBuf = Buffer.from(
    JSON.stringify({ version, channel, releasedAt }, null, 2) + '\n',
    'utf8'
  );

  const subDir = channel === 'beta'
    ? path.join(DIST_DIR, 'beta', `v${version}`)
    : path.join(DIST_DIR, 'releases', `v${version}`);
  fs.mkdirSync(subDir, { recursive: true });

  // 1. Windows package
  const winPrefix = `AI-Desk-Pet-v${version}-Windows`;
  const winPetCmd = channel === 'beta' ? '01_AI_데스크펫_BETA_실행.cmd' : '01_AI_데스크펫_실행.cmd';
  const winCliCmd = channel === 'beta' ? '02_터미널_모니터_BETA_실행.cmd' : '02_터미널_모니터_실행.cmd';
  const winEntries = [
    makeEntry(path.join(ROOT, '01_AI_데스크펫_실행.cmd'), `${winPrefix}/${winPetCmd}`),
    makeEntry(path.join(ROOT, '02_터미널_모니터_실행.cmd'), `${winPrefix}/${winCliCmd}`),
    makeEntry(path.join(ROOT, 'README.md'), `${winPrefix}/README.md`),
    makeEntry(path.join(ROOT, 'CHANGELOG.md'), `${winPrefix}/CHANGELOG.md`),
    makeBufferEntry(pkgVersionBuf, `${winPrefix}/version.json`),
    ...collectDirFiles(path.join(ROOT, 'collector'), `${winPrefix}/collector`),
    ...collectDirFiles(path.join(ROOT, 'widget'), `${winPrefix}/widget`)
  ];
  const winZipName = `AI-Desk-Pet-v${version}-Windows.zip`;
  const winZipPath = path.join(subDir, winZipName);
  const winZipBuf = buildZip(winEntries, { unixMode: false });
  fs.writeFileSync(winZipPath, winZipBuf);

  // 2. macOS package
  const macPrefix = `AI-Desk-Pet-v${version}-Mac`;
  const macEntries = [
    makeEntry(path.join(ROOT, 'mac', '01_AI_데스크펫_실행.command'), `${macPrefix}/01_AI_데스크펫_실행.command`, { normalizeLf: true }),
    makeEntry(path.join(ROOT, 'mac', '02_터미널_모니터_실행.command'), `${macPrefix}/02_터미널_모니터_실행.command`, { normalizeLf: true }),
    makeEntry(path.join(ROOT, 'mac', '03_브라우저_모니터_열기.command'), `${macPrefix}/03_브라우저_모니터_열기.command`, { normalizeLf: true }),
    makeEntry(path.join(ROOT, 'mac', 'README_Mac.md'), `${macPrefix}/README_Mac.md`, { normalizeLf: true }),
    makeEntry(path.join(ROOT, 'CHANGELOG.md'), `${macPrefix}/CHANGELOG.md`, { normalizeLf: true }),
    makeBufferEntry(pkgVersionBuf, `${macPrefix}/version.json`),
    ...collectDirFiles(path.join(ROOT, 'collector'), `${macPrefix}/collector`, { normalizeLf: true }),
    ...collectDirFiles(path.join(ROOT, 'widget-mac'), `${macPrefix}/widget-mac`, { normalizeLf: true })
  ];
  const macZipName = `AI-Desk-Pet-v${version}-Mac.zip`;
  const macZipPath = path.join(subDir, macZipName);
  const macZipBuf = buildZip(macEntries, { unixMode: true });
  fs.writeFileSync(macZipPath, macZipBuf);

  console.log(`BUILT [${channel}] ${winZipPath} (${winEntries.length} files, ${winZipBuf.length} B)`);
  console.log(`BUILT [${channel}] ${macZipPath} (${macEntries.length} files, ${macZipBuf.length} B)`);

  if (channel === 'stable') {
    const latestWin = path.join(DIST_DIR, 'AI-Desk-Pet-Windows.zip');
    const latestMac = path.join(DIST_DIR, 'AI-Desk-Pet-Mac.zip');
    fs.writeFileSync(latestWin, winZipBuf);
    fs.writeFileSync(latestMac, macZipBuf);
    console.log(`UPDATED LATEST ALIAS: ${latestWin}`);
    console.log(`UPDATED LATEST ALIAS: ${latestMac}`);
  }
}

main();
