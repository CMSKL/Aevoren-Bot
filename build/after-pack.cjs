const { spawnSync } = require("node:child_process");
const { join } = require("node:path");

module.exports = async function afterPack(context) {
  if (context.electronPlatformName !== "darwin") return;
  run("/usr/bin/xattr", ["-cr", context.appOutDir]);
  const infoPlist = join(
    context.appOutDir,
    `${context.packager.appInfo.productFilename}.app`,
    "Contents",
    "Info.plist",
  );
  for (const key of [
    "NSAudioCaptureUsageDescription",
    "NSBluetoothAlwaysUsageDescription",
    "NSBluetoothPeripheralUsageDescription",
    "NSCameraUsageDescription",
  ]) {
    spawnSync("/usr/bin/plutil", ["-remove", key, infoPlist], { stdio: "ignore" });
  }
  run("/usr/bin/plutil", ["-replace", "NSMicrophoneUsageDescription", "-string", "Aevoren 使用麦克风录制你主动发起的语音，供已配置的语音服务转写。", infoPlist]);
  run("/usr/bin/plutil", [
    "-replace",
    "NSAppTransportSecurity",
    "-json",
    JSON.stringify({ NSAllowsArbitraryLoads: false, NSAllowsLocalNetworking: true }),
    infoPlist,
  ]);
};

function run(command, args) {
  const result = spawnSync(command, args, {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (result.status !== 0) {
    throw new Error(`${command} ${args.join(" ")} failed: ${(result.stderr || result.stdout).trim()}`);
  }
}
