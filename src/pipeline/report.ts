import type { QcReport } from './qc.js';
import { writeYaml } from '../store.js';

export function qcReportText(report: QcReport): string {
  return report.checks
    .map((check) => `${check.ok ? '✓' : '✗'} ${check.key}: ${check.actual}`)
    .join('\n');
}

export function exportQcReport(file: string, report: QcReport): void {
  writeYaml(file, report);
}
