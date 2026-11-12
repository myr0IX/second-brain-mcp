export const logger = {
  info: (msg: string) => process.stderr.write(`[info] ${msg}\n`),
  warn: (msg: string) => process.stderr.write(`[warn] ${msg}\n`),
  error: (msg: string) => process.stderr.write(`[error] ${msg}\n`),
};
