# WatchForMeeting
A spoon to answer the question
> Are you in a meeting?

Watches to see if:
1) A supported application is running
2) Are you on a call
3) Are you on mute, is your camera on, and/or are you screen sharing

And then lets you share that information.

## Supported Applications

Currently this spoon supports:
1) Zoom
2) Microsoft Teams (v2)
    - *NOTE*: Teams support uses the Third-Party app API which is disabled in the Mac application as of the August 3, 2026 release (version 26198.202.4929.7171). **[Follow instructions below on how to enable it](#enable-the-teams-3rd-party-api)**

## Installation & Basic Usage
Download the [Latest Release](https://github.com/asp55/WatchForMeeting.spoon2/releases/latest) and double-click (or dragging it onto the Hammerspoon 2 icon) to installs.


Once installed in your Hammerspoon 2 `init.js`:

```js
const wfm = hs.loadSpoon("WatchForMeeting");
wfm.apps = { zoom: true, teams: true };
wfm.start();
```

This will start the spoon monitoring for zoom & teams calls, and come with the default status page, and menubar configurations.

## API Documentation
For the full list of settings, methods, properties and events, see the [API documentation](DOC.md).


# Enable the Teams 3rd party api
As of the August 3, 2026 release (version 26198.202.4929.7171) the Mac version of Teams no longer ships with the Third-Party app API enabled. To enable it create `configuration.json` in `~/Library/Containers/com.microsoft.teams2/Data/Library/Application Support/Microsoft/MSTeams`

with a value of 
```
{
  "thirdPartyDevices/thirdPartyDevicesManagerEnabled": true
}
```

and restart teams