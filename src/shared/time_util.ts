let shift_second = 0;

export function now() {
    return Date.now() / 1000 + shift_second;
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
