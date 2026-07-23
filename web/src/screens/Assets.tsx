import { useEffect, useState } from 'react';
import { EmptyState, SectionHeader, StatusTag } from '../components/Common';
import type { CharacterAsset, LocationAsset, Workspace } from '../types';

function AssetImage({
  url,
  label,
}: {
  url: string | undefined;
  label: string;
}) {
  return url ? (
    <img src={url} alt={label} loading="lazy" />
  ) : (
    <div className="asset-placeholder">
      <span>{label}</span>
      <small>等待候选图</small>
    </div>
  );
}

export function Assets({
  workspace,
  onRunCast,
  onApprove,
  onSaveCharacter,
  onSaveLocation,
}: {
  workspace: Workspace;
  onRunCast: () => Promise<void>;
  onApprove: (picks: Record<string, number>) => Promise<void>;
  onSaveCharacter: (asset: CharacterAsset) => Promise<void>;
  onSaveLocation: (asset: LocationAsset) => Promise<void>;
}) {
  const [characters, setCharacters] = useState(() =>
    structuredClone(workspace.assets.characters),
  );
  const [locations, setLocations] = useState(() =>
    structuredClone(workspace.assets.locations),
  );
  const [picks, setPicks] = useState<Record<string, number>>({});
  useEffect(() => {
    setCharacters(structuredClone(workspace.assets.characters));
    setLocations(structuredClone(workspace.assets.locations));
    setPicks({});
  }, [workspace]);

  const requiredPicks = [...characters, ...locations].filter(
    (asset) => asset.status === 'candidates_ready',
  );
  const canApprove =
    requiredPicks.length > 0 &&
    requiredPicks.every((asset) => Boolean(picks[asset.id]));

  return (
    <div className="screen-stack">
      <SectionHeader
        eyebrow="Series bible"
        title="角色与场景资产库"
        detail="系列级资产只锁定一次；镜头通过资产 ID 引用，不临时重写人物外貌。"
        actions={
          <>
            <button className="button ghost" onClick={() => void onRunCast()}>
              生成定妆候选
            </button>
            <button
              className="button primary"
              disabled={!canApprove}
              onClick={() => void onApprove(picks)}
            >
              批准圈选并锁定
            </button>
          </>
        }
      />

      {!characters.length && !locations.length ? (
        <EmptyState
          title="资产库为空"
          detail="剧本 Agent 识别新角色和场景后，会在这里创建资产档案。"
        />
      ) : (
        <>
          <section className="asset-section">
            <div className="subhead">
              <span className="eyebrow">Cast</span>
              <h3>角色与音色</h3>
            </div>
            <div className="asset-grid">
              {characters.map((character, assetIndex) => (
                <article className="asset-sheet" key={character.id}>
                  <div className="asset-hero">
                    <AssetImage
                      url={character.previewUrl ?? character.candidateUrls[0]}
                      label={character.id}
                    />
                    <StatusTag
                      value={character.status}
                      tone={character.status === 'locked' ? 'good' : 'warn'}
                    />
                  </div>
                  <div className="asset-copy">
                    <span className="eyebrow">{character.id}</span>
                    <input
                      className="asset-name"
                      disabled={character.status === 'locked'}
                      value={character.name}
                      onChange={(event) =>
                        setCharacters((current) =>
                          current.map((item, index) =>
                            index === assetIndex
                              ? { ...item, name: event.target.value }
                              : item,
                          ),
                        )
                      }
                    />
                    <textarea
                      disabled={character.status === 'locked'}
                      value={character.personality}
                      onChange={(event) =>
                        setCharacters((current) =>
                          current.map((item, index) =>
                            index === assetIndex
                              ? { ...item, personality: event.target.value }
                              : item,
                          ),
                        )
                      }
                    />
                    <label className="inline-field">
                      <span>Voice ID</span>
                      <input
                        disabled={character.status === 'locked'}
                        value={character.voice.voiceId}
                        onChange={(event) =>
                          setCharacters((current) =>
                            current.map((item, index) =>
                              index === assetIndex
                                ? {
                                    ...item,
                                    voice: {
                                      ...item.voice,
                                      voiceId: event.target.value,
                                    },
                                  }
                                : item,
                            ),
                          )
                        }
                      />
                    </label>
                    {character.voiceSampleUrl && (
                      <audio src={character.voiceSampleUrl} controls preload="none" />
                    )}
                    {character.status !== 'locked' && (
                      <button
                        className="text-button"
                        onClick={() => void onSaveCharacter(character)}
                      >
                        保存角色档案
                      </button>
                    )}
                  </div>
                  {character.status === 'candidates_ready' && (
                    <div className="candidate-strip">
                      {character.candidateUrls.map((url, index) => (
                        <label
                          key={url}
                          className={
                            picks[character.id] === index + 1 ? 'selected' : ''
                          }
                        >
                          <input
                            type="radio"
                            name={character.id}
                            checked={picks[character.id] === index + 1}
                            onChange={() =>
                              setPicks((current) => ({
                                ...current,
                                [character.id]: index + 1,
                              }))
                            }
                          />
                          <img src={url} alt={`${character.name} 候选 ${index + 1}`} />
                          <span>{String(index + 1).padStart(2, '0')}</span>
                        </label>
                      ))}
                    </div>
                  )}
                </article>
              ))}
            </div>
          </section>

          <section className="asset-section">
            <div className="subhead">
              <span className="eyebrow">Locations</span>
              <h3>主场景</h3>
            </div>
            <div className="asset-grid locations">
              {locations.map((location, assetIndex) => (
                <article className="asset-sheet" key={location.id}>
                  <div className="asset-hero">
                    <AssetImage
                      url={location.previewUrl ?? location.candidateUrls[0]}
                      label={location.id}
                    />
                    <StatusTag
                      value={location.status}
                      tone={location.status === 'locked' ? 'good' : 'warn'}
                    />
                  </div>
                  <div className="asset-copy">
                    <span className="eyebrow">{location.id}</span>
                    <input
                      className="asset-name"
                      disabled={location.status === 'locked'}
                      value={location.name}
                      onChange={(event) =>
                        setLocations((current) =>
                          current.map((item, index) =>
                            index === assetIndex
                              ? { ...item, name: event.target.value }
                              : item,
                          ),
                        )
                      }
                    />
                    {location.status !== 'locked' && (
                      <button
                        className="text-button"
                        onClick={() => void onSaveLocation(location)}
                      >
                        保存场景档案
                      </button>
                    )}
                  </div>
                  {location.status === 'candidates_ready' && (
                    <div className="candidate-strip">
                      {location.candidateUrls.map((url, index) => (
                        <label
                          key={url}
                          className={
                            picks[location.id] === index + 1 ? 'selected' : ''
                          }
                        >
                          <input
                            type="radio"
                            name={location.id}
                            checked={picks[location.id] === index + 1}
                            onChange={() =>
                              setPicks((current) => ({
                                ...current,
                                [location.id]: index + 1,
                              }))
                            }
                          />
                          <img src={url} alt={`${location.name} 候选 ${index + 1}`} />
                          <span>{String(index + 1).padStart(2, '0')}</span>
                        </label>
                      ))}
                    </div>
                  )}
                </article>
              ))}
            </div>
          </section>
        </>
      )}
    </div>
  );
}
