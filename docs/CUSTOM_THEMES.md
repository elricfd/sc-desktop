# Custom themes

A theme is a CSS file that restyles SoundCloud's pages.

## Using one

Open Settings (the menu button at the top right, or `F1`) and go to Appearance. "Open Themes Folder" opens the folder
your themes go in; drop a `.css` file there, click "Refresh Themes", and pick it from the list. "No Theme" goes back to
the default look.

The folder is:

- Windows: `%APPDATA%\sc-desktop\themes\`
- macOS: `~/Library/Application Support/sc-desktop/themes/`
- Linux: `~/.config/sc-desktop/themes/`

The themes in this repo's `themes/` folder (OLED and Gruvbox) come with the app. A file with the same name in your own
folder replaces the bundled one.

## Making one

It's plain CSS. Start with a comment that names the theme, then override whatever you like. SoundCloud's own styles
usually win unless you add `!important`.

```css
/* Midnight: darker backgrounds and an orange header */

body {
    background-color: #0b0b0b !important;
}

.header {
    background: #ff5500 !important;
}
```

Some selectors that are handy to start from:

- `body`: the page background
- `.header`: the top bar
- `.soundList__item`, `.trackItem`: tracks in lists
- `.playButton`, `.sc-button-play`: play buttons
- `.playbackTimeline`: the progress bar
- `::-webkit-scrollbar`: scrollbars

SoundCloud renames its classes now and then, so a theme can need touching up after one of their updates. If a theme
doesn't show up, check the file ends in `.css` and the CSS is valid, then refresh the list.

## Sharing one

Open a pull request that adds your file to `themes/`, or attach it to an issue. Keep it to CSS (no scripts or images)
and give it the name comment at the top.
