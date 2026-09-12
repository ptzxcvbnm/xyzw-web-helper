import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

const source = fs.readFileSync(new URL('../src/components/GameLogin.vue', import.meta.url), 'utf8');

test('runs the embedded game at the upstream desktop resolution', () => {
  assert.match(source, /const GAME_WIDTH = 720;/);
  assert.match(source, /const GAME_HEIGHT = 1280;/);
  assert.match(source, /:width="GAME_WIDTH"/);
  assert.match(source, /:height="GAME_HEIGHT"/);
  assert.match(source, /class="game-viewport"/);
});

test('scales the fixed game viewport to the available stage size', () => {
  assert.match(source, /Math\.min\(width \/ GAME_WIDTH, height \/ GAME_HEIGHT\)/);
  assert.match(source, /new ResizeObserver\(updateGameScale\)/);
  assert.match(source, /transform: `translate\(-50%, -50%\) scale\(\$\{gameScale\.value\}\)`/);
});
