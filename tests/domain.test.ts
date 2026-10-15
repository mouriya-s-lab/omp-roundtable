import { describe, test } from 'bun:test';
import { publicScenes } from './acceptance/black-box.ts';

// Expectations are independent protocol requirements, not snapshots of engine output.
// Every scenario reaches production through the five exported domain APIs only.
describe('Roundtable independent public lifecycle contract', () => {
  for (const scene of publicScenes) test(scene.name, () => scene.run());
});
