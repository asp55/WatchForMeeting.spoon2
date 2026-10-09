// WatchForMeeting/modules/ZoomMonitor.js
// Monitors the Zoom desktop app.
//
// Hammerspoon 2 has no hs.window.filter, so instead of reacting to Zoom window
// events we poll Zoom's "Meeting" menu. While in a meeting Zoom shows either
// "Mute audio" or "Unmute audio" in that menu; neither exists outside a meeting.

const { createLogger } = require("./Logger.js");
const createEventHandler = require("./EventHandler.js");

//-----------------------------------------
// Logger & Events
//-----------------------------------------
const Logger = createLogger("WatchForMeeting.ZoomMonitor");
const events = createEventHandler(["meetingChange"], "WatchForMeeting.ZoomMonitor");

//-----------------------------------------
// Declare Variables
//-----------------------------------------

const POLL_SECONDS = 0.5;
const ZOOM_APP_NAME = "Zoom";

// ZoomMonitor.zoom
// Read-only hs.application for Zoom, or null if Zoom isn't running.
let zoom = null;

// ZoomMonitor.meetingState
// Read-only { micOpen, videoOn, sharing } or null when not in a Zoom meeting.
let meetingState = null;

// private variable to track if the monitor is already running or not.
let running = false;

let pollTimer = null;

//-----------------------------------------
// End of Declare Variables
//-----------------------------------------


//-----------------------------------------
// Zoom Monitor
//-----------------------------------------

function hasMenuItem(app, name) {
    return !!app.findMenuItemByPath(["Meeting", name]);
}

function readZoomState() {
    zoom = hs.application.matchingName(ZOOM_APP_NAME) || null;
    if(!zoom) return null;

    const hasMute = hasMenuItem(zoom, "Mute audio");
    const hasUnmute = hasMenuItem(zoom, "Unmute audio");
    if(!hasMute && !hasUnmute) return null; // not in a meeting

    return {
        micOpen: !hasUnmute,
        videoOn: !hasMenuItem(zoom, "Start video"),
        sharing: !hasMenuItem(zoom, "Start share"),
    };
}

function sameState(a, b) {
    if(!a || !b) return a === b;
    return a.micOpen === b.micOpen && a.videoOn === b.videoOn && a.sharing === b.sharing;
}

function checkZoom() {
    let next;
    try {
        next = readZoomState();
    }
    catch(e) {
        Logger.warn("Failed to read Zoom state:", e);
        return;
    }

    if(!sameState(meetingState, next)) {
        Logger.debug("Zoom meeting state:", JSON.stringify(next));
        meetingState = next;
        events.emit("meetingChange", { meetingState });
    }
}

//-----------------------------------------
// End Zoom Monitor
//-----------------------------------------


const ZoomMonitor = {
    name: "WatchForMeeting.ZoomMonitor",
    appName: "zoom",
    logger: Logger,

    get zoom() {
        return zoom;
    },
    get meetingState() {
        return meetingState;
    },
};

ZoomMonitor.on = function (event, fn) {
    events.on(event, fn);
    return module.exports;
};

ZoomMonitor.once = function (event, fn) {
    events.once(event, fn);
    return module.exports;
};

ZoomMonitor.off = function (event, fn) {
    events.off(event, fn);
    return module.exports;
};

ZoomMonitor.removeAllListeners = function (event) {
    events.removeAllListeners(event);
    return module.exports;
};

ZoomMonitor.start = function () {
    Logger.debug(`start()${running ? " - skipping" : " - starting"}`);
    if(!running) {
        running = true;
        pollTimer = hs.timer.doEvery(POLL_SECONDS, checkZoom);
        checkZoom();
    }

    return module.exports;
};

ZoomMonitor.stop = function () {
    Logger.debug("stop()");

    running = false;
    if(pollTimer) {
        pollTimer.stop();
        pollTimer = null;
    }
    zoom = null;
    meetingState = null;

    return module.exports;
};


module.exports = ZoomMonitor;
