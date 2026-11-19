// Puerto Fuego — make.fun gta6-01 entrypoint.
//
// This program is the hand-in step: it stages the finished game into the
// grader's output directory and leaves behind dossier.json, the summary the
// judges read. It does not build, bundle or transform anything — the game
// under game/ is already plain static files a browser can load offline, so
// the hand-in is just a careful copy plus the dossier.
//
// Usage, outside the grader's container:
//   mkdir -p out && MAKEFUN_OUTPUT_DIR=out node main.ts
// Inside the grader the output directory is /output by default.
//
// Node 22+, standard library only. No network, no shelling out.

import { cpSync, existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildDossier } from './vendor/makefun-game.ts';

// Where this file lives is where the game lives: game/ and screenshots/
// sit next to main.ts in the repository.
const repoRoot = resolve(fileURLToPath(new URL('.', import.meta.url)));

// The grader sets MAKEFUN_OUTPUT_DIR when it wants the output somewhere
// other than /output (local runs use it the same way). Fall back to the
// container path the competition expects.
const outputDir = resolve(process.env.MAKEFUN_OUTPUT_DIR ?? '/output');

// The scorer's own caps (see the competition's gate.json). They are passed
// straight through to buildDossier, which refuses an entry the scorer
// would refuse: more than 4 screenshots, any screenshot over 256 KiB,
// more than 993 files inside game/, more than 48 MiB of game files in
// total, or any path under game/ longer than 1000 bytes.
const CAPS = {
  text_max_bytes: 163840,
  screenshots: { max: 4, max_bytes: 262144 },
  game_max_files: 993,
  game_max_bytes: 50331648,
  game_path_max_bytes: 1000,
};

// Copy one sibling folder of the repo into the output directory, replacing
// whatever a previous run left there so stale files never leak into a
// submission. Missing source folders are not an error: a fresh checkout
// may legitimately have no screenshots yet, and the dossier still gets
// written.
function stageFolder(name: string): void {
  const source = join(repoRoot, name);
  const target = join(outputDir, name);
  if (!existsSync(source)) {
    console.log(`[puerto-fuego] no ${name}/ in repo, skipping`);
    return;
  }
  rmSync(target, { recursive: true, force: true });
  cpSync(source, target, { recursive: true });
  console.log(`[puerto-fuego] staged ${name}/ -> ${target}`);
}

mkdirSync(outputDir, { recursive: true });
stageFolder('game');
stageFolder('screenshots');

// The dossier is built from the staged output, not from the repo, so what
// the judges read always matches what was actually copied.
const dossier = buildDossier(outputDir, CAPS);
writeFileSync(join(outputDir, 'dossier.json'), dossier);
console.log(
  `[puerto-fuego] wrote dossier.json (${dossier.byteLength} bytes) into ${outputDir}`,
);
