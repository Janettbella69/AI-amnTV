import fs from 'node:fs';
import path from 'node:path';
import type { AppConfig } from '../config.js';
import type { Cut, Storyboard } from '../domain.js';
import { createProviders } from '../providers/index.js';
import { ProjectStore } from '../store.js';

function directories(root: string): string[] {
  if (!fs.existsSync(root)) return [];
  return fs
    .readdirSync(root, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && !entry.name.startsWith('.'))
    .map((entry) => entry.name)
    .sort();
}

function files(root: string, pattern: RegExp): string[] {
  if (!fs.existsSync(root)) return [];
  return fs
    .readdirSync(root, { withFileTypes: true })
    .filter((entry) => entry.isFile() && pattern.test(entry.name))
    .map((entry) => path.join(root, entry.name))
    .sort();
}

function mediaUrl(config: AppConfig, file: string | undefined): string | undefined {
  if (!file) return undefined;
  const resolvedRoot = path.resolve(config.projectsRoot);
  const resolvedFile = path.resolve(file);
  const relative = path.relative(resolvedRoot, resolvedFile);
  if (relative.startsWith('..') || path.isAbsolute(relative)) return undefined;
  return `/media/${relative
    .split(path.sep)
    .map((part) => encodeURIComponent(part))
    .join('/')}`;
}

function mediaFiles(config: AppConfig, values: string[]): string[] {
  return values.flatMap((file) => {
    const value = mediaUrl(config, file);
    return value ? [value] : [];
  });
}

export function listSeries(config: AppConfig) {
  return directories(config.projectsRoot).flatMap((seriesId) => {
    try {
      const store = new ProjectStore(config.projectsRoot, seriesId);
      if (!store.hasSeries()) return [];
      const series = store.series();
      const episodeIds = directories(path.join(store.paths.root, 'episodes')).filter(
        (episodeId) => fs.existsSync(store.paths.scriptFile(episodeId)),
      );
      return [{ ...series, episodeIds }];
    } catch {
      return [];
    }
  });
}

function keyframeCandidates(
  config: AppConfig,
  store: ProjectStore,
  episodeId: string,
  cut: Cut,
  round: number,
) {
  const bag = store.paths.cut(episodeId, cut.id);
  const roles =
    cut.genMode === 'first_last' || cut.genMode === 'multi_frame'
      ? ['first', 'last']
      : ['first'];
  return Object.fromEntries(
    roles.map((role) => {
      const root = path.join(
        bag.keyframeCandidates,
        role,
        `round-${String(round).padStart(2, '0')}`,
      );
      return [
        role,
        files(root, /\.(png|jpe?g|webp)$/i).map((file, index) => ({
          index: index + 1,
          file,
          url: mediaUrl(config, file),
        })),
      ];
    }),
  );
}

export function workspaceView(
  config: AppConfig,
  seriesId: string,
  episodeId: string,
) {
  const store = new ProjectStore(config.projectsRoot, seriesId);
  const series = store.series();
  const script = store.script(episodeId);
  let storyboard: Storyboard;
  try {
    storyboard = store.storyboard(episodeId);
  } catch {
    storyboard = { episodeId, cuts: [], status: 'draft' };
  }
  const state = store.state(episodeId);
  const characters = store.characters().map((character) => {
    const root = store.paths.characterRoot(character.id);
    const candidates = files(
      path.join(root, 'candidates'),
      /\.(png|jpe?g|webp)$/i,
    );
    const voiceSample = path.join(root, 'candidates', 'voice-sample.mp3');
    return {
      ...character,
      previewUrl: mediaUrl(config, character.turnaround[0]),
      turnaroundUrls: mediaFiles(config, character.turnaround),
      candidateUrls: mediaFiles(config, candidates),
      voiceSampleUrl: fs.existsSync(voiceSample)
        ? mediaUrl(config, voiceSample)
        : undefined,
    };
  });
  const locations = store.locations().map((location) => {
    const root = path.dirname(store.paths.locationFile(location.id));
    const candidates = files(
      path.join(root, 'candidates'),
      /\.(png|jpe?g|webp)$/i,
    );
    return {
      ...location,
      previewUrl: mediaUrl(config, location.referenceImages[0]),
      referenceUrls: mediaFiles(config, location.referenceImages),
      candidateUrls: mediaFiles(config, candidates),
    };
  });
  const cuts = storyboard.cuts.map((cut) => {
    const entry = state.cuts[cut.id];
    const bag = store.paths.cut(episodeId, cut.id);
    const clips = files(bag.clips, /\.mp4$/i);
    return {
      ...cut,
      state: entry,
      candidates: keyframeCandidates(
        config,
        store,
        episodeId,
        cut,
        entry?.retakeCount ?? 0,
      ),
      selectedKeyframeUrls: mediaFiles(config, entry?.selectedKeyframes ?? []),
      clipUrls: mediaFiles(config, clips),
      selectedVideoUrl: mediaUrl(config, entry?.selectedVideo),
    };
  });
  const byProvider = new Map<
    string,
    { calls: number; knownAmountCny: number; unknown: number }
  >();
  for (const row of state.costLedger) {
    const entry = byProvider.get(row.provider) ?? {
      calls: 0,
      knownAmountCny: 0,
      unknown: 0,
    };
    entry.calls += 1;
    if (row.amountCny === undefined) entry.unknown += 1;
    else entry.knownAmountCny += row.amountCny;
    byProvider.set(row.provider, entry);
  }
  const providers = createProviders(config);
  return {
    series,
    episodeIds: directories(path.join(store.paths.root, 'episodes')).filter(
      (id) => fs.existsSync(store.paths.scriptFile(id)),
    ),
    episodeId,
    script,
    storyboard: { ...storyboard, cuts },
    state: {
      ...state,
      delivery: state.delivery
        ? {
            ...state.delivery,
            finalVideoUrl: mediaUrl(config, state.delivery.finalVideo),
            subtitlesUrl: mediaUrl(config, state.delivery.subtitles),
            coverUrl: mediaUrl(config, state.delivery.cover),
          }
        : undefined,
    },
    assets: { characters, locations },
    costs: {
      knownTotalCny: state.costLedger.reduce(
        (sum, entry) => sum + (entry.amountCny ?? 0),
        0,
      ),
      unknownEntries: state.costLedger.filter(
        (entry) => entry.amountCny === undefined,
      ).length,
      imageDrawsPerCut:
        state.costLedger.filter((entry) => entry.kind === 'image').length /
        Math.max(1, storyboard.cuts.length),
      byProvider: [...byProvider].map(([provider, value]) => ({
        provider,
        ...value,
      })),
      ledger: state.costLedger,
    },
    providers: {
      image: { name: providers.image.name, ...providers.image.status() },
      video: { name: providers.video.name, ...providers.video.status() },
      tts: { name: providers.tts.name, ...providers.tts.status() },
    },
  };
}
