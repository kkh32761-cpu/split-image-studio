'use strict';

(() => {
  const {
    preset, clamp, centeredView, zoomAt, makeCanvas, imageIntersection, drawImageArea, renderTile,
    inspectImage, decodeImage, encodeTile, makeZip,
  } = imageCore;
  const byId = id => document.getElementById(id);
  const stage = byId('stage');
  const editor = byId('editor');
  const editorContext = editor.getContext('2d');
  const preview = byId('preview');
  const previewContext = preview.getContext('2d', { alpha: false });
  const previewTile = makeCanvas(preset.outputWidth, preset.outputHeight).getContext('2d');
  const fileInput = byId('file-input');
  const format = byId('format');
  const zoom = byId('zoom');
  const exportButton = byId('export');
  const zipLink = byId('zip-link');
  const loadNote = byId('load-note');
  const exportStatus = byId('export-status');
  const guides = byId('show-guides');
  const numbers = byId('show-numbers');
  const chooseButtons = Array.from(document.querySelectorAll('.choose-file'));
  const compositionButtons = ['zoom', 'zoom-in', 'zoom-out', 'fit', 'fill', 'reset'].map(byId);
  const dropTargets = Array.from(document.querySelectorAll('[data-drop-target]'));
  const centeredPoint = { x: preset.width / 2, y: preset.height / 2 };
  const wholeFrame = { x: 0, y: 0, width: preset.width, height: preset.height };
  const numberFormat = new Intl.NumberFormat('ko-KR');

  let source = null;
  let view = null;
  let scene = null;
  let pan = null;
  let loading = false;
  let exporting = false;
  let animationFrame = 0;
  let previewDirty = true;
  let results = [];
  let zipUrl = null;

  function status(element, message, tone = '') {
    element.hidden = !message;
    element.textContent = message;
    element.dataset.tone = tone;
  }

  if (!editorContext || !previewContext || !previewTile) {
    for (const button of chooseButtons) button.disabled = true;
    status(loadNote, '이 브라우저에서 Canvas를 사용할 수 없습니다. 최신 브라우저에서 열어 주세요.', 'error');
    return;
  }

  function updateControls() {
    const canEdit = Boolean(source) && !loading && !exporting;
    for (const control of compositionButtons) control.disabled = !canEdit;
    for (const button of chooseButtons) button.disabled = loading || exporting;
    format.disabled = exporting;
    exportButton.disabled = !canEdit;
    byId('export-label').textContent = exporting ? '이미지 생성 중…' : '6장 생성 + ZIP 다운로드';
    stage.classList.toggle('has-image', Boolean(source));
    editor.tabIndex = canEdit ? 0 : -1;
  }

  function clearResults() {
    for (const result of results) URL.revokeObjectURL(result.url);
    if (zipUrl) URL.revokeObjectURL(zipUrl);
    results = [];
    zipUrl = null;
    zipLink.removeAttribute('href');
    zipLink.hidden = true;
    byId('results-grid').replaceChildren();
    byId('results').hidden = true;
  }

  function formatBytes(bytes) {
    if (bytes >= 1_000_000) return `${(bytes / 1_000_000).toFixed(1)} MB`;
    if (bytes >= 1000) return `${(bytes / 1000).toFixed(1)} KB`;
    return `${bytes} B`;
  }

  function isLargeImage(file, image) {
    return file.size >= 40_000_000 || image.width * image.height >= 32_000_000;
  }

  async function loadFile(file) {
    if (!file || loading || exporting) return;
    loading = true;
    stopPan();
    updateControls();
    status(loadNote, '이미지를 읽는 중입니다…');
    try {
      const metadata = await inspectImage(file);
      const large = isLargeImage(file, metadata);
      if (large) status(loadNote, '큰 이미지를 읽는 중입니다. 브라우저 메모리에 따라 시간이 걸릴 수 있습니다.', 'warning');

      let decoded;
      try {
        decoded = await decodeImage(file, metadata);
      } catch {
        throw new Error('이미지를 열 수 없습니다. 파일이 손상되었거나 브라우저의 디코딩 한계를 넘었을 수 있습니다.');
      }
      source?.bitmap.close?.();
      source = decoded;
      view = centeredView(source, preset, 'fill');
      byId('file-name').textContent = file.name;
      byId('file-name').title = file.name;
      byId('file-resolution').textContent = `${numberFormat.format(source.width)} × ${numberFormat.format(source.height)}px`;
      byId('file-size').textContent = formatBytes(file.size);
      byId('file-size').title = `${numberFormat.format(file.size)} 바이트`;
      byId('file-details').hidden = false;
      byId('empty-editor').hidden = true;
      byId('empty-preview').hidden = true;
      byId('choose-file').textContent = '이미지 교체';
      const notices = [];
      if (metadata.kind === 'gif') notices.push('GIF 첫 프레임을 불러왔습니다.');
      if (large || isLargeImage(file, source)) notices.push('고해상도 이미지입니다. 기기의 메모리에 따라 처리 시간이 늘어날 수 있습니다.');
      status(loadNote, notices.join(' '), notices.length > 0 ? 'warning' : '');
      compositionChanged();
    } catch (error) {
      const previous = source ? ' 기존 이미지는 그대로 편집할 수 있습니다.' : '';
      status(loadNote, `${error.message}${previous}`, 'error');
    } finally {
      loading = false;
      updateControls();
    }
  }

  function zoomScales() {
    const base = centeredView(source, preset, 'fill').scale;
    return { base, min: centeredView(source, preset, 'fit').scale / 4, max: base * 20 };
  }

  function updateZoom() {
    const { base, min, max } = zoomScales();
    const percent = view.scale / base * 100;
    const precision = percent < 1 ? 2 : percent < 10 ? 1 : 0;
    const label = `${Number(percent.toFixed(precision))}%`;
    zoom.value = Math.round(1000 * Math.log(view.scale / min) / Math.log(max / min));
    zoom.setAttribute('aria-valuetext', label);
    byId('zoom-value').textContent = label;
  }

  function compositionChanged() {
    const hadResults = results.length > 0;
    if (hadResults) clearResults();
    updateZoom();
    scheduleDraw(true);
    status(exportStatus, hadResults ? '현재 구도로 6장을 다시 생성할 수 있습니다.' : '구도를 확인한 뒤 ZIP을 받아보세요.');
  }

  function editorPoint(event) {
    const bounds = editor.getBoundingClientRect();
    return {
      x: (event.clientX - bounds.left - scene.x) / scene.scale,
      y: (event.clientY - bounds.top - scene.y) / scene.scale,
    };
  }

  function changeScale(scale, center = centeredPoint) {
    if (exportButton.disabled) return;
    const { min, max } = zoomScales();
    const target = clamp(scale, min, max);
    if (target === view.scale) return;
    view = zoomAt(view, center, target);
    compositionChanged();
  }

  function moveView(x, y) {
    view = { ...view, x: view.x + x, y: view.y + y };
    compositionChanged();
  }

  function setCentered(mode) {
    if (exportButton.disabled) return;
    view = centeredView(source, preset, mode);
    compositionChanged();
  }

  function drawEditor() {
    const width = editor.clientWidth;
    const height = editor.clientHeight;
    if (!width || !height) return;
    const density = Math.min(window.devicePixelRatio || 1, 2);
    const pixelWidth = Math.round(width * density);
    const pixelHeight = Math.round(height * density);
    if (editor.width !== pixelWidth || editor.height !== pixelHeight) {
      editor.width = pixelWidth;
      editor.height = pixelHeight;
    }

    const context = editorContext;
    context.setTransform(pixelWidth / width, 0, 0, pixelHeight / height, 0, 0);
    context.clearRect(0, 0, width, height);
    context.imageSmoothingQuality = 'high';
    const padding = Math.min(26, width / 10);
    const scale = Math.min((width - 2 * padding) / preset.width, (height - 2 * padding) / preset.height);
    const frameWidth = preset.width * scale;
    const frameHeight = preset.height * scale;
    const x = (width - frameWidth) / 2;
    const y = (height - frameHeight) / 2;
    scene = { x, y, scale };

    if (source) {
      const stageArea = { x: -x / scale, y: -y / scale, width: width / scale, height: height / scale };
      context.fillStyle = '#fff';
      context.fillRect(x, y, frameWidth, frameHeight);
      drawImageArea(context, source, view, stageArea, { x: 0, y: 0, width, height });

      context.fillStyle = 'rgba(10, 14, 20, 0.77)';
      context.fillRect(0, 0, width, y);
      context.fillRect(0, y + frameHeight, width, height - y - frameHeight);
      context.fillRect(0, y, x, frameHeight);
      context.fillRect(x + frameWidth, y, width - x - frameWidth, frameHeight);
    } else {
      context.fillStyle = '#1b222b';
      context.fillRect(x, y, frameWidth, frameHeight);
    }

    if (guides.checked) {
      context.fillStyle = '#000';
      for (let column = 1; column < preset.columns; column++) {
        const guideX = column * (preset.tileWidth + preset.gapX) - preset.gapX;
        context.fillRect(x + guideX * scale, y, preset.gapX * scale, frameHeight);
      }
      for (let row = 1; row < preset.rows; row++) {
        const guideY = row * (preset.tileHeight + preset.gapY) - preset.gapY;
        context.fillRect(x, y + guideY * scale, frameWidth, preset.gapY * scale);
      }
    }
    context.strokeStyle = source ? '#c4f080' : '#4d5b66';
    context.lineWidth = 1;
    context.strokeRect(x, y, frameWidth, frameHeight);

    if (source && numbers.checked) {
      context.font = '600 10px ui-monospace, monospace';
      context.textAlign = 'center';
      context.textBaseline = 'middle';
      for (const [index, tile] of preset.tiles.entries()) {
        const labelX = x + tile.x * scale + 5;
        const labelY = y + tile.y * scale + 5;
        context.fillStyle = 'rgba(14, 21, 17, 0.86)';
        context.fillRect(labelX, labelY, 21, 15);
        context.fillStyle = '#e4ffc1';
        context.fillText(String(index + 1).padStart(2, '0'), labelX + 10.5, labelY + 8);
      }
    }
  }

  function drawPreview() {
    const context = previewContext;
    context.fillStyle = '#000';
    context.fillRect(0, 0, preset.width, preset.height);
    context.imageSmoothingQuality = 'high';
    const hasEncodedPreview = results.length === preset.tiles.length && results.every(file => file.image.naturalWidth > 0);

    for (const [index, tile] of preset.tiles.entries()) {
      context.fillStyle = source ? '#fff' : '#1b222b';
      context.fillRect(tile.x, tile.y, tile.width, tile.height);
      if (!source) continue;

      if (hasEncodedPreview) {
        previewTile.clearRect(0, 0, preset.outputWidth, preset.outputHeight);
        previewTile.drawImage(results[index].image, 0, 0);
      } else {
        renderTile(previewTile, source, view, tile, preset);
      }
      context.drawImage(previewTile.canvas, tile.x, tile.y, tile.width, tile.height);
    }
  }

  function scheduleDraw(refreshPreview = false) {
    previewDirty ||= refreshPreview;
    if (animationFrame) return;
    animationFrame = requestAnimationFrame(() => {
      animationFrame = 0;
      try {
        drawEditor();
        if (previewDirty) drawPreview();
      } catch {
        status(loadNote, '이미지를 그릴 수 없습니다. 다른 탭을 닫거나 더 작은 이미지로 다시 시도해 주세요.', 'error');
      } finally {
        previewDirty = false;
      }
    });
  }

  function createResultCard(file) {
    const card = document.createElement('article');
    card.className = 'result-tile';
    const image = new Image();
    image.width = preset.outputWidth;
    image.height = preset.outputHeight;
    image.alt = file.name;
    image.addEventListener('load', () => scheduleDraw(true), { once: true });
    image.src = file.url;

    const meta = document.createElement('div');
    meta.className = 'tile-meta';
    const title = document.createElement('strong');
    title.textContent = file.name;
    const size = document.createElement('span');
    size.textContent = formatBytes(file.blob.size);
    size.title = `${numberFormat.format(file.blob.size)} 바이트`;
    meta.append(title, size);

    const link = document.createElement('a');
    link.className = 'tile-download';
    link.href = file.url;
    link.download = file.name;
    link.textContent = '개별 다운로드';
    link.setAttribute('aria-label', `${file.name} 다운로드`);
    card.append(image, meta, link);
    return { card, image };
  }

  async function exportTiles() {
    if (exportButton.disabled) return;
    const snapshot = { source, view: { ...view }, format: format.value };
    if (!preset.tiles.some(tile => imageIntersection(snapshot.source, snapshot.view, tile))) {
      status(exportStatus, '출력 칸 안에 이미지가 없습니다. 사진을 프레임 안으로 옮겨 주세요.', 'error');
      return;
    }
    exporting = true;
    stopPan();
    updateControls();
    const files = [];
    try {
      const canvases = {
        tileContext: makeCanvas(preset.outputWidth, preset.outputHeight).getContext('2d'),
        opaqueContext: makeCanvas(preset.outputWidth, preset.outputHeight).getContext('2d', { alpha: false }),
      };
      if (!canvases.tileContext || !canvases.opaqueContext) throw new Error('출력에 필요한 캔버스를 준비할 수 없습니다.');
      for (const [index, tile] of preset.tiles.entries()) {
        status(exportStatus, `${index + 1}/${preset.tiles.length}번 이미지 생성 및 용량 확인 중…`);
        const file = await encodeTile(snapshot.source, snapshot.view, tile, preset, snapshot.format, canvases);
        if (file.blob.size <= 0 || file.blob.size > preset.maxBytes) throw new Error(`${index + 1}번 이미지의 출력 용량을 확인할 수 없습니다.`);
        files.push({ ...file, name: `${tile.name}.${file.extension}` });
      }
      status(exportStatus, 'ZIP 파일을 만드는 중입니다…');
      const zip = await makeZip(files);
      clearResults();
      zipUrl = URL.createObjectURL(zip);
      const grid = byId('results-grid');
      for (const file of files) {
        const url = URL.createObjectURL(file.blob);
        const { card, image } = createResultCard({ ...file, url });
        results.push({ url, image });
        grid.append(card);
      }
      byId('results').hidden = false;
      zipLink.href = zipUrl;
      zipLink.hidden = false;
      zipLink.click();
      const fallbackCount = files.filter(file => file.fallback).length;
      const completion = `6장 생성 완료 · 모두 200KB 이하${fallbackCount ? ` · JPG 전환 ${fallbackCount}장` : ''}`;
      status(exportStatus, completion, 'success');
    } catch (error) {
      clearResults();
      scheduleDraw(true);
      status(exportStatus, `다운로드 실패. ${error.message}`, 'error');
    } finally {
      exporting = false;
      updateControls();
    }
  }

  function stopPan(event) {
    if (!pan || (event && pan.id !== event.pointerId)) return;
    const id = pan.id;
    pan = null;
    stage.classList.remove('is-panning');
    if (editor.hasPointerCapture(id)) editor.releasePointerCapture(id);
  }

  for (const button of chooseButtons) button.addEventListener('click', () => fileInput.click());
  fileInput.addEventListener('change', () => {
    const file = fileInput.files[0];
    fileInput.value = '';
    loadFile(file);
  });
  window.addEventListener('dragover', event => {
    if (!event.dataTransfer.types.includes('Files')) return;
    event.preventDefault();
    const busy = loading || exporting;
    event.dataTransfer.dropEffect = busy ? 'none' : 'copy';
    const target = busy ? null : event.target.closest?.('[data-drop-target]');
    for (const zone of dropTargets) zone.classList.toggle('is-dragover', zone === target);
  });
  window.addEventListener('dragleave', event => {
    if (!event.relatedTarget) for (const zone of dropTargets) zone.classList.remove('is-dragover');
  });
  window.addEventListener('drop', event => {
    if (!event.dataTransfer.types.includes('Files')) return;
    event.preventDefault();
    for (const zone of dropTargets) zone.classList.remove('is-dragover');
    loadFile(event.dataTransfer.files[0]);
  });

  editor.addEventListener('pointerdown', event => {
    if (exportButton.disabled || !scene || event.button !== 0 || pan) return;
    pan = { id: event.pointerId, x: event.clientX, y: event.clientY };
    editor.setPointerCapture(event.pointerId);
    stage.classList.add('is-panning');
  });
  editor.addEventListener('pointermove', event => {
    if (pan?.id !== event.pointerId || !scene) return;
    const x = (event.clientX - pan.x) / scene.scale;
    const y = (event.clientY - pan.y) / scene.scale;
    pan.x = event.clientX;
    pan.y = event.clientY;
    if (x || y) moveView(x, y);
  });
  for (const event of ['pointerup', 'pointercancel', 'lostpointercapture']) editor.addEventListener(event, stopPan);
  editor.addEventListener('wheel', event => {
    if (exportButton.disabled || !scene) return;
    event.preventDefault();
    const units = event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? editor.clientHeight : 1;
    const factor = Math.exp(clamp(-event.deltaY * units * 0.0018, -0.8, 0.8));
    changeScale(view.scale * factor, editorPoint(event));
  }, { passive: false });
  editor.addEventListener('keydown', event => {
    if (exportButton.disabled) return;
    const distance = event.shiftKey ? 24 : 8;
    const directions = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] };
    const direction = directions[event.key];
    if (direction) moveView(direction[0] * distance, direction[1] * distance);
    else if (event.key === '+' || event.key === '=') changeScale(view.scale * 1.2);
    else if (event.key === '-') changeScale(view.scale / 1.2);
    else return;
    event.preventDefault();
  });

  byId('zoom-in').addEventListener('click', () => changeScale(view.scale * 1.2));
  byId('zoom-out').addEventListener('click', () => changeScale(view.scale / 1.2));
  zoom.addEventListener('input', () => {
    if (exportButton.disabled) return;
    const { min, max } = zoomScales();
    changeScale(min * (max / min) ** (Number(zoom.value) / 1000));
  });
  byId('fit').addEventListener('click', () => setCentered('fit'));
  byId('fill').addEventListener('click', () => setCentered('fill'));
  byId('reset').addEventListener('click', () => setCentered('fill'));
  guides.addEventListener('change', () => scheduleDraw());
  numbers.addEventListener('change', () => scheduleDraw());
  format.addEventListener('change', () => {
    byId('format-help').textContent = format.value === 'jpeg'
      ? '투명한 부분은 흰색으로 채우고 JPG로 저장합니다.'
      : 'PNG가 200KB를 넘는 칸은 JPG로 저장합니다.';
    if (source) compositionChanged();
  });
  exportButton.addEventListener('click', exportTiles);

  if (typeof ResizeObserver === 'function') new ResizeObserver(() => scheduleDraw()).observe(stage);
  window.addEventListener('resize', () => scheduleDraw());
  for (const canvas of [editor, preview]) {
    canvas.addEventListener('contextlost', () => status(loadNote, '브라우저에서 캔버스 메모리를 잃었습니다. 사용 중인 탭을 줄인 뒤 다시 시도해 주세요.', 'error'));
    canvas.addEventListener('contextrestored', () => scheduleDraw(true));
  }
  updateControls();
  scheduleDraw(true);
})();
