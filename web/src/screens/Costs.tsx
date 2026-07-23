import { SectionHeader } from '../components/Common';
import type { Workspace } from '../types';

export function Costs({ workspace }: { workspace: Workspace }) {
  return (
    <div className="screen-stack">
      <SectionHeader
        eyebrow="Cost ledger"
        title="成本看板"
        detail="只汇总供应商明确返回的价格；未知费用不会被估算成假数字。"
      />
      <section className="cost-banner">
        <div>
          <span>已知总成本</span>
          <strong>¥{workspace.costs.knownTotalCny.toFixed(2)}</strong>
        </div>
        <div>
          <span>未知价格记录</span>
          <strong>{workspace.costs.unknownEntries}</strong>
        </div>
        <div>
          <span>出图次数 / 镜头</span>
          <strong>{workspace.costs.imageDrawsPerCut.toFixed(2)}</strong>
        </div>
      </section>
      <section className="provider-costs">
        <div className="subhead">
          <span className="eyebrow">Provider breakdown</span>
          <h3>供应商分布</h3>
        </div>
        <div className="data-table">
          <div className="table-head">
            <span>供应商</span>
            <span>调用</span>
            <span>已知费用</span>
            <span>未知</span>
          </div>
          {workspace.costs.byProvider.map((row) => (
            <div className="table-row" key={row.provider}>
              <strong>{row.provider}</strong>
              <span>{row.calls}</span>
              <span>¥{row.knownAmountCny.toFixed(2)}</span>
              <span>{row.unknown}</span>
            </div>
          ))}
        </div>
      </section>
      <section className="ledger-section">
        <div className="subhead">
          <span className="eyebrow">Immutable entries</span>
          <h3>调用流水</h3>
        </div>
        <div className="ledger-scroll">
          {workspace.costs.ledger.map((row, index) => (
            <div className="ledger-row" key={`${row.at}-${index}`}>
              <time>{new Date(row.at).toLocaleString()}</time>
              <span>{row.kind}</span>
              <strong>{row.provider}</strong>
              <span>{row.cutId ?? '系列资产'}</span>
              <span>
                {row.quantity} {row.unit}
              </span>
              <b>
                {row.amountCny === undefined
                  ? '未知'
                  : `¥${row.amountCny.toFixed(2)}`}
              </b>
            </div>
          ))}
          {!workspace.costs.ledger.length && (
            <p className="muted">尚无生成调用记录。</p>
          )}
        </div>
      </section>
    </div>
  );
}
