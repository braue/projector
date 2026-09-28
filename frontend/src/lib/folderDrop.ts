// Reading what the user dropped from the OS: folders walked into files with
// their folder-relative paths (an RTAC export arrives as its folder), files
// dropped on their own kept loose.

/** A file from a picked or dropped folder, with its folder-relative path. */
export type FolderFile = { file: File; path: string }

/** Everything under dropped OS entries: folders walked into FolderFiles,
 *  top-level files kept loose. */
export async function readDropped(entries: FileSystemEntry[]): Promise<{ folders: FolderFile[]; loose: File[] }> {
  const fileOf = (entry: FileSystemEntry) =>
    new Promise<File>((resolve, reject) => (entry as FileSystemFileEntry).file(resolve, reject))
  const childrenOf = async (entry: FileSystemEntry) => {
    const reader = (entry as FileSystemDirectoryEntry).createReader()
    const out: FileSystemEntry[] = []
    // readEntries hands a directory over in batches until an empty one.
    for (;;) {
      const batch = await new Promise<FileSystemEntry[]>((resolve, reject) => reader.readEntries(resolve, reject))
      if (!batch.length) return out
      out.push(...batch)
    }
  }
  // Siblings are read concurrently; each path is fixed, so order doesn't matter.
  const walk = async (entry: FileSystemEntry, prefix: string): Promise<FolderFile[]> => {
    const path = `${prefix}${entry.name}`
    if (entry.isFile) return [{ file: await fileOf(entry), path }]
    const nested = await Promise.all((await childrenOf(entry)).map((child) => walk(child, `${path}/`)))
    return nested.flat()
  }
  const [folders, loose] = await Promise.all([
    Promise.all(entries.filter((e) => e.isDirectory).map((e) => walk(e, ''))).then((nested) => nested.flat()),
    Promise.all(entries.filter((e) => !e.isDirectory).map(fileOf)),
  ])
  return { folders, loose }
}
