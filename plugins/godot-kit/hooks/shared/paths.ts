// Path helpers shared by every godot-kit feature. Pure: no `$`.

/** Forward slashes, no trailing slash (a drive root keeps its slash). */
export function norm(path: string): string {
  const slashed = path.replace(/\\/g, '/')
  if (/^[A-Za-z]:\/$/.test(slashed) || slashed === '/') return slashed
  return slashed.replace(/\/+$/, '')
}

/** Windows paths compare without case. */
export function isWindowsPath(path: string): boolean {
  return /^[A-Za-z]:\//.test(norm(path))
}

/** The key a file is kept under: normalised, lower-cased on Windows. */
export function fileKey(path: string): string {
  const n = norm(path)
  return isWindowsPath(n) ? n.toLowerCase() : n
}

export function isAbsolute(path: string): boolean {
  return /^([A-Za-z]:)?[\\/]/.test(path)
}

export function join(dir: string, name: string): string {
  return `${norm(dir).replace(/\/$/, '')}/${name.replace(/^[\\/]+/, '')}`
}

export function dirname(path: string): string {
  const n = norm(path)
  const cut = n.lastIndexOf('/')
  if (cut < 0) return '.'
  const head = n.slice(0, cut)
  return /^[A-Za-z]:$/.test(head) ? `${head}/` : head === '' ? '/' : head
}

/** Whether `file` lies inside `dir` (or is it). */
export function isInside(file: string, dir: string): boolean {
  const f = fileKey(file)
  const d = fileKey(dir).replace(/\/$/, '')
  return f === d || f.startsWith(`${d}/`)
}

/** `C:/game/scripts/player.gd` in project `C:/game` -> `res://scripts/player.gd`. */
export function toRes(file: string, project: string): string {
  const f = norm(file)
  const p = norm(project).replace(/\/$/, '')
  return `res://${f.slice(p.length + 1)}`
}

/** `res://scripts/player.gd` in project `C:/game` -> `C:/game/scripts/player.gd`. */
export function fromRes(res: string, project: string): string {
  return join(project, res.replace(/^res:\/\//, ''))
}

export function isGdScript(path: string): boolean {
  return /\.gd$/i.test(path)
}

/**
 * The .gd paths a shell command names, as written (relative or absolute).
 * Best effort: a glob or a computed name is not seen.
 */
export function gdPathsIn(command: string): string[] {
  const found = new Set<string>()
  const pattern = /(?:[A-Za-z]:)?[^\s"'`<>|;&(){}=,]*\.gd(?![\w.])/g
  for (const match of command.matchAll(pattern)) {
    const path = match[0]
    if (path.startsWith('res://') || path.includes('*')) continue
    found.add(path)
    if (found.size >= 20) break
  }
  return [...found]
}
