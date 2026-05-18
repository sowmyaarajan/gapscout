// Kills any process using port 3000 before the UI server starts.
import { createServer } from "net";
import { execSync } from "child_process";

const PORT = 3000;

const probe = createServer();
probe.once("error", (err) => {
  if (err.code === "EADDRINUSE") {
    try {
      if (process.platform === "win32") {
        const out = execSync(`netstat -ano | findstr :${PORT}`, { encoding: "utf8" });
        const match = out.match(/LISTENING\s+(\d+)/);
        if (match) execSync(`taskkill /PID ${match[1]} /F`, { stdio: "ignore" });
      } else {
        execSync(`lsof -ti tcp:${PORT} | xargs kill -9`, { stdio: "ignore" });
      }
      console.log(`Freed port ${PORT}.`);
    } catch {
      console.warn(`Could not free port ${PORT} automatically. Kill it manually and retry.`);
    }
  }
});
probe.once("listening", () => probe.close());
probe.listen(PORT);
