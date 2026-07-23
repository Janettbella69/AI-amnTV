import { useMemo, useState, type DragEvent } from 'react';
import { api } from '../api';
import { Field, SectionHeader, StatusTag } from '../components/Common';
import type {
  ImportKind,
  ImportMetadata,
  ImportPreview,
  ImportRequest,
  ImportResult,
} from '../types';

const modes: Array<{
  id: ImportKind;
  code: string;
  title: string;
  detail: string;
}> = [
  {
    id: 'project',
    code: '01',
    title: 'AI-amnTV 项目目录',
    detail: '迁移完整项目、素材、候选与历史状态',
  },
  {
    id: 'script',
    code: '02',
    title: '结构化剧本',
    detail: '导入 YAML / JSON，可包含分镜与资产档案',
  },
  {
    id: 'outline',
    code: '03',
    title: '小说或大纲',
    detail: '导入 TXT / Markdown，交给编剧 Agent 拆分',
  },
];

const emptyMetadata: ImportMetadata = {
  seriesId: '',
  title: '',
  genre: '女性向漫剧',
  logline: '',
  episodeId: 'EP01',
};

function bytes(value: number): string {
  if (value < 1024) return `${value} B`;
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KB`;
  if (value < 1024 * 1024 * 1024) {
    return `${(value / 1024 / 1024).toFixed(1)} MB`;
  }
  return `${(value / 1024 / 1024 / 1024).toFixed(1)} GB`;
}

export function ImportCenter({
  onComplete,
}: {
  onComplete: (result: ImportResult) => Promise<void>;
}) {
  const [kind, setKind] = useState<ImportKind>('project');
  const [sourcePath, setSourcePath] = useState('');
  const [targetSeriesId, setTargetSeriesId] = useState('');
  const [filename, setFilename] = useState('');
  const [content, setContent] = useState('');
  const [metadata, setMetadata] = useState(emptyMetadata);
  const [preview, setPreview] = useState<ImportPreview>();
  const [error, setError] = useState('');
  const [busy, setBusy] = useState<'preview' | 'commit'>();

  const request = useMemo<ImportRequest | undefined>(() => {
    if (kind === 'project') {
      if (!sourcePath.trim()) return undefined;
      return {
        kind,
        sourcePath: sourcePath.trim(),
        targetSeriesId: targetSeriesId.trim(),
      };
    }
    if (!content.trim()) return undefined;
    return {
      kind,
      filename:
        filename ||
        (kind === 'script' ? 'imported-script.yaml' : 'imported-outline.md'),
      content,
      metadata,
    };
  }, [content, filename, kind, metadata, sourcePath, targetSeriesId]);

  const invalidatePreview = () => {
    setPreview(undefined);
    setError('');
  };

  const changeKind = (next: ImportKind) => {
    setKind(next);
    setFilename('');
    setContent('');
    setPreview(undefined);
    setError('');
  };

  const acceptFile = async (file: File) => {
    if (file.size > 1_500_000) {
      setError('文本文件不能超过 1.5MB；完整大项目请使用项目目录导入');
      return;
    }
    setFilename(file.name);
    setContent(await file.text());
    setPreview(undefined);
    setError('');
  };

  const drop = (event: DragEvent<HTMLLabelElement>) => {
    event.preventDefault();
    const file = event.dataTransfer.files[0];
    if (file) void acceptFile(file);
  };

  const runPreview = async () => {
    if (!request) return;
    setBusy('preview');
    setError('');
    try {
      const value = await api.previewImport(request);
      setPreview(value);
      if (value.normalized.seriesId) {
        if (kind === 'project') {
          setTargetSeriesId(value.normalized.seriesId);
        } else {
          setMetadata(value.normalized);
        }
      }
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setBusy(undefined);
    }
  };

  const commit = async () => {
    if (!request || !preview?.ready) return;
    setBusy('commit');
    setError('');
    try {
      const result = await api.commitImport(request);
      await onComplete(result);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setBusy(undefined);
    }
  };

  const updateMetadata = (patch: Partial<ImportMetadata>) => {
    setMetadata((current) => ({ ...current, ...patch }));
    invalidatePreview();
  };

  return (
    <div className="screen-stack import-center">
      <SectionHeader
        eyebrow="Ingest desk"
        title="导入生产资料"
        detail="先预检、再落盘。不会覆盖现有系列，原文件与历史 take 保持不变。"
        actions={
          <StatusTag
            value={preview?.ready ? 'READY TO IMPORT' : 'PRECHECK REQUIRED'}
            tone={preview?.ready ? 'good' : 'neutral'}
          />
        }
      />

      <div className="import-modes" aria-label="导入类型">
        {modes.map((mode) => (
          <button
            key={mode.id}
            className={kind === mode.id ? 'active' : ''}
            onClick={() => changeKind(mode.id)}
          >
            <span>{mode.code}</span>
            <strong>{mode.title}</strong>
            <small>{mode.detail}</small>
          </button>
        ))}
      </div>

      <div className="import-workbench">
        <section className="import-form-panel">
          <header className="ledger-header">
            <div>
              <span className="eyebrow">01 · Source</span>
              <h3>选择来源</h3>
            </div>
            <small>只读取预检，不会立即写入</small>
          </header>

          {kind === 'project' ? (
            <div className="import-fields">
              <Field label="本机项目目录" wide>
                <input
                  autoFocus
                  placeholder="/Users/name/Projects/my-series"
                  value={sourcePath}
                  onChange={(event) => {
                    setSourcePath(event.target.value);
                    invalidatePreview();
                  }}
                />
              </Field>
              <p className="field-help">
                在 Finder 选中项目目录后按 ⌥⌘C 复制路径。目录根部必须包含
                series.yaml；素材、候选图和历史状态会一并复制。
              </p>
              <Field label="导入后的系列 ID（可选）" wide>
                <input
                  placeholder="留空则沿用 series.yaml 中的 ID"
                  value={targetSeriesId}
                  onChange={(event) => {
                    setTargetSeriesId(event.target.value);
                    invalidatePreview();
                  }}
                />
              </Field>
            </div>
          ) : (
            <>
              <div className="import-fields">
                <label
                  className={`file-drop ${filename ? 'has-file' : ''}`}
                  htmlFor="import-source-file"
                  onDragOver={(event) => event.preventDefault()}
                  onDrop={drop}
                >
                  <input
                    id="import-source-file"
                    type="file"
                    accept={
                      kind === 'script'
                        ? '.yaml,.yml,.json,application/json,text/yaml'
                        : '.txt,.md,text/plain,text/markdown'
                    }
                    onChange={(event) => {
                      const file = event.target.files?.[0];
                      if (file) void acceptFile(file);
                    }}
                  />
                  <span>{filename ? 'SOURCE ATTACHED' : 'DROP OR CHOOSE'}</span>
                  <strong>{filename || (kind === 'script'
                    ? '选择 YAML / JSON 剧本'
                    : '选择 TXT / Markdown 小说')}</strong>
                  <small>
                    {content
                      ? `${[...content].length.toLocaleString()} 字符 · ${bytes(
                          new Blob([content]).size,
                        )}`
                      : '最大 1.5MB，文件内容只发送到本机 Studio'}
                  </small>
                </label>
                {kind === 'outline' && (
                  <Field label="也可以直接粘贴正文" wide>
                    <textarea
                      className="source-paste"
                      placeholder="粘贴小说正文、章节梗概或分集大纲……"
                      value={content}
                      onChange={(event) => {
                        setContent(event.target.value);
                        if (!filename) setFilename('pasted-outline.md');
                        invalidatePreview();
                      }}
                    />
                  </Field>
                )}
              </div>

              <header className="ledger-header metadata-header">
                <div>
                  <span className="eyebrow">02 · Identity</span>
                  <h3>归档信息</h3>
                </div>
                <small>结构化文件会在预检后自动回填</small>
              </header>
              <div className="import-metadata">
                <Field label="系列 ID">
                  <input
                    placeholder="my-series"
                    value={metadata.seriesId}
                    onChange={(event) =>
                      updateMetadata({ seriesId: event.target.value })
                    }
                  />
                </Field>
                <Field label="分集 ID">
                  <input
                    value={metadata.episodeId}
                    onChange={(event) =>
                      updateMetadata({
                        episodeId: event.target.value.toUpperCase(),
                      })
                    }
                    disabled={kind === 'script'}
                  />
                </Field>
                <Field label="系列名称" wide>
                  <input
                    value={metadata.title}
                    onChange={(event) =>
                      updateMetadata({ title: event.target.value })
                    }
                  />
                </Field>
                <Field label="类型">
                  <input
                    value={metadata.genre}
                    onChange={(event) =>
                      updateMetadata({ genre: event.target.value })
                    }
                  />
                </Field>
                <Field label="一句话故事" wide>
                  <textarea
                    value={metadata.logline}
                    onChange={(event) =>
                      updateMetadata({ logline: event.target.value })
                    }
                  />
                </Field>
              </div>
            </>
          )}

          {error && <p className="import-error">{error}</p>}
          <footer className="import-actions">
            <span>预检不会产生文件或云端费用</span>
            <button
              className="button ghost"
              disabled={!request || Boolean(busy)}
              onClick={() => void runPreview()}
            >
              {busy === 'preview' ? '正在扫描' : '1 / 2 预检资料'}
            </button>
          </footer>
        </section>

        <section className="import-preview-panel">
          <header className="ledger-header">
            <div>
              <span className="eyebrow">03 · Preflight</span>
              <h3>导入清单</h3>
            </div>
            {preview && (
              <StatusTag
                value={preview.ready ? 'PASS' : 'BLOCKED'}
                tone={preview.ready ? 'good' : 'bad'}
              />
            )}
          </header>

          {!preview ? (
            <div className="import-awaiting">
              <span>WAITING FOR SOURCE</span>
              <strong>尚未执行预检</strong>
              <p>选择资料并点击“预检资料”，这里会显示结构、冲突和缺失项。</p>
            </div>
          ) : (
            <>
              <div className="import-summary">
                <div>
                  <span>系列</span>
                  <strong>{preview.normalized.title}</strong>
                  <small>{preview.normalized.seriesId}</small>
                </div>
                <div>
                  <span>分集</span>
                  <strong>{preview.summary.episodes}</strong>
                  <small>{preview.normalized.episodeId || '未识别'}</small>
                </div>
                <div>
                  <span>场 / 卡</span>
                  <strong>
                    {preview.summary.scenes} / {preview.summary.cuts}
                  </strong>
                  <small>结构化内容</small>
                </div>
                <div>
                  <span>角色 / 场景</span>
                  <strong>
                    {preview.summary.characters} / {preview.summary.locations}
                  </strong>
                  <small>资产档案</small>
                </div>
                <div>
                  <span>体积</span>
                  <strong>{bytes(preview.summary.bytes)}</strong>
                  <small>
                    {preview.summary.files
                      ? `${preview.summary.files.toLocaleString()} 个文件`
                      : preview.summary.source}
                  </small>
                </div>
              </div>

              {(preview.errors.length > 0 || preview.warnings.length > 0) && (
                <div className="import-findings">
                  {preview.errors.map((item) => (
                    <p className="blocking" key={item}>
                      <span>BLOCK</span>
                      {item}
                    </p>
                  ))}
                  {preview.warnings.map((item) => (
                    <p key={item}>
                      <span>NOTE</span>
                      {item}
                    </p>
                  ))}
                </div>
              )}

              <dl className="import-contract">
                <div>
                  <dt>写入策略</dt>
                  <dd>仅创建新系列，不覆盖同名目录</dd>
                </div>
                <div>
                  <dt>源资料</dt>
                  <dd>保持不变</dd>
                </div>
                <div>
                  <dt>事实源</dt>
                  <dd>项目 YAML 与本地媒体</dd>
                </div>
              </dl>
            </>
          )}

          <footer className="import-commit">
            <p>
              {preview?.ready
                ? '预检通过，可以写入当前项目库。'
                : '解决阻塞项后才能导入。'}
            </p>
            <button
              className="button primary"
              disabled={!preview?.ready || Boolean(busy)}
              onClick={() => void commit()}
            >
              {busy === 'commit'
                ? '正在导入'
                : preview?.summary.alreadyAvailable
                  ? '打开已有项目'
                  : '2 / 2 确认导入'}
            </button>
          </footer>
        </section>
      </div>
    </div>
  );
}
