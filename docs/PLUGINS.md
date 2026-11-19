# Plugins

A plugin is a JavaScript file in the plugins folder (Settings → Plugins → Open folder).

## Only install plugins you trust

A plugin runs with full access to your computer, like any app you install. It runs in Electron's main process with all
of Node.js, so it can read and write your files, start programs, use the network, and read what the app stores,
including your Last.fm session and proxy password.

The loader runs plugins inside Node's `vm` module to give them `module` and `exports`, but that is not a sandbox and
doesn't contain anything. Read a plugin's source, or know who wrote it, before you turn it on.

## Changed files are turned off

When you enable a plugin, the app remembers a hash of its source. If the file changes after that (you edit it, update
it, or another file takes its name), it stays off until you enable it again, and the log says:

```
Plugin "example-plugin" changed on disk since it was enabled; it stays disabled until re-enabled.
```

That's expected after editing your own plugin; just turn it back on.

## Writing one

Put the details in a comment at the top:

```js
/**
 * @name Example Plugin
 * @description Does something useful
 * @version 1.0.0
 * @author you
 */
```

Then export any of these:

| Hook            | Signature                   | Called when                                  |
| --------------- | --------------------------- | -------------------------------------------- |
| `onEnable`      | `() => void`                | The plugin is turned on                      |
| `onDisable`     | `() => void`                | The plugin is turned off                     |
| `onTrackChange` | `(track) => void`           | A new track starts                           |
| `onThemeChange` | `(isDark: boolean) => void` | The theme changes                            |
| `contentScript` | `() => string`              | Returns JS to run inside the SoundCloud page |

```js
module.exports = {
    onEnable() {
        console.log('enabled');
    },
    onTrackChange(track) {
        console.log(track.title, 'by', track.author);
    },
};
```

### Running code in the page

`contentScript()` returns code that runs in the SoundCloud page instead of the main process. To clean up when the plugin
is turned off, set `window.__scrpc_cleanup_<id>` to a function, where `<id>` is your file name with anything other than
letters, digits and `_` replaced by `_`.

```js
module.exports = {
    contentScript() {
        return `
            const handler = () => console.log('clicked');
            document.addEventListener('click', handler);
            window.__scrpc_cleanup_my_plugin = () => {
                document.removeEventListener('click', handler);
            };
        `;
    },
};
```

### Timers

`setTimeout`, `setInterval` and their `clear` versions work, but the app doesn't stop them for you: clear yours in
`onDisable`, or they keep running after the plugin is off.
