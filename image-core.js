'use strict';

// These coordinates are in platform display pixels, independent of the editor size.
const imageCore = (() => {
  function makePreset(config) {
    const { columns, rows, tileWidth, tileHeight, gapX, gapY, names } = config;
    const width = columns * tileWidth + (columns - 1) * gapX;
    const height = rows * tileHeight + (rows - 1) * gapY;
    const tiles = Array.from({ length: columns * rows }, (_, index) => Object.freeze({
      x: (index % columns) * (tileWidth + gapX),
      y: Math.floor(index / columns) * (tileHeight + gapY),
      width: tileWidth,
      height: tileHeight,
      name: `${String(index + 1).padStart(2, '0')}_${names[index]}`,
    }));
    return Object.freeze({ ...config, width, height, tiles: Object.freeze(tiles) });
  }

  const preset = makePreset({
    columns: 2,
    rows: 3,
    tileWidth: 441,
    tileHeight: 92,
    gapX: 1,
    gapY: 1,
    outputWidth: 720,
    outputHeight: 150,
    maxBytes: 200_000,
    names: ['top_left', 'top_right', 'middle_left', 'middle_right', 'bottom_left', 'bottom_right'],
  });

  const clamp = (value, min, max) => Math.max(min, Math.min(value, max));

  function centeredView(source, frame, mode) {
    const widthScale = frame.width / source.width;
    const heightScale = frame.height / source.height;
    const scale = mode === 'fit' ? Math.min(widthScale, heightScale) : Math.max(widthScale, heightScale);
    return {
      x: (frame.width - source.width * scale) / 2,
      y: (frame.height - source.height * scale) / 2,
      scale,
    };
  }

  function zoomAt(view, point, scale) {
    const ratio = scale / view.scale;
    return {
      x: point.x - (point.x - view.x) * ratio,
      y: point.y - (point.y - view.y) * ratio,
      scale,
    };
  }

  function makeCanvas(width, height) {
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    return canvas;
  }

  function imageIntersection(source, view, area) {
    const left = Math.max(area.x, view.x);
    const top = Math.max(area.y, view.y);
    const right = Math.min(area.x + area.width, view.x + source.width * view.scale);
    const bottom = Math.min(area.y + area.height, view.y + source.height * view.scale);
    if (right <= left || bottom <= top) return null;
    return { x: left, y: top, width: right - left, height: bottom - top };
  }

  function drawImageArea(context, source, view, area, destination) {
    const visible = imageIntersection(source, view, area);
    if (!visible) return;
    const scaleX = destination.width / area.width;
    const scaleY = destination.height / area.height;
    context.drawImage(
      source.bitmap,
      (visible.x - view.x) / view.scale, (visible.y - view.y) / view.scale,
      visible.width / view.scale, visible.height / view.scale,
      destination.x + (visible.x - area.x) * scaleX, destination.y + (visible.y - area.y) * scaleY,
      visible.width * scaleX, visible.height * scaleY,
    );
  }

  function renderTile(context, source, view, tile, frame) {
    const { outputWidth: width, outputHeight: height } = frame;
    context.clearRect(0, 0, width, height);
    context.imageSmoothingQuality = 'high';
    drawImageArea(context, source, view, tile, { x: 0, y: 0, width, height });
  }

  function jpegDimensions(bytes, header) {
    let offset = 2;
    while (offset + 4 <= bytes.length && bytes[offset] === 0xff) {
      while (bytes[offset] === 0xff) offset++;
      const marker = bytes[offset++];
      if (marker === 0xda || marker === 0xd9 || offset + 2 > bytes.length) break;
      if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) continue;
      const length = header.getUint16(offset);
      if (length < 2) break;
      if (marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker) && length >= 8 && offset + 7 <= bytes.length) {
        return { width: header.getUint16(offset + 5), height: header.getUint16(offset + 3) };
      }
      offset += length;
    }
    return {};
  }

  function webpDimensions(bytes, header, tag) {
    if (bytes.length < 30) return {};
    if (tag(12, 16) === 'VP8X') {
      const valueAt = offset => 1 + bytes[offset] + 256 * bytes[offset + 1] + 65_536 * bytes[offset + 2];
      return { width: valueAt(24), height: valueAt(27) };
    }
    if (tag(12, 16) === 'VP8L' && bytes[20] === 0x2f) {
      const bits = header.getUint32(21, true);
      return { width: 1 + (bits & 0x3fff), height: 1 + ((bits >>> 14) & 0x3fff) };
    }
    if (tag(12, 16) === 'VP8 ' && bytes[23] === 0x9d && bytes[24] === 1 && bytes[25] === 0x2a) {
      return { width: header.getUint16(26, true) & 0x3fff, height: header.getUint16(28, true) & 0x3fff };
    }
    return {};
  }

  async function inspectImage(file) {
    // Only metadata is sampled here. The original file goes to the browser decoder.
    const buffer = await file.slice(0, 256 * 1024).arrayBuffer();
    const bytes = new Uint8Array(buffer);
    const header = new DataView(buffer);
    const tag = (start, end) => String.fromCharCode(...bytes.subarray(start, end));

    if (bytes.length >= 24 && header.getUint32(0) === 0x89504e47 && header.getUint32(4) === 0x0d0a1a0a) {
      return { kind: 'png', width: header.getUint32(16), height: header.getUint32(20) };
    }
    if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
      return { kind: 'jpeg', ...jpegDimensions(bytes, header) };
    }
    if (bytes.length >= 12 && tag(0, 4) === 'RIFF' && tag(8, 12) === 'WEBP') {
      return { kind: 'webp', ...webpDimensions(bytes, header, tag) };
    }
    if (bytes.length >= 10 && ['GIF87a', 'GIF89a'].includes(tag(0, 6))) {
      return { kind: 'gif', width: header.getUint16(6, true), height: header.getUint16(8, true) };
    }
    throw new Error('지원하는 이미지 파일을 선택해 주세요. JPG, PNG, WEBP, GIF를 열 수 있습니다.');
  }

  async function decodeImage(file, metadata) {
    let bitmap;
    try {
      // ImageBitmap uses the animation's default image or first frame.
      bitmap = await createImageBitmap(file, { imageOrientation: 'from-image' });
    } catch (error) {
      if (metadata.kind === 'gif') throw error;
      const url = URL.createObjectURL(file);
      try {
        bitmap = new Image();
        bitmap.src = url;
        await bitmap.decode();
      } finally {
        URL.revokeObjectURL(url);
      }
    }

    const width = bitmap.naturalWidth ?? bitmap.width;
    const height = bitmap.naturalHeight ?? bitmap.height;
    if (!width || !height) {
      bitmap.close?.();
      throw new Error('이미지 해상도를 읽을 수 없습니다.');
    }
    return { bitmap, width, height, kind: metadata.kind };
  }

  function toBlob(canvas, type, quality) {
    return new Promise((resolve, reject) => {
      canvas.toBlob(blob => {
        if (blob?.type === type && blob.size) resolve(blob);
        else reject(new Error('브라우저가 출력 이미지를 인코딩하지 못했습니다.'));
      }, type, quality);
    });
  }

  async function jpegWithinLimit(canvas, maxBytes) {
    const bestQuality = await toBlob(canvas, 'image/jpeg', 1);
    if (bestQuality.size <= maxBytes) return bestQuality;

    let low = 0;
    let high = 1;
    let best = null;
    for (let step = 0; step < 9; step++) {
      const quality = (low + high) / 2;
      const candidate = await toBlob(canvas, 'image/jpeg', quality);
      if (candidate.size <= maxBytes) {
        best = candidate;
        low = quality;
      } else {
        high = quality;
      }
    }
    if (best) return best;
    const smallest = await toBlob(canvas, 'image/jpeg', 0);
    if (smallest.size <= maxBytes) return smallest;
    throw new Error('최저 JPG 품질에서도 200KB 이내로 압축할 수 없습니다.');
  }

  function coversTile(source, view, tile) {
    const tolerance = 1e-8;
    return view.x <= tile.x + tolerance && view.y <= tile.y + tolerance
      && view.x + source.width * view.scale >= tile.x + tile.width - tolerance
      && view.y + source.height * view.scale >= tile.y + tile.height - tolerance;
  }

  async function encodeTile(source, view, tile, frame, format, canvases) {
    const { tileContext, opaqueContext } = canvases;
    renderTile(tileContext, source, view, tile, frame);
    const tryPNG = format === 'png' || (format === 'auto' && (source.kind !== 'jpeg' || !coversTile(source, view, tile)));
    if (tryPNG) {
      const png = await toBlob(tileContext.canvas, 'image/png');
      if (png.size <= frame.maxBytes) return { blob: png, extension: 'png', fallback: false };
    }

    opaqueContext.fillStyle = '#fff';
    opaqueContext.fillRect(0, 0, frame.outputWidth, frame.outputHeight);
    opaqueContext.drawImage(tileContext.canvas, 0, 0);
    const jpg = await jpegWithinLimit(opaqueContext.canvas, frame.maxBytes);
    return { blob: jpg, extension: 'jpg', fallback: tryPNG };
  }

  // ZIP storage keeps the prototype's CRC-32 and avoids recompressing JPG or PNG.
  const crcTable = Uint32Array.from({ length: 256 }, (_, byte) => {
    for (let bit = 0; bit < 8; bit++) byte = byte & 1 ? 0xedb88320 ^ (byte >>> 1) : byte >>> 1;
    return byte;
  });

  function crc32(bytes) {
    let crc = 0xffffffff;
    for (const byte of bytes) crc = crcTable[(crc ^ byte) & 255] ^ (crc >>> 8);
    return (crc ^ 0xffffffff) >>> 0;
  }

  function zipHeader(length, signature, words, doubleWords, name) {
    const bytes = new Uint8Array(length + (name?.length ?? 0));
    const data = new DataView(bytes.buffer);
    data.setUint32(0, signature, true);
    for (const [offset, value] of words) data.setUint16(offset, value, true);
    for (const [offset, value] of doubleWords) data.setUint32(offset, value, true);
    if (name) bytes.set(name, length);
    return bytes;
  }

  async function makeZip(files) {
    const encoder = new TextEncoder();
    const now = new Date();
    const time = (now.getHours() << 11) | (now.getMinutes() << 5) | (now.getSeconds() >> 1);
    const date = ((clamp(now.getFullYear(), 1980, 2107) - 1980) << 9) | ((now.getMonth() + 1) << 5) | now.getDate();
    const parts = [];
    const directory = [];
    let offset = 0;
    let directorySize = 0;

    for (const file of files) {
      const bytes = new Uint8Array(await file.blob.arrayBuffer());
      const name = encoder.encode(file.name);
      const crc = crc32(bytes);
      const local = zipHeader(30, 0x04034b50,
        [[4, 20], [6, 0x0800], [10, time], [12, date], [26, name.length]],
        [[14, crc], [18, bytes.length], [22, bytes.length]], name);
      const entry = zipHeader(46, 0x02014b50,
        [[4, 20], [6, 20], [8, 0x0800], [12, time], [14, date], [28, name.length]],
        [[16, crc], [20, bytes.length], [24, bytes.length], [42, offset]], name);
      parts.push(local, bytes);
      directory.push(entry);
      offset += local.length + bytes.length;
      directorySize += entry.length;
    }

    const end = zipHeader(22, 0x06054b50, [[8, files.length], [10, files.length]], [[12, directorySize], [16, offset]]);
    return new Blob([...parts, ...directory, end], { type: 'application/zip' });
  }

  return { preset, clamp, centeredView, zoomAt, makeCanvas, imageIntersection, drawImageArea, renderTile, inspectImage, decodeImage, encodeTile, makeZip };
})();
