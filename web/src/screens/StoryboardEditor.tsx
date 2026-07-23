import { useEffect, useMemo, useState } from 'react';
import { Field, SectionHeader, StatusTag } from '../components/Common';
import type { Cut, StoryboardDocument } from '../types';

export function StoryboardEditor({
  storyboard,
  approved,
  onSave,
  onApprove,
  onGenerate,
  onRetake,
}: {
  storyboard: StoryboardDocument;
  approved: boolean;
  onSave: (storyboard: StoryboardDocument) => Promise<void>;
  onApprove: () => Promise<void>;
  onGenerate: () => Promise<void>;
  onRetake: (cut: Cut) => void;
}) {
  const [draft, setDraft] = useState(() => structuredClone(storyboard));
  const [saving, setSaving] = useState(false);
  useEffect(() => setDraft(structuredClone(storyboard)), [storyboard]);
  const duration = useMemo(
    () => draft.cuts.reduce((sum, cut) => sum + Number(cut.durationSec), 0),
    [draft],
  );
  const update = (cutId: string, patch: Partial<Cut>) => {
    setDraft((current) => ({
      ...current,
      cuts: current.cuts.map((cut) =>
        cut.id === cutId ? { ...cut, ...patch } : cut,
      ),
    }));
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
        eyebrow="Shot planning"
        title="分镜编辑器"
        detail={`${draft.cuts.length} 卡 · ${duration.toFixed(2)} 秒 · 每条台词必须恰好被一张卡覆盖`}
        actions={
          <>
            <StatusTag
              value={draft.status === 'approved' ? 'APPROVED' : 'DRAFT'}
              tone={draft.status === 'approved' ? 'good' : 'warn'}
            />
            <button className="button ghost" onClick={() => void onGenerate()}>
              Agent 生成分镜
            </button>
            <button className="button ghost" onClick={save} disabled={saving}>
              {saving ? '保存中' : '保存镜头表'}
            </button>
            <button
              className="button primary"
              onClick={() => void onApprove()}
              disabled={approved}
            >
              {approved ? '分镜已批准' : '批准分镜'}
            </button>
          </>
        }
      />
      <section className="storyboard-list">
        {draft.cuts.map((cut, index) => (
          <article className="cut-editor" key={cut.id}>
            <header>
              <span className="cut-number">{String(index + 1).padStart(2, '0')}</span>
              <div>
                <strong>{cut.id}</strong>
                <small>
                  {cut.sceneId} · {cut.state?.stage ?? '未建状态'}
                </small>
              </div>
              <StatusTag
                value={cut.importance === 'key' ? 'KEY' : 'NORMAL'}
                tone={cut.importance === 'key' ? 'warn' : 'neutral'}
              />
              <button className="text-button" onClick={() => onRetake(cut)}>
                局部重做
              </button>
            </header>
            <div className="cut-form">
              <Field label="时长">
                <input
                  type="number"
                  min={1}
                  max={12}
                  step={0.1}
                  value={cut.durationSec}
                  onChange={(event) =>
                    update(cut.id, { durationSec: Number(event.target.value) })
                  }
                />
              </Field>
              <Field label="景别">
                <select
                  value={cut.shotSize}
                  onChange={(event) =>
                    update(cut.id, {
                      shotSize: event.target.value as Cut['shotSize'],
                    })
                  }
                >
                  {['ECU', 'CU', 'MS', 'WS', 'EWS'].map((value) => (
                    <option key={value}>{value}</option>
                  ))}
                </select>
              </Field>
              <Field label="运镜">
                <select
                  value={cut.camera.move}
                  onChange={(event) =>
                    update(cut.id, {
                      camera: {
                        ...cut.camera,
                        move: event.target.value as Cut['camera']['move'],
                      },
                    })
                  }
                >
                  {['STATIC', 'PAN', 'ZOOM_IN', 'ZOOM_OUT', 'SHAKE'].map(
                    (value) => (
                      <option key={value}>{value}</option>
                    ),
                  )}
                </select>
              </Field>
              <Field label="生成模式">
                <select
                  value={cut.genMode}
                  onChange={(event) =>
                    update(cut.id, {
                      genMode: event.target.value as Cut['genMode'],
                    })
                  }
                >
                  <option value="first_frame">首帧</option>
                  <option value="first_last">首尾帧</option>
                  <option value="multi_frame">多帧</option>
                  <option value="still_pan">静常运镜</option>
                </select>
              </Field>
              <Field label="重要度">
                <select
                  value={cut.importance}
                  onChange={(event) =>
                    update(cut.id, {
                      importance: event.target.value as Cut['importance'],
                    })
                  }
                >
                  <option value="normal">普通</option>
                  <option value="key">关键</option>
                </select>
              </Field>
              <Field label="台词 ID">
                <input
                  value={cut.dialogueIds.join(',')}
                  onChange={(event) =>
                    update(cut.id, {
                      dialogueIds: event.target.value
                        .split(',')
                        .map((value) => value.trim())
                        .filter(Boolean),
                    })
                  }
                />
              </Field>
              <Field label="可见动作" wide>
                <textarea
                  value={cut.action}
                  onChange={(event) =>
                    update(cut.id, { action: event.target.value })
                  }
                />
              </Field>
              <Field label="局部提示词" wide>
                <textarea
                  value={cut.promptDelta}
                  onChange={(event) =>
                    update(cut.id, { promptDelta: event.target.value })
                  }
                />
              </Field>
            </div>
          </article>
        ))}
        {!draft.cuts.length && (
          <div className="empty-inline">
            分镜尚未生成。先通过剧本与定妆关卡，再运行分镜 Agent。
          </div>
        )}
      </section>
    </div>
  );
}
