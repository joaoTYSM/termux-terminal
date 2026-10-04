const { execSync } = require("child_process");
const fs = require("fs");
const https = require("https");

function run(cmd) {
  console.log(`\n> ${cmd}`);
  execSync(cmd, { stdio: "inherit" });
}

async function download(url, file) {
  return new Promise((resolve, reject) => {
    const f = fs.createWriteStream(file);

    https.get(url, (res) => {
      if (res.statusCode !== 200) {
        reject(new Error(`HTTP ${res.statusCode}`));
        return;
      }

      res.pipe(f);

      f.on("finish", () => {
        f.close();
        resolve();
      });
    }).on("error", reject);
  });
}

(async () => {
  try {
    run("pkg update -y");
    run("pkg install -y nodejs python make clang pkg-config git");

    console.log("\nExecute e aceite a permissão:");
    console.log("termux-setup-storage");

    await download(
      "https://raw.githubusercontent.com/joaoTYSM/termux-terminal/refs/heads/main/server.js",
      "server.js"
    );

    run(
      "npm install ws @xterm/xterm@6.0.0 @xterm/addon-fit@0.11.0 node-pty@npm:node-pty-android-arm64@1.1.0"
    );

    run("node server.js");
  } catch (err) {
    console.error(err);
  }
})();
