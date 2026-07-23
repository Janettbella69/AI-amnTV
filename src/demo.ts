import type { AppConfig } from './config.js';
import type {
  Character,
  Cut,
  Location,
  Script,
  Series,
  Storyboard,
} from './domain.js';
import {
  approveCast,
  approveFinal,
  approveKeyframes,
  approveScript,
  approveStoryboard,
  audioStage,
  castingStage,
  composeStage,
  keyframeStage,
  videoStage,
} from './pipeline/index.js';
import { ProjectStore } from './store.js';

const lines = [
  ['CH-02', '这门婚事，就此作罢。', '轻蔑'],
  ['CH-01', '好，我也正有此意。', '平静'],
  ['CH-01', '嫁妆清单，请你签收。', '锋利'],
  ['CH-02', '你别以为我会后悔。', '恼怒'],
  ['CH-01', '后悔的人不会是我。', '笃定'],
  ['CH-01', '账本第一页，是假账。', '冷静'],
  ['CH-02', '你从哪里拿到的？', '慌张'],
  ['CH-01', '从你最信任的人手里。', '克制'],
  ['CH-01', '证据已经送到法务。', '坚定'],
  ['CH-02', '你敢毁掉顾家？', '威胁'],
  ['CH-01', '是你先毁掉了自己。', '决绝'],
  ['CH-01', '从今天起，各走各路。', '释然'],
  ['CH-02', '等等，我们还能谈。', '失控'],
  ['CH-01', '迟来的诚意没有用。', '冷淡'],
  ['CH-01', '下一份证据，明早见。', '神秘'],
] as const;

export function seedDemo(store: ProjectStore): void {
  if (store.hasSeries()) throw new Error(`demo 系列已存在: ${store.paths.root}`);
  const series: Series = {
    id: store.seriesId,
    title: '样例：她先撕掉婚约',
    genre: '女性向·复仇成长（dry-run 样例）',
    logline: '订婚宴上被退婚的她亮出假账证据，夺回主动权并留下下一集钩子。',
    spec: {
      width: 1080,
      height: 1920,
      fps: 24,
      episodeDurationSec: [60, 120],
      targetCuts: [15, 25],
    },
    style: {
      prompt:
        'anime, elegant modern Chinese drama, clean line art, cinematic cel shading, consistent faces',
      negativePrompt:
        'photorealistic, 3d render, text, logo, watermark, extra fingers, deformed face',
      referenceImages: [],
      imageModel: 'dry-run stub',
    },
  };
  store.saveSeries(series);

  const characters: Character[] = [
    {
      id: 'CH-01',
      name: '林晚',
      age: '24',
      personality: '冷静、有行动力，受挫后不再退让',
      relationships: { 'CH-02': '前未婚夫' },
      turnaround: [],
      expressions: {},
      outfits: {
        'OF-01-a': { label: '订婚宴礼服', referenceImage: '' },
      },
      palette: {
        normal: ['#6f2945', '#e8d4ca'],
        night: ['#331a2b', '#9b7a86'],
        evening: ['#8c3a50', '#e1ad91'],
      },
      voice: { provider: 'stub', voiceId: 'lin-wan', params: {} },
      status: 'draft',
    },
    {
      id: 'CH-02',
      name: '顾沉',
      age: '27',
      personality: '傲慢、控制欲强，失去优势后慌乱',
      relationships: { 'CH-01': '前未婚妻' },
      turnaround: [],
      expressions: {},
      outfits: {
        'OF-01-a': { label: '深色西装', referenceImage: '' },
      },
      palette: {
        normal: ['#19202e', '#a7b0c0'],
        night: ['#0f1420', '#5d6574'],
        evening: ['#2b3140', '#b88d72'],
      },
      voice: { provider: 'stub', voiceId: 'gu-chen', params: {} },
      status: 'draft',
    },
  ];
  characters.forEach((character) => store.saveCharacter(character));

  const locations: Location[] = [
    {
      id: 'LOC-01',
      name: '订婚宴大厅',
      referenceImages: [],
      variants: {},
      status: 'draft',
    },
    {
      id: 'LOC-02',
      name: '大厅侧廊',
      referenceImages: [],
      variants: {},
      status: 'draft',
    },
  ];
  locations.forEach((location) => store.saveLocation(location));

  const scenes = Array.from({ length: 5 }, (_, sceneIndex) => {
    const start = sceneIndex * 3;
    return {
      id: `S${String(sceneIndex + 1).padStart(2, '0')}`,
      status: 'active' as const,
      revision: 1,
      intExt: 'INT' as const,
      dayNight: 'EVENING' as const,
      locationId: sceneIndex === 4 ? 'LOC-02' : 'LOC-01',
      synopsis: [
        '顾沉当众退婚，林晚反客为主',
        '林晚亮出第一份假账证据',
        '证据已经送达法务，顾沉失去控制',
        '林晚宣布关系结束并离席',
        '顾沉追到侧廊，林晚留下下一集钩子',
      ][sceneIndex]!,
      emotionBeat: ['对抗开场', '第一次爆点', '爽点', '反转', '结尾钩子'][sceneIndex]!,
      dialogue: lines.slice(start, start + 3).map(([speakerId, text, emotion], offset) => ({
        id: `D${String(start + offset + 1).padStart(3, '0')}`,
        kind: 'dialogue' as const,
        speakerId,
        text,
        emotion,
      })),
    };
  });
  const manifests = scenes.map((scene) => ({
    sceneId: scene.id,
    characters: ['CH-01', 'CH-02'],
    locations: [scene.locationId],
    props: scene.id === 'S02' ? ['PR-01:账本'] : [],
    wardrobe: [
      { characterId: 'CH-01', outfitId: 'OF-01-a' },
      { characterId: 'CH-02', outfitId: 'OF-01-a' },
    ],
    vfxNotes: [],
  }));
  const script: Script = {
    episodeId: 'EP01',
    title: '退婚宴上的第一份证据',
    emotionContract: {
      promise: '被当众退婚的女主会夺回主动权',
      payoff: '女主展示假账并让男方陷入被调查的危机',
    },
    scenes,
    manifests,
    status: 'draft',
  };
  store.saveScript(script);

  const cuts: Cut[] = lines.map(([speakerId], index) => {
    const sceneNumber = Math.floor(index / 3) + 1;
    const sceneId = `S${String(sceneNumber).padStart(2, '0')}`;
    const key = [2, 8, 14].includes(index);
    return {
      id: `EP01_${sceneId}_C${String(index + 1).padStart(3, '0')}`,
      sceneId,
      durationSec: 4,
      shotSize: key ? 'MS' : index % 3 === 0 ? 'MS' : 'CU',
      camera: {
        move: key ? 'ZOOM_IN' : index % 2 ? 'STATIC' : 'PAN',
        ...(key ? { note: '情绪爆点，缓慢推进' } : {}),
      },
      action:
        speakerId === 'CH-01'
          ? '林晚保持视线稳定，完成台词后转身或展示证据'
          : '顾沉面向林晚说话，神情从傲慢逐渐转为慌乱',
      dialogueIds: [`D${String(index + 1).padStart(3, '0')}`],
      characters: [
        {
          characterId: speakerId,
          outfitId: 'OF-01-a',
          expression: speakerId === 'CH-01' ? '克制坚定' : '情绪逐步失控',
        },
      ],
      soundEffects: key ? ['纸张翻动或脚步停顿'] : [],
      transition: index === lines.length - 1 ? 'FADE' : 'CUT',
      genMode: key ? 'first_last' : 'first_frame',
      importance: key ? 'key' : 'normal',
      promptDelta: sceneNumber === 5 ? '侧廊纵深构图' : '宴会厅宾客作为虚化背景',
      tailLink: index > 0 && sceneNumber === Math.floor((index - 1) / 3) + 1,
    };
  });
  const storyboard: Storyboard = {
    episodeId: 'EP01',
    cuts,
    status: 'draft',
  };
  store.saveStoryboard(storyboard);
  store.initCuts('EP01', cuts);
}

export function automaticAssetPicks(store: ProjectStore): Record<string, number> {
  return Object.fromEntries([
    ...store.characters()
      .filter((item) => item.status === 'candidates_ready')
      .map((item) => [item.id, 1] as const),
    ...store.locations()
      .filter((item) => item.status === 'candidates_ready')
      .map((item) => [item.id, 1] as const),
  ]);
}

export function automaticKeyframePicks(
  store: ProjectStore,
  episodeId: string,
): Record<string, number> {
  return Object.fromEntries(
    store.storyboard(episodeId).cuts.flatMap((cut) => {
      const roles =
        cut.genMode === 'first_last' || cut.genMode === 'multi_frame'
          ? ['first', 'last']
          : ['first'];
      return roles.map((role) => [`${cut.id}:${role}`, 1] as const);
    }),
  );
}

export async function runDemoWorkflow(
  config: AppConfig,
  store: ProjectStore,
): Promise<void> {
  const episodeId = 'EP01';
  await approveScript(config, store, episodeId);
  await castingStage(config, store, episodeId);
  approveCast(store, episodeId, automaticAssetPicks(store));
  approveStoryboard(store, episodeId);
  await audioStage(config, store, episodeId);
  await keyframeStage(config, store, episodeId);
  approveKeyframes(store, episodeId, automaticKeyframePicks(store, episodeId));
  await videoStage(config, store, episodeId);
  await composeStage(config, store, episodeId);
  approveFinal(store, episodeId);
}
