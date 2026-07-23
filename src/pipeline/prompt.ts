import type { Character, Cut, Location, Scene, Series } from '../domain.js';

export interface PromptBundle {
  prompt: string;
  negativePrompt: string;
  referenceImages: string[];
  referenceLegend: string[];
}

export function assemblePrompt(
  series: Series,
  scene: Scene,
  cut: Cut,
  characters: Character[],
  location: Location | undefined,
): PromptBundle {
  const referenceImages: string[] = [];
  const referenceLegend: string[] = [];

  const locationImage =
    location?.variants[scene.dayNight.toLowerCase()] ?? location?.referenceImages[0];
  if (locationImage) {
    referenceImages.push(locationImage);
    referenceLegend.push(`图1=场景${location!.id}`);
  }

  const characterReferences = new Map<string, number>();
  for (const appearance of cut.characters) {
    const character = characters.find((item) => item.id === appearance.characterId);
    const image =
      character?.outfits[appearance.outfitId]?.referenceImage ??
      character?.turnaround[0];
    if (!image || referenceImages.length >= 8) continue;
    referenceImages.push(image);
    characterReferences.set(appearance.characterId, referenceImages.length);
    referenceLegend.push(
      `图${referenceImages.length}=角色${appearance.characterId}/${appearance.outfitId}`,
    );
  }

  const characterSegment = cut.characters.length
    ? cut.characters
        .map((appearance) => {
          const index = characterReferences.get(appearance.characterId);
          return `${index ? `图${index}` : appearance.characterId}，表情=${appearance.expression}`;
        })
        .join('；')
    : '无人空镜';
  const backgroundSegment = locationImage
    ? '图1作为场景空间、材质和色彩参考'
    : `${location?.name ?? scene.locationId}；${cut.promptDelta}`;
  const timeLight =
    scene.dayNight === 'NIGHT'
      ? '夜景，环境主光明确'
      : scene.dayNight === 'EVENING'
        ? '黄昏暖光与长阴影'
        : '自然日光';
  const prompt = [
    `CHARACTER: ${characterSegment}`,
    `BACKGROUND: ${backgroundSegment}`,
    `ACTION: ${cut.action}`,
    `SCENE: ${scene.intExt}，${scene.dayNight}，${cut.promptDelta}`,
    `CAMERA: 竖屏 9:16，${cut.shotSize}，${cut.camera.move}${cut.camera.note ? `，${cut.camera.note}` : ''}`,
    `LIGHT: ${timeLight}`,
    'TEXT: 画面内禁止文字、字幕、logo、水印',
    `STYLE: ${series.style.prompt}`,
  ].join('\n');

  return {
    prompt,
    negativePrompt: series.style.negativePrompt,
    referenceImages,
    referenceLegend,
  };
}
