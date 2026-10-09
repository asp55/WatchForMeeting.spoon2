const { createLogger } = require("./Logger.js");
const createEventHandler = require("./EventHandler.js");

const TOKEN_KEY = "WatchForMeeting.teamsToken";

// Monitors Microsoft Teams through its local "Third-party app API" websocket.
const logger = createLogger("WatchForMeeting.TeamsMonitor");
const events = createEventHandler(["meetingChange"], "WatchForMeeting.TeamsMonitor");

let version = "0";
let meetingState = null;
let ws = null;
let connectionId = 0;
let pairing = false;
let running = false;
let closedCount = 0;
let retryTimer = null;

const clearRetry = () => {
    if (retryTimer) {
        retryTimer.stop();
        retryTimer = null;
    }
};

const scheduleConnect = (seconds) => {
    clearRetry();
    retryTimer = hs.timer.doAfter(seconds, connect);
};

const disconnect = () => {
    logger.debug("disconnect()");
    clearRetry();
    if (ws) {
        const old = ws;
        ws = null;
        try { old.close(); } catch (err) { logger.debug("close failed:", err); }
    }
};

const setMeetingState = (next) => {
    const same = next && meetingState
        ? next.micOpen === meetingState.micOpen &&
          next.videoOn === meetingState.videoOn &&
          next.sharing === meetingState.sharing
        : next === meetingState;
    if (!same) {
        meetingState = next;
        events.emit("meetingChange", { meetingState });
    }
};

const onMessage = (message) => {
    logger.debug("onMessage", message);
    let parsed;
    try {
        parsed = JSON.parse(message);
    } catch (err) {
        logger.warn("Failed to parse Teams message:", message);
        return;
    }

    if (parsed.tokenRefresh) {
        logger.debug("Teams token refreshed");
        hs.userdefaults.set(TOKEN_KEY, parsed.tokenRefresh);
    }

    const update = parsed.meetingUpdate;
    if (update && update.meetingPermissions && update.meetingPermissions.canPair && !pairing) {
        logger.debug("Sending pairing request");
        pairing = true;
        if (ws) ws.send('{"action":"pair","parameters":{},"requestId":1}');
    }

    if (parsed.response === "Pairing response resulted in no action") {
        logger.info("Didn't pair. Will try again next meeting.");
        pairing = false;
    }

    if (update) {
        const ms = update.meetingState;
        if (ms && ms.isInMeeting) {
            setMeetingState({
                micOpen: !ms.isMuted,
                videoOn: !!ms.isVideoOn,
                sharing: !!ms.isSharing,
            });
        } else {
            setMeetingState(null);
        }
    }
};

const onClosed = () => {
    ws = null;
    pairing = false;
    if (!running) return;
    closedCount += 1;
    if (closedCount > 3) {
        logger.warn("Teams WebSocket closed multiple times in a row");
        logger.warn("This likely means this app was blocked from the Third-party app API in teams.");
        logger.warn("Go to `Settings > Privacy > Third-party app API > Manage API` and remove the application from block.");
        logger.warn("Then restart this spoon.");
        monitor.stop();
    } else {
        logger.info("Teams not available, retrying in 5 seconds");
        scheduleConnect(5);
    }
};

const onFail = () => {
    ws = null;
    if (!running) return;
    logger.warn("Teams not available, retrying in 30 seconds");
    scheduleConnect(30);
};

function connect() {
    logger.debug("connect()");
    retryTimer = null;
    // Bump the id first so callbacks from the previous socket are ignored,
    // even if close() fires its callback synchronously.
    connectionId += 1;
    const myId = connectionId;
    if (ws) {
        const old = ws;
        ws = null;
        try { old.close(); } catch (err) { logger.debug("close failed:", err); }
    }

    const token = hs.userdefaults.get(TOKEN_KEY) || "";
    const params = {
        token,
        "protocol-version": "2.0.0",
        manufacturer: "Hammerspoon",
        device: "WatchForMeeting.spoon2",
        app: "WatchForMeeting.spoon2",
        "app-version": version,
    };
    const query = Object.entries(params)
        .map(([k, v]) => `${k}=${encodeURIComponent(v)}`)
        .join("&");

    const guard = (fn) => (...args) => { if (myId === connectionId) fn(...args); };

    logger.debug("Connecting to Teams");
    const socket = hs.http.openWebSocket(`ws://localhost:8124?${query}`);
    if (!socket) {
        logger.error("Could not create Teams websocket");
        onFail();
        return;
    }
    ws = socket;
    socket
        .setOpenCallback(guard(() => logger.debug("Connected to Teams local API")))
        .setMessageCallback(guard(onMessage))
        .setCloseCallback(guard(onClosed))
        .setErrorCallback(guard((desc) => {
            logger.debug("Teams websocket error:", desc);
            onFail();
        }));
}

const monitor = {
    name: "WatchForMeeting.TeamsMonitor",
    appName: "teams",
    logger,

    get version() { return version; },
    set version(v) { version = String(v); },
    get meetingState() { return meetingState; },

    on(event, fn) { events.on(event, fn); return monitor; },
    once(event, fn) { events.once(event, fn); return monitor; },
    off(event, fn) { events.off(event, fn); return monitor; },
    removeAllListeners(event) { events.removeAllListeners(event); return monitor; },

    start() {
        logger.debug(`start()${ws ? " - skipping" : " - starting"}`);
        if (!ws && !retryTimer) {
            running = true;
            connect();
        }
        return monitor;
    },

    stop() {
        logger.debug("stop()");
        running = false;
        closedCount = 0;
        disconnect();
        meetingState = null;
        return monitor;
    },
};

module.exports = monitor;
