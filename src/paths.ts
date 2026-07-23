import path from 'node:path';

function safe(value: string, label: string): string {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(value)) {
    throw new Error(`${label} 含不安全字符: ${value}`);
  }
  return value;
}

export class ProjectPaths {
  readonly root: string;

  constructor(
    projectsRoot: string,
    readonly seriesId: string,
  ) {
    this.root = path.join(projectsRoot, safe(seriesId, 'seriesId'));
  }

  get seriesFile(): string {
    return path.join(this.root, 'series.yaml');
  }

  get charactersDir(): string {
    return path.join(this.root, 'assets', 'characters');
  }

  characterFile(characterId: string): string {
    return path.join(this.charactersDir, safe(characterId, 'characterId'), 'profile.yaml');
  }

  characterRoot(characterId: string): string {
    return path.dirname(this.characterFile(characterId));
  }

  get locationsDir(): string {
    return path.join(this.root, 'assets', 'locations');
  }

  locationFile(locationId: string): string {
    return path.join(this.locationsDir, safe(locationId, 'locationId'), 'profile.yaml');
  }

  episodeRoot(episodeId: string): string {
    return path.join(this.root, 'episodes', safe(episodeId, 'episodeId'));
  }

  scriptFile(episodeId: string): string {
    return path.join(this.episodeRoot(episodeId), 'script.yaml');
  }

  storyboardFile(episodeId: string): string {
    return path.join(this.episodeRoot(episodeId), 'storyboard.yaml');
  }

  stateFile(episodeId: string): string {
    return path.join(this.episodeRoot(episodeId), 'state.yaml');
  }

  sourceFile(episodeId: string): string {
    return path.join(this.episodeRoot(episodeId), 'source.md');
  }

  sourceMetaFile(episodeId: string): string {
    return path.join(this.episodeRoot(episodeId), 'source-meta.yaml');
  }

  reviewDir(episodeId: string): string {
    return path.join(this.episodeRoot(episodeId), 'review');
  }

  finalDir(episodeId: string): string {
    return path.join(this.episodeRoot(episodeId), 'final');
  }

  cutRoot(episodeId: string, cutId: string): string {
    return path.join(this.episodeRoot(episodeId), 'cuts', safe(cutId, 'cutId'));
  }

  cut(episodeId: string, cutId: string) {
    const root = this.cutRoot(episodeId, cutId);
    return {
      root,
      audio: path.join(root, 'audio'),
      keyframeCandidates: path.join(root, 'keyframes', 'candidates'),
      keyframeSelected: path.join(root, 'keyframes', 'selected'),
      clips: path.join(root, 'clips'),
      tickets: path.join(root, 'tickets'),
      meta: path.join(root, 'meta'),
    };
  }
}
