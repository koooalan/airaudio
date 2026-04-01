/** @type {import('electron-builder').Configuration} */
module.exports = {
  appId: 'com.wuuzaa.aireaudio',
  productName: 'AirAudio',
  copyright: 'WUU ZAA',

  files: ['out/**/*'],

  extraResources: [
    { from: 'node_modules/ffmpeg-static/ffmpeg.exe', to: 'ffmpeg.exe' },
    { from: 'extension', to: 'extension' },
    { from: 'assets/tray-icon.png',            to: 'assets/tray-icon.png' },
    { from: 'assets/tray-icon-streaming.png',  to: 'assets/tray-icon-streaming.png' },
    { from: 'assets/tray-icon-connecting.png', to: 'assets/tray-icon-connecting.png' },
    { from: 'assets/tray-icon-error.png',      to: 'assets/tray-icon-error.png' },
  ],

  win: {
    target: [{ target: 'nsis', arch: ['x64'] }],
    icon: 'assets/icon.ico',
  },

  nsis: {
    oneClick: true,
    perMachine: false,
    createDesktopShortcut: false,
    createStartMenuShortcut: true,
    runAfterFinish: true,
  },
}
