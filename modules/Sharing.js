// WatchForMeeting/modules/Sharing.js
// Shares the meeting status, either by hosting a status page on this Mac ("local")
// or by connecting out to a MeetingStatusServer ("hosted").
//
// Call configure() once with { getMeetingState, monitorHtmlPath } before start().

const { createLogger } = require("./Logger.js");

const log = createLogger("WatchForMeeting.Sharing");

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

let sharingMode = false;
let sharingValues = Object.freeze({ ...sharingSettingsDefaults });

// private variable to track if sharing is running or not.
let running = false;

// Set by configure()
let getMeetingState = () => null;
let monitorHtmlPath = null;

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

//-----------------------------------------
// Status sharing (self hosted server / external server)
//-----------------------------------------
let server = null; // self hosted HSHTTPServer, or external websocket client
let serverIsExternal = false;
let websocketStatus = "closed";
let connectionAttempts = 0;
let connectionError = false;
let retryTimer = null;
let stableTimer = null; // resets connectionAttempts once a connection has stayed up
let startCheckTimer = null; // verifies the self hosted server actually bound its port
const clients = new Set(); // self hosted websocket connections

// A hosted connection must stay open this long before earlier failed attempts are forgiven,
// so a server that accepts and immediately drops us still counts toward maxConnectionAttempts.
const STABLE_CONNECTION_SECONDS = 2;
const SERVER_START_CHECK_SECONDS = 1;

// The status page and MeetingStatusServer expect snake_case keys on the wire.
const toWire = (state) => (state
    ? { mic_open: state.micOpen, video_on: state.videoOn, sharing: state.sharing }
    : false);

const composeUpdate = () => JSON.stringify({ action: "update", inMeeting: toWire(getMeetingState()) });

let monitorHtml = null;
function loadMonitorHtml() {
    if (monitorHtml === null) monitorHtml = (monitorHtmlPath && hs.fs.read(monitorHtmlPath)) || "";
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

function clearStableTimer() {
    if (stableTimer) { stableTimer.stop(); stableTimer = null; }
}

function disconnectFromSharing() {
    if (retryTimer) { retryTimer.stop(); retryTimer = null; }
    clearStableTimer();
    if (startCheckTimer) { startCheckTimer.stop(); startCheckTimer = null; }
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
        log.error("Could not open a websocket to sharing.settings.serverURL");
        websocketStatus = "fail";
        scheduleReconnect();
        return;
    }
    server = ws;
    serverIsExternal = true;
    ws.setOpenCallback(() => {
        if (server !== ws) return;
        websocketStatus = "open";
        clearStableTimer();
        stableTimer = hs.timer.doAfter(STABLE_CONNECTION_SECONDS, () => {
            stableTimer = null;
            if (server === ws) connectionAttempts = 0;
        });
        ws.send(JSON.stringify({
            action: "identify", key, type: "room",
            status: { inMeeting: toWire(getMeetingState()) },
        }));
    }).setMessageCallback((message) => {
        if (server !== ws) return;
        let parsed;
        try { parsed = JSON.parse(message); } catch (err) { log.warn("Unparseable sharing message"); return; }
        if (typeof parsed !== "object" || parsed === null) { log.warn("Unexpected sharing message"); return; }
        if (parsed.error) {
            // Only a rejected key is fatal; other errors leave the connection (and its reconnects) alone.
            if (parsed.errorType === "badkey") {
                connectionError = true;
                disconnectFromSharing();
                log.error("sharing.key not valid. Make sure that key has been established on the server.");
            } else {
                log.warn("Sharing server reported an error:", parsed.errorType || "unknown");
            }
        } else {
            // Never log the raw message: it could echo the sharing key.
            log.debug("Sharing websocket message received:", JSON.stringify(
                "key" in parsed ? { ...parsed, key: "[redacted]" } : parsed));
        }
    }).setCloseCallback(() => {
        if (server !== ws) return;
        server = null;
        websocketStatus = "closed";
        clearStableTimer();
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
        clearStableTimer();
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
        } else if (event === "closed") {
            // Sending to a closed connection only logs a warning (it doesn't throw), so drop it here.
            clients.delete(conn);
        }
    });
    server = srv;
    serverIsExternal = false;
    try {
        srv.start();
    } catch (err) {
        log.error(`Could not start self hosted server on port ${port}:`, err);
        failSelfHosted(srv);
        return;
    }
    websocketStatus = "open";
    // start() reports no status, and binding may be asynchronous; getPort() is 0 if nothing is listening.
    startCheckTimer = hs.timer.doAfter(SERVER_START_CHECK_SECONDS, () => {
        startCheckTimer = null;
        if (server !== srv || srv.getPort() !== 0) return;
        log.error(`Self hosted server is not listening on port ${port}. Is the port already in use?`);
        failSelfHosted(srv);
    });
}

function failSelfHosted(srv) {
    if (server === srv) disconnectFromSharing();
    websocketStatus = "fail";
}

function connectToSharing() {
    retryTimer = null;
    if (!running || !sharingMode) return;
    if (sharingMode === "hosted") connectExternal(); else connectSelfHosted();
}

//-----------------------------------------
// Public API
//-----------------------------------------
const Sharing = {
    name: "WatchForMeeting.Sharing",
    logger: log,

    // getMeetingState: () => the current { micOpen, videoOn, sharing } or null
    // monitorHtmlPath: absolute path of the status page served in "local" mode
    configure(options) {
        getMeetingState = options.getMeetingState;
        monitorHtmlPath = options.monitorHtmlPath;
        return Sharing;
    },

    start() {
        log.debug("start()");
        if (!running) {
            running = true;
            connectionError = false;
            connectionAttempts = 0;
            connectToSharing();
        }
        return Sharing;
    },

    stop() {
        log.debug("stop()");
        running = false;
        disconnectFromSharing();
        return Sharing;
    },

    // Sends the current meeting state to connected viewers.
    broadcast,

    // Live { mode, settings } view; assigning merges over the current values (see assignSharing).
    get settings() {
        return sharingView;
    },
    set settings(v) {
        assignSharing(v);
    },
};

module.exports = Sharing;
