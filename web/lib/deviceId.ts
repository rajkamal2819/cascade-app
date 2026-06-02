// Anonymous device id stored in localStorage. Used to scope the Memory
// agent's history to the calling browser without any user PII.
const KEY = "cascade-device-id";

export function getDeviceId(): string {
  if (typeof window === "undefined") return "";
  let id = "";
  try {
    id = localStorage.getItem(KEY) ?? "";
    if (!id) {
      const arr = new Uint8Array(12);
      crypto.getRandomValues(arr);
      id = "d-" + Array.from(arr, (b) => b.toString(16).padStart(2, "0")).join("");
      localStorage.setItem(KEY, id);
    }
  } catch {
    return "";
  }
  return id;
}
