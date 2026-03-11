export function getDefaultShell(): string {
  return (
    process.env.SHELL ||
    (process.platform === 'win32' ? 'powershell.exe' : 'bash')
  );
}
