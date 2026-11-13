// Chrome syncs each key independently. Membership and ordering use different keys so a
// reorder cannot re-pin a bookmark someone just unpinned on another device.
export const SHARED_PREFIX = 'heatmark:1:';
const shelfKey = (id) => SHARED_PREFIX + 's:' + id;
const pinsPrefix = SHARED_PREFIX + 'p:';
const pinPrefix = (id) => pinsPrefix + id + ':';
const itemOrderKey = (id) => SHARED_PREFIX + 'o:' + id;
const shelfOrderKey = SHARED_PREFIX + 'order';
const defaultKey = SHARED_PREFIX + 'default';

async function digest(value) {
  const bytes = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value)));
  return btoa(String.fromCharCode(...bytes.subarray(0, 12))).replaceAll('/', '_').replaceAll('+', '-');
}

async function reference(node) {
  return { url: await digest(node.url), added: node.dateAdded ?? 0, title: await digest(node.title || '') };
}

function bookmarkIndex(nodes) {
  const byDate = new Map();
  for (const node of nodes) {
    if (!node.url) continue;
    const date = node.dateAdded ?? 0;
    if (!byDate.has(date)) byDate.set(date, []);
    byDate.get(date).push(node);
  }
  return byDate;
}

async function resolvePin(ref, byDate, hashes) {
  const candidates = byDate.get(ref.added) || [];
  const exact = [], titles = [];
  for (const node of candidates) {
    if (!hashes.has(node.id)) hashes.set(node.id, Promise.all([digest(node.url), digest(node.title || '')]));
    const [url, title] = await hashes.get(node.id);
    if (url === ref.url) exact.push(node);
    if (title === ref.title) titles.push(node);
  }
  if (exact.length === 1) return exact[0].id;
  if (exact.length > 1) {
    const named = exact.filter((node) => titles.includes(node));
    return named.length === 1 ? named[0].id : undefined;
  }
  // Chrome Sync preserves the creation time when a bookmark URL is edited.
  if (ref.added && titles.length === 1) return titles[0].id;
}

function ordered(records, order) {
  const rank = new Map(Array.isArray(order) ? order.map((id, i) => [id, i]) : []);
  return records.sort((a, b) => (rank.get(a.id) ?? Infinity) - (rank.get(b.id) ?? Infinity)
    || a.at - b.at || a.id.localeCompare(b.id, 'en'));
}

export async function readSharedShelves(nodes, pending) {
  const stored = await chrome.storage.sync.get(null);
  const records = { ...stored, ...pending };
  const byDate = bookmarkIndex(nodes);
  const hashes = new Map();
  const shelves = new Map(), pins = new Map();
  for (const [key, value] of Object.entries(records)) {
    if (value == null) continue;
    if (key.startsWith(shelfKey('')) && typeof value.name === 'string' && Number.isFinite(value.at)) {
      const id = key.slice(shelfKey('').length);
      shelves.set(id, { id, name: value.name, at: value.at });
    } else if (key.startsWith(pinsPrefix) && typeof value.url === 'string'
      && Number.isFinite(value.added) && Number.isFinite(value.at)) {
      const [shelf, id] = key.slice(pinsPrefix.length).split(':');
      if (!pins.has(shelf)) pins.set(shelf, []);
      pins.get(shelf).push({ id, ...value });
    }
  }

  const orderedShelves = ordered([...shelves.values()], records[shelfOrderKey]);
  const projected = await Promise.all(orderedShelves.map(async ({ id, name }) => {
    const list = ordered(pins.get(id) || [], records[itemOrderKey(id)]);
    const items = new Set();
    for (const pin of list) {
      pin.bookmark = await resolvePin(pin, byDate, hashes);
      if (pin.bookmark) items.add(pin.bookmark);
    }
    pins.set(id, list);
    return { id, name, items: [...items], unavailable: list.filter((pin) => !pin.bookmark).length };
  }));
  return {
    shelves: projected, defaultShelf: records[defaultKey],
    unavailable: projected.reduce((count, shelf) => count + shelf.unavailable, 0),
    shared: { records, shelves, pins },
  };
}

// Convert one shelf operation into independent records. Missing bookmarks keep their
// memberships while Chrome's bookmark tree catches up.
export async function sharedChanges(before, after, shared, nodes) {
  const { records, shelves, pins } = shared;
  const changes = {};
  const afterIds = new Set(after.map((s) => s.id));
  // Append after current records, including when the two device clocks differ.
  let at = Math.max(Date.now(), ...[...shelves.values()].map((shelf) => shelf.at + 1),
    ...[...pins.values()].flat().map((pin) => pin.at + 1));
  for (const old of before) {
    if (afterIds.has(old.id)) continue;
    changes[shelfKey(old.id)] = null;
    if (records[itemOrderKey(old.id)]) changes[itemOrderKey(old.id)] = null;
    for (const pin of pins.get(old.id) || []) changes[pinPrefix(old.id) + pin.id] = null;
  }
  for (const shelf of after) {
    const old = before.find((s) => s.id === shelf.id);
    const saved = shelves.get(shelf.id);
    if (!saved || saved.name !== shelf.name) {
      changes[shelfKey(shelf.id)] = { name: shelf.name, at: saved?.at ?? at++ };
    }
    const list = pins.get(shelf.id) || [];
    const retained = new Set(shelf.items);
    for (const pin of list) {
      if (pin.bookmark && !retained.has(pin.bookmark)) changes[pinPrefix(shelf.id) + pin.id] = null;
    }
    const previous = new Set(old?.items);
    for (const id of shelf.items) {
      if (previous.has(id)) continue;
      const node = nodes.get(id);
      if (!node?.url) continue;
      const ref = await reference(node);
      const key = pinPrefix(shelf.id) + await digest(JSON.stringify([ref.url, ref.added, ref.title]));
      changes[key] = { ...ref, at: at++ };
    }
    const prevOrder = old?.items.filter((id) => retained.has(id)) || [];
    const newOrder = shelf.items.filter((id) => previous.has(id));
    if (prevOrder.some((id, i) => id !== newOrder[i])) {
      const sorted = newOrder.flatMap((id) => list.filter((pin) => pin.bookmark === id).map((pin) => pin.id));
      const reordered = list.filter((pin) => !pin.bookmark || retained.has(pin.bookmark))
        .map((pin) => pin.bookmark ? sorted.shift() : pin.id);
      changes[itemOrderKey(shelf.id)] = reordered;
    }
  }
  const oldIds = before.map((s) => s.id).filter((id) => afterIds.has(id));
  const prevIds = new Set(oldIds);
  const nextIds = after.map((s) => s.id);
  const order = records[shelfOrderKey];
  if (nextIds.filter((id) => prevIds.has(id)).some((id, i) => id !== oldIds[i])) changes[shelfOrderKey] = nextIds;
  else if (Array.isArray(order) && before.some((shelf) => !afterIds.has(shelf.id))) {
    changes[shelfOrderKey] = order.filter((id) => afterIds.has(id));
  }
  return changes;
}
