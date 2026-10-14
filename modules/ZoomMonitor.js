// WatchForMeeting/modules/ZoomMonitor.js
// Monitors the Zoom desktop app.
//
// Hammerspoon 2 has no hs.window.filter, so instead of reacting to Zoom window
// events we poll Zoom's "Meeting" menu. While in a meeting Zoom shows either
// "Mute audio" or "Unmute audio" in that menu; neither exists outside a meeting.

const Monitor = require("./Monitor.js");

const POLL_SECONDS = 0.5;
const ZOOM_APP_NAME = "Zoom";

function hasMenuItem(app, name) {
    return !!app.findMenuItemByPath(["Meeting", name]);
}

class ZoomMonitor extends Monitor {
    #zoom = null;
    #running = false;
    #pollTimer = null;

    constructor() {
        super({ name: "ZoomMonitor", appName: "zoom" });
    }

    // Read-only hs.application for Zoom, or null if Zoom isn't running.
    get zoom() {
        return this.#zoom;
    }

    #readState() {
        this.#zoom = hs.application.matchingName(ZOOM_APP_NAME) || null;
        const zoom = this.#zoom;
        if (!zoom) return null;

        const hasMute = hasMenuItem(zoom, "Mute audio");
        const hasUnmute = hasMenuItem(zoom, "Unmute audio");
        if (!hasMute && !hasUnmute) return null; // not in a meeting

        return {
            micOpen: !hasUnmute,
            videoOn: !hasMenuItem(zoom, "Start video"),
            sharing: !hasMenuItem(zoom, "Start share"),
        };
    }

    #check() {
        let next;
        try {
            next = this.#readState();
        } catch (e) {
            this.logger.warn("Failed to read Zoom state:", e);
            return;
        }
        this.setMeetingState(next);
    }

    start() {
        this.logger.debug(`start()${this.#running ? " - skipping" : " - starting"}`);
        if (!this.#running) {
            this.#running = true;
            this.#pollTimer = hs.timer.doEvery(POLL_SECONDS, () => this.#check());
            this.#check();
        }
        return this;
    }

    stop() {
        this.logger.debug("stop()");
        this.#running = false;
        if (this.#pollTimer) {
            this.#pollTimer.stop();
            this.#pollTimer = null;
        }
        this.#zoom = null;
        this.clearState();
        return this;
    }
}

module.exports = new ZoomMonitor();
