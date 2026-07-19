let shift_second = 0;

export function now() {
    // Integer Unix seconds. Callers that want sub-second precision should use
    // nowMs() instead — keeping the two APIs' units clean avoids surprise
    // fractional timestamps leaking into rank encoding, protocol payloads, etc.
    return Math.floor(Date.now() / 1000) + shift_second;
}
export function nowMs() {
    return Date.now() + shift_second * 1000;
}
export function setShiftSecond(s: number) {
    shift_second = s;
}
export function getShiftSecond() {
    return shift_second;
}
