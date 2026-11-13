# Privacy policy — Heatmark

_Last updated: 2026-11-13_

Heatmark is a Chrome extension for organizing your bookmarks. It has no server, makes
no direct network requests, and contains no analytics, tracking or advertising code. If you
choose Shared shelves, Chrome handles their sync through your Google account.

## What the extension accesses

| Data | When and why | What happens to it |
| --- | --- | --- |
| **Bookmarks** (titles, URLs, folders, dates) | To show, search, organize, archive and delete them at your request. | Read and changed through Chrome's bookmarks API. Changes sync to your other devices through Chrome Sync, exactly as edits made in Chrome itself would. |
| **Browsing history** | To show how often and how recently you visit each bookmarked page. | Read on your device. Only daily visit counts and the last visit time for bookmarked pages are kept; the rest of your history is never stored. |
| **Current tab's address and title** | When you open the toolbar popup, to offer "Pin this page" for the page you are on. | Used only inside the popup. Nothing is stored unless you choose "Pin this page", which bookmarks the page if needed and pins it. |
| **Site icons** | To show favicons next to bookmarks. | Served by Chrome from its local icon cache. |
| **A file you choose to import** | Only when you use **Import JSON**. | Read once and merged into the extension's storage. |

## What the extension stores

Heatmark keeps these on your device in its own storage:

- per-day visit counts and the last visit time for bookmarked pages;
- a log of changes to your bookmarks (adds, removals, moves, renames, URL edits, archives and
  pins), including the contents of deleted items so they can be restored;
- your local shelves and default shelf, your choice of shelf storage, and the location of the Archive folder;
- interface preferences: which folders are expanded, which sections are collapsed, which log
  filters are on.

If you enable **Shared** on a device, Heatmark uses Chrome Sync (`chrome.storage.sync`) for
shared shelf names, order, default shelf, and pin references. Each pin reference includes
hashes of the bookmarked URL and title and its creation time. Chrome stores this data in your
Google account according to Chrome’s sync settings. Heatmark keeps shared edits on the device
if Chrome rejects a write. Visit counts, the change log, and restore data are stored locally.

**Export JSON** saves a file on your computer with your bookmarks, available pins from the active
shelf collection, the change log, and visit counts. Keep it private.

## How long it is kept

Visit counts follow your Chrome history. Heatmark holds its local change log and shelves until
you delete them or remove the extension. You can delete shared shelves from a device using
Shared mode.

## Sharing and selling

The optional Shared feature uses Chrome Sync as described above. Heatmark uses your data only
for the features described here and does not sell it, use it for advertising, or use it for
creditworthiness or lending.

Heatmark's use of information received from Chrome APIs adheres to the
[Chrome Web Store User Data Policy](https://developer.chrome.com/docs/webstore/program-policies/user-data-faq),
including the Limited Use requirements.

## Deleting your data

- **Browsing history you delete in Chrome is deleted here too.** Clearing all history erases the
  stored visit counts. Removing pages or recent time ranges removes those visits from the counts
  (for the roughly 90 days Chrome itself keeps history).
- Counts for pages that are no longer bookmarked are dropped at the next sync.
- **Delete local data** erases Heatmark’s data and unsent shared edits from the current profile,
  then returns it to Local mode. Visit counts and the log are rebuilt. Shelves already saved to
  Chrome Sync remain available to devices in Shared mode.
- Removing Heatmark from Chrome clears its local storage in that profile.

None of these touch your bookmarks themselves.

## Changes and contact

If this policy changes, the new version is published at
<https://github.com/gubenkoved/heatmark/blob/main/PRIVACY.md> with an updated date.
Questions: open an issue at <https://github.com/gubenkoved/heatmark/issues>.
