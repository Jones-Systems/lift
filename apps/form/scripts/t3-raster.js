window.Form2Raster = async function ({ direction, filename, width = 402, height = 874, selector = '.phone' }) {
  await document.fonts.ready;
  const phone = document.querySelector(selector);
  if (!phone) throw new Error('Missing logical phone frame');
  const clone = phone.cloneNode(true);
  const bounds = phone.getBoundingClientRect();
  const scale = bounds.width / width;
  const frames = Array.from(phone.querySelectorAll('[data-a11y-id],[data-testid]')).slice(0, 100).map(el => {
    const r = el.getBoundingClientRect();
    return {
      a11y_id: el.getAttribute('data-a11y-id') || el.getAttribute('data-testid'),
      frame_pt: [(r.x - bounds.x) / scale, (r.y - bounds.y) / scale, r.width / scale, r.height / scale],
    };
  });
  async function dataURL(url) {
    const response = await fetch(url);
    if (!response.ok) throw new Error(`Resource failed: ${url}`);
    return await new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result);
      reader.onerror = reject;
      response.blob().then(blob => reader.readAsDataURL(blob));
    });
  }
  const styles = [];
  for (const sheet of Array.from(document.styleSheets)) {
    let css = sheet.href
      ? await (await fetch(sheet.href)).text()
      : sheet.ownerNode?.textContent || Array.from(sheet.cssRules).map(rule => rule.cssText).join('\n');
    for (const match of [...css.matchAll(/url\(["']?([^"')]+)["']?\)/g)]) {
      if (match[1].startsWith('#') || match[1].startsWith('data:')) continue;
      const encoded = await dataURL(new URL(match[1], sheet.href || location.href).href);
      css = css.replace(match[0], `url("${encoded}")`);
    }
    styles.push(css);
  }
  const originalImages = Array.from(phone.querySelectorAll('img'));
  const images = Array.from(clone.querySelectorAll('img'));
  for (let i = 0; i < images.length; i++) images[i].src = await dataURL(originalImages[i].currentSrc || originalImages[i].src);
  const originals = Array.from(phone.querySelectorAll('input,textarea'));
  const controls = Array.from(clone.querySelectorAll('input,textarea'));
  for (let i = 0; i < controls.length; i++) {
    controls[i].setAttribute('value', originals[i].value);
    if (controls[i].tagName === 'TEXTAREA') controls[i].textContent = originals[i].value;
  }
  clone.style.transform = 'none';
  clone.style.transformOrigin = '0 0';
  const body = getComputedStyle(document.body);
  const documentClone = document.documentElement.cloneNode(false);
  const bodyClone = document.body.cloneNode(false);
  const style = document.createElement('style');
  style.textContent = styles.join('\n');
  documentClone.setAttribute('xmlns', 'http://www.w3.org/1999/xhtml');
  Object.assign(documentClone.style, { width: `${width}px`, height: `${height}px`, overflow: 'hidden' });
  Object.assign(bodyClone.style, { margin: '0', width: `${width}px`, height: `${height}px`, overflow: 'hidden', color: body.color, fontFamily: body.fontFamily });
  bodyClone.append(clone);
  documentClone.append(style, bodyClone);
  const content = new XMLSerializer().serializeToString(documentClone);
  const source = `<svg xmlns="http://www.w3.org/2000/svg" width="${width * 3}" height="${height * 3}" viewBox="0 0 ${width} ${height}"><foreignObject width="${width}" height="${height}">${content}</foreignObject></svg>`;
  const image = new Image();
  await new Promise((resolve, reject) => {
    image.onload = resolve;
    image.onerror = reject;
    image.src = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(source)}`;
  });
  const canvas = document.createElement('canvas');
  canvas.width = width * 3;
  canvas.height = height * 3;
  canvas.getContext('2d').drawImage(image, 0, 0);
  const blob = await new Promise(resolve => canvas.toBlob(resolve, 'image/png'));
  const response = await fetch(`/__capture__/${direction}/${filename}`, {
    method: 'POST', headers: { 'Content-Type': 'image/png' }, body: blob,
  });
  if (!response.ok) throw new Error(`Capture store failed: ${response.status}`);
  return {
    method: 'T3 browser SVG foreignObject raster v2, raw linked CSS, embedded local fonts and assets, original html/body attributes, no PNG upsampling',
    sourceURL: location.href, viewport: [innerWidth, innerHeight], browserDPR: devicePixelRatio,
    logicalFrame: [width, height], store: await response.json(), frames,
  };
};
