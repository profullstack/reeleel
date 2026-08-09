import chalk from 'chalk';

import { isReelEelError } from '@reeleel/core';

export interface OutputOptions {
  json: boolean;
  quiet: boolean;
}

const state: OutputOptions = { json: false, quiet: false };

export const configureOutput = (options: Partial<OutputOptions>): void => {
  if (options.json !== undefined) state.json = options.json;
  if (options.quiet !== undefined) state.quiet = options.quiet;
};

export const isJson = (): boolean => state.json;

/**
 * Every command funnels its result through here. In `--json` mode we emit the
 * structured payload and nothing else, so the CLI stays pipeable.
 */
export const emit = (payload: unknown, human: () => void): void => {
  if (state.json) {
    process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
    return;
  }
  if (!state.quiet) human();
};

export const say = (message = ''): void => {
  if (!state.json && !state.quiet) process.stdout.write(`${message}\n`);
};

export const success = (message: string): void => say(`${chalk.green('✓')} ${message}`);
export const warn = (message: string): void => say(`${chalk.yellow('!')} ${message}`);
export const info = (message: string): void => say(`${chalk.dim('·')} ${message}`);
export const heading = (message: string): void => say(chalk.bold(message));

export interface Column<T> {
  header: string;
  value: (row: T) => string;
  align?: 'left' | 'right';
}

/** Strip ANSI colour codes so coloured cells still line up in the table. */
const ANSI_PATTERN = new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, 'g');

const visibleLength = (value: string): number => value.replace(ANSI_PATTERN, '').length;

const pad = (value: string, width: number, align: 'left' | 'right'): string => {
  const padding = ' '.repeat(Math.max(0, width - visibleLength(value)));
  return align === 'right' ? `${padding}${value}` : `${value}${padding}`;
};

export const table = <T>(rows: T[], columns: Column<T>[]): void => {
  if (state.json || state.quiet) return;
  if (rows.length === 0) return;

  const cells = rows.map((row) => columns.map((column) => column.value(row)));
  const widths = columns.map((column, index) =>
    Math.max(visibleLength(column.header), ...cells.map((row) => visibleLength(row[index] ?? ''))),
  );

  say(
    columns
      .map((column, index) =>
        chalk.dim(pad(column.header, widths[index] ?? 0, column.align ?? 'left')),
      )
      .join('  '),
  );

  for (const row of cells) {
    say(
      row
        .map((cell, index) => pad(cell, widths[index] ?? 0, columns[index]?.align ?? 'left'))
        .join('  '),
    );
  }
};

export const formatDuration = (seconds: number): string => {
  if (!Number.isFinite(seconds) || seconds < 0) return '—';
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const secs = Math.floor(seconds % 60);
  if (hours > 0) {
    return `${hours}:${String(minutes).padStart(2, '0')}:${String(secs).padStart(2, '0')}`;
  }
  return `${minutes}:${String(secs).padStart(2, '0')}`;
};

export const formatBytes = (bytes: number): string => {
  if (!Number.isFinite(bytes) || bytes <= 0) return '—';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  const exponent = Math.min(units.length - 1, Math.floor(Math.log(bytes) / Math.log(1024)));
  return `${(bytes / 1024 ** exponent).toFixed(exponent === 0 ? 0 : 1)} ${units[exponent]}`;
};

export const formatScore = (score: number): string => {
  const text = score.toFixed(2);
  if (score >= 0.75) return chalk.green(text);
  if (score >= 0.5) return chalk.yellow(text);
  return chalk.dim(text);
};

/** `included` is a tri-state: kept, rejected, or not yet reviewed. */
export const formatDecision = (included: boolean | null): string => {
  if (included === true) return chalk.green('keep');
  if (included === false) return chalk.red('reject');
  return chalk.dim('undecided');
};

export const fail = (error: unknown): never => {
  if (state.json) {
    const payload = isReelEelError(error)
      ? { ok: false, code: error.code, error: error.message, hint: error.hint }
      : {
          ok: false,
          code: 'UNKNOWN',
          error: error instanceof Error ? error.message : String(error),
        };
    process.stderr.write(`${JSON.stringify(payload, null, 2)}\n`);
  } else if (isReelEelError(error)) {
    process.stderr.write(`${chalk.red('✗')} ${error.message}\n`);
    if (error.hint !== undefined) process.stderr.write(`  ${chalk.dim(error.hint)}\n`);
  } else {
    process.stderr.write(
      `${chalk.red('✗')} ${error instanceof Error ? error.message : String(error)}\n`,
    );
    if (process.env['REELEEL_DEBUG'] === '1' && error instanceof Error && error.stack !== undefined) {
      process.stderr.write(`${chalk.dim(error.stack)}\n`);
    }
  }
  process.exitCode = 1;
  // Callers `return fail(e)` so control flow stays obvious at the call site.
  return undefined as never;
};
