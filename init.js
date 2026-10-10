// WatchForMeeting - Hammerspoon 2 Spoon
//
// Answers the question "Are you in a meeting?" by watching supported apps,
// then (optionally) sharing that status via a menubar icon and a status page.
//
// Usage in your Hammerspoon 2 init.js:
//   const wfm = hs.loadSpoon("WatchForMeeting");
//   wfm.start();

const { createLogger } = require("./modules/Logger.js");
const createEventHandler = require("./modules/EventHandler.js");
const zoomMonitor = require("./modules/ZoomMonitor.js");
const teamsMonitor = require("./modules/TeamsMonitor.js");

const log = createLogger("WatchForMeeting");

// Pseudo-events for on() / once() / off()
const EVENT_NAMES = [
    "meetingChange", "meetingStarted", "meetingStopped",
    "micChange", "micOn", "micOff",
    "videoChange", "videoOn", "videoOff",
    "screensharingChange", "screensharingOn", "screensharingOff",
];
const eventHandler = createEventHandler(EVENT_NAMES, "WatchForMeeting");
const EVENTS = eventHandler.eventNames;

//-----------------------------------------
// Settings
//-----------------------------------------
// sharing: enabled, useServer, port, serverURL, key, maxConnectionAttempts (Infinity = never give up), waitBeforeRetry (s)
const sharingDefaults = {
    enabled: true, useServer: false, port: 8080,
    serverURL: null, key: null, maxConnectionAttempts: Infinity, waitBeforeRetry: 5,
};
// menubar: enabled, color, detailed, showFullState
const menubarDefaults = { enabled: true, color: true, detailed: true, showFullState: true };

// apps: which monitors run in automatic mode. If already started, changing will trigger a restart.
const appsDefaults = { zoom: false, teams: false };

const sharingValues = { ...sharingDefaults };
const menubarValues = { ...menubarDefaults };
const appsValues = { ...appsDefaults };

// Applies a change to the menubar settings. `key` is the changed key, or undefined for a batch.
function applyMenubarChange(key) {
    if (!menuBar || !running) return;
    if (key === undefined || key === "enabled") {
        if (menubarValues.enabled) menuBar.show(); else menuBar.hide();
    }
    updateMenuIcon();
}

// Applies a change to the sharing settings by reconnecting with the new values.
function applySharingChange() {
    if (!running) return;
    disconnectFromSharing();
    connectionError = false;
    connectionAttempts = 0;
    if (sharingValues.enabled && validateShareSettings()) connectToSharing();
}

// Applies a change to the apps settings by restarting, so the right monitors run.
function applyAppsChange() {
    if (running) WatchForMeeting.restart();
}

// Setting a key on the proxy applies the change immediately.
const makeSettingsProxy = (values, apply) => new Proxy(values, {
    set(target, key, value) {
        target[key] = value;
        apply(key);
        return true;
    },
});
const sharingSettings = makeSettingsProxy(sharingValues, () => applySharingChange());
const menubarSettings = makeSettingsProxy(menubarValues, applyMenubarChange);
const appsSettings = makeSettingsProxy(appsValues, () => applyAppsChange());

//-----------------------------------------
// State
//-----------------------------------------
let running = false;
let mode = "auto"; // "auto" | "fake"
let meetingState = null; // null | { micOpen, videoOn, sharing }
let lastMeetingState = null;
let meetingApp = null;
let faking = false;

//-----------------------------------------
// Menu bar
//-----------------------------------------
const menuBar = hs.menubar.create(true);

function iconFileName() {
    let file = "Free";
    if (meetingState) {
        file = "Meeting";
        const s = meetingState;
        if (menubarSettings.showFullState && (s.micOpen || s.videoOn || s.sharing)) {
            if (s.micOpen) file += "-Mic";
            if (s.videoOn) file += "-Vid";
            if (s.sharing) file += "-Screen";
        }
        if (faking) file += "-Faking";
    }
    return `${file}.pdf`;
}

function updateMenuIcon() {
    if (!menuBar || !menubarSettings.enabled) return;
    const dir = [
        "menubar-icons",
        menubarSettings.color ? "Color" : "Template",
        menubarSettings.detailed ? "Detailed" : "Minimal",
    ].join("/");
    const img = HSImage.fromPath(`${__dirname}/${dir}/${iconFileName()}`);
    if (!img) {
        log.warn("Could not load menubar icon", dir, iconFileName());
        return;
    }
    img.template = !menubarSettings.color;
    menuBar.setIcon(img);
}

//-----------------------------------------
// Status sharing (self hosted server / external server)
//-----------------------------------------
let server = null; // self hosted HSHTTPServer, or external websocket client
let websocketStatus = "closed";
let connectionAttempts = 0;
let connectionError = false;
let retryTimer = null;
const clients = new Set(); // self hosted websocket connections

// The status page and MeetingStatusServer expect snake_case keys on the wire.
const toWire = (state) => (state
    ? { mic_open: state.micOpen, video_on: state.videoOn, sharing: state.sharing }
    : false);

const composeUpdate = () => JSON.stringify({ action: "update", inMeeting: toWire(meetingState) });

let monitorHtml = null;
function loadMonitorHtml() {
    if (monitorHtml === null) monitorHtml = hs.fs.read(`${__dirname}/monitor.html`) || "";
    return monitorHtml;
}

// A VPN makes the primary interface a tunnel (utun*, ppp*, ...) whose address isn't
// reachable from the LAN, so prefer a physical interface (enN) for the websocket URL.
function primaryIPv4() {
    const usable = (a) => a.family === "ipv4"
        && !a.address.startsWith("127.")
        && !a.address.startsWith("169.254.");
    const addrs = hs.network.addresses().filter(usable);
    const physical = addrs.filter((a) => /^en\d+$/.test(a.interface));
    const primary = hs.network.primaryInterface();
    const entry = physical.find((a) => a.interface === primary)
        || physical[0]
        || addrs.find((a) => a.interface === primary);
    return entry ? entry.address : "localhost";
}

function broadcast() {
    if (!server) return;
    if (sharingSettings.useServer) {
        if (websocketStatus === "open") server.send(composeUpdate());
    } else {
        const msg = composeUpdate();
        for (const conn of [...clients]) {
            try { conn.send(msg); } catch (err) { clients.delete(conn); }
        }
    }
}

function validateShareSettings() {
    if (sharingSettings.useServer) {
        if (!sharingSettings.serverURL) log.error("sharing.serverURL required when using a server");
        if (!sharingSettings.key) log.error("sharing.key required when using a server");
        return !!(sharingSettings.serverURL && sharingSettings.key);
    }
    if (!sharingSettings.port) {
        log.error("sharing.port required when self hosting");
        return false;
    }
    return true;
}

function disconnectFromSharing() {
    if (retryTimer) { retryTimer.stop(); retryTimer = null; }
    clients.clear();
    if (server) {
        const old = server;
        server = null;
        websocketStatus = "closed";
        try {
            if (sharingSettings.useServer) old.close(); else old.stop();
        } catch (err) { log.debug("disconnectFromSharing:", err); }
    }
}

function scheduleReconnect() {
    const max = sharingSettings.maxConnectionAttempts;
    if (connectionAttempts >= max) {
        log.error("Maximum Connection Attempts failed");
        disconnectFromSharing();
    } else if (connectionError || !running) {
        disconnectFromSharing();
    } else {
        retryTimer = hs.timer.doAfter(sharingSettings.waitBeforeRetry, connectToSharing);
    }
}

function connectExternal() {
    log.debug(`Connecting to server at ${sharingSettings.serverURL}`);
    connectionAttempts += 1;
    websocketStatus = "connecting";
    const ws = hs.http.openWebSocket(sharingSettings.serverURL);
    if (!ws) {
        log.error("Invalid sharing.serverURL");
        websocketStatus = "fail";
        return;
    }
    server = ws;
    ws.setOpenCallback(() => {
        if (server !== ws) return;
        websocketStatus = "open";
        connectionAttempts = 0;
        ws.send(JSON.stringify({
            action: "identify", key: sharingSettings.key, type: "room",
            status: { inMeeting: toWire(meetingState) },
        }));
    }).setMessageCallback((message) => {
        if (server !== ws) return;
        let parsed;
        try { parsed = JSON.parse(message); } catch (err) { log.warn("Unparseable sharing message"); return; }
        if (parsed.error) {
            connectionError = true;
            if (parsed.errorType === "badkey") {
                disconnectFromSharing();
                log.error("sharing.key not valid. Make sure that key has been established on the server.");
            }
        } else {
            log.debug("Sharing websocket message received:", message);
        }
    }).setCloseCallback(() => {
        if (server !== ws) return;
        server = null;
        websocketStatus = "closed";
        if (!running) return;
        if (connectionError) {
            log.debug("Lost connection to sharing websocket, will not reattempt due to error");
        } else {
            log.debug(`Lost connection to sharing websocket, reconnecting in ${sharingSettings.waitBeforeRetry}s`);
            scheduleReconnect();
        }
    }).setErrorCallback((desc) => {
        if (server !== ws) return;
        server = null;
        websocketStatus = "fail";
        log.debug("Could not connect to sharing websocket server:", desc);
        scheduleReconnect();
    });
}

function connectSelfHosted() {
    log.debug(`Starting self hosted server on port ${sharingSettings.port}`);
    const srv = hs.httpserver.create();
    srv.setPort(sharingSettings.port);
    srv.setCallback(() => {
        const wsPath = `ws://${primaryIPv4()}:${sharingSettings.port}/ws`;
        return {
            status: 200,
            headers: { "Content-Type": "text/html; charset=utf-8" },
            body: loadMonitorHtml().replace("%websocketpath%", wsPath),
        };
    });
    srv.setWebSocketCallback("/ws", (event, conn) => {
        if (event === "connected") {
            clients.add(conn);
            try { conn.send(composeUpdate()); } catch (err) { clients.delete(conn); }
        }
    });
    srv.start();
    server = srv;
    websocketStatus = "open";
}

function connectToSharing() {
    retryTimer = null;
    if (!running || !sharingSettings.enabled) return;
    if (sharingSettings.useServer) connectExternal(); else connectSelfHosted();
}

//-----------------------------------------
// Events
//-----------------------------------------
function updateCallbacks() {
    broadcast();

    const next = meetingState || {};
    const prev = lastMeetingState || {};
    const queue = [];
    // Immutable snapshot so listeners can't mutate internal state
    const payload = { meetingState: meetingState ? Object.freeze({ ...meetingState }) : null };

    if (meetingState && !lastMeetingState) queue.push("meetingStarted");

    const diff = (key, change, on, off) => {
        if (prev[key] !== next[key]) {
            queue.push(change, next[key] ? on : off);
        }
    };
    diff("micOpen", "micChange", "micOn", "micOff");
    diff("videoOn", "videoChange", "videoOn", "videoOff");
    diff("sharing", "screensharingChange", "screensharingOn", "screensharingOff");

    if (!meetingState && lastMeetingState) queue.push("meetingStopped");

    if (queue.length > 0) {
        eventHandler.emit("meetingChange", payload);
        queue.forEach((e) => eventHandler.emit(e, payload));
    }
    lastMeetingState = meetingState;
}

//-----------------------------------------
// Monitors
//-----------------------------------------
function startMonitors() {
    log.debug("startMonitors");
    if (appsSettings.zoom) zoomMonitor.start();
    if (appsSettings.teams) teamsMonitor.start();
}

function stopMonitors(except) {
    log.debug(`stopMonitors(${except ? except.name : ""})`);
    for (const m of [teamsMonitor, zoomMonitor]) {
        if (m !== except) m.stop();
    }
}

function handleAppChange(appMonitor) {
    log.debug(`handleAppChange(${appMonitor.name})`);
    if (appMonitor.meetingState) {
        stopMonitors(appMonitor);
        meetingApp = appMonitor.appName;
    }
    meetingState = appMonitor.meetingState;
    updateMenuIcon();
    updateCallbacks();
    if (!appMonitor.meetingState) {
        meetingApp = null;
        startMonitors();
    }
}

zoomMonitor.on("meetingChange", () => handleAppChange(zoomMonitor));
teamsMonitor.on("meetingChange", () => handleAppChange(teamsMonitor));

//-----------------------------------------
// Public API
//-----------------------------------------
const WatchForMeeting = {

    // Called by hs.loadSpoon() after it injects author/description/version from spoon.json. Idempotent.
    init() {
        teamsMonitor.version = this.version; // sent to Teams as the app-version
        return WatchForMeeting;
    },

    start() {
        log.debug("start()");
        if (!running) {
            running = true;
            connectionError = false;
            connectionAttempts = 0;
            if (sharingSettings.enabled && validateShareSettings()) connectToSharing();
            if (menuBar && menubarSettings.enabled) menuBar.show();
            if (mode === "fake") WatchForMeeting.fake(); else WatchForMeeting.auto();
        }
        return WatchForMeeting;
    },

    stop() {
        log.debug("stop()");
        running = false;
        disconnectFromSharing();
        lastMeetingState = null;
        if (menuBar) menuBar.hide();
        stopMonitors();
        return WatchForMeeting;
    },

    restart() {
        WatchForMeeting.stop();
        return WatchForMeeting.start();
    },

    // Monitor configured apps and update status accordingly.
    auto() {
        mode = "auto";
        if (running) {
            faking = false;
            meetingState = null;
            startMonitors();
            if (menuBar) {
                menuBar.setMenu([
                    { title: "Meeting Status:", disabled: true },
                    { title: "Automatic", checked: true },
                    { title: "Busy", checked: false, fn: () => WatchForMeeting.fake() },
                ]);
            }
            updateMenuIcon();
            updateCallbacks();
        }
        return WatchForMeeting;
    },

    // Stop monitoring and report as being in a meeting.
    fake(micOpen = false, videoOn = false, sharing = false) {
        mode = "fake";
        if (running) {
            faking = true;
            meetingApp = "fake";
            meetingState = { micOpen: !!micOpen, videoOn: !!videoOn, sharing: !!sharing };
            stopMonitors();

            const menu = [
                { title: "Meeting Status:", disabled: true },
                { title: "Automatic", checked: false, fn: () => WatchForMeeting.auto() },
                { title: "Busy", checked: true },
                { title: "-" },
            ];
            if (!(micOpen && videoOn && sharing)) {
                menu.push({ title: "Select All", fn: () => WatchForMeeting.fake(true, true, true) });
            } else {
                menu.push({ title: "Select None", fn: () => WatchForMeeting.fake(false, false, false) });
            }
            menu.push(
                { title: "  Mic On", checked: !!micOpen, fn: () => WatchForMeeting.fake(!micOpen, videoOn, sharing) },
                { title: "  Video On", checked: !!videoOn, fn: () => WatchForMeeting.fake(micOpen, !videoOn, sharing) },
                { title: "  Sharing Screen", checked: !!sharing, fn: () => WatchForMeeting.fake(micOpen, videoOn, !sharing) },
            );
            if (micOpen || videoOn || sharing) {
                menu.push({ title: "Clear", fn: () => WatchForMeeting.fake(false, false, false) });
            }
            if (menuBar) menuBar.setMenu(menu);
            updateCallbacks();
            updateMenuIcon();
        }
        return WatchForMeeting;
    },

    on(event, fn) { eventHandler.on(event, fn); return WatchForMeeting; },
    once(event, fn) { eventHandler.once(event, fn); return WatchForMeeting; },
    // With no `fn`, removes every listener for the event.
    off(event, fn) { eventHandler.off(event, fn); return WatchForMeeting; },
    removeAllListeners(event) { eventHandler.removeAllListeners(event); return WatchForMeeting; },
};

// Read-only
Object.defineProperties(WatchForMeeting, {
    // Array of valid event names for on() / once() / off()
    events: { get: () => EVENTS, enumerable: true },
    meetingState: { get: () => meetingState, enumerable: true },
    meetingApp: { get: () => meetingApp, enumerable: true },
    faking: { get: () => faking, enumerable: true },
    zoom: { get: () => zoomMonitor.zoom, enumerable: true },
    // Read/write. Assigning an object merges it over the current values; changes apply immediately.
    sharing: {
        get: () => sharingSettings,
        set: (v) => { Object.assign(sharingValues, v); applySharingChange(); },
        enumerable: true,
    },
    apps: {
        get: () => appsSettings,
        set: (v) => { Object.assign(appsValues, v); applyAppsChange(); },
        enumerable: true,
    },
    menubar: {
        get: () => menubarSettings,
        set: (v) => { Object.assign(menubarValues, v); applyMenubarChange(); },
        enumerable: true,
    },
    mode: {
        get: () => mode,
        set: (v) => {
            if (v === "fake") WatchForMeeting.fake();
            else if (v === "auto") WatchForMeeting.auto();
            else throw new Error(`invalid mode: ${v} (expected "auto" or "fake")`);
        },
        enumerable: true,
    },
    // Sets the level on this spoon's loggers: "error" | "warn" | "info" | "log" | "debug"
    logLevel: {
        get: () => log.level,
        set: (v) => {
            for (const l of [log, eventHandler.logger, zoomMonitor.logger, teamsMonitor.logger]) l.level = v;
        },
        enumerable: true,
    },
});

module.exports = WatchForMeeting;
