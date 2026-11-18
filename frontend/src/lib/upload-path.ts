export function folderSegments(relativePath: string): string[] {
  const segments = relativePath.split('/')
  if (segments.length < 2 || segments.length > 33 || segments.some((segment) => !segment || segment === '.' || segment === '..' || segment.length > 255 || /[\\\u0000-\u001f]/.test(segment))) {
    throw new Error('Folder path is invalid or too deep.')
  }
  return segments.slice(0, -1)
}
