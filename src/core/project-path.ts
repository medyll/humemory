/** Browser-safe lexical normalization; POSIX identities remain case sensitive. */
export function projectPath(path: string): string {
  const windows = /^[a-z]:[\\/]/i.test(path) || path.startsWith('\\\\');
  const normalized = path.replace(/\\/g, '/').replace(/\/$/, '').replace(/^\.\//, '');
  return windows ? normalized.toLowerCase() : normalized;
}

export function remapPath(path: string, from: string, to: string): string {
  const key = projectPath(path);
  const source = projectPath(from);
  if (key !== source && !key.startsWith(source + '/')) return path;
  const suffix = path.replace(/\\/g, '/').replace(/\/$/, '').slice(source.length);
  return to.replace(/\\/g, '/').replace(/\/$/, '') + suffix;
}
