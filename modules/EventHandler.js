const { createLogger } = require("./Logger.js");

// Creates a small event emitter restricted to `acceptedEvents` (an array of event name strings).
// API follows the Node convention: on, once, off, emit, removeAllListeners.
// Listeners receive one argument: an event object `{ type, ...payload }`.
function createEventHandler(acceptedEvents, objectName) {
    const logger = createLogger("WatchForMeeting.EventHandler");
    const eventNames = Object.freeze([...acceptedEvents]);
    // e.g. events.meetingChange === "meetingChange"
    const events = Object.freeze(Object.fromEntries(eventNames.map((name) => [name, name])));
    const listeners = new Map(); // event -> [{ fn, once }]
    const label = (event) => (objectName ? `${objectName}.${event}` : event);

    logger.debug(objectName ? `Create EventHandler for ${objectName}` : "Create EventHandler");

    const assertEvent = (event) => {
        if (!eventNames.includes(event)) {
            throw new Error(`invalid event: ${event} (expected one of ${eventNames.join(", ")})`);
        }
    };
    const assertFn = (fn) => {
        if (typeof fn !== "function") throw new TypeError("listener must be a function");
    };

    const add = (event, fn, once) => {
        assertEvent(event);
        assertFn(fn);
        const list = listeners.get(event) || [];
        if (list.some((l) => l.fn === fn)) {
            // A function is registered at most once per event; the first registration wins.
            logger.debug(`listener already registered for event ${label(event)}; ignoring`);
        } else {
            list.push({ fn, once });
            listeners.set(event, list);
            logger.debug(`added listener for event ${label(event)}`);
        }
        return handler;
    };

    const handler = {
        events,
        logger,

        on(event, fn) { return add(event, fn, false); },

        once(event, fn) { return add(event, fn, true); },

        // With no `fn`, removes every listener for the event.
        off(event, fn) {
            assertEvent(event);
            if (fn === undefined) return handler.removeAllListeners(event);
            const list = listeners.get(event);
            if (!list) return handler;
            const remaining = list.filter((l) => l.fn !== fn);
            if (remaining.length !== list.length) logger.debug(`removed listener for event ${label(event)}`);
            if (remaining.length) listeners.set(event, remaining); else listeners.delete(event);
            return handler;
        },

        // With no `event`, removes every listener for every event.
        removeAllListeners(event) {
            if (event === undefined) {
                logger.debug("removed all listeners");
                listeners.clear();
            } else {
                assertEvent(event);
                if (listeners.delete(event)) logger.debug(`removed all listeners for event ${label(event)}`);
            }
            return handler;
        },

        emit(event, payload = {}) {
            assertEvent(event);
            logger.debug(`Emit ${label(event)}`);
            const eventObject = Object.freeze({ ...payload, type: event });
            // copy so listeners can unsubscribe while being iterated
            for (const l of [...(listeners.get(event) || [])]) {
                if (l.once) handler.off(event, l.fn);
                try {
                    l.fn(eventObject);
                } catch (err) {
                    logger.error(`listener for ${label(event)} threw:`, err);
                }
            }
            return handler;
        },
    };

    return handler;
}

module.exports = createEventHandler;
