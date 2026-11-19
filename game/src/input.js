// Single owner of keyboard and mouse input.
//
// Everything else in the game asks for named actions, never raw key codes —
// so a key can be remapped (or a gamepad added later) without touching the
// player, the vehicle or the HUD. Each frame the game calls update() once,
// then reads the published `state` object.

/**
 * Action -> physical key codes. Each action takes an array because one
 * player reaches for WASD and another for the arrow keys; both mean the
 * same thing to the game.
 */
export const BINDINGS = {
  forward: ['KeyW', 'ArrowUp'],
  back: ['KeyS', 'ArrowDown'],
  left: ['KeyA', 'ArrowLeft'],
  right: ['KeyD', 'ArrowRight'],
  sprint: ['ShiftLeft'],
  jump: ['Space'],
  interact: ['KeyE'],
  reload: ['KeyR'],
  pause: ['Escape'],
  weapon1: ['Digit1'],
  weapon2: ['Digit2'],
  weapon3: ['Digit3'],
  weapon4: ['Digit4'],
  horn: ['KeyH'],
};

/** Radians of look per pixel of mouse travel (~0.137 deg/px). */
const LOOK_PER_PIXEL = 0.0024;

/** Mouse buttons the game cares about, as the browser numbers them. */
const MOUSE_FIRE = 0;
const MOUSE_AIM = 2;

/** Keys whose default browser behaviour (scrolling, focus jumps) would fight the game. */
const SWALLOWED_KEYS = new Set(['Space', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Tab']);

/** True when the event target is a text field — those keystrokes are not game input. */
function isTypingInto(target) {
  if (!target || !target.tagName) return false;
  const tag = target.tagName;
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || target.isContentEditable;
}

export function createInput(canvas, options = {}) {
  const onAction = typeof options.onAction === 'function' ? options.onAction : null;

  // Physical keys held right now, and keydowns that landed since the last update().
  const down = new Set();
  const newlyDown = new Set();
  // Actions edge-triggered on the current frame (published on state.actions).
  const triggered = new Set();
  // Key set as of the previous update(), for detecting presses that began
  // before this frame.
  let lastFrameDown = new Set();

  // Mouse travel is buffered here and published once per update(). Buffering
  // instead of adding straight into state means a frame that runs twice in a
  // millisecond cannot double-count, and a frame that never polls cannot drop
  // the look delta.
  let bufferedLookX = 0;
  let bufferedLookY = 0;

  let firing = false;
  let aiming = false;

  const state = {
    moveX: 0,
    moveZ: 0,
    sprint: false,
    jump: false,
    fire: false,
    aim: false,
    lookX: 0,
    lookZ: 0,
    locked: false,
    actions: triggered,
  };

  /* ------------------------------------------------------------ keyboard */

  function handleKeyDown(event) {
    if (isTypingInto(event.target)) return;
    if (SWALLOWED_KEYS.has(event.code)) event.preventDefault();
    // Auto-repeat is a held key, not a new press — letting it through would
    // fire pause or the horn dozens of times a second while held.
    if (event.repeat) return;
    // Some browsers re-emit a keydown when focus returns or a modifier is
    // involved; a key we already hold is not a second physical press.
    if (down.has(event.code)) return;
    down.add(event.code);
    newlyDown.add(event.code);
  }

  function handleKeyUp(event) {
    down.delete(event.code);
  }

  /** Losing focus must not leave keys stuck — a tab-switch would sprint forever. */
  function handleBlur() {
    down.clear();
    firing = false;
    aiming = false;
  }

  /* --------------------------------------------------------------- mouse */

  function handleMouseDown(event) {
    if (event.target !== canvas && !canvas.contains(event.target)) return;
    if (!state.locked) lockPointer();
    if (event.button === MOUSE_FIRE) firing = true;
    if (event.button === MOUSE_AIM) aiming = true;
  }

  function handleMouseUp(event) {
    if (event.button === MOUSE_FIRE) firing = false;
    if (event.button === MOUSE_AIM) aiming = false;
  }

  function handleMouseMove(event) {
    // Deltas only mean something while the pointer is captured on our canvas;
    // with the pointer free the cursor is over the HUD, not looking around.
    if (document.pointerLockElement !== canvas) return;
    bufferedLookX += (event.movementX || 0) * LOOK_PER_PIXEL;
    bufferedLookY += (event.movementY || 0) * LOOK_PER_PIXEL;
  }

  function handlePointerLockChange() {
    state.locked = document.pointerLockElement === canvas;
    if (!state.locked) {
      // Releasing the pointer is how the player opens a menu: drop held
      // fire/aim commands with it.
      firing = false;
      aiming = false;
    }
  }

  function handleContextMenu(event) {
    // Right mouse is aim, so the browser menu must never appear over the canvas.
    if (event.target === canvas || canvas.contains(event.target)) event.preventDefault();
  }

  window.addEventListener('keydown', handleKeyDown);
  window.addEventListener('keyup', handleKeyUp);
  window.addEventListener('blur', handleBlur);
  canvas.addEventListener('mousedown', handleMouseDown);
  window.addEventListener('mouseup', handleMouseUp);
  document.addEventListener('mousemove', handleMouseMove);
  document.addEventListener('pointerlockchange', handlePointerLockChange);
  canvas.addEventListener('contextmenu', handleContextMenu);

  /* ---------------------------------------------------------- pointer lock */

  function lockPointer() {
    if (document.pointerLockElement === canvas) return;
    const request = canvas.requestPointerLock && canvas.requestPointerLock();
    // Chrome returns a promise that rejects when the user has not gestured
    // recently; that is a normal refusal, not an error worth surfacing.
    if (request && typeof request.catch === 'function') request.catch(() => {});
  }

  function unlockPointer() {
    if (document.pointerLockElement === canvas) document.exitPointerLock();
  }

  /* --------------------------------------------------------------- queries */

  /** True while any key bound to `action` is physically held. */
  function isDown(action) {
    const codes = BINDINGS[action];
    if (!codes) return false;
    for (const code of codes) {
      if (down.has(code)) return true;
    }
    return false;
  }

  /** True when `action` was edge-triggered on the current frame. */
  function wasPressed(action) {
    return triggered.has(action);
  }

  /* -------------------------------------------------------------- per frame */

  function update() {
    // Publish this frame's mouse travel, then empty the buffer.
    state.lookX = bufferedLookX;
    state.lookZ = bufferedLookY;
    bufferedLookX = 0;
    bufferedLookY = 0;

    triggered.clear();

    for (const name in BINDINGS) {
      const codes = BINDINGS[name];
      let pressed = false;
      for (const code of codes) {
        // `newlyDown` catches a tap that went down and up inside one frame;
        // the last-frame comparison catches a key already down when the
        // frame began.
        if (newlyDown.has(code) || (down.has(code) && !lastFrameDown.has(code))) {
          pressed = true;
          break;
        }
      }
      if (pressed) {
        triggered.add(name);
        if (onAction) onAction(name);
      }
    }

    lastFrameDown = new Set(down);
    newlyDown.clear();

    const strafe = (isDown('right') ? 1 : 0) - (isDown('left') ? 1 : 0);
    const advance = (isDown('forward') ? 1 : 0) - (isDown('back') ? 1 : 0);
    // Diagonal movement must not be ~41% faster than the cardinals.
    const magnitude = Math.hypot(strafe, advance);
    const scale = magnitude > 1 ? 1 / magnitude : 1;

    state.moveX = strafe * scale;
    state.moveZ = advance * scale;
    state.sprint = isDown('sprint');
    state.jump = isDown('jump');
    state.fire = firing;
    state.aim = aiming;
  }

  function dispose() {
    window.removeEventListener('keydown', handleKeyDown);
    window.removeEventListener('keyup', handleKeyUp);
    window.removeEventListener('blur', handleBlur);
    canvas.removeEventListener('mousedown', handleMouseDown);
    window.removeEventListener('mouseup', handleMouseUp);
    document.removeEventListener('mousemove', handleMouseMove);
    document.removeEventListener('pointerlockchange', handlePointerLockChange);
    canvas.removeEventListener('contextmenu', handleContextMenu);
    down.clear();
    newlyDown.clear();
    triggered.clear();
    unlockPointer();
  }

  return { state, update, isDown, wasPressed, lockPointer, unlockPointer, dispose };
}
