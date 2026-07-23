import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';

export const jobTypes = [
  'script',
  'cast',
  'storyboard',
  'audio',
  'keyframes',
  'video',
  'compose',
] as const;
export type StudioJobType = (typeof jobTypes)[number];
export type StudioJobStatus =
  | 'queued'
  | 'running'
  | 'succeeded'
  | 'failed'
  | 'cancelled';

interface JobRow {
  id: string;
  series_id: string;
  episode_id: string;
  type: StudioJobType;
  payload_json: string;
  status: StudioJobStatus;
  progress: number;
  message: string;
  error: string | null;
  created_at: string;
  started_at: string | null;
  finished_at: string | null;
  updated_at: string;
}

export interface StudioJob {
  id: string;
  seriesId: string;
  episodeId: string;
  type: StudioJobType;
  payload: Record<string, unknown>;
  status: StudioJobStatus;
  progress: number;
  message: string;
  error?: string;
  createdAt: string;
  startedAt?: string;
  finishedAt?: string;
  updatedAt: string;
}

const now = () => new Date().toISOString();

function mapJob(row: JobRow): StudioJob {
  return {
    id: row.id,
    seriesId: row.series_id,
    episodeId: row.episode_id,
    type: row.type,
    payload: JSON.parse(row.payload_json) as Record<string, unknown>,
    status: row.status,
    progress: row.progress,
    message: row.message,
    ...(row.error ? { error: row.error } : {}),
    createdAt: row.created_at,
    ...(row.started_at ? { startedAt: row.started_at } : {}),
    ...(row.finished_at ? { finishedAt: row.finished_at } : {}),
    updatedAt: row.updated_at,
  };
}

export class StudioDatabase {
  private readonly database: Database.Database;

  constructor(readonly file: string) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    this.database = new Database(file);
    this.database.pragma('journal_mode = WAL');
    this.database.pragma('foreign_keys = ON');
    this.database.exec(`
      CREATE TABLE IF NOT EXISTS jobs (
        id TEXT PRIMARY KEY,
        series_id TEXT NOT NULL,
        episode_id TEXT NOT NULL,
        type TEXT NOT NULL,
        payload_json TEXT NOT NULL DEFAULT '{}',
        status TEXT NOT NULL,
        progress INTEGER NOT NULL DEFAULT 0 CHECK(progress BETWEEN 0 AND 100),
        message TEXT NOT NULL DEFAULT '',
        error TEXT,
        created_at TEXT NOT NULL,
        started_at TEXT,
        finished_at TEXT,
        updated_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_jobs_status_created
        ON jobs(status, created_at);
      CREATE INDEX IF NOT EXISTS idx_jobs_project
        ON jobs(series_id, episode_id, created_at DESC);
    `);
    this.recoverInterrupted();
  }

  private recoverInterrupted(): void {
    const at = now();
    this.database
      .prepare(
        `UPDATE jobs
         SET status = 'failed',
             error = '工作台进程重启，任务未自动重提',
             message = '已中断',
             finished_at = ?,
             updated_at = ?
         WHERE status = 'running'`,
      )
      .run(at, at);
  }

  enqueue(input: {
    seriesId: string;
    episodeId: string;
    type: StudioJobType;
    payload?: Record<string, unknown>;
  }): StudioJob {
    const active = this.database
      .prepare(
        `SELECT * FROM jobs
         WHERE series_id = ? AND episode_id = ? AND type = ?
           AND status IN ('queued', 'running')
         ORDER BY created_at DESC LIMIT 1`,
      )
      .get(input.seriesId, input.episodeId, input.type) as JobRow | undefined;
    if (active) return mapJob(active);
    const id = randomUUID();
    const at = now();
    this.database
      .prepare(
        `INSERT INTO jobs (
          id, series_id, episode_id, type, payload_json, status,
          progress, message, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, 'queued', 0, '等待执行', ?, ?)`,
      )
      .run(
        id,
        input.seriesId,
        input.episodeId,
        input.type,
        JSON.stringify(input.payload ?? {}),
        at,
        at,
      );
    return this.get(id)!;
  }

  get(id: string): StudioJob | undefined {
    const row = this.database.prepare('SELECT * FROM jobs WHERE id = ?').get(id) as
      | JobRow
      | undefined;
    return row ? mapJob(row) : undefined;
  }

  list(input?: {
    seriesId?: string;
    episodeId?: string;
    limit?: number;
  }): StudioJob[] {
    const conditions: string[] = [];
    const parameters: Array<string | number> = [];
    if (input?.seriesId) {
      conditions.push('series_id = ?');
      parameters.push(input.seriesId);
    }
    if (input?.episodeId) {
      conditions.push('episode_id = ?');
      parameters.push(input.episodeId);
    }
    parameters.push(Math.min(200, Math.max(1, input?.limit ?? 50)));
    const rows = this.database
      .prepare(
        `SELECT * FROM jobs
         ${conditions.length ? `WHERE ${conditions.join(' AND ')}` : ''}
         ORDER BY created_at DESC LIMIT ?`,
      )
      .all(...parameters) as JobRow[];
    return rows.map(mapJob);
  }

  claimNext(): StudioJob | undefined {
    const claim = this.database.transaction(() => {
      const row = this.database
        .prepare(
          `SELECT * FROM jobs WHERE status = 'queued'
           ORDER BY created_at ASC LIMIT 1`,
        )
        .get() as JobRow | undefined;
      if (!row) return undefined;
      const at = now();
      this.database
        .prepare(
          `UPDATE jobs
           SET status = 'running', progress = 2, message = '正在启动',
               started_at = ?, updated_at = ?
           WHERE id = ? AND status = 'queued'`,
        )
        .run(at, at, row.id);
      return this.get(row.id);
    });
    return claim();
  }

  updateProgress(id: string, progress: number, message: string): StudioJob {
    this.database
      .prepare(
        `UPDATE jobs SET progress = ?, message = ?, updated_at = ? WHERE id = ?`,
      )
      .run(Math.min(99, Math.max(0, Math.round(progress))), message, now(), id);
    const job = this.get(id);
    if (!job) throw new Error(`任务不存在: ${id}`);
    return job;
  }

  succeed(id: string, message = '完成'): StudioJob {
    const at = now();
    this.database
      .prepare(
        `UPDATE jobs
         SET status = 'succeeded', progress = 100, message = ?,
             error = NULL, finished_at = ?, updated_at = ?
         WHERE id = ?`,
      )
      .run(message, at, at, id);
    return this.get(id)!;
  }

  fail(id: string, error: string): StudioJob {
    const at = now();
    this.database
      .prepare(
        `UPDATE jobs
         SET status = 'failed', message = '执行失败', error = ?,
             finished_at = ?, updated_at = ?
         WHERE id = ?`,
      )
      .run(error, at, at, id);
    return this.get(id)!;
  }

  cancel(id: string): StudioJob {
    const at = now();
    const result = this.database
      .prepare(
        `UPDATE jobs
         SET status = 'cancelled', message = '已取消',
             finished_at = ?, updated_at = ?
         WHERE id = ? AND status = 'queued'`,
      )
      .run(at, at, id);
    if (result.changes === 0) throw new Error('只能取消尚未开始的任务');
    return this.get(id)!;
  }

  close(): void {
    this.database.close();
  }
}
