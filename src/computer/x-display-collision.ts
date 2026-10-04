import fs from 'node:fs/promises';

type Lstat = (file: string) => Promise<unknown>;
export type XDisplayCollisionOptions = { fileSystem?: { lstat: Lstat } };

export class XDisplayCollisionError extends Error {
  constructor(readonly file: string, cause?: unknown) {
    super(`X11 display path is occupied or unreadable: ${file}`, { cause });
    this.name = 'XDisplayCollisionError';
  }
}

export function xDisplayCollisionPaths(number: number): string[] {
  if (!Number.isSafeInteger(number) || number < 90 || number > 209)
    throw new RangeError('X11 display number must be an integer from 90 to 209');
  return [
    `/var/lib/xkb/server-${number}.xkm`,
    `/tmp/server-${number}.xkm`,
    `/tmp/.tX${number}-lock`,
    `/tmp/.X${number}-lock`,
    `/tmp/.X11-unix/X${number}`,
  ];
}

/** A pre-spawn observation, not an atomic defense against another same-UID process. */
export async function assertXDisplayCollisionPathsAbsent(number: number,
  options: XDisplayCollisionOptions = {}): Promise<void> {
  const lstat = options.fileSystem?.lstat ?? fs.lstat;
  for (const file of xDisplayCollisionPaths(number)) {
    try { await lstat(file); }
    catch (error) {
      if ((error as NodeJS.ErrnoException)?.code === 'ENOENT') continue;
      throw new XDisplayCollisionError(file, error);
    }
    // lstat observes links themselves, including dangling links. Never repair or retry.
    throw new XDisplayCollisionError(file);
  }
}

/** Keep the final observation adjacent to the actual launch call. */
export async function launchAfterXDisplayCollisionGuard<T>(number: number,
  launch: () => T | Promise<T>, options: XDisplayCollisionOptions = {}): Promise<T> {
  await assertXDisplayCollisionPathsAbsent(number, options);
  return launch();
}

/** A collision leaves only its exact private directory in place for inspection. */
export async function cleanupUnlessXDisplayCollision(error: unknown, dir: string,
  retainedDirs: Set<string>, cleanup: () => Promise<void>): Promise<void> {
  if (error instanceof XDisplayCollisionError) retainedDirs.add(dir);
  else await cleanup();
}
