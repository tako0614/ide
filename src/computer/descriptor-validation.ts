type Details = { role?: string; pid?: unknown; field?: string; expected?: unknown; observed?: unknown };
export type DescriptorValidationDiagnostic = Readonly<{
  kind: 'rejection' | 'catch'; predicate: string; role?: string; pid?: number;
  field?: string; expected?: number | boolean | string | null;
  observed?: number | boolean | string | null; errno?: string; errorType?: string;
  previousPredicate?: string; boundaries?: readonly string[];
}>;
const observers = new Set<(data: DescriptorValidationDiagnostic) => unknown>();
/** Task-local diagnostics only; an observer cannot replace a rejection or skip cleanup. */
export function observeDescriptorValidationFailures(observer: (data: DescriptorValidationDiagnostic) => unknown): () => void {
  observers.add(observer);
  return () => { observers.delete(observer); };
}
function publish(data: DescriptorValidationDiagnostic): void {
  for (const observer of observers) {
    try { void Promise.resolve(observer(data)).catch(() => undefined); } catch { /* report is best effort */ }
  }
}
const roles = new Set(['descriptor', 'runtime', 'authority', 'owner', 'supervisor',
  'xvfb', 'desktop_runner', 'bounded_session', 'dbus', 'openbox', 'chatgpt', 'auxiliary']);
const tokens = new Set(['INVALID', 'ABSENT', 'PRESENT', 'ready', 'bounded', 'deckide-owned',
  'chatgpt-private-desktop/v1', 'chatgpt-private-desktop/v2', 'MIT-MAGIC-COOKIE-1',
  'node', 'MainThread', 'python3', 'Xvfb', 'dbus-run-sessio', 'dbus-daemon', 'openbox',
  'ChatGPT', 'R', 'S', 'D', 'T', 't', 'I', 'Z', 'X', 'x', 'z']);
const errnos = new Set(['ENOENT', 'ESRCH', 'EACCES', 'EPERM', 'ELOOP', 'ENOTDIR',
  'EIO', 'EBADF', 'EINVAL', 'ETIMEDOUT']);
function name(value: string): string {
  return typeof value === 'string' && /^[a-z][a-z0-9_.-]{0,95}$/.test(value)
    ? value : 'validation.invalid_name';
}
function scalar(value: unknown): number | boolean | string | null {
  if (value === null || typeof value === 'boolean' || Number.isSafeInteger(value))
    return value as number | boolean | null;
  if (typeof value === 'string' && (tokens.has(value) ||
    /^(?:pid|user|mnt|net):\[\d{1,20}\]$/.test(value))) return value;
  return 'INVALID';
}
function diagnostic(kind: 'rejection' | 'catch', predicate: string, details: Details,
  error?: unknown): DescriptorValidationDiagnostic {
  const data: Record<string, unknown> = { kind, predicate: name(predicate) };
  try {
  if (details.role && roles.has(details.role)) data.role = details.role;
  if (Number.isSafeInteger(details.pid) && (details.pid as number) > 1) data.pid = details.pid;
  if (details.field) data.field = name(details.field);
  if ('expected' in details) data.expected = scalar(details.expected);
  if ('observed' in details) data.observed = scalar(details.observed);
  if (error && typeof error === 'object') {
    // Reading exception getters can itself throw or expose arbitrary text.
    const code = Object.getOwnPropertyDescriptor(error, 'code')?.value;
    const errorName = error instanceof DescriptorValidationError ? 'DescriptorValidationError'
      : error instanceof SyntaxError ? 'SyntaxError' : error instanceof TypeError ? 'TypeError'
      : error instanceof RangeError ? 'RangeError' : error instanceof Error ? 'Error' : undefined;
    if (typeof code === 'string' && errnos.has(code)) data.errno = code;
    if (typeof errorName === 'string' &&
      ['Error', 'TypeError', 'SyntaxError', 'RangeError', 'DescriptorValidationError'].includes(errorName))
      data.errorType = errorName;
    if (error instanceof DescriptorValidationError) data.previousPredicate = error.diagnostic.predicate;
  }
  } catch { /* Retain the fixed boundary name; never replace validation/cleanup. */ }
  return Object.freeze(data) as DescriptorValidationDiagnostic;
}

/** Only allowlisted lifecycle metadata is emitted. No paths, hashes, session IDs,
 * descriptor text, exception message/stack, authority or environment values. */
export class DescriptorValidationError extends Error {
  readonly code?: string;
  constructor(readonly diagnostic: DescriptorValidationDiagnostic,
    message = 'Borrowed desktop descriptor is unverified') {
    const prefix = ['Borrowed desktop descriptor is unverified',
      'ChatGPT desktop ownership could not be verified',
      'ChatGPT desktop generation is unavailable'].includes(message)
      ? message : 'Borrowed desktop descriptor is unverified';
    super(`${prefix} [${diagnostic.predicate}]`);
    this.name = 'DescriptorValidationError';
    this.code = diagnostic.errno;
  }
}
export function rejectDescriptorValidation(predicate: string, details: Details = {},
  error?: unknown, message?: string): never {
  const data = diagnostic('rejection', predicate, details, error);
  publish(data);
  throw new DescriptorValidationError(data, message);
}
export function descriptorValidationBoundary(predicate: string, error: unknown,
  message?: string, details: Details = {}): DescriptorValidationError {
  const data = diagnostic('catch', predicate, details, error);
  publish(data);
  try {
    if (error instanceof DescriptorValidationError) {
      return new DescriptorValidationError(Object.freeze({ ...error.diagnostic,
        boundaries: Object.freeze([...(error.diagnostic.boundaries ?? []), data.predicate].slice(-12)) }), message);
    }
  } catch { /* Unexpected exception access must not skip guarded cleanup. */ }
  return new DescriptorValidationError(data, message);
}
