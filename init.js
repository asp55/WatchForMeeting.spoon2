// WatchForMeeting/init.js

//-----------------------------------------
// Logger
//-----------------------------------------
const Logger = {
    log:(...params)=>{
        console.log("[WatchForMeeting]", ...params);
    },
    debug:(...params)=>{
        console.debug("[WatchForMeeting]", ...params);
    },
    error:(...params)=>{
        console.error("[WatchForMeeting]", ...params);
    },
    info:(...params)=>{
        console.info("[WatchForMeeting]", ...params);
    },
    warn:(...params)=>{
        console.warn("[WatchForMeeting]", ...params);
    },

} 

//-----------------------------------------
// End Logger
//-----------------------------------------

const WatchForMeeting = {};

WatchForMeeting.init = function () {
    Logger.debug("initstart()");
    return module.exports;
}


WatchForMeeting.start = function () {
    Logger.debug("start()");
    return module.exports;
}

WatchForMeeting.stop = function () {
    Logger.debug("stop()");
    return module.exports;
}

module.exports = MSTeams;