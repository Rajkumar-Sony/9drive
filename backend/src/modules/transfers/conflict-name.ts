export function keepBothName(original: string, existingNames: ReadonlySet<string>): string {
  if (!existingNames.has(original)) return original
  const dot = original.lastIndexOf('.')
  const stem = dot > 0 ? original.slice(0, dot) : original
  const extension = dot > 0 ? original.slice(dot) : ''
  for (let suffix = 2; suffix < 1_000_000; suffix++) {
    const tail = ` (${suffix})${extension}`
    const candidate = `${stem.slice(0, Math.max(1, 255 - tail.length))}${tail}`
    if (!existingNames.has(candidate)) return candidate
  }
  throw new Error('Could not find an available destination filename.')
}
