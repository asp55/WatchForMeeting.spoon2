// Levelled logger using the JavaScript console's method names and levels.
// Ordered from least to most verbose: error < warn < info < log < debug
const LEVELS = { error: 0, warn: 1, info: 2, log: 3, debug: 4 };

const DEFAULT_LEVEL = "log";

function assertLevel(value) {
    if (!(value in LEVELS)) {
        throw new Error(`invalid log level: ${value} (expected one of ${Object.keys(LEVELS).join(", ")})`);
    }
}

function createLogger(name, initialLevel = DEFAULT_LEVEL) {
    assertLevel(initialLevel);
    let level = initialLevel;
    const emit = (lvl, params) => {
        if (LEVELS[lvl] <= LEVELS[level]) console[lvl](`[${name}]`, ...params);
    };
    const logger = {
        error: (...p) => emit("error", p),
        warn: (...p) => emit("warn", p),
        info: (...p) => emit("info", p),
        log: (...p) => emit("log", p),
        debug: (...p) => emit("debug", p),
        get level() { return level; },
        set level(value) {
            assertLevel(value);
            level = value;
        },
    };
    return logger;
}

module.exports = { createLogger, LEVELS };
