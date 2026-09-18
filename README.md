# Library Tweaks

Small tweaks for the native Zen Library. Each feature is toggled independently
from the mod's settings page.

## Features

### Saves section (bookmarks) — `zen.bookmarks.enabled`

- Adds a visible Saves section to the native Zen Library.
- Supports bookmarks, folders, separators, tags, filtering, drag and drop, and native bookmark editing.
- Intercepts `Ctrl+D` / `Cmd+D` to save the current page without opening the native bookmark panel.
- Uses configured Tidy Downloads AI provider settings, when available, to generate concise save names and up to three tags.
- Shows a Zen-style save animation, tooltip, undo control, and notification.
- Supports one mandatory Saves root folder, defaulting to Bookmarks Toolbar.
- Other top-level Firefox folders (Menu, Other, Mobile) stay visible alongside the Saves contents.
- Natural-language urlbar search: ask "what was that article I bookmarked about X" (or prefix with `bm`) to surface the best matching bookmark; uses local scoring instantly and the configured AI provider to re-rank when available.

Turning the toggle off unregisters the Saves section, the `Ctrl+D` smart save,
the bookmark shortcuts and the tab-drop handling immediately — no restart
needed — and turning it back on re-registers everything the same way.

### Easels section — `zen.easels.enabled`

- Lists the boards stored by the zen-easel mod in the native Zen Library.
- Search filters the grid in place; the "+" card creates and opens a board.
- Right-click a card for Open, Rename and Delete (delete animates out).
- Opening a board closes the Library, like the other sections.
- Without the zen-easel mod installed the section shows an empty state instead.

### Media section — `zen.media.enabled`

- Gathers images, video and audio from your Downloads folder, Zen Easel
  captures, your Screenshots folder and optional extra folders
  (`zen.library.media.user-dirs`, semicolon-separated absolute paths).
- Masonry grid with type pills, location chips and search; video duration and
  GIF badges; audio cover art with click-to-play and progress.
- Cards drag to the filesystem, copy, rename (downloads) and delete;
  right-click menu with open/show/hide options.
- Newest download-history items paint first while the folder walk fills in the
  rest behind them; the grid patches in place without losing scroll.

## Sidebar

- Drag any Library sidebar tab up or down to rearrange the sections; the
  arrangement is remembered across restarts (`zen.library.tweaks.sidebar.order`).
- The **Drag sidebar tabs to rearrange sections** toggle
  (`zen.library.tweaks.sidebar.reorder`, on by default) locks the tabs in place.

## History — `zen.library.tweaks.history.menu`

- Right-click any native history row for **Copy**, **Forget About This Site**
  and **Delete**, mirroring the classic library menu. The visit is resolved
  through Places search; native sections refresh themselves after each action.

## Boosts — `zen.library.tweaks.boosts.ui`

- Groups native boost rows under domain headers, enlarges icons into tinted
  tiles, and strikes through disabled boosts — the classic presentation.
- Clicks, the toggle and the context menu stay 100% native by design.

## Spaces

- **Drop position indicator** (`zen.library.tweaks.spaces.drop-indicator`):
  an accent line (rows) or card outline follows the cursor while dragging over
  native spaces. Visual only; drops behave exactly as native.
- **New space button** (`zen.library.tweaks.spaces.new-button`): a trailing
  + tile opens workspace creation.
- Complex gradients need no toggle: native already passes theme gradient
  strings through untouched, so richer gradients show up automatically when a
  gradient provider mod supplies them.

## Downloads

- **Also show files from the Downloads folder**
  (`zen.library.tweaks.downloads.system`, off by default): appends an
  On this device group with top-level Downloads-folder files and folders that
  have no history entry (hidden/partial skipped), with Open, Show in Folder,
  Rename and Delete. Respects the native search term.
- **Rename file** (`zen.library.tweaks.downloads.rename`): adds renaming to
  the native download menu, resolved against live downloads.
- File icons already resolve from the OS exactly like the classic library.

## Animation — `zen.library.tweaks.animation.switch`

- Incoming sections fade and rise on tab switches with the classic easing;
  in-place updates never retrigger it, and reduced-motion is respected.

## Install

Install as a Sine mod by copying this folder into your Zen profile `chrome/sine-mods` directory and enabling it in `mods.json`.
