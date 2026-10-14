// WatchForMeeting/modules/Monitor.js
// Base class for app monitors (Zoom, Teams, ...). A monitor watches one app and reports
// its meeting state; subclasses implement start() and stop() and call setMeetingState().
//
// Emits "meetingChange" with { meetingState } whenever the state changes.
// meetingState is { micOpen, videoOn, sharing }, or null when not in a meeting.

const { createLogger } = require("./Logger.js");
const createEventHandler = require("./EventHandler.js");

class Monitor {
    #events;
    #meetingState = null;

    // name: short class name, e.g. "ZoomMonitor". appName: lowercase app id, e.g. "zoom".
    // appName is also the key in the spoon's `apps` setting that enables this monitor.
    constructor({ name, appName }) {
        this.name = `WatchForMeeting.${name}`;
        this.appName = appName;
        this.logger = createLogger(this.name);
        this.#events = createEventHandler(["meetingChange"], this.name);
    }

    static sameState(a, b) {
        if (!a || !b) return a === b;
        return a.micOpen === b.micOpen && a.videoOn === b.videoOn && a.sharing === b.sharing;
    }

    // Read-only { micOpen, videoOn, sharing } or null when not in a meeting.
    get meetingState() {
        return this.#meetingState;
    }

    // For subclasses: stores `next` and emits "meetingChange" if it differs from the current state.
    setMeetingState(next) {
        if (Monitor.sameState(this.#meetingState, next)) return;
        this.logger.debug("meeting state:", JSON.stringify(next));
        this.#meetingState = next;
        this.#events.emit("meetingChange", { meetingState: next });
    }

    // For subclasses: resets to "not in a meeting" without emitting (used by stop()).
    clearState() {
        this.#meetingState = null;
    }

    start() {
        throw new Error(`${this.name} must implement start()`);
    }

    stop() {
        throw new Error(`${this.name} must implement stop()`);
    }

    on(event, fn) { this.#events.on(event, fn); return this; }
    once(event, fn) { this.#events.once(event, fn); return this; }
    // With no `fn`, removes every listener for the event.
    off(event, fn) { this.#events.off(event, fn); return this; }
    removeAllListeners(event) { this.#events.removeAllListeners(event); return this; }
}

module.exports = Monitor;
