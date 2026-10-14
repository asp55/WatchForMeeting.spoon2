// WatchForMeeting/modules/TeamsMonitor.js
// Monitors Microsoft Teams through its local "Third-party app API" websocket.

const Monitor = require("./Monitor.js");

const TOKEN_KEY = "WatchForMeeting.teamsToken";

class TeamsMonitor extends Monitor {
    #version = "0";
    #running = false;
    #pairing = false;
    #websocket = null;
    #connectionId = 0;
    #retryTimer = null;
    #closedCount = 0;

    constructor() {
        super({ name: "TeamsMonitor", appName: "teams" });
    }

    // Set by the parent spoon, sent to Teams as the app-version.
    get version() {
        return this.#version;
    }
    set version(v) {
        this.#version = String(v);
    }

    #clearRetry() {
        if (this.#retryTimer) {
            this.#retryTimer.stop();
            this.#retryTimer = null;
        }
    }

    #scheduleConnect(seconds) {
        this.#clearRetry();
        this.#retryTimer = hs.timer.doAfter(seconds, () => this.#connect());
    }

    #closeWebsocket() {
        if (this.#websocket) {
            const old = this.#websocket;
            this.#websocket = null;
            try { old.close(); } catch (e) { this.logger.debug("close failed:", e); }
        }
    }

    #disconnect() {
        this.logger.debug("disconnectFromTeams()");
        this.#clearRetry();
        this.#closeWebsocket();
    }

    #connect() {
        this.logger.debug("connectToTeams()");
        this.#retryTimer = null;

        // Increment the connection ID before closing, so any callbacks from the
        // previous connection are ignored even if close() fires synchronously.
        this.#connectionId++;
        const myId = this.#connectionId;
        this.#closeWebsocket();

        const onClose = () => {
            if (myId !== this.#connectionId) return;
            this.logger.debug("Teams WebSocket Closed");
            this.#websocket = null;
            this.#pairing = false;
            if (this.#running) {
                this.#closedCount++;
                if (this.#closedCount > 3) {
                    this.logger.warn("Teams WebSocket closed multiple times in a row");
                    this.logger.warn("This likely means this app was blocked from the Third-party app API in teams.");
                    this.logger.warn("Go to Settings > Privacy > Third-party app API > Manage API and remove the application from block.");
                    this.logger.warn("Then restart this spoon.");
                    this.stop();
                } else {
                    this.logger.info("Teams not available, retrying in 5 seconds");
                    this.#scheduleConnect(5);
                }
            }
        };

        const onOpen = () => {
            if (myId !== this.#connectionId) return;
            this.logger.debug("Connected to Teams local API");
        };

        const onMessage = (message) => {
            if (myId !== this.#connectionId) return;

            let parsed;
            try {
                parsed = JSON.parse(message);
            } catch (e) {
                // Don't log the raw message: it may carry a token.
                this.logger.warn("Failed to parse Teams message");
                return;
            }
            if (typeof parsed !== "object" || parsed === null) {
                this.logger.warn("Unexpected Teams message");
                return;
            }

            // Messages can carry a token (tokenRefresh), so never log them verbatim.
            this.logger.debug("Teams WebSocket Received", JSON.stringify(
                parsed.tokenRefresh ? { ...parsed, tokenRefresh: "[redacted]" } : parsed));

            if (parsed.tokenRefresh) {
                this.logger.debug("Teams token refreshed");
                hs.userdefaults.set(TOKEN_KEY, parsed.tokenRefresh);
            }

            const update = parsed.meetingUpdate;
            if (update) {
                // A meeting update proves the API is usable, so earlier closes weren't a block.
                this.#closedCount = 0;
                if (update.meetingPermissions && update.meetingPermissions.canPair && !this.#pairing) {
                    this.logger.debug("Sending pairing request");
                    this.#pairing = true;
                    if (this.#websocket) this.#websocket.send('{"action":"pair","parameters":{},"requestId":1}');
                }

                const ms = update.meetingState;
                if (ms && ms.isInMeeting) {
                    this.setMeetingState({
                        micOpen: !ms.isMuted,
                        videoOn: !!ms.isVideoOn,
                        sharing: !!ms.isSharing,
                    });
                } else {
                    this.setMeetingState(null);
                }
            }

            if (parsed.response === "Pairing response resulted in no action") {
                this.logger.info("Didn't pair. Will try again next meeting.");
                this.#pairing = false;
            }
        };

        const onError = (err) => {
            if (myId !== this.#connectionId) return;
            this.logger.debug("Teams WebSocket Error", err);
            this.#websocket = null;
            if (this.#running) {
                this.logger.warn("Teams not available, retrying in 30 seconds");
                this.#scheduleConnect(30);
            }
        };

        const params = {
            token: hs.userdefaults.get(TOKEN_KEY) || "",
            "protocol-version": "2.0.0",
            manufacturer: "Hammerspoon2",
            device: "WatchForMeeting.spoon2",
            app: "WatchForMeeting.spoon2",
            "app-version": this.#version,
        };
        const query = Object.entries(params)
            .map(([k, v]) => `${k}=${encodeURIComponent(v)}`)
            .join("&");
        const url = `ws://localhost:8124?${query}`;

        this.#websocket = hs.http.openWebSocket(url)
            .setOpenCallback(onOpen)
            .setMessageCallback(onMessage)
            .setCloseCallback(onClose)
            .setErrorCallback(onError);
    }

    start() {
        this.logger.debug(`start()${this.#websocket ? " - skipping" : " - starting"}`);
        if (!this.#websocket && !this.#retryTimer) {
            this.#running = true;
            this.#connect();
        }
        return this;
    }

    stop() {
        this.logger.debug("stop()");
        this.#running = false;
        this.#closedCount = 0;
        this.#pairing = false;
        this.#disconnect();
        this.clearState();
        return this;
    }
}

module.exports = new TeamsMonitor();
