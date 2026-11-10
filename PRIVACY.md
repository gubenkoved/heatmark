# Privacy policy — Heatmark

_Last updated: 2026-11-10_

Heatmark is a Chrome extension for organizing your bookmarks. It runs entirely on your device.
It has no server, sends no network requests (its content security policy forbids them), and
contains no analytics, tracking or advertising code.

## What the extension accesses

| Data | When and why | What happens to it |
| --- | --- | --- |
| **Bookmarks** (titles, URLs, folders, dates) | To show, search, organize, archive and delete them at your request. | Read and changed through Chrome's bookmarks API. Changes sync to your other devices through Chrome Sync, exactly as edits made in Chrome itself would. |
| **Browsing history** | To show how often and how recently you visit each bookmarked page. | Read on your device. Only daily visit counts and the last visit time for bookmarked pages are kept; the rest of your history is never stored. |
| **Current tab's address and title** | When you open the toolbar popup, to offer "Pin this page" for the page you are on. | Used only inside the popup. Nothing is stored unless you choose "Pin this page", which bookmarks the page if needed and pins it. |
| **Site icons** | To show favicons next to bookmarks. | Served by Chrome from its local icon cache. |
| **A file you choose to import** | Only when you use **Import JSON**. | Read once and merged into the extension's storage. |

## What the extension stores

Everything is kept on your device, in the extension's own storage (`chrome.storage.local`, plus a
few interface preferences in the extension pages' local storage):

- per-day visit counts and the last visit time for bookmarked pages;
- a log of changes to your bookmarks (adds, removals, moves, renames, URL edits, archives and
  pins), including the contents of deleted items so they can be restored;
- your shelves (lists of pinned bookmarks), the default shelf and the location of the Archive folder;
- interface preferences: which folders are expanded, which sections are collapsed, which log
  filters are on.

This data is not synced, uploaded or shared. It leaves your device only if you export it yourself
with **Export JSON**, which saves a file to your computer. That file contains your bookmarks, the
change log and the visit counts, so keep it private.

## How long it is kept

Until you delete it. Visit counts follow your Chrome history (see below); the change log and your
shelves are kept until you delete them or remove the extension.

## Sharing and selling

Heatmark does not sell, transfer or share any user data with anyone, does not use it for any
purpose other than the features described above, and does not use it to determine creditworthiness
or for lending.

Heatmark's use of information received from Chrome APIs adheres to the
[Chrome Web Store User Data Policy](https://developer.chrome.com/docs/webstore/program-policies/user-data-faq),
including the Limited Use requirements.

## Deleting your data

- **Browsing history you delete in Chrome is deleted here too.** Clearing all history erases the
  stored visit counts. Removing pages or recent time ranges removes those visits from the counts
  (for the roughly 90 days Chrome itself keeps history).
- Counts for pages that are no longer bookmarked are dropped at the next sync.
- **Delete all stored data** (press `Ctrl+K` in the extension and type "delete") erases everything
  the extension keeps, at any time. Visit counts are then rebuilt from your Chrome history and the
  change log starts again.
- Removing the extension from Chrome deletes everything it stored.

None of these touch your bookmarks themselves.

## Changes and contact

If this policy changes, the new version is published at
<https://github.com/gubenkoved/heatmark/blob/main/PRIVACY.md> with an updated date.
Questions: open an issue at <https://github.com/gubenkoved/heatmark/issues>.
