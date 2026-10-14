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
const sharing = require("./modules/Sharing.js");

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
// menubar: enabled, color, detailed, showFullState
const menubarDefaults = { enabled: true, color: true, detailed: true, showFullState: true };

// apps: which monitors run in automatic mode. If already started, changing will trigger a restart.
// Keys must match each monitor's appName (see MONITORS).
const appsDefaults = { zoom: false, teams: false };

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

// Applies a change to the apps settings by restarting the monitors only (sharing and the menu bar
// are untouched). Only relevant in automatic mode; fake mode runs no monitors.
function applyAppsChange() {
    if (!running || mode !== "auto") return;
    stopMonitors();
    WatchForMeeting.auto();
}

// Setting a key on the proxy applies the change immediately, unless the value is unchanged.
const makeSettingsProxy = (values, apply) => new Proxy(values, {
    set(target, key, value) {
        const changed = target[key] !== value;
        target[key] = value;
        if (changed) apply(key);
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

sharing.configure({
    getMeetingState: () => meetingState,
    monitorHtmlPath: `${__dirname}/monitor.html`,
});

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
// Events
//-----------------------------------------
function updateCallbacks() {
    sharing.broadcast();

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
// Each monitor's appName is the key in the `apps` setting that enables it.
const MONITORS = [zoomMonitor, teamsMonitor];

function startMonitors() {
    log.debug("startMonitors");
    for (const m of MONITORS) {
        if (appsSettings[m.appName]) m.start();
    }
}

function stopMonitors(except) {
    log.debug(`stopMonitors(${except ? except.name : ""})`);
    for (const m of MONITORS) {
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

for (const m of MONITORS) m.on("meetingChange", () => handleAppChange(m));

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
            sharing.start();
            if (menuBar && menubarSettings.enabled) menuBar.show();
            if (mode === "fake") WatchForMeeting.fake(); else WatchForMeeting.auto();
        }
        return WatchForMeeting;
    },

    stop() {
        log.debug("stop()");
        running = false;
        sharing.stop();
        stopMonitors();
        // Reset so getters are accurate while stopped, and tell listeners a meeting has ended.
        meetingState = null;
        meetingApp = null;
        faking = false;
        updateCallbacks();
        lastMeetingState = null;
        if (menuBar) menuBar.hide();
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
            meetingApp = null;
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
        get: () => sharing.settings,
        set: (v) => { sharing.settings = v; },
        enumerable: true,
    },
    apps: {
        get: () => appsSettings,
        set: (v) => {
            const before = JSON.stringify(appsValues);
            Object.assign(appsValues, v);
            if (JSON.stringify(appsValues) !== before) applyAppsChange();
        },
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
            for (const l of [log, eventHandler.logger, ...MONITORS.map((m) => m.logger), sharing.logger]) l.level = v;
        },
        enumerable: true,
    },
});

module.exports = WatchForMeeting;
