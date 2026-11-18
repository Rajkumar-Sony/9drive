import { apiFetch } from '@/lib/api'
import { folderSegments } from '@/lib/upload-path'

export async function resolveUploadFolder(relativePath: string | null | undefined, rootFolderId: string | null, cache: Map<string, string>): Promise<string | null> {
  if (!relativePath) return rootFolderId
  let parentId = rootFolderId
  for (const name of folderSegments(relativePath)) {
    const key = JSON.stringify([parentId, name])
    const cached = cache.get(key)
    if (cached) { parentId = cached; continue }
    const query = parentId ? `?parentId=${encodeURIComponent(parentId)}` : ''
    const existing = await apiFetch<{ folders: Array<{ id: string; name: string }> }>(`/folders${query}`)
    const found = existing.folders.find((folder) => folder.name === name)
    const id = found?.id ?? (await apiFetch<{ folder: { id: string } }>('/folders', { method: 'POST', body: JSON.stringify({ name, parentId }) })).folder.id
    cache.set(key, id)
    parentId = id
  }
  return parentId
}
