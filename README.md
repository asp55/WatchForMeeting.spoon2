# WatchForMeeting
A spoon to answer the question
> Are you in a meeting?

Watches to see if:
1) A supported application is running
2) Are you on a call
3) Are you on mute, is your camera on, and/or are you screen sharing

And then lets you share that information.

## Installation (Hammerspoon 2)
Copy this folder to `~/.config/Hammerspoon2/Spoons/WatchForMeeting.spoon2`, then in your Hammerspoon 2 `init.js`:

```js
const wfm = hs.loadSpoon("WatchForMeeting");
wfm.apps = { zoom: true, teams: false };
wfm.start();
```

Settings: `wfm.sharing`, `wfm.menubar`, `wfm.apps`, `wfm.mode`, `wfm.logLevel` (`"error" | "warn" | "info" | "log" | "debug"`, default `"log"`).
Methods: `start()`, `stop()`, `restart()`, `auto()`, `fake(micOpen, videoOn, sharing)`, `on(event, fn)`, `once(event, fn)`, `off(event, fn)`, `removeAllListeners(event)`.
Events (`wfm.events` lists them): `meetingChange`, `meetingStarted`, `meetingStopped`, `micChange`, `micOn`, `micOff`, `videoChange`, `videoOn`, `videoOff`, `screensharingChange`, `screensharingOn`, `screensharingOff`.
Listeners receive an event object `{ type, meetingState }` (`meetingState` is a frozen snapshot).
State: `wfm.meetingState` is `null` or `{ micOpen, videoOn, sharing }`. `wfm.mode` is `"auto"` or `"fake"`. `wfm.sharing.maxConnectionAttempts` defaults to `Infinity`.
