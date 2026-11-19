// Puerto Fuego — procedural canvas textures.
//
// Every surface in the city is painted once at boot into a small 2D canvas and cached by key, so
// the renderer uploads a handful of tiny images instead of shipping art files. Repeat wrapping
// lets one 256 px tile pave a whole block; sRGB colour space is set because a canvas holds
// display-referred colour while MeshStandardMaterial works in linear space.
//
// Determinism matters: each painter runs from its own seeded generator, so the same build always
// produces the same streets — and two buildings that ask for different facade variants genuinely
// get different windows.

import * as THREE from 'three';

/** Every texture built this session, keyed by name: repeat callers share one GPU upload. */
const textureCache = new Map();

/**
 * Mulberry32 — a tiny seeded PRNG. Fast, stable across engines, and good enough for speckle and
 * cracks where the exact sequence only has to look random, not be random.
 */
function seededRandom(seed) {
  let a = seed >>> 0;
  return function next() {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** 0xRRGGBB number -> '#rrggbb' css string. */
function hexCss(hex) {
  const n = hex >>> 0;
  const r = (n >> 16) & 0xff;
  const g = (n >> 8) & 0xff;
  const b = n & 0xff;
  return `rgb(${r},${g},${b})`;
}

/** Same as hexCss but with an alpha channel: 'rgba(r,g,b,a)'. */
function hexCssAlpha(hex, alpha) {
  const n = hex >>> 0;
  const r = (n >> 16) & 0xff;
  const g = (n >> 8) & 0xff;
  const b = n & 0xff;
  return `rgba(${r},${g},${b},${alpha})`;
}

/**
 * Paint into an offscreen canvas and wrap it as a repeating sRGB texture. The painter receives
 * (ctx, width, height). Results are cached by key, so asking twice returns the same texture.
 *
 * Returns a THREE.CanvasTexture with colorSpace SRGBColorSpace, RepeatWrapping on both axes,
 * mipmaps on and anisotropy 4.
 */
export function makeCanvasTexture(key, width, height, draw) {
  const hit = textureCache.get(key);
  if (hit) return hit;

  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d');
  draw(ctx, width, height);

  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.wrapS = THREE.RepeatWrapping;
  texture.wrapT = THREE.RepeatWrapping;
  texture.generateMipmaps = true;
  texture.anisotropy = 4;
  textureCache.set(key, texture);
  return texture;
}

/** Scatter `count` tiny 1-3 px specks across the tile — the grain every surface here starts from. */
function grain(ctx, w, h, rand, count, lightHex, darkHex, alpha) {
  for (let i = 0; i < count; i++) {
    const x = rand() * w;
    const y = rand() * h;
    ctx.fillStyle = rand() < 0.5 ? lightHex : darkHex;
    ctx.globalAlpha = alpha * (0.35 + rand() * 0.65);
    ctx.fillRect(x, y, 1 + rand() * 2, 1 + rand() * 2);
  }
  ctx.globalAlpha = 1;
}

/** Soft radial blobs of one colour fading to transparent — large-scale tonal drift, no hard edge. */
function mottle(ctx, w, h, rand, count, colourHex, minR, maxR, alpha) {
  for (let i = 0; i < count; i++) {
    const x = rand() * w;
    const y = rand() * h;
    const r = minR + rand() * (maxR - minR);
    const grad = ctx.createRadialGradient(x, y, 0, x, y, r);
    grad.addColorStop(0, hexCssAlpha(colourHex, alpha));
    grad.addColorStop(1, hexCssAlpha(colourHex, 0));
    ctx.fillStyle = grad;
    ctx.fillRect(x - r, y - r, r * 2, r * 2);
  }
}

/** Mid-grey asphalt: stone aggregate, polished tyre tracks, dark tar repairs and wandering cracks. */
export function asphaltTexture() {
  return makeCanvasTexture('asphalt', 256, 256, (ctx, w, h) => {
    const rand = seededRandom(0x41504c41);

    ctx.fillStyle = '#4a4a4d';
    ctx.fillRect(0, 0, w, h);

    // Stone chips: the aggregate is what gives asphalt its tooth at 4 m per tile.
    grain(ctx, w, h, rand, 5200, '#6b6b6e', '#2e2e30', 0.55);

    // Worn tracks where tyres have polished the surface, lighter than the surrounding grit.
    mottle(ctx, w, h, rand, 7, 0x8a8a8c, 14, 46, 0.16);
    // Fresh tar patches: the dark repairs that never quite match the road around them.
    mottle(ctx, w, h, rand, 5, 0x1f1f21, 10, 34, 0.22);

    // Cracks: short polylines walked in a random heading, each with a couple of side spurs, so
    // the tile never shows the same single line repeating every 4 m.
    ctx.strokeStyle = 'rgba(24, 24, 26, 0.75)';
    ctx.lineWidth = 1;
    const crackCount = 3 + Math.floor(rand() * 3);
    for (let c = 0; c < crackCount; c++) {
      let x = rand() * w;
      let y = rand() * h;
      let angle = rand() * Math.PI * 2;
      ctx.beginPath();
      ctx.moveTo(x, y);
      const steps = 8 + Math.floor(rand() * 14);
      for (let s = 0; s < steps; s++) {
        angle += (rand() - 0.5) * 0.9;
        x += Math.cos(angle) * (3 + rand() * 5);
        y += Math.sin(angle) * (3 + rand() * 5);
        ctx.lineTo(x, y);
        if (rand() < 0.12) {
          // Spur branches make the crack look like it spread rather than was drawn.
          const spur = angle + (rand() - 0.5) * 2.2;
          ctx.moveTo(x, y);
          ctx.lineTo(x + Math.cos(spur) * (4 + rand() * 8), y + Math.sin(spur) * (4 + rand() * 8));
          ctx.moveTo(x, y);
        }
      }
      ctx.stroke();
    }
  });
}

/** Pale concrete slabs, 64 px to a slab, with a joint groove (dark line + light lip) per edge. */
export function sidewalkTexture() {
  return makeCanvasTexture('sidewalk', 256, 256, (ctx, w, h) => {
    const rand = seededRandom(0x51de001);
    const slab = 64;

    ctx.fillStyle = '#a8a094';
    ctx.fillRect(0, 0, w, h);

    // Per-slab tint: each cell lightened or darkened slightly, so the pavement reads as individual
    // poured slabs rather than one sheet. Cells tile exactly, so the repeat stays seamless.
    for (let gy = 0; gy < h; gy += slab) {
      for (let gx = 0; gx < w; gx += slab) {
        const shade = (rand() - 0.5) * 0.08;
        ctx.fillStyle =
          shade > 0 ? hexCssAlpha(0xffffff, shade) : hexCssAlpha(0x000000, -shade);
        ctx.fillRect(gx, gy, slab, slab);
      }
    }

    grain(ctx, w, h, rand, 2600, '#d0c9bc', '#6f6860', 0.35);

    // Joint grooves: a dark line with a light lip below it reads as a shallow chamfer once lit.
    for (let p = 0; p < w; p += slab) {
      ctx.fillStyle = 'rgba(70, 64, 58, 0.55)';
      ctx.fillRect(p, 0, 2, h);
      ctx.fillRect(0, p, w, 2);
      ctx.fillStyle = 'rgba(226, 220, 208, 0.35)';
      ctx.fillRect(p + 2, 0, 1, h);
      ctx.fillRect(0, p + 2, w, 1);
    }
  });
}

/**
 * Building facade: a 4 x 4 grid of window panes on a pale render wall, some lit warm, the rest
 * dark glass with a reflection streak. `key` lets each building cache its own pattern;
 * `variant` seeds the window layout and drifts the wall colour between warm plaster and cool
 * concrete so a row of buildings stays varied.
 *
 * Returns a THREE.CanvasTexture (256 x 256, sRGB, repeat-wrapped).
 */
export function facadeTexture(key = 'facade0', variant = 0) {
  return makeCanvasTexture(key, 256, 256, (ctx, w, h) => {
    const rand = seededRandom(0xf4c4de + variant * 7919);

    // Wall colour drifts with the variant: warm plaster, pale render, cool concrete, repeating.
    const wall = variant % 3 === 0 ? 0xd8d0c2 : variant % 3 === 1 ? 0xc9bfae : 0xbdb4a6;
    ctx.fillStyle = hexCss(wall);
    ctx.fillRect(0, 0, w, h);
    grain(ctx, w, h, rand, 1400, '#ffffff', '#4a443c', 0.25);

    const cols = 4;
    const rows = 4;
    const cellW = w / cols;
    const cellH = h / rows;
    const paneW = cellW * 0.52;
    const paneH = cellH * 0.5;

    for (let r = 0; r < rows; r++) {
      // Floor slab band across the bottom of each row, slightly darker than the wall.
      ctx.fillStyle = 'rgba(60, 54, 46, 0.18)';
      ctx.fillRect(0, r * cellH + cellH - 5, w, 5);

      for (let c = 0; c < cols; c++) {
        const x = c * cellW + (cellW - paneW) * 0.5;
        const y = r * cellH + (cellH - paneH) * 0.36;

        // Recess shadow behind the glass, then the pane itself.
        ctx.fillStyle = 'rgba(30, 26, 22, 0.55)';
        ctx.fillRect(x - 2, y - 2, paneW + 4, paneH + 4);

        const lit = rand() < 0.34;
        if (lit) {
          const warm = 0xd9c48a + Math.floor(rand() * 24) * 0x010101;
          ctx.fillStyle = hexCss(warm);
        } else {
          ctx.fillStyle = hexCss(0x1d242b + Math.floor(rand() * 10) * 0x010101);
        }
        ctx.fillRect(x, y, paneW, paneH);

        if (!lit) {
          // Diagonal reflection streak sells the glass even when the room behind it is dark.
          ctx.fillStyle = 'rgba(150, 180, 200, 0.18)';
          ctx.beginPath();
          ctx.moveTo(x, y + paneH);
          ctx.lineTo(x + paneW * 0.45, y);
          ctx.lineTo(x + paneW * 0.7, y);
          ctx.lineTo(x + paneW * 0.25, y + paneH);
          ctx.closePath();
          ctx.fill();
        } else {
          // Blinds: lit windows are rarely uniform, a couple of horizontal slats break them up.
          ctx.fillStyle = 'rgba(120, 100, 60, 0.35)';
          for (let s = 0; s < 3; s++) {
            const sy = y + paneH * (0.2 + s * 0.28);
            ctx.fillRect(x, sy, paneW, 1 + rand() * 2);
          }
        }

        // Mullion splitting the pane in two.
        ctx.fillStyle = 'rgba(70, 64, 56, 0.6)';
        ctx.fillRect(x + paneW * 0.5 - 1, y, 2, paneH);
      }
    }
  });
}

/** Warm beach sand: tonal drift between dry pale crests and damp hollows, plus wind ripples. */
export function sandTexture() {
  return makeCanvasTexture('sand', 256, 256, (ctx, w, h) => {
    const rand = seededRandom(0x5a4d01);

    ctx.fillStyle = '#e2cda0';
    ctx.fillRect(0, 0, w, h);

    // Broad tonal variation: dry pale crests and slightly damp hollows.
    mottle(ctx, w, h, rand, 10, 0xf2e2c0, 16, 50, 0.25);
    mottle(ctx, w, h, rand, 8, 0xb99f74, 12, 40, 0.18);

    // Ripples: sine waves offset by a slow second sine so the crest spacing breathes instead of
    // looking like a barcode. Wavelength lands around 18 px, ankle ripples at beach scale.
    const rippleCount = 14;
    for (let i = 0; i < rippleCount; i++) {
      const baseY = (i / rippleCount) * h;
      const phase = rand() * Math.PI * 2;
      ctx.beginPath();
      for (let x = 0; x <= w; x += 4) {
        const y =
          baseY + Math.sin(x * 0.06 + phase) * 3 + Math.sin(x * 0.17 + phase * 2) * 1.5;
        if (x === 0) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
      }
      ctx.strokeStyle = 'rgba(160, 136, 98, 0.30)';
      ctx.lineWidth = 1.5;
      ctx.stroke();
    }

    grain(ctx, w, h, rand, 3400, '#fff3dd', '#8a7350', 0.3);
  });
}

/** Flat poured concrete: light, speckled, almost featureless — for kerbs, plinths and steps. */
export function concreteTexture() {
  return makeCanvasTexture('concrete', 256, 256, (ctx, w, h) => {
    const rand = seededRandom(0xc0c0c0);

    ctx.fillStyle = '#b9b2a4';
    ctx.fillRect(0, 0, w, h);
    mottle(ctx, w, h, rand, 6, 0xffffff, 18, 60, 0.1);
    mottle(ctx, w, h, rand, 6, 0x6a6358, 12, 44, 0.1);
    grain(ctx, w, h, rand, 3000, '#f2ece0', '#7d756a', 0.35);
  });
}

/**
 * Boardwalk: long planks running down the tile's long axis, one board per 32 px column, each with
 * its own tone shift, wandering grain strokes, dark gaps with a lit lip, and staggered butt
 * joints so the seams never line up into a visible grid.
 */
export function boardwalkTexture() {
  return makeCanvasTexture('boardwalk', 128, 256, (ctx, w, h) => {
    const rand = seededRandom(0xb04d01);
    const plankW = 32;

    for (let x = 0; x < w; x += plankW) {
      // Tone nudges all three channels by the same amount: a board shifts in value, not hue.
      const shift = Math.round((rand() - 0.5) * 46);
      const tone = ((0x8a + shift) << 16) | ((0x6a + shift) << 8) | (0x48 + shift);
      ctx.fillStyle = hexCss(tone);
      ctx.fillRect(x, 0, plankW, h);

      // Grain: thin darker strokes wandering down the board, a different wobble per board.
      const strokes = 5 + Math.floor(rand() * 4);
      for (let g = 0; g < strokes; g++) {
        const gx = x + 3 + rand() * (plankW - 6);
        const wobble = rand() * 3;
        const phase = rand() * Math.PI * 2;
        ctx.beginPath();
        for (let y = 0; y <= h; y += 6) {
          const off = Math.sin(y * 0.05 + phase) * wobble;
          if (y === 0) ctx.moveTo(gx + off, y);
          else ctx.lineTo(gx + off, y);
        }
        ctx.strokeStyle = 'rgba(58, 38, 22, 0.28)';
        ctx.lineWidth = 0.8 + rand();
        ctx.stroke();
      }

      // Gap between boards, dark, with a lit lip on one side.
      ctx.fillStyle = 'rgba(30, 20, 12, 0.8)';
      ctx.fillRect(x, 0, 2, h);
      ctx.fillStyle = 'rgba(220, 190, 150, 0.2)';
      ctx.fillRect(x + 2, 0, 1, h);

      // Staggered butt joints: the seam between two lengths of board is offset per column.
      for (let j = 0; j < 2; j++) {
        const jy = ((j + rand()) / 2) * h;
        ctx.fillStyle = 'rgba(30, 20, 12, 0.7)';
        ctx.fillRect(x, jy, plankW, 2);
      }
    }
  });
}
