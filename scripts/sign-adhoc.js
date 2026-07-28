// electron-builder afterPack: полноценная ad-hoc подпись.
// Без неё бинарь остаётся «linker-signed» и AMFI на Apple Silicon убивает
// процессы приложения у пользователей («кликнул — повисло»).
const { execSync } = require('child_process')
const path = require('path')
exports.default = async function (context) {
  if (context.electronPlatformName !== 'darwin') return
  const app = path.join(context.appOutDir, `${context.packager.appInfo.productFilename}.app`)
  execSync(`codesign --force --deep --sign - "${app}"`, { stdio: 'inherit' })
  execSync(`codesign --verify --deep --strict "${app}"`, { stdio: 'inherit' })
  console.log('  • ad-hoc подпись наложена и проверена')
}
