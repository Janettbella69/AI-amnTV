import { useEffect, useMemo, useState } from 'react';
import { Field, SectionHeader, StatusTag } from '../components/Common';
import type { Dialogue, ScriptDocument, Scene } from '../types';

function clone<T>(value: T): T {
  return structuredClone(value);
}

export function ScriptEditor({
  script,
  approved,
  onSave,
  onApprove,
  onGenerate,
}: {
  script: ScriptDocument;
  approved: boolean;
  onSave: (script: ScriptDocument) => Promise<void>;
  onApprove: () => Promise<void>;
  onGenerate: (outline: string) => Promise<void>;
}) {
  const [draft, setDraft] = useState(() => clone(script));
  const [outline, setOutline] = useState('');
  const [saving, setSaving] = useState(false);
  useEffect(() => setDraft(clone(script)), [script]);
  const dialogueCount = useMemo(
    () => draft.scenes.reduce((sum, scene) => sum + scene.dialogue.length, 0),
    [draft],
  );

  const updateScene = (sceneId: string, patch: Partial<Scene>) => {
    setDraft((current) => ({
      ...current,
      scenes: current.scenes.map((scene) =>
        scene.id === sceneId ? { ...scene, ...patch } : scene,
      ),
    }));
  };

  const updateLine = (
    sceneId: string,
    dialogueId: string,
    patch: Partial<Dialogue>,
  ) => {
    setDraft((current) => ({
      ...current,
      scenes: current.scenes.map((scene) =>
        scene.id === sceneId
          ? {
              ...scene,
              dialogue: scene.dialogue.map((line) =>
                line.id === dialogueId ? { ...line, ...patch } : line,
              ),
            }
          : scene,
      ),
    }));
  };

  const addDialogue = (sceneId: string) => {
    const maxId = draft.scenes
      .flatMap((scene) => scene.dialogue)
      .reduce((max, line) => Math.max(max, Number(line.id.slice(1)) || 0), 0);
    updateScene(sceneId, {
      dialogue: [
        ...draft.scenes.find((scene) => scene.id === sceneId)!.dialogue,
        {
          id: `D${String(maxId + 1).padStart(3, '0')}`,
          kind: 'dialogue',
          speakerId: 'CH-01',
          text: '新台词',
          emotion: '平静',
        },
      ],
    });
  };

  const save = async () => {
    setSaving(true);
    try {
      await onSave(draft);
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="screen-stack">
      <SectionHeader
        eyebrow="Editorial desk"
        title="剧本编辑器"
        detail={`${draft.scenes.length} 场 · ${dialogueCount} 条内容 · 单句对白最多 15 个汉字`}
        actions={
          <>
            <StatusTag
              value={draft.status === 'locked' ? 'LOCKED' : 'DRAFT'}
              tone={draft.status === 'locked' ? 'good' : 'warn'}
            />
            <button className="button ghost" onClick={save} disabled={saving}>
              {saving ? '保存中' : '保存剧本'}
            </button>
            <button
              className="button primary"
              onClick={() => void onApprove()}
              disabled={approved}
            >
              {approved ? '关卡①已批准' : '批准关卡①'}
            </button>
          </>
        }
      />

      <section className="editor-document script-meta">
        <Field label="分集标题" wide>
          <input
            value={draft.title}
            onChange={(event) =>
              setDraft((current) => ({ ...current, title: event.target.value }))
            }
          />
        </Field>
        <Field label="情绪承诺">
          <textarea
            value={draft.emotionContract.promise}
            onChange={(event) =>
              setDraft((current) => ({
                ...current,
                emotionContract: {
                  ...current.emotionContract,
                  promise: event.target.value,
                },
              }))
            }
          />
        </Field>
        <Field label="兑现方式">
          <textarea
            value={draft.emotionContract.payoff}
            onChange={(event) =>
              setDraft((current) => ({
                ...current,
                emotionContract: {
                  ...current.emotionContract,
                  payoff: event.target.value,
                },
              }))
            }
          />
        </Field>
      </section>

      <section className="agent-box">
        <div>
          <span className="eyebrow">Claude Agent SDK</span>
          <h3>从大纲重新生成剧本</h3>
          <p>任务进入 SQLite 队列；已有锁定剧本不会被无提示覆盖。</p>
        </div>
        <textarea
          placeholder="输入本集大纲、爆点和结尾钩子……"
          value={outline}
          onChange={(event) => setOutline(event.target.value)}
        />
        <button
          className="button ghost"
          disabled={!outline.trim()}
          onClick={() => void onGenerate(outline)}
        >
          加入剧本任务
        </button>
      </section>

      <div className="scene-list">
        {draft.scenes.map((scene) => (
          <article className="scene-sheet" key={scene.id}>
            <header>
              <div>
                <span className="scene-id">{scene.id}</span>
                <input
                  className="scene-synopsis"
                  value={scene.synopsis}
                  onChange={(event) =>
                    updateScene(scene.id, { synopsis: event.target.value })
                  }
                />
              </div>
              <button
                className="text-button"
                onClick={() =>
                  updateScene(scene.id, {
                    status: scene.status === 'active' ? 'omitted' : 'active',
                  })
                }
              >
                {scene.status === 'active' ? '标记删场' : '恢复场景'}
              </button>
            </header>
            <div className="scene-fields">
              <Field label="内 / 外">
                <select
                  value={scene.intExt}
                  onChange={(event) =>
                    updateScene(scene.id, {
                      intExt: event.target.value as Scene['intExt'],
                    })
                  }
                >
                  <option value="INT">INT · 内景</option>
                  <option value="EXT">EXT · 外景</option>
                </select>
              </Field>
              <Field label="时间">
                <select
                  value={scene.dayNight}
                  onChange={(event) =>
                    updateScene(scene.id, {
                      dayNight: event.target.value as Scene['dayNight'],
                    })
                  }
                >
                  <option value="DAY">日</option>
                  <option value="EVENING">黄昏</option>
                  <option value="NIGHT">夜</option>
                </select>
              </Field>
              <Field label="场景资产">
                <input
                  value={scene.locationId}
                  onChange={(event) =>
                    updateScene(scene.id, { locationId: event.target.value })
                  }
                />
              </Field>
              <Field label="情绪节拍">
                <input
                  value={scene.emotionBeat}
                  onChange={(event) =>
                    updateScene(scene.id, { emotionBeat: event.target.value })
                  }
                />
              </Field>
            </div>
            <div className="dialogue-table">
              {scene.dialogue.map((line) => {
                const length = [...line.text.replace(/\s|\p{P}/gu, '')].length;
                return (
                  <div className="dialogue-row" key={line.id}>
                    <span>{line.id}</span>
                    <select
                      value={line.kind}
                      onChange={(event) =>
                        updateLine(scene.id, line.id, {
                          kind: event.target.value as Dialogue['kind'],
                        })
                      }
                    >
                      <option value="dialogue">对白</option>
                      <option value="narration">旁白</option>
                      <option value="sfx">音效</option>
                      <option value="ambient">环境</option>
                    </select>
                    <input
                      value={line.speakerId ?? ''}
                      placeholder="说话人"
                      onChange={(event) =>
                        updateLine(scene.id, line.id, {
                          ...(event.target.value
                            ? { speakerId: event.target.value }
                            : { speakerId: undefined }),
                        })
                      }
                    />
                    <input
                      className={length > 15 ? 'invalid' : ''}
                      value={line.text}
                      onChange={(event) =>
                        updateLine(scene.id, line.id, { text: event.target.value })
                      }
                    />
                    <input
                      value={line.emotion}
                      onChange={(event) =>
                        updateLine(scene.id, line.id, {
                          emotion: event.target.value,
                        })
                      }
                    />
                    <b className={length > 15 ? 'bad-count' : ''}>{length}/15</b>
                  </div>
                );
              })}
            </div>
            <button className="text-button add-line" onClick={() => addDialogue(scene.id)}>
              添加台词
            </button>
          </article>
        ))}
      </div>
    </div>
  );
}
