// Maximum safe canvas height in Chromium before toBlob() returns null
const MAX_SAFE_CANVAS_HEIGHT = 30000;

// State management for user settings
let currentMode = 'equal'; // 'equal' (Equal Parts) or 'full' (Full Page)
let currentFormat = 'png'; // 'png', 'jpeg', or 'webp'
let detectedPageHeight = 0; // Total page height in physical pixels

const modeButtons = document.querySelectorAll('.segment-btn');
const formatButtons = document.querySelectorAll('.format-btn');
const sliceHeightGroup = document.getElementById('slice-height-group');
const sliceHeightInput = document.getElementById('slice-height');
const calcBadge = document.getElementById('calc-badge');
const hidePopupsToggle = document.getElementById('hide-popups-toggle');
const captureBtn = document.getElementById('capture-btn');
const captureBtnText = document.getElementById('capture-btn-text');
const statusText = document.getElementById('status-text');

// Update the calculation info badge whenever slice height or mode changes
const updateCalculationBadge = () => {
  if (!detectedPageHeight || detectedPageHeight <= 0) {
    calcBadge.textContent = 'System page';
    return;
  }

  if (currentMode === 'full') {
    calcBadge.textContent = `${detectedPageHeight}px → 1 image`;
    return;
  }

  const sliceHeight = parseInt(sliceHeightInput.value, 10) || 1080;
  const slicesCount = Math.max(1, Math.ceil(detectedPageHeight / sliceHeight));
  const label = slicesCount === 1 ? 'slice' : 'slices';
  calcBadge.textContent = `${detectedPageHeight}px → ${slicesCount} ${label}`;
};

// Initialize default slice height and measure page dimensions on popup open
document.addEventListener('DOMContentLoaded', async () => {
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (tab && tab.url && !tab.url.startsWith('chrome://') && !tab.url.startsWith('edge://')) {
      const results = await chrome.scripting.executeScript({
        target: { tabId: tab.id },
        func: () => {
          const dpr = window.devicePixelRatio || 1;
          const viewportWidth = window.innerWidth;
          const viewportHeight = window.innerHeight;

          let totalHeight = Math.max(
            document.body ? document.body.scrollHeight : 0,
            document.documentElement.scrollHeight,
            document.body ? document.body.offsetHeight : 0,
            document.documentElement.offsetHeight
          );

          if (totalHeight <= viewportHeight + 5) {
            const candidates = document.querySelectorAll('*');
            for (const el of candidates) {
              const style = window.getComputedStyle(el);
              if (
                (style.overflowY === 'auto' || style.overflowY === 'scroll' || style.overflowY === 'overlay') &&
                el.scrollHeight > el.clientHeight + 50 &&
                el.clientWidth >= viewportWidth * 0.5 &&
                el.scrollHeight > totalHeight
              ) {
                totalHeight = el.scrollHeight;
              }
            }
          }

          return {
            physicalViewportHeight: Math.round(viewportHeight * dpr),
            physicalPageHeight: Math.round(totalHeight * dpr)
          };
        }
      });

      if (results && results[0] && results[0].result) {
        const { physicalViewportHeight, physicalPageHeight } = results[0].result;
        sliceHeightInput.value = physicalViewportHeight;
        detectedPageHeight = physicalPageHeight;
      }
    }
  } catch (err) {
    sliceHeightInput.value = 1080;
  } finally {
    updateCalculationBadge();
  }
});

sliceHeightInput.addEventListener('input', updateCalculationBadge);

// Handle Slicing Mode Toggle
modeButtons.forEach((btn) => {
  btn.addEventListener('click', () => {
    modeButtons.forEach((b) => b.classList.remove('active'));
    btn.classList.add('active');
    currentMode = btn.dataset.mode;

    if (currentMode === 'full') {
      sliceHeightGroup.classList.add('disabled');
      captureBtnText.textContent = 'Capture Full Page';
    } else {
      sliceHeightGroup.classList.remove('disabled');
      captureBtnText.textContent = 'Capture & Slice';
    }

    updateCalculationBadge();
  });
});

// Handle Image Format Selection
formatButtons.forEach((btn) => {
  btn.addEventListener('click', () => {
    formatButtons.forEach((b) => b.classList.remove('active'));
    btn.classList.add('active');
    currentFormat = btn.dataset.format;
  });
});

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const loadImage = (dataUrl) => {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = reject;
    img.src = dataUrl;
  });
};

const canvasToBlob = (canvas, format) => {
  const mimeType = `image/${format}`;
  const quality = format === 'png' ? undefined : 0.92;
  return new Promise((resolve, reject) => {
    canvas.toBlob((blob) => {
      if (blob) {
        resolve(blob);
      } else {
        reject(new Error('Canvas exceeds browser maximum size limit'));
      }
    }, mimeType, quality);
  });
};

const downloadBlob = async (blob, filename) => {
  const url = URL.createObjectURL(blob);
  await chrome.downloads.download({
    url,
    filename,
    saveAs: false
  });
  setTimeout(() => URL.revokeObjectURL(url), 15000);
};

// Precomputed CRC32 table for creating valid ZIP archives
const CRC32_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let k = 0; k < 8; k++) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    table[i] = c >>> 0;
  }
  return table;
})();

const crc32 = (bytes) => {
  let crc = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) {
    crc = CRC32_TABLE[(crc ^ bytes[i]) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
};

// Build an uncompressed (STORE) ZIP Blob from an array of { name, data: Uint8Array }
const createZipBlob = (files) => {
  const encoder = new TextEncoder();
  const localParts = [];
  const centralParts = [];
  let offset = 0;

  const now = new Date();
  const dosTime =
    ((now.getHours() & 0x1f) << 11) |
    ((now.getMinutes() & 0x3f) << 5) |
    ((now.getSeconds() >> 1) & 0x1f);
  const dosDate =
    (((now.getFullYear() - 1980) & 0x7f) << 9) |
    (((now.getMonth() + 1) & 0x0f) << 5) |
    (now.getDate() & 0x1f);

  for (const file of files) {
    const nameBytes = encoder.encode(file.name);
    const data = file.data;
    const fileCrc = crc32(data);
    const size = data.length;

    const localHeader = new Uint8Array(30 + nameBytes.length);
    const localView = new DataView(localHeader.buffer);
    localView.setUint32(0, 0x04034b50, true);
    localView.setUint16(4, 20, true);
    localView.setUint16(6, 0x0800, true);
    localView.setUint16(8, 0, true);
    localView.setUint16(10, dosTime, true);
    localView.setUint16(12, dosDate, true);
    localView.setUint32(14, fileCrc, true);
    localView.setUint32(18, size, true);
    localView.setUint32(22, size, true);
    localView.setUint16(26, nameBytes.length, true);
    localView.setUint16(28, 0, true);
    localHeader.set(nameBytes, 30);

    localParts.push(localHeader, data);

    const centralHeader = new Uint8Array(46 + nameBytes.length);
    const centralView = new DataView(centralHeader.buffer);
    centralView.setUint32(0, 0x02014b50, true);
    centralView.setUint16(4, 20, true);
    centralView.setUint16(6, 20, true);
    centralView.setUint16(8, 0x0800, true);
    centralView.setUint16(10, 0, true);
    centralView.setUint16(12, dosTime, true);
    centralView.setUint16(14, dosDate, true);
    centralView.setUint32(16, fileCrc, true);
    centralView.setUint32(20, size, true);
    centralView.setUint32(24, size, true);
    centralView.setUint16(28, nameBytes.length, true);
    centralView.setUint16(30, 0, true);
    centralView.setUint16(32, 0, true);
    centralView.setUint16(34, 0, true);
    centralView.setUint16(36, 0, true);
    centralView.setUint32(38, 0, true);
    centralView.setUint32(42, offset, true);
    centralHeader.set(nameBytes, 46);

    centralParts.push(centralHeader);
    offset += localHeader.length + size;
  }

  const centralSize = centralParts.reduce((acc, part) => acc + part.length, 0);

  const eocd = new Uint8Array(22);
  const eocdView = new DataView(eocd.buffer);
  eocdView.setUint32(0, 0x06054b50, true);
  eocdView.setUint16(4, 0, true);
  eocdView.setUint16(6, 0, true);
  eocdView.setUint16(8, files.length, true);
  eocdView.setUint16(10, files.length, true);
  eocdView.setUint32(12, centralSize, true);
  eocdView.setUint32(16, offset, true);
  eocdView.setUint16(20, 0, true);

  return new Blob([...localParts, ...centralParts, eocd], { type: 'application/zip' });
};

// Core function that scrolls through the page and captures non-overlapping frames
const capturePageFrames = async (tab) => {
  const shouldHidePopups = hidePopupsToggle.checked;

  // Step 1: Prepare page, disable scroll-anchoring & scroll-snap, hide overlays, and measure dimensions
  const [{ result: metrics }] = await chrome.scripting.executeScript({
    target: { tabId: tab.id },
    args: [shouldHidePopups],
    func: (hidePopups) => {
      const styleEl = document.createElement('style');
      styleEl.id = '__screen-glimpse-style';
      styleEl.textContent = `
        *::-webkit-scrollbar { display: none !important; width: 0 !important; height: 0 !important; }
        html, body, * {
          scrollbar-width: none !important;
          -ms-overflow-style: none !important;
          scroll-behavior: auto !important;
          scroll-snap-type: none !important;
          overflow-anchor: none !important;
        }
      `;
      document.head.appendChild(styleEl);

      const hiddenElements = [];
      const hideElementCompletely = (el) => {
        if (!el || el.style.display === 'none') return;
        hiddenElements.push({
          el,
          visibility: el.style.visibility,
          display: el.style.display,
          opacity: el.style.opacity,
          pointerEvents: el.style.pointerEvents
        });
        el.style.setProperty('display', 'none', 'important');
        el.style.setProperty('opacity', '0', 'important');
        el.style.setProperty('pointer-events', 'none', 'important');
      };

      // Only protect genuine page layout wrappers, not modal dialogs containing headers
      const isMainContentWrapper = (el) => {
        if (!el || el === document.body || el === document.documentElement) return true;
        if (el.tagName === 'MAIN' || el.tagName === 'ARTICLE') return true;
        if (el.querySelector('main, #__next, #root, #app')) return true;
        if (el.scrollHeight > window.innerHeight * 1.5 && el.clientHeight > window.innerHeight * 1.2) {
          return true;
        }
        return false;
      };

      if (hidePopups) {
        const popupSelectors = [
          '[id*="cookie" i]', '[class*="cookie" i]',
          '[id*="consent" i]', '[class*="consent" i]',
          '[id*="gdpr" i]', '[class*="gdpr" i]',
          '[id*="privacy-banner" i]', '[class*="privacy-banner" i]',
          '[id*="onetrust" i]', '[id*="cybot" i]', '[class*="cc-window" i]',
          '#cookie-information-template-wrapper', '[id*="coiOverlay" i]', '[id*="coiPage" i]', '[class*="coi-banner" i]',
          '[id*="usercentrics" i]', '[id*="didomi" i]', '[id*="truste" i]',
          '[id*="cmp" i]', '[class*="cmp-" i]',
          '[id*="intercom" i]', '[class*="intercom" i]',
          '[id*="crisp" i]', '[class*="crisp" i]',
          '[id*="tawk" i]', '[id*="zendesk" i]',
          '[id*="hubspot-messages" i]', '[id*="drift" i]',
          '[id*="freshchat" i]', '[class*="chat-widget" i]',
          '[class*="chat-bubble" i]', 'iframe[title*="chat" i]',
          'iframe[title*="cookie" i]', 'iframe[title*="consent" i]',
          '[class*="backdrop" i]', '[id*="backdrop" i]',
          '[class*="modal-overlay" i]', '[class*="popup-overlay" i]'
        ].join(',');

        document.querySelectorAll(popupSelectors).forEach((el) => {
          if (isMainContentWrapper(el)) return;
          const style = window.getComputedStyle(el);
          const isOverlayOrFloating =
            style.position === 'fixed' ||
            style.position === 'sticky' ||
            (style.position === 'absolute' && (parseInt(style.zIndex, 10) > 10 || el.offsetHeight >= window.innerHeight * 0.8)) ||
            el.getAttribute('role') === 'dialog' ||
            el.getAttribute('aria-modal') === 'true';

          if (isOverlayOrFloating) {
            hideElementCompletely(el);
          }
        });

        // Heuristic detection for privacy/cookie modals with custom class names (e.g. "We value your privacy" / "Accept all cookies")
        const cookiePhrases = [
          'accept all cookies',
          'only necessary cookies',
          'allow all cookies',
          'reject all cookies',
          'we value your privacy',
          'powered by cookie information',
          'cookie settings',
          'manage cookies'
        ];

        document.querySelectorAll('div, aside, section, dialog, form').forEach((el) => {
          if (isMainContentWrapper(el)) return;
          const style = window.getComputedStyle(el);
          if (style.display === 'none') return;

          const isFloating =
            style.position === 'fixed' ||
            style.position === 'sticky' ||
            el.getAttribute('role') === 'dialog' ||
            el.getAttribute('aria-modal') === 'true';

          if (!isFloating) return;

          const rect = el.getBoundingClientRect();
          const text = (el.innerText || '').toLowerCase();

          // Check if floating dialog contains standard cookie consent button phrases
          if (text.length > 0 && text.length < 3500 && cookiePhrases.some((phrase) => text.includes(phrase))) {
            hideElementCompletely(el);
            return;
          }

          // Detect full-screen dimmed backdrop/overlay covering the viewport
          const coversViewport =
            rect.width >= window.innerWidth * 0.9 &&
            rect.height >= window.innerHeight * 0.9;

          if (coversViewport) {
            const bg = style.backgroundColor || '';
            const isSemiTransparentBg =
              bg.startsWith('rgba') && !bg.endsWith(', 0)') && !bg.endsWith(', 0.0)');
            const hasBlur =
              (style.backdropFilter && style.backdropFilter !== 'none') ||
              (style.webkitBackdropFilter && style.webkitBackdropFilter !== 'none');
            const hasLowOpacity =
              parseFloat(style.opacity) < 0.95 &&
              parseFloat(style.opacity) > 0.05 &&
              bg !== 'rgba(0, 0, 0, 0)';

            if ((isSemiTransparentBg || hasBlur || hasLowOpacity) && text.trim().length < 500) {
              hideElementCompletely(el);
            }
          }
        });
      }

      const viewportWidth = window.innerWidth;
      const viewportHeight = window.innerHeight;
      const dpr = window.devicePixelRatio || 1;

      let scrollTarget = document.scrollingElement || document.documentElement;
      let totalHeight = Math.max(
        document.body ? document.body.scrollHeight : 0,
        document.documentElement.scrollHeight,
        document.body ? document.body.offsetHeight : 0,
        document.documentElement.offsetHeight
      );

      let isCustomContainer = false;
      if (totalHeight <= viewportHeight + 5) {
        const candidates = document.querySelectorAll('*');
        let maxScrollHeight = totalHeight;
        for (const el of candidates) {
          const style = window.getComputedStyle(el);
          if (
            (style.overflowY === 'auto' || style.overflowY === 'scroll' || style.overflowY === 'overlay') &&
            el.scrollHeight > el.clientHeight + 50 &&
            el.clientWidth >= viewportWidth * 0.5 &&
            el.scrollHeight > maxScrollHeight
          ) {
            maxScrollHeight = el.scrollHeight;
            scrollTarget = el;
            isCustomContainer = true;
          }
        }
        totalHeight = maxScrollHeight;
      }

      window.__screenGlimpseState = {
        isCustomContainer,
        scrollTarget,
        initialScrollTop: isCustomContainer ? scrollTarget.scrollTop : window.scrollY,
        initialScrollLeft: isCustomContainer ? scrollTarget.scrollLeft : window.scrollX,
        hiddenElements
      };

      return { totalHeight, viewportWidth, viewportHeight, dpr };
    }
  });

  const { totalHeight, viewportWidth, viewportHeight, dpr } = metrics;
  const totalSteps = Math.max(1, Math.ceil(totalHeight / viewportHeight));

  let physicalWidth = Math.round(viewportWidth * dpr);
  let actualScale = dpr;
  let coveredPhysicalHeight = 0;
  const segments = [];

  // Step 2: Scroll step-by-step, lock scroll position after hiding sticky elements, and record non-overlapping segments
  for (let step = 0; step < totalSteps; step++) {
    const targetY = step * viewportHeight;
    statusText.textContent = `Capturing part ${step + 1} of ${totalSteps}...`;

    // Initial scroll to trigger any scroll-based sticky headers on the page
    await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      args: [targetY],
      func: (y) => {
        const state = window.__screenGlimpseState;
        if (!state) return;
        if (state.isCustomContainer && state.scrollTarget) {
          state.scrollTarget.scrollTop = y;
        } else {
          window.scrollTo(0, y);
        }
      }
    });

    // Wait 160ms for site scroll listeners to settle
    await delay(160);

    // Hide sticky/fixed bars using opacity: 0 (so child elements with visibility: visible cannot bleed through)
    // and re-enforce exact targetY so scroll position never drifts
    const [{ result: scrollResult }] = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      args: [targetY, step > 0],
      func: (y, isScrolledFrame) => {
        const state = window.__screenGlimpseState;
        if (!state) return { actualY: 0 };

        const allElements = document.querySelectorAll('*');
        allElements.forEach((el) => {
          if (el === document.body || el === document.documentElement) return;
          const style = window.getComputedStyle(el);
          if (style.display === 'none' || style.opacity === '0' || style.visibility === 'hidden') {
            return;
          }

          const isFixedOrSticky = style.position === 'fixed' || style.position === 'sticky';
          if (!isFixedOrSticky) return;

          const rect = el.getBoundingClientRect();
          if (rect.height > window.innerHeight * 0.9 && el.querySelector('main, article, #search, #rso')) {
            return;
          }

          if (isScrolledFrame) {
            state.hiddenElements.push({
              el,
              visibility: el.style.visibility,
              display: el.style.display,
              opacity: el.style.opacity,
              pointerEvents: el.style.pointerEvents
            });
            el.style.setProperty('opacity', '0', 'important');
            el.style.setProperty('pointer-events', 'none', 'important');
          } else if (rect.top > window.innerHeight * 0.55 && rect.height < window.innerHeight * 0.4) {
            state.hiddenElements.push({
              el,
              visibility: el.style.visibility,
              display: el.style.display,
              opacity: el.style.opacity,
              pointerEvents: el.style.pointerEvents
            });
            el.style.setProperty('opacity', '0', 'important');
            el.style.setProperty('pointer-events', 'none', 'important');
          }
        });

        // Re-lock scroll position to exact targetY in case hiding headers shifted scrollY
        if (state.isCustomContainer && state.scrollTarget) {
          state.scrollTarget.scrollTop = y;
          return { actualY: state.scrollTarget.scrollTop };
        } else {
          window.scrollTo(0, y);
          return { actualY: window.scrollY };
        }
      }
    });

    // Wait remaining 400ms to satisfy Chrome's captureVisibleTab rate limit
    await delay(400);

    const dataUrl = await chrome.tabs.captureVisibleTab(tab.windowId, { format: 'png' });
    const img = await loadImage(dataUrl);

    if (step === 0) {
      physicalWidth = img.width;
      actualScale = img.height / viewportHeight;
    }

    let frameTop = Math.round(scrollResult.actualY * actualScale);

    // Prevent any gap or fractional DPI rounding drift when the frame is at the expected scroll step
    if (frameTop > coveredPhysicalHeight || Math.abs(frameTop - coveredPhysicalHeight) <= 2) {
      frameTop = coveredPhysicalHeight;
    }

    const frameBottom = frameTop + img.height;

    // Only append the newly revealed vertical portion [coveredPhysicalHeight .. frameBottom]
    if (frameBottom > coveredPhysicalHeight) {
      const srcY = coveredPhysicalHeight - frameTop;
      const copyHeight = frameBottom - coveredPhysicalHeight;

      segments.push({
        img,
        srcY,
        destY: coveredPhysicalHeight,
        height: copyHeight
      });

      coveredPhysicalHeight = frameBottom;
    }
  }

  // Step 3: Restore page state and previously hidden elements
  await chrome.scripting.executeScript({
    target: { tabId: tab.id },
    func: () => {
      const styleEl = document.getElementById('__screen-glimpse-style');
      if (styleEl) styleEl.remove();

      const state = window.__screenGlimpseState;
      if (state) {
        state.hiddenElements.forEach((item) => {
          item.el.style.visibility = item.visibility;
          item.el.style.display = item.display;
          item.el.style.opacity = item.opacity;
          item.el.style.pointerEvents = item.pointerEvents;
        });
        if (state.isCustomContainer && state.scrollTarget) {
          state.scrollTarget.scrollTop = state.initialScrollTop;
          state.scrollTarget.scrollLeft = state.initialScrollLeft;
        } else {
          window.scrollTo(state.initialScrollLeft, state.initialScrollTop);
        }
        delete window.__screenGlimpseState;
      }
    }
  });

  detectedPageHeight = coveredPhysicalHeight;
  updateCalculationBadge();

  return {
    segments,
    physicalWidth,
    physicalTotalHeight: coveredPhysicalHeight,
    viewportHeight,
    dpr: actualScale
  };
};

// Render an exact vertical slice [sy, sy + sh] from non-overlapping segments
const renderRegionCanvas = (captureData, sy, sh) => {
  const { segments, physicalWidth } = captureData;
  const canvas = document.createElement('canvas');
  canvas.width = physicalWidth;
  canvas.height = sh;
  const ctx = canvas.getContext('2d');

  if (currentFormat === 'jpeg') {
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
  }

  for (const seg of segments) {
    const segTop = seg.destY;
    const segBottom = seg.destY + seg.height;

    const intersectTop = Math.max(sy, segTop);
    const intersectBottom = Math.min(sy + sh, segBottom);

    if (intersectBottom > intersectTop) {
      const drawHeight = intersectBottom - intersectTop;
      const sourceY = seg.srcY + (intersectTop - segTop);
      const targetY = intersectTop - sy;

      ctx.drawImage(
        seg.img,
        0, sourceY, physicalWidth, drawHeight,
        0, targetY, physicalWidth, drawHeight
      );
    }
  }
  return canvas;
};

// Build a single full-page canvas safe for image export
const buildSafeFullCanvas = (captureData) => {
  const { segments, physicalWidth, physicalTotalHeight } = captureData;
  const scale = physicalTotalHeight > MAX_SAFE_CANVAS_HEIGHT
    ? MAX_SAFE_CANVAS_HEIGHT / physicalTotalHeight
    : 1;

  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.round(physicalWidth * scale));
  canvas.height = Math.max(1, Math.round(physicalTotalHeight * scale));
  const ctx = canvas.getContext('2d');

  if (currentFormat === 'jpeg') {
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
  }

  if (scale !== 1) {
    ctx.scale(scale, scale);
  }

  for (const seg of segments) {
    ctx.drawImage(
      seg.img,
      0, seg.srcY, physicalWidth, seg.height,
      0, seg.destY, physicalWidth, seg.height
    );
  }

  return canvas;
};

// Main Capture & Download Action (Full Page or ZIP Slices)
captureBtn.addEventListener('click', async () => {
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });

    if (!tab || !tab.url || tab.url.startsWith('chrome://') || tab.url.startsWith('edge://')) {
      statusText.textContent = 'Cannot capture browser system pages';
      return;
    }

    captureBtn.disabled = true;
    statusText.textContent = 'Preparing page...';

    const captureData = await capturePageFrames(tab);
    const { physicalTotalHeight, viewportHeight, dpr } = captureData;

    const ext = currentFormat === 'jpeg' ? 'jpg' : currentFormat;
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);

    if (currentMode === 'full') {
      statusText.textContent = 'Saving full page image...';
      const fullCanvas = buildSafeFullCanvas(captureData);
      const fullBlob = await canvasToBlob(fullCanvas, currentFormat);
      await downloadBlob(fullBlob, `ScreenGlimpse_Full_${timestamp}.${ext}`);
    } else {
      const requestedSliceHeight =
        parseInt(sliceHeightInput.value, 10) || Math.round(viewportHeight * dpr);
      const numSlices = Math.max(1, Math.ceil(physicalTotalHeight / requestedSliceHeight));
      const zipFiles = [];

      for (let i = 0; i < numSlices; i++) {
        statusText.textContent = `Slicing part ${i + 1} of ${numSlices}...`;

        const sy = i * requestedSliceHeight;
        const currentSliceHeight = Math.min(requestedSliceHeight, physicalTotalHeight - sy);
        const sliceCanvas = renderRegionCanvas(captureData, sy, currentSliceHeight);

        const sliceBlob = await canvasToBlob(sliceCanvas, currentFormat);
        const arrayBuffer = await sliceBlob.arrayBuffer();
        const partNumber = String(i + 1).padStart(2, '0');

        zipFiles.push({
          name: `ScreenGlimpse_Part_${partNumber}.${ext}`,
          data: new Uint8Array(arrayBuffer)
        });
      }

      statusText.textContent = 'Packing slices into ZIP...';
      const zipBlob = createZipBlob(zipFiles);
      await downloadBlob(zipBlob, `ScreenGlimpse_Slices_${timestamp}.zip`);
    }

    statusText.textContent = 'Capture complete!';
    setTimeout(() => {
      statusText.textContent = 'Ready to capture';
    }, 3000);
  } catch (error) {
    console.error('Capture error:', error);
    statusText.textContent = `Error: ${error.message || 'Capture failed'}`;
  } finally {
    captureBtn.disabled = false;
  }
});
