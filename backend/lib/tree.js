// Fold flat item nodes (path-keyed, forward-slash separated) into a nested
// folder tree, sorted folders-first. Flat paths (no slashes) simply come back
// as a flat list. `errors` rows (files a parser rejected) still appear —
// visibility beats silently shrinking the tree.

function foldTree(nodes, errors = []) {
  const root = { type: 'folder', name: '', path: '', children: [] };
  const folders = new Map([['', root]]);

  const folderFor = (dirPath) => {
    const existing = folders.get(dirPath);
    if (existing) return existing;
    const parent = folderFor(dirPath.split('/').slice(0, -1).join('/'));
    const folder = {
      type: 'folder',
      name: dirPath.split('/').pop(),
      path: dirPath,
      children: [],
    };
    parent.children.push(folder);
    folders.set(dirPath, folder);
    return folder;
  };

  const place = (node) => {
    const dir = node.path.split('/').slice(0, -1).join('/');
    folderFor(dir).children.push(node);
  };

  for (const node of nodes) place(node);

  for (const { file, error } of errors) {
    place({
      type: 'item',
      name: file.split('/').pop(),
      path: file,
      kind: 'ParseError',
      kindLabel: 'Unparseable file',
      category: 'other',
      error,
    });
  }

  const sortTree = (node) => {
    node.children.sort(treeOrder);
    for (const child of node.children) if (child.type === 'folder') sortTree(child);
  };
  sortTree(root);
  return root.children;
}

// Folders first, then natural name order — the one ordering every tree
// (inspect, compare, project files) shares.
function treeOrder(a, b) {
  if (a.type !== b.type) return a.type === 'folder' ? -1 : 1;
  return a.name.localeCompare(b.name, undefined, { numeric: true });
}

export { foldTree, treeOrder };
