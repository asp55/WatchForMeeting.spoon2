# WatchForMeeting API

```js
const WatchForMeeting = hs.loadSpoon("WatchForMeeting");
WatchForMeeting.apps = { zoom: true, teams: true };
WatchForMeeting.start();
```

Everything on `WatchForMeeting` is either a **method** (chainable, returns `WatchForMeeting`), a **setting** (read/write property), or a **read-only property**.

- [Properties](#Properties)
- [Methods](#methods)
- [Events](#events)
- [Status sharing](#status-sharing)

---

## Properties

### `WatchForMeeting.apps`

Which applications are monitored in automatic mode.

| Key | Default | Description |
|---|---|---|
| `zoom` | `false` | Watch the Zoom desktop app. |
| `teams` | `false` | Watch Microsoft Teams (v2). Requires the [Third-Party app API](README.md#enable-the-teams-3rd-party-api). |

Both default to `false`, so nothing is monitored until you enable an app. Changing `WatchForMeeting.apps` while the spoon is running **restarts it**, whether you assign an object (restarts once) or a single key such as `WatchForMeeting.apps.zoom = true`.

```js
WatchForMeeting.apps = { zoom: true, teams: true };
```

### `WatchForMeeting.sharing`
`{ mode, settings }`

Controls how status is shared with other devices. See [Status sharing](#status-sharing) for what is sent.

`sharing.mode` (default `false`):

| Value | Meaning |
|---|---|
| `false` | Sharing off. |
| `"local"` | Serve a status page and websocket from this Mac, on `settings.port`. |
| `"hosted"` | Connect out to a websocket server at `settings.serverURL`, identifying with `settings.key`. |

`sharing.settings`:

| Key | Default | Used by | Description |
|---|---|---|---|
| `port` | `8080` | `"local"` | Port for the built-in HTTP/websocket server. |
| `serverURL` | `null` | `"hosted"` | Websocket URL (`ws://` / `wss://`). Required for `"hosted"` mode. |
| `key` | `null` | `"hosted"` | Key identifying this room to the server. Required for `"hosted"` mode. |
| `maxConnectionAttempts` | `Infinity` | `"hosted"` | Consecutive failed connection attempts before giving up. `Infinity` never gives up. The counter resets after a successful connection. |
| `waitBeforeRetry` | `5` | `"hosted"` | Seconds to wait between reconnection attempts. |

All settings are kept when you switch modes, so you can set up both and flip `mode` at any time. Changes apply immediately: when the spoon is running, changing `mode`, or a setting the active mode uses (`port` for `"local"`; `serverURL` or `key` for `"hosted"`), reconnects sharing. Other changes, such as `serverURL` while in `"local"` mode, are stored without disturbing the connection.

You can assign a single value or several at once. Assigning `WatchForMeeting.sharing` or `WatchForMeeting.sharing.settings` **merges** over the current values; omitted keys are left alone. The whole result is validated first. An invalid result (unknown keys, an out-of-range `port`, `"hosted"` without `serverURL` and `key`, ...) throws and leaves the previous values in place.

```js
// Configure and switch on in one step
WatchForMeeting.sharing = { mode: "hosted", settings: { serverURL: "wss://example.com/ws", key: "my-room-key" } };

// Change a single setting (reconnects if it matters for the current mode)
WatchForMeeting.sharing.settings.port = 9000;

// Switch modes; settings are retained
WatchForMeeting.sharing.mode = "local";
WatchForMeeting.sharing.mode = false;
```

Set `serverURL` and `key` *before* switching to `"hosted"` (or in the same assignment as above); `WatchForMeeting.sharing.mode = "hosted"` on its own throws if they are still `null`.

### `WatchForMeeting.menubar`
`object`

Appearance of the menubar item.

| Key | Default | Description |
|---|---|---|
| `enabled` | `true` | Show the menubar item. |
| `color` | `true` | `true`: colored icons. `false`: monochrome template icons that follow the system light/dark appearance. |
| `detailed` | `true` | `true`: detailed icon set. `false`: minimal icon set. |
| `showFullState` | `true` | `true`: icon also shows mic, video and screen-share state. `false`: icon only shows meeting / not in a meeting. |

Changes apply immediately, including while running:

```js
WatchForMeeting.menubar.color = false;
WatchForMeeting.menubar.enabled = false;
```

Assigning an object merges it over the current values; unspecified keys are left unchanged.

```js
WatchForMeeting.menubar = { color: false }; // other keys keep their current values
```

### `WatchForMeeting.mode`
`string`

`"auto"` or `"fake"`. Assigning is equivalent to calling `WatchForMeeting.auto()` / `WatchForMeeting.fake()`. Any other value throws.

### `WatchForMeeting.logLevel`
`string`

Verbosity of the spoon's console logging, one of `"error"`, `"warn"`, `"info"`, `"log"` (default), `"debug"`, ordered from least to most output. Applies to the spoon and its internal modules. Any other value throws.

```js
WatchForMeeting.logLevel = "debug";
```


### `WatchForMeeting.events`
`string[]` (Read-Only) 
List of valid event names

| Event | Fires when |
|---|---|
| `meetingChange` | Any change to the meeting state, including each of the events below. Fires first. |
| `meetingStarted` | You go from not in a meeting to in a meeting. |
| `meetingStopped` | You go from in a meeting to not in a meeting. |
| `micChange` | Mic open state changes (fires with `micOn` or `micOff`). |
| `micOn` / `micOff` | Mic becomes open / muted. |
| `videoChange` | Camera state changes (fires with `videoOn` or `videoOff`). |
| `videoOn` / `videoOff` | Camera turns on / off. |
| `screensharingChange` | Screen sharing state changes (fires with `screensharingOn` or `screensharingOff`). |
| `screensharingOn` / `screensharingOff` | Screen sharing starts / stops. |

### `WatchForMeeting.meetingState`
`object | null` (Read-Only) 
`WatchForMeeting.meetingState` is `null` when not in a meeting, otherwise:

| Key | Type | Meaning |
|---|---|---|
| `micOpen` | `boolean` | Microphone is unmuted. |
| `videoOn` | `boolean` | Camera is on. |
| `sharing` | `boolean` | Screen sharing is active. |

Only one app is tracked at a time. When one app reports a meeting, the other monitors are stopped until that meeting ends.

How each app is detected:

- **Zoom**: polls Zoom's *Meeting* menu twice a second. Being in a meeting is inferred from the presence of *Mute audio* / *Unmute audio*; video and sharing from *Start video* / *Start share*. Requires Hammerspoon to have Accessibility permission.
- **Teams**: connects to the local Third-Party app API (`ws://localhost:8124`) and pairs on first use. Teams will prompt you to allow the pairing. The token is stored in Hammerspoon's user defaults so you only pair once. If Teams closes the connection several times in a row the monitor stops, and you must allow the app in *Teams > Settings > Privacy > Third-party app API > Manage API* and restart the spoon.

### `WatchForMeeting.meetingApp`
`string | null` (Read-Only) 
Which source is reporting the current meeting: `"zoom"`, `"teams"`, `"fake"`, or `null` when not in a meeting.

### `WatchForMeeting.faking`
`boolean` (Read-Only)
`true` while in fake mode and running.


### `WatchForMeeting.zoom`
`hs.application | null` (Read-Only) 
The Zoom application object while the Zoom monitor is running and Zoom is open, otherwise `null`.

---

## Methods

All methods return `WatchForMeeting`, so calls can be chained: `WatchForMeeting.on("micOn", fn).start()`.

### Lifecycle

| Method | Description |
|---|---|
| `start()` | Starts the spoon. Connects status sharing (if enabled and valid), shows the menubar item (if enabled), then enters the current `mode` (`auto()` or `fake()`). Does nothing if already running. |
| `stop()` | Stops monitoring, shuts down status sharing, hides the menubar item. Event listeners and settings are kept. |
| `restart()` | `stop()` followed by `start()`. |

### Mode

| Method | Description |
|---|---|
| `auto()` | Sets `mode` to `"auto"`. Monitors the apps enabled in `WatchForMeeting.apps` and reports their real state. The menubar menu shows **Automatic** checked. |
| `fake(micOpen = false, videoOn = false, sharing = false)` | Sets `mode` to `"fake"`. Stops all monitors and reports you as in a meeting with the given state (a "busy" override). The menubar menu lets you toggle mic, video and sharing by hand. |

Both can be called before `start()`; the mode is remembered and applied when the spoon starts. While running, either call immediately updates the menubar, sharing clients and listeners.

```js
WatchForMeeting.fake(true, false, false); // busy, mic open
WatchForMeeting.auto();                   // back to watching apps
```

### Events

| Method | Description |
|---|---|
| `on(event, fn)` | Adds a listener. Adding the same `fn` twice for an event is ignored. |
| `once(event, fn)` | Like `on`, but the listener is removed after its first call. |
| `off(event, fn)` | Removes one listener. With no `fn`, removes every listener for `event`. |
| `removeAllListeners(event)` | Removes every listener for `event`. With no `event`, removes all listeners for all events. |

`on`, `once` and `off` throw if `event` is not in `WatchForMeeting.events`, or if `fn` is not a function. An exception thrown inside a listener is logged and does not affect other listeners.

### Other

| Method | Description |
|---|---|
| `init()` | Called by `hs.loadSpoon()`. Idempotent; you shouldn't need to call it. |

---

## Events

Subscribe with `on` / `once`. Every `*Change` event fires for any change of that kind; the `On` / `Off` events fire for the specific direction.

A single update can produce several events. For example, joining a call with your mic open and camera on emits, in order: `meetingChange`, `meetingStarted`, `micChange`, `micOn`, `videoChange`, `videoOn`. Switching between `auto` and `fake` mode emits events for whatever differs between the two states.

Listeners receive one argument:

```js
{
    type: "micOn",           // the event name
    meetingState: { micOpen: true, videoOn: false, sharing: false } // frozen snapshot, or null
}
```

Both the event object and `meetingState` are frozen; modifying them throws in strict mode and has no effect otherwise.

```js
WatchForMeeting.on("meetingStarted", (e) => console.log("In a meeting", e.meetingState));
WatchForMeeting.on("micChange", (e) => console.log(e.type));        // "micOn" or "micOff" is also emitted
WatchForMeeting.once("meetingStopped", () => console.log("Done"));
```

---

## Status sharing

Unless `sharing.mode` is `false`, the current state is pushed to listeners every time it changes.

### Local (`mode: "local"`)

The spoon starts an HTTP server on `sharing.settings.port`:

- `http://<your-ip>:<port>/` serves a status page (`monitor.html`).
- `ws://<your-ip>:<port>/ws` is the websocket the page connects to. New connections immediately receive the current state.

`<your-ip>` is the IPv4 address of the primary physical interface (`enN`); VPN tunnels are skipped. Falls back to `localhost`.

### Hosted (`mode: "hosted"`)

The spoon opens a websocket to `sharing.settings.serverURL` and sends an identify message with `sharing.settings.key`:

```json
{ "action": "identify", "key": "<key>", "type": "room", "status": { "inMeeting": false } }
```

If the connection drops or fails, it retries every `sharing.settings.waitBeforeRetry` seconds up to `sharing.settings.maxConnectionAttempts`. If the server rejects the key (`badkey`), sharing is shut down without retrying.

### Message format

Both modes send the same update message. Keys are snake_case on the wire:

```json
{ "action": "update", "inMeeting": false }
{ "action": "update", "inMeeting": { "mic_open": true, "video_on": false, "sharing": false } }
```

`inMeeting` is `false` when not in a meeting.
