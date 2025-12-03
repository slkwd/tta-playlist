# 🎵 TTA Playlist System  
*Interactive personal playlists for MediaWiki — part of The Traditional Tune Archive (TTA)*

> A complete playlist ecosystem for MediaWiki, including an audio player gadget, a playlist manager, and a visual gallery of user playlists.  
> Developed for **The Traditional Tune Archive** (https://tunearch.org / https://ttadev.org).

---

## 📌 Overview

The **TTA Playlist System** is a set of MediaWiki gadgets that implement:

1. **Per-user personal playlists** stored under  
   `User:<name>/Playlists/...`
2. **An interactive HTML5 playlist player**
3. **A playlist management interface** (create, rename, delete, reorder)
4. **A playlist library gallery** (grid of playlist covers)
5. **Artwork support** per playlist and per track
6. **Wikitext parsing and regeneration**
7. **Safety mechanisms** to prevent accidental edits

The system modularizes into **three gadgets**:

| Gadget | Purpose |
|--------|---------|
| `ttaPlaylist.js` | Turns a playlist into an interactive audio player. |
| `ttaPlaylistManager.js` | Handles creation & management of playlists. |
| `ttaPlaylistLibrary.js` | Visual gallery of all playlists for each user. |

---

## 🧱 Architecture

### 🎧 Playlist Wikitext Format

Each playlist page contains:

```wikitext
<div class="tta-playlist" data-title="My Playlist" data-cover="File:Cover.jpg">
* [[File:The Braes Of Mar.mp3]] // Alasdair Fraser
* [[File:Katherine_Oggie.mp3]] // Julie Petit
<div class="tta-playlist-artworks" style="display:none">
  <span data-file="File:The Braes Of Mar.mp3" data-artwork="File:Braes-OMar.jpg"></span>
  <span data-file="File:Katherine_Oggie.mp3" data-artwork="File:Ruaidri.png"></span>
</div>
</div>
```

The gadgets parse, modify, reorder, and rewrite this structure as needed, always producing a **canonical** and **clean** playlist definition.

---

# 🎧 Gadget 1 — `ttaPlaylist.js`
### *Client-side audio player*

Transforms the simple wikitext structure into a rich HTML5 audio experience.

#### Features:

- Play / pause / previous / next
- Inline cover art
- Optional per-track artwork
- Drag-and-drop sorting in DOM
- Highlight current track
- Automatic file URL lookup via MediaWiki API
- Works across Vector, Timeless, and other skins
- No server components required

---

# 🎚 Gadget 2 — `ttaPlaylistManager.js`
### *Create, rename, delete, reorder playlists via OOUI dialogs*

This gadget rewrites playlist pages safely and consistently.

### Main Features

#### ✔ Create playlist
Automatically generates:

- the user’s master *Library* page (`User:<name>/Playlists`)  
- the new playlist page with default cover and headers

#### ✔ Add track
Appends a new `* [[File:...]] // Artist` line and maintains artwork mappings.

#### ✔ Remove track
Removes both the bullet line and its corresponding `<span>` in the hidden artwork block.

#### ✔ Save order
Reads the order from DOM and reconstructs both bullet list and artwork block.

#### ✔ Rename playlist
Updates:

- the playlist page header
- the entry inside the Library index

#### ✔ Delete playlist
Deletes the page + cleans library index.

---

# 🖼 Gadget 3 — `ttaPlaylistLibrary.js`
### *Visual gallery of playlists*

On the page:

```
User:<name>/Playlists
```

the gadget:

1. Reads all playlist links between  
   `<!-- TTA_PLAYLIST_LIBRARY_START -->` and  
   `<!-- TTA_PLAYLIST_LIBRARY_END -->`
2. Loads each playlist page
3. Extracts the `data-cover` file
4. Builds a responsive grid of square thumbnails
5. Hides the raw list if gallery loads correctly

This provides a modern “music app” feeling.

---

# 🔒 Safety & Abuse Protection

To prevent accidental corruption of playlists:

### 1. Edit Tab Hidden
Injected via Common.js to remove the `Edit` tab on playlist pages.

### 2. AbuseFilter
A filter should block manual edits to:

```
User:.*/Playlists(/.*)?
```

This ensures gadgets are the only editors.

---

# 📦 Installation

### 1. Create the gadget pages

In `MediaWiki:` namespace:

```
MediaWiki:Gadget-ttaPlaylist.js
MediaWiki:Gadget-ttaPlaylist.css
MediaWiki:Gadget-ttaPlaylistManager.js
MediaWiki:Gadget-ttaPlaylistManager.css
MediaWiki:Gadget-ttaPlaylistLibrary.js
MediaWiki:Gadget-ttaPlaylistLibrary.css
```

Paste gadget code into each.

---

### 2. Add gadgets definition

In `MediaWiki:Gadgets-definition`:

```text
ttaPlaylist[ResourceLoader|dependencies=mediawiki.api,mediawiki.util,jquery.ui.sortable]|ttaPlaylist.js|ttaPlaylist.css

ttaPlaylistManager[ResourceLoader|dependencies=mediawiki.api,mediawiki.util,oojs-ui-core,oojs-ui-windows,oojs-ui-widgets]|ttaPlaylistManager.js|ttaPlaylistManager.css

ttaPlaylistLibrary[ResourceLoader|dependencies=mediawiki.api,mediawiki.util,jquery]|ttaPlaylistLibrary.js|ttaPlaylistLibrary.css
```

---

### 3. Add playlist entry to user menu (optional)

Using extension **AddPersonalUrls**:

```php
$wgAddPersonalUrlsTable['addpersonalurls-playlist'] = 'Special:Mypage/Playlists';
```

---

### 4. Configure AbuseFilter (optional but recommended)

Create rule:

```text
condition:
  page_namespace == 2 &
  rlike(page_title, "/Playlists")

action:
  disallow + warn
```

---

# 🤝 Contributing

Pull requests and improvements are welcome.

Good areas for contributions:

- Internationalization (i18n)
- Duplicate-track detection
- Custom cover selection UI
- Bulk track import/export
- Better error handling

---

# 📄 License

**MIT License** (recommended — can be replaced by repository owner).

---

# ❤️ Credits

Developed by **Valerio Pelliccioni** for  
**The Traditional Tune Archive** — *Folk Music Semantic Index*

Refined and tested with extensive debugging assistance from ChatGPT.

---

# 🖼 Screenshots

*(You can replace these placeholders with real images.)*

```
/screenshots/
   player.png
   playlist-library.png
   add-dialog.png
   reorder-menu.png
```
