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

//-----------------------------------------
// Settings
//-----------------------------------------
// sharing: { mode, settings }
//   mode: false (off) | "local" (host a status page on this Mac, uses port) | "hosted" (connect out, uses serverURL + key)
//   settings: port, serverURL, key, maxConnectionAttempts (Infinity = never give up), waitBeforeRetry (s)
const sharingSettingsDefaults = {
    port: 8080, serverURL: null, key: null, maxConnectionAttempts: Infinity, waitBeforeRetry: 5,
};
const SHARING_MODES = [false, "local", "hosted"];
// menubar: enabled, color, detailed, showFullState
const menubarDefaults = { enabled: true, color: true, detailed: true, showFullState: true };

// apps: which monitors run in automatic mode. If already started, changing will trigger a restart.
const appsDefaults = { zoom: false, teams: false };

let sharingMode = false;
let sharingValues = Object.freeze({ ...sharingSettingsDefaults });
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

// Throws on anything invalid rather than guessing what was meant. Returns the frozen settings.
function validateSharing(mode, settings) {
    if (!SHARING_MODES.includes(mode)) throw new Error(`sharing.mode must be false, "local" or "hosted"`);
    const unknown = Object.keys(settings).filter((k) => !(k in sharingSettingsDefaults));
    if (unknown.length) throw new Error(`unknown sharing setting(s): ${unknown.join(", ")}`);

    const { port, serverURL, key, maxConnectionAttempts, waitBeforeRetry } = settings;
    if (!Number.isInteger(port) || port < 1 || port > 65535) {
        throw new Error("sharing.settings.port must be an integer from 1 to 65535");
    }
    if (serverURL !== null && (typeof serverURL !== "string" || !/^wss?:\/\/\S+$/.test(serverURL))) {
        throw new Error("sharing.settings.serverURL must be null or a ws:// or wss:// URL");
    }
    if (key !== null && (typeof key !== "string" || !key)) {
        throw new Error("sharing.settings.key must be null or a non-empty string");
    }
    if (typeof maxConnectionAttempts !== "number" || !(maxConnectionAttempts >= 1)) {
        throw new Error("sharing.settings.maxConnectionAttempts must be a number >= 1 (or Infinity)");
    }
    if (typeof waitBeforeRetry !== "number" || !(waitBeforeRetry > 0)) {
        throw new Error("sharing.settings.waitBeforeRetry must be a number > 0");
    }
    if (mode === "hosted" && (serverURL === null || key === null)) {
        throw new Error(`sharing.mode "hosted" requires sharing.settings.serverURL and sharing.settings.key`);
    }
    return Object.freeze({ ...settings });
}

// What a connection actually depends on; changes outside this don't need a reconnect.
const sharingSignature = (mode, v) => JSON.stringify(
    mode === "local" ? [mode, v.port] : mode === "hosted" ? [mode, v.serverURL, v.key] : [mode]);

// Validates the whole result, then applies it. Throws, leaving the current values, if invalid.
function commitSharing(mode, settings) {
    const next = validateSharing(mode, settings);
    const changed = sharingSignature(mode, next) !== sharingSignature(sharingMode, sharingValues);
    sharingMode = mode;
    sharingValues = next;
    if (changed) applySharingChange();
}

const readOnlyTraps = (what) => ({
    deleteProperty() { throw new Error(`${what} can't be deleted; assign a value instead`); },
    defineProperty() { throw new Error(`${what} can't be redefined; assign a value instead`); },
});

// Live view of sharing.settings. Setting a key applies immediately.
const sharingSettingsView = new Proxy({}, {
    get: (_, key) => Reflect.get(sharingValues, key),
    has: (_, key) => Reflect.has(sharingValues, key),
    ownKeys: () => Reflect.ownKeys(sharingValues),
    getOwnPropertyDescriptor: (_, key) => (Reflect.has(sharingValues, key)
        ? { value: sharingValues[key], enumerable: true, configurable: true, writable: true }
        : undefined),
    set(_, key, value) {
        commitSharing(sharingMode, { ...sharingValues, [key]: value });
        return true;
    },
    ...readOnlyTraps("sharing.settings keys"),
});

// Merges a partial { mode?, settings? } over the current sharing values and applies it.
function assignSharing(v) {
    if (typeof v !== "object" || v === null || Array.isArray(v)) {
        throw new Error("sharing must be an object like { mode, settings }");
    }
    const unknown = Object.keys(v).filter((k) => k !== "mode" && k !== "settings");
    if (unknown.length) throw new Error(`unknown sharing key(s): ${unknown.join(", ")} (expected mode, settings)`);
    if ("settings" in v && (typeof v.settings !== "object" || v.settings === null || Array.isArray(v.settings))) {
        throw new Error("sharing.settings must be an object");
    }
    commitSharing("mode" in v ? v.mode : sharingMode, { ...sharingValues, ...v.settings });
}

// Live view of { mode, settings }. Setting mode or any settings key applies immediately.
const sharingView = new Proxy({}, {
    get(_, key) {
        if (key === "mode") return sharingMode;
        if (key === "settings") return sharingSettingsView;
        return undefined;
    },
    has: (_, key) => key === "mode" || key === "settings",
    ownKeys: () => ["mode", "settings"],
    getOwnPropertyDescriptor: (_, key) => ((key === "mode" || key === "settings")
        ? { value: key === "mode" ? sharingMode : sharingSettingsView, enumerable: true, configurable: true, writable: true }
        : undefined),
    set(_, key, value) {
        if (key !== "mode" && key !== "settings") throw new Error(`unknown sharing key: ${String(key)} (expected mode, settings)`);
        assignSharing({ [key]: value });
        return true;
    },
    ...readOnlyTraps("sharing keys"),
});

// Applies a change to the sharing settings by reconnecting with the new values.
function applySharingChange() {
    if (!running) return;
    disconnectFromSharing();
    connectionError = false;
    connectionAttempts = 0;
    connectToSharing();
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
let serverIsExternal = false;
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
    if (serverIsExternal) {
        if (websocketStatus === "open") server.send(composeUpdate());
    } else {
        const msg = composeUpdate();
        for (const conn of [...clients]) {
            try { conn.send(msg); } catch (err) { clients.delete(conn); }
        }
    }
}

function disconnectFromSharing() {
    if (retryTimer) { retryTimer.stop(); retryTimer = null; }
    clients.clear();
    if (server) {
        const old = server;
        server = null;
        websocketStatus = "closed";
        try {
            if (serverIsExternal) old.close(); else old.stop();
        } catch (err) { log.debug("disconnectFromSharing:", err); }
    }
}

function scheduleReconnect() {
    const max = sharingValues.maxConnectionAttempts;
    if (connectionAttempts >= max) {
        log.error("Maximum Connection Attempts failed");
        disconnectFromSharing();
    } else if (connectionError || !running) {
        disconnectFromSharing();
    } else {
        retryTimer = hs.timer.doAfter(sharingValues.waitBeforeRetry, connectToSharing);
    }
}

function connectExternal() {
    const { serverURL, key } = sharingValues;
    log.debug(`Connecting to server at ${serverURL}`);
    connectionAttempts += 1;
    websocketStatus = "connecting";
    const ws = hs.http.openWebSocket(serverURL);
    if (!ws) {
        log.error("Invalid sharing.serverURL");
        websocketStatus = "fail";
        return;
    }
    server = ws;
    serverIsExternal = true;
    ws.setOpenCallback(() => {
        if (server !== ws) return;
        websocketStatus = "open";
        connectionAttempts = 0;
        ws.send(JSON.stringify({
            action: "identify", key, type: "room",
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
            log.debug(`Lost connection to sharing websocket, reconnecting in ${sharingValues.waitBeforeRetry}s`);
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
    const { port } = sharingValues;
    log.debug(`Starting self hosted server on port ${port}`);
    const srv = hs.httpserver.create();
    srv.setPort(port);
    srv.setCallback(() => {
        const wsPath = `ws://${primaryIPv4()}:${port}/ws`;
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
    serverIsExternal = false;
    websocketStatus = "open";
}

function connectToSharing() {
    retryTimer = null;
    if (!running || !sharingMode) return;
    if (sharingMode === "hosted") connectExternal(); else connectSelfHosted();
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
            connectToSharing();
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
    // Dictionary of valid event names for on() / once() / off(), e.g. events.meetingChange === "meetingChange"
    events: { get: () => eventHandler.events, enumerable: true },
    meetingState: { get: () => meetingState, enumerable: true },
    meetingApp: { get: () => meetingApp, enumerable: true },
    faking: { get: () => faking, enumerable: true },
    zoom: { get: () => zoomMonitor.zoom, enumerable: true },
    // Read/write { mode, settings }. Assigning merges over the current values (throws, changing nothing,
    // if the result is invalid); changes apply immediately, as do changes to sharing.mode / sharing.settings.*
    sharing: {
        get: () => sharingView,
        set: assignSharing,
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
