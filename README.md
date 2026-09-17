# Zen Bookmarks

Zen Bookmarks adds a Saves section to Zen Library through the `ZenLibrarySections` extension API.

## Features

- Adds a visible Saves section to Zen Library.
- Supports bookmarks, folders, separators, tags, filtering, drag and drop, and native bookmark editing.
- Intercepts `Ctrl+D` / `Cmd+D` to save the current page without opening the native bookmark panel.
- Uses configured Tidy Downloads AI provider settings, when available, to generate concise save names and up to three tags.
- Shows a Zen-style save animation, tooltip, undo control, and notification.
- Supports one mandatory Saves root folder, defaulting to Bookmarks Toolbar.
- Other top-level Firefox folders (Menu, Other, Mobile) stay visible alongside the Saves contents.
- Natural-language urlbar search: ask "what was that article I bookmarked about X" (or prefix with `bm`) to surface the best matching bookmark; uses local scoring instantly and the configured AI provider to re-rank when available.

## Install

Install as a Sine mod by copying this folder into your Zen profile `chrome/sine-mods` directory and enabling it in `mods.json`.

## Master toggle

The mod's settings page exposes an **Enable Zen Bookmarks** checkbox
(`zen.bookmarks.enabled`, on by default). Turning it off unregisters the Saves
library section, the `Ctrl+D` smart save, the bookmark shortcuts and the
tab-drop handling immediately — no restart needed — and turning it back on
re-registers everything the same way.
