import { env } from './env';

type LogLevel = 'info' | 'warn' | 'error' | 'debug';

function write(level: LogLevel, message: string, meta?: unknown): void {
  const entry: Record<string, unknown> = {
    ts: new Date().toISOString(),
    level,
    message,
  };
  if (meta !== undefined) {
    entry['meta'] = meta instanceof Error
      ? { name: meta.name, message: meta.message, stack: meta.stack }
      : meta;
  }
  const line = JSON.stringify(entry);
  if (level === 'error' || level === 'warn') process.stderr.write(line + '\n');
  else process.stdout.write(line + '\n');
}

export const logger = {
  info:  (msg: string, meta?: unknown) => write('info',  msg, meta),
  warn:  (msg: string, meta?: unknown) => write('warn',  msg, meta),
  error: (msg: string, meta?: unknown) => write('error', msg, meta),
  debug: (msg: string, meta?: unknown) => {
    if (env.NODE_ENV !== 'production') write('debug', msg, meta);
  },
};
