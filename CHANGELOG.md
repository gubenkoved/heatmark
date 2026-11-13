# Changelog

## 1.2.0 — 2026-11-13

- Sharing is now a choice per shelf: new shelves are Local, and **Share…** on a shelf syncs it
  through Chrome Sync. **Make local copy…** copies a Shared shelf to this computer. This replaces
  the Local or Shared switch in Settings; shelves from both 1.1.0 collections are kept.
- Each Chrome profile chooses its own default pin shelf and the shelves shown in Quick Access
  (the popup and `Ctrl+K`), so a work computer and a home computer can differ on one account.
- Added **Choose a shelf for this page…** and **Pin to shelf…** to the popup.

## 1.1.0 — 2026-11-13

- Added an opt-in Shared shelf collection through Chrome Sync. Local is the default on each device.
- Added a Settings action to copy local shelves into Shared and retry pending shared edits.
- Refreshed the Heatmark icon with a transparent background.

## 1.0.0 — first release

- Manager with a folder tree, a tree table of bookmarks with 90-day visit sparklines, and a
  detail pane.
- Visit counts and last visits from Chrome history, kept long-term; deletions in Chrome history
  are honored.
- `Ctrl+K` palette with fuzzy search ranked by use; the toolbar popup is the same palette.
- Shelves of pinned bookmarks.
- Filter language (`in:`, `host:`, `added:`, `visited:`, `visits:`, `is:`).
- Views: Recent, Frequent, New, Not visited, Stale, Duplicates, Empty folders, Archive.
- Archive, move and delete in bulk, with Undo.
- Activity: a year heatmap and a day-by-day log of visits and every bookmark change, with
  restore for deleted items.
- Context menus everywhere, keyboard navigation throughout, light and dark themes.
- Export and import of everything Heatmark keeps.
