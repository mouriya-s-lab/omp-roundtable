import { publicScenes } from './black-box.ts';

let failed = 0;
const selectedNames = process.argv.slice(2);
const selected = selectedNames.length === 0 ? publicScenes : publicScenes.filter(scene => selectedNames.includes(scene.name));
if (selected.length === 0) throw new Error(`Unknown scenario selection: ${selectedNames.join(', ')}`);
for (const scene of selected) {
  console.log(JSON.stringify({ scene: scene.name, operation: 'scene-start' }));
  try {
    scene.run(record => console.log(JSON.stringify(record)));
    console.log(JSON.stringify({ scene: scene.name, operation: 'scene-result', outcome: 'passed' }));
  } catch (error: unknown) {
    failed++;
    console.error(JSON.stringify({ scene: scene.name, operation: 'scene-result', outcome: 'failed', error: error instanceof Error ? { name: error.name, message: error.message, stack: error.stack } : String(error) }));
  }
}
console.log(JSON.stringify({ operation: 'public-api-summary', selected: selected.length, passed: selected.length - failed, failed }));
if (failed !== 0) process.exitCode = 1;
