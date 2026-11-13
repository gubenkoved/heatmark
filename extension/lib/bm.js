// Bookmark-tree helpers shared by the popup, the manager page and the background worker.

export const ARCHIVE_TITLE = 'Archive';

export async function getRoot() {
  const [root] = await chrome.bookmarks.getTree();
  return root;
}

// Chrome 134+ tags permanent folders with folderType; older versions use fixed ids.
function isOtherRoot(n) {
  return n.folderType ? n.folderType === 'other' : n.id === '2';
}

// "Other bookmarks" — preferring the synced (account) copy when Chrome has both. With
// `localOnly`, a device-only folder when this profile has one: a profile with Chrome Sync
// on keeps a single, synced set of folders.
export async function getOtherRootId(localOnly = false) {
  const root = await getRoot();
  const others = root.children.filter(isOtherRoot);
  const local = localOnly && (others.find((node) => node.syncing === false)
    || root.children.find((node) => node.folderType === 'bookmarks-bar' && node.syncing === false));
  const pick = local || others.find((n) => n.syncing) || others[0] || root.children[root.children.length - 1];
  return pick.id;
}

// Archive = a plain folder inside "Other bookmarks". Non-destructive, still synced.
export async function ensureArchiveFolder() {
  const { archiveFolderId } = await chrome.storage.local.get('archiveFolderId');
  if (archiveFolderId) {
    try {
      const [n] = await chrome.bookmarks.get(archiveFolderId);
      if (n && !n.url) return n.id;
    } catch { /* deleted — recreate below */ }
  }
  const otherId = await getOtherRootId();
  const children = await chrome.bookmarks.getChildren(otherId);
  const folder =
    children.find((c) => !c.url && c.title === ARCHIVE_TITLE) ||
    (await chrome.bookmarks.create({ parentId: otherId, title: ARCHIVE_TITLE }));
  await chrome.storage.local.set({ archiveFolderId: folder.id });
  return folder.id;
}

// Flatten the tree. URL entries and folders know their path and ancestor ids.
export function indexTree(root, archiveId) {
  const byId = new Map();
  const urls = [];
  const entryById = new Map();
  const folders = [];
  const folderById = new Map();

  function walk(node, path, ancestors, depth, inArchive) {
    byId.set(node.id, node);
    if (node.url) {
      const e = { node, path, pathStr: path.join(' / '), ancestors, inArchive };
      urls.push(e);
      entryById.set(node.id, e);
      return;
    }
    const here = depth === 0 ? [] : [...path, node.title];
    const anc = [...ancestors, node.id];
    const isArchive = node.id === archiveId;
    const f = {
      node, path: here, pathStr: here.join(' / '), parentPathStr: path.join(' / '),
      ancestors, depth, isRoot: depth <= 1, isArchive, inArchive: inArchive || isArchive,
      childCount: (node.children || []).length,
    };
    folders.push(f);
    folderById.set(node.id, f);
    for (const c of node.children || []) walk(c, here, anc, depth + 1, inArchive || isArchive);
  }

  walk(root, [], [], 0, false);
  return { root, byId, urls, entryById, folders, folderById };
}

export async function pathOf(id) {
  const parts = [];
  for (let guard = 0; id && guard < 64; guard++) {
    let n;
    try { [n] = await chrome.bookmarks.get(id); } catch { break; }
    if (!n || !n.parentId) break; // invisible root
    parts.unshift(n.title);
    id = n.parentId;
  }
  return parts;
}

// Identity used for matching visits and finding duplicates: scheme, "www." and trailing
// slashes are ignored; the host is case-insensitive, while path, query and fragment keep their
// case (YouTube ids, Docs ids and short links are case-sensitive).
export function normUrl(u) {
  try {
    const x = new URL(u);
    if (!/^https?:$/.test(x.protocol)) return String(u);
    return x.host.replace(/^www\./, '') + x.pathname.replace(/\/+$/, '') + x.search + x.hash;
  } catch {
    return String(u);
  }
}

export function host(u) {
  try { return new URL(u).host.replace(/^www\./, ''); } catch { return ''; }
}

// The last two folders of a path: enough to place an item, short enough to read in a column.
export function shortPath(parts) {
  return parts.slice(-2).join(' / ');
}

// URL without scheme / www — what people actually read and type.
export function displayUrl(u) {
  return String(u).replace(/^https?:\/\/(www\.)?/i, '').replace(/\/$/, '');
}

// Keep only what's needed to recreate a removed subtree.
export function slim(n) {
  const out = { id: n.id, title: n.title, dateAdded: n.dateAdded, syncing: n.syncing };
  if (n.url) out.url = n.url;
  if (n.children) out.children = n.children.map(slim);
  return out;
}

export function countUrls(n) {
  if (n.url) return 1;
  return (n.children || []).reduce((s, c) => s + countUrls(c), 0);
}

// Recreate a removed subtree. idMap collects old id → new id (to re-pin).
export async function restoreNode(node, parentId, index, idMap = new Map()) {
  const args = { parentId, title: node.title };
  if (node.url) args.url = node.url;
  if (index != null) {
    const siblings = await chrome.bookmarks.getChildren(parentId);
    args.index = Math.min(index, siblings.length);
  }
  const created = await chrome.bookmarks.create(args);
  idMap.set(node.id, created.id);
  for (const c of node.children || []) await restoreNode(c, created.id, undefined, idMap);
  return created;
}
