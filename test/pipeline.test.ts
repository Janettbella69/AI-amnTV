import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { seedDemo } from '../src/demo.js';
import { assemblePrompt } from '../src/pipeline/prompt.js';
import {
  validateScript,
  validateStoryboard,
} from '../src/pipeline/validation.js';
import { ProjectStore } from '../src/store.js';

function fixture(): { root: string; store: ProjectStore } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-amntv-test-'));
  const store = new ProjectStore(root, 'unit-series');
  seedDemo(store);
  return { root, store };
}

test('demo script and storyboard satisfy the production contract', (context) => {
  const { root, store } = fixture();
  context.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const script = store.script('EP01');
  const storyboard = store.storyboard('EP01');

  assert.deepEqual(validateScript(script), { ok: true, errors: [] });
  assert.deepEqual(validateStoryboard(store.series(), script, storyboard), {
    ok: true,
    errors: [],
  });
  assert.equal(storyboard.cuts.length, 15);
  assert.equal(
    storyboard.cuts.reduce((sum, cut) => sum + cut.durationSec, 0),
    60,
  );
});

test('storyboard validation rejects duplicated dialogue coverage', (context) => {
  const { root, store } = fixture();
  context.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const script = store.script('EP01');
  const storyboard = store.storyboard('EP01');
  storyboard.cuts[0]!.dialogueIds.push('D002');

  const validation = validateStoryboard(store.series(), script, storyboard);
  assert.equal(validation.ok, false);
  assert.match(validation.errors.join('\n'), /D002 必须被恰好一张卡覆盖/);
});

test('locked script identifiers cannot be deleted or reordered', (context) => {
  const { root, store } = fixture();
  context.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const script = store.script('EP01');
  script.status = 'locked';
  script.lockedAt = new Date().toISOString();
  store.saveScript(script);

  script.scenes = script.scenes.slice(1);
  assert.throws(() => store.saveScript(script), /既有场号不可删除或重排/);
});

test('local retake invalidates only the requested downstream state', (context) => {
  const { root, store } = fixture();
  context.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const cutId = store.storyboard('EP01').cuts[0]!.id;
  const state = store.state('EP01');
  state.cuts[cutId]!.stage = 'composited';
  state.cuts[cutId]!.selectedKeyframes = ['/tmp/first.png'];
  state.cuts[cutId]!.selectedVideo = '/tmp/take.mp4';
  state.gates.visual = { at: new Date().toISOString(), by: 'human' };
  state.gates.final = { at: new Date().toISOString(), by: 'human' };
  state.delivery = {
    finalVideo: '/tmp/final.mp4',
    subtitles: '/tmp/final.srt',
    cover: '/tmp/cover.jpg',
    aigcLabel: 'burned',
    jianyingDraft: '/tmp/draft',
    durationSec: 60,
    qcPassedAt: new Date().toISOString(),
  };
  store.saveState(state);

  const round = store.resetCutForRetake(
    'EP01',
    cutId,
    'keyframe_selected',
    '视频动作太快',
  );
  const revised = store.state('EP01');
  assert.equal(round, 1);
  assert.equal(revised.cuts[cutId]!.stage, 'keyframe_selected');
  assert.deepEqual(revised.cuts[cutId]!.selectedKeyframes, ['/tmp/first.png']);
  assert.equal(revised.cuts[cutId]!.selectedVideo, undefined);
  assert.equal(revised.delivery, undefined);
  assert.equal(revised.gates.final, undefined);
  assert.ok(revised.gates.visual);
});

test('prompt assembly is structured and caps references at eight', (context) => {
  const { root, store } = fixture();
  context.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const series = store.series();
  const script = store.script('EP01');
  const cut = store.storyboard('EP01').cuts[0]!;
  const scene = script.scenes.find((item) => item.id === cut.sceneId)!;
  const location = store.location(scene.locationId)!;
  location.referenceImages = ['/tmp/location.png'];
  const characters = Array.from({ length: 10 }, (_, index) => ({
    ...store.characters()[0]!,
    id: `CH-${String(index + 10).padStart(2, '0')}`,
    turnaround: [`/tmp/character-${index}.png`],
    outfits: {
      'OF-01-a': {
        label: '测试服装',
        referenceImage: `/tmp/character-${index}.png`,
      },
    },
  }));
  cut.characters = characters.map((character) => ({
    characterId: character.id,
    outfitId: 'OF-01-a',
    expression: '坚定',
  }));

  const bundle = assemblePrompt(series, scene, cut, characters, location);
  for (const section of [
    'CHARACTER:',
    'BACKGROUND:',
    'ACTION:',
    'SCENE:',
    'CAMERA:',
    'LIGHT:',
    'TEXT:',
    'STYLE:',
  ]) {
    assert.match(bundle.prompt, new RegExp(section));
  }
  assert.equal(bundle.referenceImages.length, 8);
});
