// Puerto Fuego — title, pause, controls and game-over screens.
//
// Drawn entirely with canvas 2D primitives, so the menu costs no extra
// assets and scales with the window exactly like the HUD does. The screens
// are a small dispatch table: one draw function per screen, all reading the
// same shared layout numbers, so a resize only changes numbers and never
// rebuilds structure.
//
// Navigation is offered two ways. The game loop can drive it through
// handleKey() / move() / confirm(), and the menu also listens for pointer
// input on its own canvas and hit-tests the item rows itself. Either way,
// every confirmed choice flows through one place — select() — which calls
// the onSelect callback the bootstrapper passes in.

import { createRandom, clamp } from './mathutil.js';

export const TITLE_ITEMS = [
  { id: 'start', label: 'Start' },
  { id: 'continue', label: 'Continue' },
  { id: 'controls', label: 'Controls' },
  { id: 'quit', label: 'Quit' },
];

export const PAUSE_ITEMS = [
  { id: 'resume', label: 'Resume' },
  { id: 'restart', label: 'Restart' },
  { id: 'controls', label: 'Controls' },
  { id: 'quit', label: 'Quit' },
];

// One readable binding per line: key first, action second, separated by a
// dash so the whole column scans as a list rather than a paragraph.
export const CONTROL_LINES = [
  'W A S D   -  Walk / Drive',
  'Mouse     -  Look / Steer',
  'Shift     -  Sprint',
  'Space     -  Jump / Handbrake',
  'F         -  Enter / Exit vehicle',
  'Left Click -  Fire weapon',
  'R         -  Reload',
  '1 2 3 4   -  Select weapon slot',
  'Q / E     -  Cycle weapon',
  'V         -  Cycle camera',
  'H         -  Horn',
  'M         -  Toggle map',
  'Esc       -  Pause',
];

const PAL = {
  ink: '#f6f4ee',
  dim: 'rgba(246, 244, 238, 0.62)',
  faint: 'rgba(246, 244, 238, 0.42)',
  gold: '#ffc247',
  goldDeep: '#ff8a1e',
  glass: 'rgba(10, 12, 18, 0.76)',
  glassStrong: 'rgba(12, 15, 20, 0.92)',
  edge: 'rgba(255, 255, 255, 0.16)',
  skyTop: '#20344f',
  skyMid: '#7d5f70',
  skyLow: '#f0a15f',
  sun: '#ffe0a6',
  cash: '#63e06f',
  red: '#c8302a',
};

const UI_FONT = '"Helvetica Neue", Arial, sans-serif';
const DISPLAY_FONT = '"Arial Black", Impact, sans-serif';
const DIGIT_FONT = '"Courier New", monospace';

// A wordmark with a warm vertical gradient and a dark offset shadow, so it
// stays legible over the bright lower half of the sky.
function wordmark(c, text, x, y, font, top, bottom, shadow) {
  c.save();
  c.font = font;
  c.textBaseline = 'middle';
  if (shadow) {
    c.fillStyle = 'rgba(0, 0, 0, 0.55)';
    c.fillText(text, x + 4, y + 5);
  }
  const w = c.measureText(text).width;
  const grad = c.createLinearGradient(0, y - 30, 0, y + 30);
  grad.addColorStop(0, top);
  grad.addColorStop(1, bottom);
  c.fillStyle = grad;
  c.fillText(text, x, y);
  // Thin dark outline underneath keeps the gradient from dissolving into the
  // sky gradient behind it at low contrast.
  c.lineWidth = 2;
  c.strokeStyle = 'rgba(24, 12, 4, 0.55)';
  c.strokeText(text, x, y);
  c.restore();
  return w;
}

export function createMenu(canvas, options) {
  const ctx = canvas.getContext('2d');
  const opts = options || {};
  const onSelect = typeof opts.onSelect === 'function' ? opts.onSelect : null;

  let width = 0;
  let height = 0;
  let scale = 1;
  let dpr = 1;

  const state = {
    screen: 'title',
    index: 0,
    // Filled by gameplay while playing; the pause board and the game-over
    // card read only from here, so the menu never reaches into simulation
    // objects.
    info: {
      mission: '',
      step: '',
      cash: 0,
      stars: 0,
      cause: '',
      earned: 0,
      heading: 'WASTED',
    },
    // Where a Controls screen returns to, since it can be opened from both
    // the title and the pause board.
    returnTo: 'title',
    // False while the game is running with no menu up; draw() becomes a
    // no-op so a hidden menu costs nothing.
    visible: true,
  };

  // Hit-test rectangles for the item rows, recorded during draw. Pointer
  // handlers read them; the game loop never has to know where rows sit.
  let rowRects = [];

  // The skyline is generated once per resize into plain arrays. Regenerating
  // it every frame from a seeded rng would give the same picture, but
  // storing the buildings keeps the draw loop to plain rectangle fills and
  // makes the art identical on every frame by construction.
  let skylineFar = [];
  let skylineNear = [];

  function buildSkyline() {
    const makeBand = (baseY, maxH, widthFactor, seed) => {
      const rng = createRandom(seed);
      const out = [];
      const bw = Math.max(18, width * widthFactor);
      for (let x = -bw; x < width + bw; x += bw) {
        const bh = maxH * (0.35 + rng() * 0.65);
        const bwActual = bw * (0.86 + rng() * 0.28);
        // A few lit windows per tower, decided at build time.
        const windows = [];
        const step = Math.max(6, 9 * scale);
        for (let wy = baseY - bh + step; wy < baseY - step; wy += step) {
          for (let wx = x + step; wx < x + bwActual - step; wx += step) {
            if (rng() > 0.72) windows.push([wx, wy, step * 0.35, step * 0.45]);
          }
        }
        out.push({ x, y: baseY - bh, w: bwActual, h: bh + height - baseY, windows });
      }
      return out;
    };
    skylineFar = makeBand(height * 0.60, height * 0.10, 0.020, 42);
    skylineNear = makeBand(height * 0.66, height * 0.16, 0.030, 30);
  }

  function resize() {
    width = Math.max(1, canvas.clientWidth || canvas.width || 1280);
    height = Math.max(1, canvas.clientHeight || canvas.height || 720);
    const ratio = canvas.width ? canvas.width / width : 1;
    dpr = clamp(ratio, 0.5, 3);
    scale = clamp(height / 900, 0.62, 1.4);
    buildSkyline();
  }

  resize();

  // --- shared drawing ------------------------------------------------------

  function roundedPanel(x, y, w, h, radius, fill, stroke) {
    const r = Math.min(radius, w / 2, h / 2);
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.lineTo(x + w - r, y);
    ctx.arcTo(x + w, y, x + w, y + r, r);
    ctx.lineTo(x + w, y + h - r);
    ctx.arcTo(x + w, y + h, x + w - r, y + h, r);
    ctx.lineTo(x + r, y + h);
    ctx.arcTo(x, y + h, x, y + h - r, r);
    ctx.lineTo(x, y + r);
    ctx.arcTo(x, y, x + r, y, r);
    ctx.closePath();
    ctx.fillStyle = fill;
    ctx.fill();
    ctx.lineWidth = 1 / dpr;
    ctx.strokeStyle = stroke;
    ctx.stroke();
  }

  function starPath(cx, cy, r) {
    ctx.beginPath();
    for (let i = 0; i < 10; i++) {
      const rad = i % 2 === 0 ? r : r * 0.46;
      const a = (Math.PI / 5) * i - Math.PI / 2;
      const px = cx + Math.cos(a) * rad;
      const py = cy + Math.sin(a) * rad;
      if (i === 0) ctx.moveTo(px, py);
      else ctx.lineTo(px, py);
    }
    ctx.closePath();
  }

  function cashStr(value) {
    const v = Math.round(Number(value) || 0);
    return v < 0 ? '-$' + Math.abs(v) : '$' + v;
  }

  // Truncate by measured width, never by character count.
  function fit(text, maxW) {
    const str = String(text == null ? '' : text);
    if (ctx.measureText(str).width <= maxW) return str;
    let lo = 0;
    let hi = str.length;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (ctx.measureText(str.slice(0, mid) + '...').width <= maxW) lo = mid;
      else hi = mid - 1;
    }
    return lo > 0 ? str.slice(0, lo) + '...' : '...';
  }

  // CONTROL_LINES is authored as "KEY - Action"; split on the first dash so
  // a key label containing a dash cannot confuse the layout.
  function splitBinding(line) {
    const i = String(line).indexOf('-');
    if (i < 0) return [String(line), ''];
    return [String(line).slice(0, i).trimEnd(), String(line).slice(i + 1).trim()];
  }

  function currentItems() {
    return state.screen === 'pause' ? PAUSE_ITEMS : TITLE_ITEMS;
  }

  // --- title art -----------------------------------------------------------

  function drawBackdrop(t) {
    ctx.save();
    ctx.beginPath();
    ctx.rect(0, 0, width, height);
    ctx.clip();

    // Sky, sampled from the game's golden-hour palette so the menu and the
    // first frame of play look like the same evening.
    const sky = ctx.createLinearGradient(0, 0, 0, height);
    sky.addColorStop(0, PAL.skyTop);
    sky.addColorStop(0.55, PAL.skyMid);
    sky.addColorStop(1, PAL.skyLow);
    ctx.fillStyle = sky;
    ctx.fillRect(0, 0, width, height);

    const sunX = width * 0.72;
    const sunY = height * 0.52;
    const sunR = Math.min(width, height) * 0.13;
    // A wide radial halo behind the disc: the warm bloom is what makes the
    // flat sky read as low sun rather than a gradient wallpaper.
    const halo = ctx.createRadialGradient(sunX, sunY, sunR * 0.4, sunX, sunY, sunR * 3.4);
    halo.addColorStop(0, 'rgba(255, 214, 150, 0.55)');
    halo.addColorStop(1, 'rgba(255, 170, 90, 0)');
    ctx.fillStyle = halo;
    ctx.fillRect(0, 0, width, height);

    ctx.beginPath();
    ctx.arc(sunX, sunY, sunR, 0, Math.PI * 2);
    const disc = ctx.createLinearGradient(sunX, sunY - sunR, sunX, sunY + sunR);
    disc.addColorStop(0, '#fff3cf');
    disc.addColorStop(1, PAL.sun);
    ctx.fillStyle = disc;
    ctx.fill();

    // Slow horizontal drift of the far band gives the still frame a little
    // life without ever reading as a cutscene.
    const drift = Math.sin(t * 0.06) * width * 0.012;
    drawBand(skylineFar, 'rgba(46, 54, 76, 0.85)', drift);
    drawBand(skylineNear, 'rgba(20, 24, 34, 0.96)', -drift * 0.6);

    // Ground haze over the skyline base so the buildings sit in the scene
    // instead of being pasted on top of it.
    const haze = ctx.createLinearGradient(0, height * 0.64, 0, height);
    haze.addColorStop(0, 'rgba(255, 150, 90, 0.10)');
    haze.addColorStop(1, 'rgba(8, 10, 16, 0.55)');
    ctx.fillStyle = haze;
    ctx.fillRect(0, height * 0.64, width, height * 0.36);
    ctx.restore();
  }

  function drawBand(buildings, colour, offset) {
    ctx.fillStyle = colour;
    for (const b of buildings) {
      ctx.fillRect(b.x + offset, b.y, b.w, b.h);
    }
    // Lit windows, drawn in a second pass so the tower colour is restored
    // before the next building.
    ctx.fillStyle = 'rgba(255, 206, 130, 0.25)';
    for (const b of buildings) {
      for (const win of b.windows) {
        ctx.fillRect(win[0] + offset, win[1], win[2], win[3]);
      }
    }
  }

  // --- item rows -----------------------------------------------------------
  // Selection is a chevron plus a warm underline, not a filled bar: colour
  // plus a shape, so it survives a colour-blind player and a washed-out
  // projector. Rows are recorded for pointer hit-testing.

  function drawRows(cx, startY, list) {
    const s = scale;
    const rowH = 42 * s;
    const gap = 6 * s;
    const rowW = Math.min(width * 0.42, 320 * s);
    const left = cx - rowW / 2;
    rowRects = [];

    ctx.save();
    for (let i = 0; i < list.length; i++) {
      const y = startY + i * (rowH + gap);
      const selected = i === state.index;
      rowRects.push({ x: left, y, w: rowW, h: rowH, index: i });

      if (selected) {
        // A translucent warm wash with a solid underline: the row is marked
        // without the whole list turning into a stack of buttons.
        const wash = ctx.createLinearGradient(left, 0, left + rowW, 0);
        wash.addColorStop(0, 'rgba(255, 194, 71, 0.28)');
        wash.addColorStop(0.5, 'rgba(255, 194, 71, 0.16)');
        wash.addColorStop(1, 'rgba(255, 194, 71, 0.28)');
        ctx.fillStyle = wash;
        ctx.fillRect(left, y, rowW, rowH);
        ctx.fillStyle = PAL.gold;
        ctx.fillRect(left, y + rowH - 2, rowW, 2);
      } else {
        roundedPanel(left, y, rowW, rowH, 2 * s, 'rgba(8, 10, 14, 0.42)', 'rgba(255, 255, 255, 0.10)');
      }

      ctx.textBaseline = 'middle';
      ctx.font = '700 ' + 19 * s + 'px ' + UI_FONT;
      ctx.textAlign = 'center';
      ctx.fillStyle = selected ? PAL.gold : PAL.ink;
      ctx.globalAlpha = selected ? 1 : 0.9;
      ctx.fillText(list[i].label, cx, y + rowH / 2);
      ctx.globalAlpha = 1;

      if (selected) {
        // Chevron rides the left edge of the row and points at the label.
        ctx.fillStyle = PAL.gold;
        const ax = left + 16 * s;
        const ay = y + rowH / 2;
        ctx.beginPath();
        ctx.moveTo(ax, ay - 7 * s);
        ctx.lineTo(ax + 9 * s, ay);
        ctx.lineTo(ax, ay + 7 * s);
        ctx.closePath();
        ctx.fill();
      }
    }
    ctx.restore();
  }

  // --- screens -------------------------------------------------------------

  function drawTitle() {
    const s = scale;
    const cx = width / 2;
    // The wordmark sits above the skyline so nothing competes with it.
    const titleY = height * 0.30;
    const baseSize = Math.min(width * 0.13, 132 * s);
    const fontFor = (size) => '900 italic ' + size + 'px ' + DISPLAY_FONT;

    // Measure before committing: the wordmark at the base size overflows a
    // phone-width window, and a centred overflow clips on both edges at once.
    ctx.save();
    ctx.font = fontFor(baseSize);
    const measured = ctx.measureText('PUERTO FUEGO').width;
    const room = width * 0.9;
    const titleSize = measured > room ? baseSize * (room / measured) : baseSize;
    ctx.restore();

    ctx.save();
    ctx.textAlign = 'center';
    // Wide, heavy, warm: the town name is the one thing that must read at a
    // glance from across a room.
    wordmark(ctx, 'PUERTO FUEGO', cx, titleY, fontFor(titleSize), '#fff6d8', '#ff8d2a', true);

    const subSize = Math.max(12, 16 * s);
    ctx.font = '700 ' + subSize + 'px ' + UI_FONT;
    if ('letterSpacing' in ctx) ctx.letterSpacing = (3 * s) + 'px';
    ctx.fillStyle = PAL.dim;
    ctx.fillText(fit('DANI REYES  ·  A SUN-SOAKED WATERFRONT CITY', width * 0.9), cx, titleY + titleSize * 0.62);
    if ('letterSpacing' in ctx) ctx.letterSpacing = '0px';
    ctx.restore();

    drawRows(cx, height * 0.52, TITLE_ITEMS);

    ctx.save();
    ctx.textAlign = 'center';
    ctx.font = '700 ' + 11 * s + 'px ' + UI_FONT;
    ctx.fillStyle = 'rgba(255, 255, 255, 0.45)';
    ctx.fillText('W / S TO CHOOSE    ENTER TO CONFIRM', width / 2, height - 26 * s);
    ctx.restore();
  }

  function drawPause() {
    const s = scale;
    // Dim the world behind the board: the pause screen is an overlay on live
    // gameplay, not a separate scene.
    ctx.fillStyle = 'rgba(4, 6, 10, 0.62)';
    ctx.fillRect(0, 0, width, height);

    const boardW = Math.min(width * 0.78, 780 * s);
    const boardH = Math.min(height * 0.86, 520 * s);
    const bx = width / 2 - boardW / 2;
    const by = height / 2 - boardH / 2;

    roundedPanel(bx, by, boardW, boardH, 8 * s, PAL.glassStrong, 'rgba(255, 194, 71, 0.35)');
    // Job-board header band: the amber rule separates the mission briefing
    // from the menu, so the eye lands on the mission first.
    ctx.fillStyle = 'rgba(255, 194, 71, 0.14)';
    ctx.fillRect(bx, by, boardW, 52 * s);
    ctx.fillStyle = PAL.gold;
    ctx.fillRect(bx, by + 52 * s, boardW, 1.5);

    const pad = 26 * s;
    ctx.save();
    ctx.textAlign = 'left';
    ctx.textBaseline = 'middle';
    ctx.font = '700 ' + 12 * s + 'px ' + UI_FONT;
    if ('letterSpacing' in ctx) ctx.letterSpacing = (2 * s) + 'px';
    ctx.fillStyle = PAL.gold;
    ctx.fillText('JOB BOARD', bx + pad, by + 26 * s);
    ctx.textAlign = 'right';
    ctx.fillStyle = PAL.dim;
    ctx.fillText('PAUSED', bx + boardW - pad, by + 26 * s);
    if ('letterSpacing' in ctx) ctx.letterSpacing = '0px';

    // Active mission: title, step, then the compact numbers a player checks
    // before deciding whether to resume.
    const info = state.info || {};
    const missionTop = by + 82 * s;
    ctx.textAlign = 'left';
    ctx.font = '700 ' + 9.5 * s + 'px ' + UI_FONT;
    ctx.fillStyle = PAL.dim;
    ctx.fillText('ACTIVE MISSION', bx + pad, missionTop);
    ctx.font = '700 ' + 17 * s + 'px ' + UI_FONT;
    ctx.fillStyle = PAL.ink;
    ctx.fillText(fit(info.mission || 'Free roam', boardW * 0.55), bx + pad, missionTop + 24 * s);
    if (info.step) {
      ctx.font = '700 ' + 11 * s + 'px ' + UI_FONT;
      ctx.fillStyle = 'rgba(255, 194, 71, 0.85)';
      ctx.fillText(fit(info.step, boardW * 0.55), bx + pad, missionTop + 44 * s);
    }

    // Cash and stars, right side of the header block: money in green, wanted
    // level as filled and hollow stars.
    const statX = bx + boardW - pad;
    ctx.textAlign = 'right';
    ctx.font = '700 ' + 9.5 * s + 'px ' + UI_FONT;
    ctx.fillStyle = PAL.dim;
    ctx.fillText('CASH', statX, missionTop);
    ctx.font = '700 ' + 20 * s + 'px ' + DIGIT_FONT;
    ctx.fillStyle = PAL.cash;
    ctx.fillText(cashStr(info.cash), statX, missionTop + 24 * s);

    const stars = clamp(Math.round(Number(info.stars) || 0), 0, 5);
    const starR = 8 * s;
    const starGap = 20 * s;
    for (let i = 0; i < 5; i++) {
      const sx = statX - (4 - i) * starGap - starR;
      const sy = missionTop + 50 * s;
      starPath(sx, sy, starR);
      if (i < stars) {
        ctx.fillStyle = PAL.gold;
        ctx.fill();
      } else {
        ctx.strokeStyle = 'rgba(255, 255, 255, 0.3)';
        ctx.lineWidth = 1.2 / dpr + 0.4;
        ctx.stroke();
      }
    }

    ctx.strokeStyle = 'rgba(255, 255, 255, 0.12)';
    ctx.lineWidth = 1 / dpr;
    ctx.beginPath();
    ctx.moveTo(bx + pad, by + 152 * s);
    ctx.lineTo(bx + boardW - pad, by + 152 * s);
    ctx.stroke();
    ctx.restore();

    drawRows(width / 2, by + 178 * s, PAUSE_ITEMS);

    ctx.save();
    ctx.textAlign = 'center';
    ctx.font = '700 ' + 10.5 * s + 'px ' + UI_FONT;
    ctx.fillStyle = 'rgba(255, 255, 255, 0.42)';
    ctx.fillText('ESC TO RESUME', width / 2, by + boardH - 20 * s);
    ctx.restore();
  }

  function drawControls() {
    const s = scale;
    ctx.fillStyle = 'rgba(4, 6, 10, 0.94)';
    ctx.fillRect(0, 0, width, height);

    const boardW = Math.min(width * 0.88, 860 * s);
    const pad = 28 * s;

    // Rows and columns are decided before the board is sized: the panel is
    // then built to fit its contents exactly, instead of being a fixed tall
    // box with a dead lower half under a short list.
    const rows = CONTROL_LINES.length;
    const columns = boardW > 520 * s ? 2 : 1;
    const perColumn = Math.ceil(rows / columns);
    const maxBoardH = height * 0.9;
    const lineH = Math.min(30 * s, (maxBoardH - 150 * s) / perColumn);
    // Height from the first row's baseline to the last, plus header and
    // footer padding: sizing off perColumn * lineH instead would leave a
    // whole empty row of dead space under the list.
    const boardH = Math.min(maxBoardH, 96 * s + (perColumn - 1) * lineH + 48 * s);

    const bx = width / 2 - boardW / 2;
    const by = height / 2 - boardH / 2;
    roundedPanel(bx, by, boardW, boardH, 8 * s, 'rgba(12, 15, 20, 0.94)', 'rgba(255, 255, 255, 0.14)');

    ctx.save();
    ctx.textAlign = 'left';
    ctx.textBaseline = 'middle';
    ctx.font = '900 italic ' + Math.min(38 * s, width * 0.05) + 'px ' + DISPLAY_FONT;
    wordmark(ctx, 'CONTROLS', bx + pad, by + 40 * s, ctx.font, '#fff6d8', '#ff8d2a', false);
    ctx.textAlign = 'right';
    ctx.font = '700 ' + 10.5 * s + 'px ' + UI_FONT;
    ctx.fillStyle = PAL.dim;
    ctx.fillText('ESC OR ENTER TO GO BACK', bx + boardW - pad, by + 40 * s);

    ctx.strokeStyle = 'rgba(255, 255, 255, 0.14)';
    ctx.lineWidth = 1 / dpr;
    ctx.beginPath();
    ctx.moveTo(bx + pad, by + 66 * s);
    ctx.lineTo(bx + boardW - pad, by + 66 * s);
    ctx.stroke();

    const colW = (boardW - pad * 2) / columns;

    ctx.font = '700 ' + 13.5 * s + 'px ' + DIGIT_FONT;
    for (let i = 0; i < rows; i++) {
      const col = Math.floor(i / perColumn);
      const row = i % perColumn;
      const x = bx + pad + col * colW;
      const y = by + 96 * s + row * lineH;
      const pair = splitBinding(CONTROL_LINES[i]);
      const actionX = x + Math.min(colW * 0.42, 150 * s);
      ctx.textAlign = 'left';
      ctx.fillStyle = PAL.gold;
      ctx.fillText(fit(pair[0], actionX - x - 8 * s), x, y);
      ctx.fillStyle = PAL.ink;
      ctx.font = '700 ' + 13.5 * s + 'px ' + UI_FONT;
      // Clipped to the column so a long action never runs into the next one.
      ctx.fillText(fit(pair[1], x + colW - actionX - 10 * s), actionX, y);
      ctx.font = '700 ' + 13.5 * s + 'px ' + DIGIT_FONT;
    }
    ctx.restore();
  }

  function drawGameOver() {
    const s = scale;
    ctx.fillStyle = 'rgba(6, 4, 6, 0.82)';
    ctx.fillRect(0, 0, width, height);

    const info = state.info || {};
    const cx = width / 2;
    const heading = String(info.heading || 'WASTED');
    const headingFont = (size) => '900 italic ' + size + 'px ' + DISPLAY_FONT;
    const baseSize = Math.min(width * 0.16, 150 * s);

    // Same shrink-to-fit as the title: "WASTED" is fine at phone width but a
    // longer heading would otherwise clip off both edges of a centred line.
    ctx.save();
    ctx.font = headingFont(baseSize);
    const measured = ctx.measureText(heading).width;
    const room = width * 0.9;
    const headingSize = measured > room ? baseSize * (room / measured) : baseSize;
    ctx.restore();

    ctx.save();
    ctx.textAlign = 'center';
    // Red-to-amber rather than the menu's gold: the same wordmark treatment,
    // a different emotional register.
    wordmark(ctx, heading, cx, height * 0.34, headingFont(headingSize), '#ffd9c2', '#c8302a', true);

    ctx.font = '700 ' + 18 * s + 'px ' + UI_FONT;
    ctx.fillStyle = 'rgba(255, 255, 255, 0.82)';
    ctx.fillText(fit(info.cause || 'The city won this round.', width * 0.8), cx, height * 0.48);

    // Cash earned is the one number the player will read, so it gets its own
    // line and its own colour.
    ctx.font = '700 ' + 11 * s + 'px ' + UI_FONT;
    ctx.fillStyle = PAL.dim;
    if ('letterSpacing' in ctx) ctx.letterSpacing = (2 * s) + 'px';
    ctx.fillText('CASH EARNED', cx, height * 0.56);
    if ('letterSpacing' in ctx) ctx.letterSpacing = '0px';
    ctx.font = '700 ' + 30 * s + 'px ' + DIGIT_FONT;
    ctx.fillStyle = PAL.cash;
    ctx.fillText(cashStr(info.earned), cx, height * 0.63);

    // Prompt pulses gently: a static line on a static screen reads as a
    // freeze.
    const pulse = 0.55 + 0.45 * (0.5 + 0.5 * Math.sin(performance.now() / 420));
    ctx.globalAlpha = pulse;
    ctx.font = '700 ' + 14 * s + 'px ' + UI_FONT;
    ctx.fillStyle = PAL.ink;
    ctx.fillText('PRESS ENTER TO CONTINUE', cx, height * 0.76);
    ctx.globalAlpha = 1;
    ctx.restore();
  }

  // --- selection -----------------------------------------------------------
  // Every confirmed choice — keyboard, pointer, or a direct confirm() call —
  // lands here, so the bootstrapper only ever has to listen in one place.

  function select(id) {
    if (onSelect) {
      try {
        onSelect(id, state.screen);
      } catch (err) {
        // A callback that throws must not take the menu down with it; the id
        // is still returned so the caller can act on it directly.
        if (typeof console !== 'undefined' && console.error) console.error(err);
      }
    }
    return id;
  }

  // --- public API ----------------------------------------------------------

  function draw(time) {
    if (!state.visible) return;
    if (!width || !height) resize();
    const t = Number.isFinite(time) ? time : performance.now() / 1000;

    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, width, height);

    if (state.screen === 'controls') {
      drawControls();
      return;
    }
    if (state.screen === 'pause') {
      drawPause();
      return;
    }
    if (state.screen === 'gameover') {
      drawGameOver();
      return;
    }
    // Title is the only screen that owns the animated art; the others sit on
    // a dimmed copy of the same palette via their own flat fills.
    drawBackdrop(t);
    drawTitle();
  }

  function setScreen(screen, info) {
    const next = String(screen || 'title');
    // Controls opened from pause must return to pause, so remember where the
    // player came from rather than assuming the title.
    if (next === 'controls' && state.screen !== 'controls') state.returnTo = state.screen;
    state.screen = next;
    state.index = 0;
    state.visible = next !== 'hidden';
    if (info && typeof info === 'object') Object.assign(state.info, info);
    resize();
    return state.screen;
  }

  // Show a screen (and make the menu visible). Same as setScreen, but named
  // for the bootstrapper's show/hide pair.
  function show(screen, info) {
    return setScreen(screen || 'title', info);
  }

  function hide() {
    state.visible = false;
    state.screen = 'hidden';
    return false;
  }

  function visible() {
    return state.visible;
  }

  function move(delta) {
    // Whole-step move, not just the sign: a wheel or a "jump to top" caller
    // can pass 2, and the modulo keeps that wrapped as well.
    const step = Math.trunc(Number(delta) || 0);
    if (step === 0) return state.index;
    // Controls and the game-over card have no list; moving on them would
    // leave a stale selection behind the overlay.
    if (state.screen === 'controls' || state.screen === 'gameover') return state.index;
    const list = currentItems();
    if (!list.length) return state.index;
    // Wraparound: pressing up on the first item lands on the last, which is
    // what makes a four-item menu feel like a ring instead of a dead end. The
    // double modulo keeps a large negative delta positive.
    state.index = (((state.index + step) % list.length) + list.length) % list.length;
    return state.index;
  }

  function confirm() {
    if (state.screen === 'controls') {
      state.screen = state.returnTo || 'title';
      state.index = 0;
      return select('back');
    }
    if (state.screen === 'gameover') return select('continue');
    const list = currentItems();
    const item = list[state.index];
    if (!item) return null;
    // Controls is a sub-screen in both menus, so it becomes the current
    // screen here and the caller only has to react to the real actions.
    if (item.id === 'controls') {
      state.returnTo = state.screen;
      state.screen = 'controls';
      state.index = 0;
      return select(item.id);
    }
    return select(item.id);
  }

  function controls(open) {
    // Toggle with no argument, or force a screen with a boolean, so both the
    // Esc key and an explicit menu click can use this.
    const shouldOpen = open === undefined ? state.screen !== 'controls' : !!open;
    if (shouldOpen && state.screen !== 'controls') {
      state.returnTo = state.screen;
      state.screen = 'controls';
      state.index = 0;
    } else if (!shouldOpen) {
      state.screen = state.returnTo || 'title';
      state.index = 0;
    }
    return state.screen === 'controls';
  }

  // One keyboard entry point for the bootstrapper: returns the selected id
  // when a key confirms a choice, 'back' when Esc backs out of a sub-screen,
  // and null when the key did nothing. The game loop owns the listener; this
  // only interprets keys.
  function handleKey(key) {
    const k = String(key || '').toLowerCase();
    if (k === 'arrowup' || k === 'w') {
      move(-1);
      return null;
    }
    if (k === 'arrowdown' || k === 's') {
      move(1);
      return null;
    }
    if (k === 'enter' || k === ' ') {
      return confirm();
    }
    if (k === 'escape') {
      if (state.screen === 'controls') return confirm();
      if (state.screen === 'pause') return select('resume');
      return null;
    }
    return null;
  }

  // Pointer entry point for the bootstrapper (or the canvas listeners below):
  // x/y are CSS pixels relative to the canvas. 'hover' moves the selection
  // onto the row under the cursor; 'click' selects it.
  function handlePointer(x, y, kind) {
    if (!state.visible) return null;
    if (state.screen === 'controls' || state.screen === 'gameover') return null;
    for (const r of rowRects) {
      if (x >= r.x && x <= r.x + r.w && y >= r.y && y <= r.y + r.h) {
        state.index = r.index;
        if (kind === 'click') return confirm();
        return null;
      }
    }
    return null;
  }

  // Pointer listeners on the menu canvas itself. They are harmless when the
  // canvas is pointer-events: none (no events ever arrive) and let a
  // bootstrapper that gives the menu its own canvas get mouse navigation for
  // free. Pass { mouse: false } to keep all pointer handling with the caller.
  if (opts.mouse !== false && canvas && typeof canvas.addEventListener === 'function') {
    canvas.addEventListener('mousemove', (event) => {
      const rect = canvas.getBoundingClientRect();
      handlePointer(event.clientX - rect.left, event.clientY - rect.top, 'hover');
    });
    canvas.addEventListener('click', (event) => {
      const rect = canvas.getBoundingClientRect();
      handlePointer(event.clientX - rect.left, event.clientY - rect.top, 'click');
    });
  }

  // Guarded: headless capture scripts have no window, and a menu that throws
  // on import would take the whole screenshot pipeline down with it.
  if (typeof window !== 'undefined' && typeof window.addEventListener === 'function') {
    window.addEventListener('resize', resize);
  }

  return { draw, state, show, hide, visible, setScreen, move, confirm, controls, handleKey, handlePointer };
}
