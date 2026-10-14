// WatchForMeeting/modules/TeamsMonitor.js
// Monitors Microsoft Teams through its local "Third-party app API" websocket.

const { createLogger } = require("./Logger.js");
const createEventHandler = require("./EventHandler.js");

//-----------------------------------------
// Logger & Events
//-----------------------------------------
const Logger = createLogger("WatchForMeeting.TeamsMonitor");
const events = createEventHandler(["meetingChange"], "WatchForMeeting.TeamsMonitor");

//-----------------------------------------
// Declare Variables
//-----------------------------------------

const TOKEN_KEY = "WatchForMeeting.teamsToken";

// TeamsMonitor.version
// Set by the parent spoon, sent to Teams as the app-version.
let version = "0";

// TeamsMonitor.meetingState
// Read-only { micOpen, videoOn, sharing } or null when not in a Teams meeting.
let meetingState = null;

// private variable to track if the monitor is already running or not.
let running = false;

let teamsPairing = false;
let teamsWebsocket = null;
let teamsConnectionId = 0;
let retryTimer = null;
let closedCount = 0;

//-----------------------------------------
// End of Declare Variables
//-----------------------------------------


//-----------------------------------------
// Teams Monitor
//-----------------------------------------

function clearRetry() {
    if(retryTimer) {
        retryTimer.stop();
        retryTimer = null;
    }
}

function scheduleConnect(seconds) {
    clearRetry();
    retryTimer = hs.timer.doAfter(seconds, connectToTeams);
}

function closeWebsocket() {
    if(teamsWebsocket) {
        const old = teamsWebsocket;
        teamsWebsocket = null;
        try { old.close(); } catch(e) { Logger.debug("close failed:", e); }
    }
}

function disconnectFromTeams() {
    Logger.debug("disconnectFromTeams()");
    clearRetry();
    closeWebsocket();
}

function setMeetingState(next) {
    const same = next && meetingState
        ? next.micOpen === meetingState.micOpen &&
          next.videoOn === meetingState.videoOn &&
          next.sharing === meetingState.sharing
        : next === meetingState;

    if(!same) {
        meetingState = next;
        events.emit("meetingChange", { meetingState });
    }
}

function connectToTeams() {
    Logger.debug(`connectToTeams()`);
    retryTimer = null;

    // Increment the connection ID before closing, so any callbacks from the
    // previous connection are ignored even if close() fires synchronously.
    teamsConnectionId++;
    const myId = teamsConnectionId;
    closeWebsocket();

    const onTeamsClose = ()=>{
        if(myId === teamsConnectionId) {
            Logger.debug("Teams WebSocket Closed");
            teamsWebsocket = null;
            teamsPairing = false;
            if(running) {
                closedCount++;
                if(closedCount > 3) {
                    Logger.warn("Teams WebSocket closed multiple times in a row");
                    Logger.warn("This likely means this app was blocked from the Third-party app API in teams.");
                    Logger.warn("Go to Settings > Privacy > Third-party app API > Manage API and remove the application from block.");
                    Logger.warn("Then restart this spoon.");
                    TeamsMonitor.stop();
                }
                else {
                    Logger.info("Teams not available, retrying in 5 seconds");
                    scheduleConnect(5);
                }
            }
        }
    }

    const onTeamsOpen = ()=>{
        if(myId === teamsConnectionId) {
            Logger.debug("Connected to Teams local API");
        }
    }

    const onTeamsMessage = (message)=>{
        if(myId === teamsConnectionId) {
            let parsed;
            try {
                parsed = JSON.parse(message);
            }
            catch(e) {
                // Don't log the raw message: it may carry a token.
                Logger.warn("Failed to parse Teams message");
                return;
            }
            if(typeof parsed !== "object" || parsed === null) {
                Logger.warn("Unexpected Teams message");
                return;
            }

            // Messages can carry a token (tokenRefresh), so never log them verbatim.
            Logger.debug("Teams WebSocket Received", JSON.stringify(
                parsed.tokenRefresh ? { ...parsed, tokenRefresh: "[redacted]" } : parsed));

            if(parsed.tokenRefresh) {
                Logger.debug("Teams token refreshed");
                hs.userdefaults.set(TOKEN_KEY, parsed.tokenRefresh);
            }

            const update = parsed.meetingUpdate;
            if(update) {
                // A meeting update proves the API is usable, so earlier closes weren't a block.
                closedCount = 0;
                if(update.meetingPermissions && update.meetingPermissions.canPair && !teamsPairing) {
                    Logger.debug("Sending pairing request");
                    teamsPairing = true;
                    if(teamsWebsocket) teamsWebsocket.send('{"action":"pair","parameters":{},"requestId":1}');
                }

                const ms = update.meetingState;
                if(ms && ms.isInMeeting) {
                    setMeetingState({
                        micOpen: !ms.isMuted,
                        videoOn: !!ms.isVideoOn,
                        sharing: !!ms.isSharing,
                    });
                }
                else {
                    setMeetingState(null);
                }
            }

            if(parsed.response === "Pairing response resulted in no action") {
                Logger.info("Didn't pair. Will try again next meeting.");
                teamsPairing = false;
            }
        }
    }

    const onTeamsError = (err)=>{
        if(myId === teamsConnectionId) {
            Logger.debug("Teams WebSocket Error", err);
            teamsWebsocket = null;
            if(running) {
                Logger.warn("Teams not available, retrying in 30 seconds");
                scheduleConnect(30);
            }
        }
    }

    const params = {
        token: hs.userdefaults.get(TOKEN_KEY) || "",
        "protocol-version": "2.0.0",
        manufacturer: "Hammerspoon2",
        device: "WatchForMeeting.spoon2",
        app: "WatchForMeeting.spoon2",
        "app-version": version,
    };
    const query = Object.entries(params)
        .map(([k, v]) => `${k}=${encodeURIComponent(v)}`)
        .join("&");
    const url = `ws://localhost:8124?${query}`;


    teamsWebsocket = hs.http.openWebSocket(url)
        .setOpenCallback(onTeamsOpen)
        .setMessageCallback(onTeamsMessage)
        .setCloseCallback(onTeamsClose)
        .setErrorCallback(onTeamsError);
}

//-----------------------------------------
// End Teams Monitor
//-----------------------------------------


const TeamsMonitor = {
    name: "WatchForMeeting.TeamsMonitor",
    appName: "teams",
    logger: Logger,

    get version() {
        return version;
    },
    set version(v) {
        version = String(v);
    },
    get meetingState() {
        return meetingState;
    },
};

TeamsMonitor.on = function (event, fn) {
    events.on(event, fn);
    return module.exports;
};

TeamsMonitor.once = function (event, fn) {
    events.once(event, fn);
    return module.exports;
};

TeamsMonitor.off = function (event, fn) {
    events.off(event, fn);
    return module.exports;
};

TeamsMonitor.removeAllListeners = function (event) {
    events.removeAllListeners(event);
    return module.exports;
};

TeamsMonitor.start = function () {
    Logger.debug(`start()${teamsWebsocket ? " - skipping" : " - starting"}`);
    if(!teamsWebsocket && !retryTimer) {
        running = true;
        connectToTeams();
    }

    return module.exports;
};

TeamsMonitor.stop = function () {
    Logger.debug("stop()");

    running = false;
    closedCount = 0;
    teamsPairing = false;

    disconnectFromTeams();
    meetingState = null;

    return module.exports;
};


module.exports = TeamsMonitor;
