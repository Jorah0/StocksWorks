// Hardens the packaged exe by flipping Electron fuses (compile-time switches baked into the binary):
// it can't be used as a generic Node runtime, ignores NODE_OPTIONS / inspector flags, and loads only its own app.asar.
const { flipFuses, FuseVersion, FuseV1Options } = require('@electron/fuses');
const exe = process.argv[2] || 'dist/StocksWorks-win32-x64/StocksWorks.exe';
flipFuses(exe, {
  version: FuseVersion.V1,
  [FuseV1Options.RunAsNode]: false,
  [FuseV1Options.EnableNodeOptionsEnvironmentVariable]: false,
  [FuseV1Options.EnableNodeCliInspectArguments]: false,
  [FuseV1Options.OnlyLoadAppFromAsar]: true,
  [FuseV1Options.EnableCookieEncryption]: true,
}).then(() => console.log(`fuses flipped: ${exe}`));
