import { EmptyState, SectionHeader, StatusTag } from '../components/Common';
import type { Workspace } from '../types';

export function Delivery({
  workspace,
  onApprove,
}: {
  workspace: Workspace;
  onApprove: () => void;
}) {
  const delivery = workspace.state.delivery;
  if (!delivery) {
    return (
      <div className="screen-stack">
        <SectionHeader
          eyebrow="Picture lock"
          title="成片交付"
          detail="所有卡通过作监并完成合成后，交付物会出现在这里。"
        />
        <EmptyState
          title="尚无通过 QC 的成片"
          detail="在概览执行成片合成；自动 QC 通过后才能批准关卡③。"
        />
      </div>
    );
  }
  return (
    <div className="screen-stack">
      <SectionHeader
        eyebrow="Picture lock"
        title="成片交付"
        detail={`${delivery.durationSec.toFixed(2)} 秒 · 1080×1920 · AIGC 标识已烧录`}
        actions={
          <button
            className="button primary"
            disabled={Boolean(workspace.state.gates.final)}
            onClick={onApprove}
          >
            {workspace.state.gates.final ? '关卡③已批准' : '批准成片'}
          </button>
        }
      />
      <div className="delivery-grid">
        <div className="delivery-player">
          {delivery.finalVideoUrl ? (
            <video src={delivery.finalVideoUrl} controls playsInline />
          ) : (
            <div className="media-placeholder">成片路径不在项目根目录</div>
          )}
        </div>
        <aside className="delivery-manifest">
          <span className="eyebrow">Delivery manifest</span>
          <h3>{workspace.script.title}</h3>
          <dl>
            <div>
              <dt>自动 QC</dt>
              <dd>
                <StatusTag value="PASS" tone="good" />
              </dd>
            </div>
            <div>
              <dt>人工确认</dt>
              <dd>
                <StatusTag
                  value={workspace.state.gates.final ? 'LOCKED' : 'PENDING'}
                  tone={workspace.state.gates.final ? 'good' : 'warn'}
                />
              </dd>
            </div>
            <div>
              <dt>QC 时间</dt>
              <dd>{new Date(delivery.qcPassedAt).toLocaleString()}</dd>
            </div>
          </dl>
          <div className="download-stack">
            {delivery.finalVideoUrl && (
              <a className="button ghost" href={delivery.finalVideoUrl} download>
                下载 MP4
              </a>
            )}
            {delivery.subtitlesUrl && (
              <a className="button ghost" href={delivery.subtitlesUrl} download>
                下载 SRT
              </a>
            )}
            {delivery.coverUrl && (
              <a className="button ghost" href={delivery.coverUrl} download>
                下载封面
              </a>
            )}
          </div>
          <p className="small-note">
            剪映 native draft 为实验性结构；timeline.json 是稳定重建依据。
          </p>
        </aside>
      </div>
    </div>
  );
}
