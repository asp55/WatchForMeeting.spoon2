const { createLogger } = require("./Logger.js");
const createEventHandler = require("./EventHandler.js");

const POLL_SECONDS = 0.5;
const ZOOM_APP_NAME = "zoom.us";

// Hammerspoon 2 has no hs.window.filter, so instead of reacting to Zoom window
// events we poll Zoom's "Meeting" menu. While in a meeting Zoom shows either
// "Mute audio" or "Unmute audio" in that menu; neither exists outside a meeting.
function createZoomMonitor() {
    const logger = createLogger("WatchForMeeting.ZoomMonitor");
    const events = createEventHandler(["meetingChange"], "WatchForMeeting.ZoomMonitor");

    let running = false;
    let timer = null;
    let zoom = null;
    let meetingState = null;

    const hasItem = (app, name) => !!app.findMenuItemByPath(["Meeting", name]);

    const readState = () => {
        zoom = hs.application.matchingName(ZOOM_APP_NAME) || null;
        if (!zoom) return null;
        const hasMute = hasItem(zoom, "Mute audio");
        const hasUnmute = hasItem(zoom, "Unmute audio");
        if (!hasMute && !hasUnmute) return null; // not in a meeting
        return {
            micOpen: !hasUnmute,
            videoOn: !hasItem(zoom, "Start video"),
            sharing: !hasItem(zoom, "Start share"),
        };
    };

    const sameState = (a, b) => {
        if (!a || !b) return a === b;
        return a.micOpen === b.micOpen && a.videoOn === b.videoOn && a.sharing === b.sharing;
    };

    const check = () => {
        let next;
        try {
            next = readState();
        } catch (err) {
            logger.warn("Failed to read Zoom state:", err);
            return;
        }
        if (!sameState(meetingState, next)) {
            logger.debug("Zoom meeting state:", JSON.stringify(next));
            meetingState = next;
            events.emit("meetingChange", { meetingState });
        }
    };

    const monitor = {
        name: "WatchForMeeting.ZoomMonitor",
        appName: "zoom",
        logger,

        get zoom() { return zoom; },
        get meetingState() { return meetingState; },

        on(event, fn) { events.on(event, fn); return monitor; },
        once(event, fn) { events.once(event, fn); return monitor; },
        off(event, fn) { events.off(event, fn); return monitor; },
        removeAllListeners(event) { events.removeAllListeners(event); return monitor; },

        start() {
            logger.debug(`start()${running ? " - skipping" : " - starting"}`);
            if (!running) {
                running = true;
                timer = hs.timer.doEvery(POLL_SECONDS, check);
                check();
            }
            return monitor;
        },

        stop() {
            logger.debug("stop()");
            running = false;
            if (timer) {
                timer.stop();
                timer = null;
            }
            zoom = null;
            meetingState = null;
            return monitor;
        },
    };

    return monitor;
}

module.exports = createZoomMonitor;
