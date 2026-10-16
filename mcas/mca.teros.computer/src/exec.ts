import { execFile } from 'node:child_process';

export interface ExecResult {
  stdout: string;
  stderr: string;
  exitCode: number;
  timedOut: boolean;
}

/** The X display every desktop process uses (set by the image entrypoint). */
export const DISPLAY = process.env.DISPLAY || ':1';

/**
 * Run a program without a shell (arguments are never interpreted), with the
 * desktop's DISPLAY. Never rejects: callers decide what a non-zero exit means.
 */
export function run(
  file: string,
  args: string[],
  opts: { timeoutMs?: number; cwd?: string; maxBuffer?: number } = {},
): Promise<ExecResult> {
  return new Promise((resolve) => {
    execFile(
      file,
      args,
      {
        timeout: opts.timeoutMs ?? 15_000,
        cwd: opts.cwd,
        maxBuffer: opts.maxBuffer ?? 8 * 1024 * 1024,
        env: { ...process.env, DISPLAY },
        encoding: 'utf8',
      },
      (error, stdout, stderr) => {
        const err = error as (NodeJS.ErrnoException & { killed?: boolean; code?: number | string }) | null;
        resolve({
          stdout: stdout ?? '',
          stderr: stderr ?? '',
          exitCode: err ? (typeof err.code === 'number' ? err.code : 1) : 0,
          timedOut: Boolean(err?.killed),
        });
      },
    );
  });
}
