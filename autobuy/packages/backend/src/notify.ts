import { execFile } from "node:child_process";

/** macOS notification via osascript. Arguments are passed as an argv array — no shell interpolation. */
export function notify(title: string, message: string) {
  if (process.platform !== "darwin") return;
  const esc = (s: string) => s.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
  execFile("osascript", ["-e", `display notification "${esc(message)}" with title "${esc(title)}" sound name "Glass"`], (err) => {
    if (err) console.error("[notify]", err.message);
  });
}
