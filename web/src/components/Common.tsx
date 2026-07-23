import type { ReactNode } from 'react';

export function SectionHeader({
  eyebrow,
  title,
  detail,
  actions,
}: {
  eyebrow: string;
  title: string;
  detail?: string;
  actions?: ReactNode;
}) {
  return (
    <header className="section-header">
      <div>
        <span className="eyebrow">{eyebrow}</span>
        <h2>{title}</h2>
        {detail && <p>{detail}</p>}
      </div>
      {actions && <div className="section-actions">{actions}</div>}
    </header>
  );
}

export function StatusTag({
  value,
  tone,
}: {
  value: string;
  tone?: 'good' | 'warn' | 'bad' | 'neutral';
}) {
  return <span className={`status-tag ${tone ?? 'neutral'}`}>{value}</span>;
}

export function ProgressBar({ value }: { value: number }) {
  return (
    <span
      className="progress-track"
      role="progressbar"
      aria-valuenow={value}
      aria-valuemin={0}
      aria-valuemax={100}
    >
      <span style={{ width: `${Math.max(0, Math.min(100, value))}%` }} />
    </span>
  );
}

export function EmptyState({
  title,
  detail,
  actions,
}: {
  title: string;
  detail: string;
  actions?: ReactNode;
}) {
  return (
    <div className="empty-state">
      <span className="empty-mark" aria-hidden="true">
        AM
      </span>
      <h2>{title}</h2>
      <p>{detail}</p>
      {actions && <div className="button-row">{actions}</div>}
    </div>
  );
}

export function Field({
  label,
  children,
  wide,
}: {
  label: string;
  children: ReactNode;
  wide?: boolean;
}) {
  return (
    <label className={`field ${wide ? 'wide' : ''}`}>
      <span>{label}</span>
      {children}
    </label>
  );
}

export function formatTime(value: string | undefined): string {
  if (!value) return '—';
  return new Intl.DateTimeFormat('zh-CN', {
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  }).format(new Date(value));
}
