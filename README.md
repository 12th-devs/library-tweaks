# Library Tweaks

Small tweaks for the native Zen Library. Each feature is toggled independently
from the mod's settings page.

## Features

### Saves section (bookmarks) — `zen.bookmarks.enabled`

- Adds a visible Saves section to the native Zen Library.
- Supports bookmarks, folders, separators, tags, filtering, drag and drop, and native bookmark editing.
- Right-click blank space for Bookmark Current Page, Bookmark URL and Add Folder.
- Folders start closed; open-state is shared with the bookmarks sidebar and remembered across restarts, and folders wear the native Zen folder artwork with open/closed states and special icons for the system roots (ported from JustAdumbPrsn/ZenLibraryTweaks).
- Keyword-first search: a bookmark whose keyword is the address-bar keyword for the first word typed ranks in Top matches above the tree.
- Picking several tags keeps only bookmarks carrying all of them.
- Intercepts `Ctrl+D` / `Cmd+D` to save the current page without opening the native bookmark panel.
- Uses configured Tidy Downloads AI provider settings, when available, to generate concise save names and up to three tags.
- Shows a Zen-style save animation, tooltip, undo control, and notification.
- Supports one mandatory Saves root folder, defaulting to Bookmarks Toolbar.
- Other top-level Firefox folders (Menu, Other, Mobile) stay visible alongside the Saves contents, unless **Hide other root folders** (`zen.bookmarks.hideOtherRoots`, off by default) is on.
- Natural-language urlbar search: ask "what was that article I bookmarked about X" (or prefix with `bm`) to surface the best matching bookmark; uses local scoring instantly and the configured AI provider to re-rank when available.

Turning the toggle off unregisters the Saves section, the `Ctrl+D` smart save,
the bookmark shortcuts and the tab-drop handling immediately — no restart
needed — and turning it back on re-registers everything the same way.

### Native Media wider panel — `zen.library.tweaks.media.wide`

- Zen now ships its own Media section, so this mod no longer overrides it —
  the section is 100% native.
- The toggle (on by default) grows the Library panel to 794px while Zen's
  native Media tab is showing — 1.9x the 418px width of Downloads and the
  other sections — with a roomier grid (140px-minimum columns, wider gaps and
  padding, like the old custom tab). Off keeps Media at the same width as the
  other sections. Applies immediately, no restart needed.

### Native Media file actions — `zen.library.tweaks.media.menu`

- Adds **Rename file** and **Delete file** to the right-click menu on Zen's
  native Media cards (on by default). Rename prompts for a name, moves the
  file on disk and repaints the grid; Delete confirms, moves nothing to trash
  (file is removed) and drops the card. Missing files offer neither, mirroring
  the downloads tweak.

## Sidebar

- Drag any Library sidebar tab up or down to rearrange the sections; the
  arrangement is remembered across restarts (`zen.library.tweaks.sidebar.order`).
- The **Drag sidebar tabs to rearrange sections** toggle
  (`zen.library.tweaks.sidebar.reorder`, on by default) locks the tabs in place.

## Shortcuts

- **Ctrl+D (Cmd+D)** smart-saves the page
  (`zen.library.tweaks.shortcut.save`, on by default). Off hands the key back
  to the native bookmark panel.
- **Ctrl+H (Cmd+H)** opens the native Library on History
  (`zen.library.tweaks.shortcut.history`, on by default). Off hands the key
  back to Firefox.
- **Ctrl+J (Cmd+J)** opens the native Library on Downloads
  (`zen.library.tweaks.shortcut.downloads`, on by default). Off hands the key
  back.

## History

- **Recently closed tabs** (`zen.library.tweaks.history.section`, on by
  default): shows Recently closed tabs and Clear recent history shortcuts
  above the native History list. Closed tabs open in a sliding pane with
  reopen and forget actions per row; Escape steps back instead of closing
  the Library. Off restores the native History tab. Ported from
  JustAdumbPrsn/ZenLibraryTweaks (`dev`).
- **Right-click menu** (`zen.library.tweaks.history.menu`, on by default):
  right-click any native history row for **Copy**, **Forget About This Site**
  and **Delete**, mirroring the classic library menu. The visit is resolved
  through Places search; native sections refresh themselves after each action.

## Boosts — `zen.library.tweaks.boosts.ui`

- Groups native boost rows under domain headers, enlarges icons into tinted
  tiles, and strikes through disabled boosts — the classic presentation.
- Clicks, the toggle and the context menu stay 100% native by design.

## Downloads

- **Show Downloads folder instead of history**
  (`zen.library.tweaks.downloads.system`, off by default): hides the browser
  download history and shows the actual top-level files and folders in the
  Downloads folder instead (hidden/partial skipped). Rows offer Open, Show
  in Folder, Rename and Delete with the file name in each label like the
  native menu; files downloaded in the browser keep their source link via
  Copy Download Link, and renaming one follows its history entries to the
  new path. Rows drag out to Explorer, tabs and other apps, and cold opens
  paint filenames instantly with sizes and links filling in right after.
  Respects the native search term and type/date filters.
- **Rename file** (`zen.library.tweaks.downloads.rename`): adds renaming to
  the download context menus, resolved against live session + history downloads.
  Renaming updates every matching entry, refreshes the file on disk and
  re-renders the section so the new name is visible immediately.
- **Grey out moved or missing files**
  (`zen.library.tweaks.downloads.dim-missing`): dims rows whose files are gone
  from disk; those rows are also excluded from renaming.
- File icons already resolve from the OS exactly like the classic library.

## Animation — `zen.library.tweaks.animation.switch`

- Incoming sections fade and rise on tab switches with the classic easing;
  in-place updates never retrigger it, and reduced-motion is respected.

## Install

1. In Zen, open Settings → Sine Mods and enable external JS.
2. Paste `https://github.com/12th-devs/library-tweaks` into the install
   section and install.
3. Restart Zen when prompted.
