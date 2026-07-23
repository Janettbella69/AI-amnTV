import type {
  CharacterAsset,
  BenchmarkCandidate,
  BenchmarkCriterion,
  BenchmarkReport,
  EvaluationDimensionId,
  EvaluationReport,
  EvaluationScope,
  ImportPreview,
  ImportRequest,
  ImportResult,
  JobType,
  LibTvSession,
  LibTvSessionsResponse,
  LocationAsset,
  ScriptDocument,
  SeriesSummary,
  StoryboardDocument,
  StudioJob,
  Workspace,
  WorkflowView,
} from './types';

async function request<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, {
    ...init,
    headers: {
      'Content-Type': 'application/json',
      ...init?.headers,
    },
  });
  const value = (await response.json()) as T & { error?: string };
  if (!response.ok) throw new Error(value.error ?? `HTTP ${response.status}`);
  return value;
}

const episodePath = (seriesId: string, episodeId: string) =>
  `/api/series/${encodeURIComponent(seriesId)}/episodes/${encodeURIComponent(episodeId)}`;

export const api = {
  previewImport(input: ImportRequest): Promise<ImportPreview> {
    return request('/api/imports/preview', {
      method: 'POST',
      body: JSON.stringify(input),
    });
  },

  commitImport(input: ImportRequest): Promise<ImportResult> {
    return request('/api/imports', {
      method: 'POST',
      body: JSON.stringify(input),
    });
  },

  async series(): Promise<SeriesSummary[]> {
    return (await request<{ series: SeriesSummary[] }>('/api/series')).series;
  },

  workspace(seriesId: string, episodeId: string): Promise<Workspace> {
    return request(`${episodePath(seriesId, episodeId)}/workspace`);
  },

  libTvSessions(
    seriesId: string,
    episodeId: string,
  ): Promise<LibTvSessionsResponse> {
    return request(`${episodePath(seriesId, episodeId)}/libtv/sessions`);
  },

  workflow(seriesId: string, episodeId: string): Promise<WorkflowView> {
    return request(`${episodePath(seriesId, episodeId)}/workflow`);
  },

  async evaluations(
    seriesId: string,
    episodeId: string,
  ): Promise<EvaluationReport[]> {
    return (
      await request<{ evaluations: EvaluationReport[] }>(
        `${episodePath(seriesId, episodeId)}/evaluations`,
      )
    ).evaluations;
  },

  createEvaluation(
    seriesId: string,
    episodeId: string,
    input: {
      scope: EvaluationScope;
      title?: string;
      manualRatings: Array<{
        dimension: EvaluationDimensionId;
        score: number;
        note: string;
      }>;
    },
  ): Promise<EvaluationReport> {
    return request(`${episodePath(seriesId, episodeId)}/evaluations`, {
      method: 'POST',
      body: JSON.stringify(input),
    });
  },

  async benchmarkCandidates(
    seriesId: string,
    episodeId: string,
  ): Promise<BenchmarkCandidate[]> {
    return (
      await request<{ candidates: BenchmarkCandidate[] }>(
        `${episodePath(seriesId, episodeId)}/benchmarks/candidates`,
      )
    ).candidates;
  },

  async benchmarks(
    seriesId: string,
    episodeId: string,
  ): Promise<BenchmarkReport[]> {
    return (
      await request<{ benchmarks: BenchmarkReport[] }>(
        `${episodePath(seriesId, episodeId)}/benchmarks`,
      )
    ).benchmarks;
  },

  createBenchmark(
    seriesId: string,
    episodeId: string,
    input: {
      title: string;
      ratings: Array<{
        candidateId: string;
        criteria: Partial<Record<BenchmarkCriterion, number>>;
        note: string;
      }>;
    },
  ): Promise<BenchmarkReport> {
    return request(`${episodePath(seriesId, episodeId)}/benchmarks`, {
      method: 'POST',
      body: JSON.stringify(input),
    });
  },

  createLibTvSession(
    seriesId: string,
    episodeId: string,
    input: { instruction: string; referenceFiles: string[] },
  ): Promise<LibTvSession> {
    return request(`${episodePath(seriesId, episodeId)}/libtv/sessions`, {
      method: 'POST',
      body: JSON.stringify(input),
    });
  },

  refreshLibTvSession(
    seriesId: string,
    episodeId: string,
    sessionId: string,
  ): Promise<LibTvSession> {
    return request(
      `${episodePath(seriesId, episodeId)}/libtv/sessions/${encodeURIComponent(sessionId)}/refresh`,
      { method: 'POST' },
    );
  },

  collectLibTvSession(
    seriesId: string,
    episodeId: string,
    sessionId: string,
  ): Promise<LibTvSession> {
    return request(
      `${episodePath(seriesId, episodeId)}/libtv/sessions/${encodeURIComponent(sessionId)}/collect`,
      { method: 'POST' },
    );
  },

  continueLibTvSession(
    seriesId: string,
    episodeId: string,
    sessionId: string,
    input: { instruction: string; referenceFiles: string[] },
  ): Promise<LibTvSession> {
    return request(
      `${episodePath(seriesId, episodeId)}/libtv/sessions/${encodeURIComponent(sessionId)}/continue`,
      {
        method: 'POST',
        body: JSON.stringify(input),
      },
    );
  },

  promoteLibTvResult(
    seriesId: string,
    episodeId: string,
    sessionId: string,
    input: {
      resultIndex: number;
      cutId: string;
      role: 'first' | 'last';
      replaceExisting: boolean;
    },
  ): Promise<{
    ok: true;
    cutId: string;
    role: 'first' | 'last';
    round: number;
    candidateIndex: number;
    file: string;
  }> {
    return request(
      `${episodePath(seriesId, episodeId)}/libtv/sessions/${encodeURIComponent(sessionId)}/promote`,
      {
        method: 'POST',
        body: JSON.stringify(input),
      },
    );
  },

  async jobs(seriesId?: string, episodeId?: string): Promise<StudioJob[]> {
    const search = new URLSearchParams();
    if (seriesId) search.set('seriesId', seriesId);
    if (episodeId) search.set('episodeId', episodeId);
    return (await request<{ jobs: StudioJob[] }>(`/api/jobs?${search}`)).jobs;
  },

  enqueue(
    seriesId: string,
    episodeId: string,
    type: JobType,
    payload: Record<string, unknown> = {},
  ): Promise<StudioJob> {
    return request(`${episodePath(seriesId, episodeId)}/jobs`, {
      method: 'POST',
      body: JSON.stringify({ type, payload }),
    });
  },

  cancel(jobId: string): Promise<StudioJob> {
    return request(`/api/jobs/${encodeURIComponent(jobId)}/cancel`, {
      method: 'POST',
    });
  },

  saveScript(
    seriesId: string,
    episodeId: string,
    script: ScriptDocument,
  ): Promise<{ ok: true }> {
    return request(`${episodePath(seriesId, episodeId)}/script`, {
      method: 'PUT',
      body: JSON.stringify(script),
    });
  },

  saveStoryboard(
    seriesId: string,
    episodeId: string,
    storyboard: StoryboardDocument,
  ): Promise<{ ok: true }> {
    const clean = {
      ...storyboard,
      cuts: storyboard.cuts.map(
        ({
          state: _state,
          candidates: _candidates,
          selectedKeyframeUrls: _selectedKeyframeUrls,
          clipUrls: _clipUrls,
          selectedVideoUrl: _selectedVideoUrl,
          ...cut
        }) => cut,
      ),
    };
    return request(`${episodePath(seriesId, episodeId)}/storyboard`, {
      method: 'PUT',
      body: JSON.stringify(clean),
    });
  },

  saveCharacter(seriesId: string, character: CharacterAsset): Promise<{ ok: true }> {
    const {
      previewUrl: _previewUrl,
      turnaroundUrls: _turnaroundUrls,
      candidateUrls: _candidateUrls,
      voiceSampleUrl: _voiceSampleUrl,
      ...clean
    } = character;
    return request(
      `/api/series/${encodeURIComponent(seriesId)}/characters/${encodeURIComponent(character.id)}`,
      { method: 'PUT', body: JSON.stringify(clean) },
    );
  },

  saveLocation(seriesId: string, location: LocationAsset): Promise<{ ok: true }> {
    const {
      previewUrl: _previewUrl,
      referenceUrls: _referenceUrls,
      candidateUrls: _candidateUrls,
      ...clean
    } = location;
    return request(
      `/api/series/${encodeURIComponent(seriesId)}/locations/${encodeURIComponent(location.id)}`,
      { method: 'PUT', body: JSON.stringify(clean) },
    );
  },

  approve(
    seriesId: string,
    episodeId: string,
    gate: 'script' | 'cast' | 'storyboard' | 'keyframes' | 'final',
    picks: Record<string, number> = {},
  ): Promise<{ ok: true }> {
    return request(`${episodePath(seriesId, episodeId)}/approve/${gate}`, {
      method: 'POST',
      body: JSON.stringify({ picks }),
    });
  },

  retake(
    seriesId: string,
    episodeId: string,
    input: { cutId: string; stage: 'keyframe' | 'video'; instruction: string },
  ): Promise<{ ok: true }> {
    return request(`${episodePath(seriesId, episodeId)}/retakes`, {
      method: 'POST',
      body: JSON.stringify(input),
    });
  },

  createSeries(input: {
    id: string;
    title: string;
    genre: string;
    logline: string;
  }): Promise<SeriesSummary> {
    return request('/api/series', {
      method: 'POST',
      body: JSON.stringify(input),
    });
  },

  createDemo(seriesId = 'demo-series'): Promise<{
    seriesId: string;
    episodeId: string;
  }> {
    return request('/api/demo', {
      method: 'POST',
      body: JSON.stringify({ seriesId }),
    });
  },
};
