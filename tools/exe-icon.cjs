/**
 * Put the OrderBook icon and name into a packed Windows executable (U11, 2026-10-07).
 *
 * **Why.** Every Windows yml sets `signAndEditExecutable: false`, and that one flag also
 * turns off electron-builder's resource edit (rcedit), not only the signing. The panel's
 * `.exe` therefore kept Electron's own icon and its "Electron" name, and everything that
 * takes its picture from the executable showed the Electron logo: the window and taskbar
 * button, the Start menu and desktop shortcuts, and Explorer. The NSIS setup file was
 * never affected, because makensis gets the icon directly.
 *
 * Turning the flag back on would bring back electron-builder's winCodeSign download,
 * which fails to unpack on a Windows PC without symlink rights. That failure is what the
 * flag works around. So this edits the resources itself with `resedit`, the library
 * electron-builder already uses to write its asar-integrity resource, using the `.ico`
 * that electron-builder derives from `installer/icon.png`.
 */

'use strict';

const fs = require('node:fs');
const ResEdit = require('resedit');

/**
 * Replace the executable's main icon group and its name strings, in place.
 *
 * @param {string} exePath the packed `.exe`
 * @param {string} icoPath a multi-size `.ico`
 * @param {{ productName: string, version: string }} identity
 */
function stampExe(exePath, icoPath, { productName, version }) {
  const exe = ResEdit.NtExecutable.from(fs.readFileSync(exePath));
  const res = ResEdit.NtExecutableResource.from(exe);

  // Electron ships one group (id 1, en-US); Windows shows the first group as the file's icon.
  const [group] = ResEdit.Resource.IconGroupEntry.fromEntries(res.entries);
  if (!group) throw new Error(`${exePath} has no icon group to replace`);
  const icons = ResEdit.Data.IconFile.from(fs.readFileSync(icoPath)).icons.map((icon) => icon.data);
  if (icons.length === 0) throw new Error(`${icoPath} holds no images`);
  ResEdit.Resource.IconGroupEntry.replaceIconsForResource(res.entries, group.id, group.lang, icons);

  const [info] = ResEdit.Resource.VersionInfo.fromEntries(res.entries);
  if (info) {
    const [language] = info.getAllLanguagesForStringValues();
    const fileName = exePath.split(/[\\/]/).pop();
    info.setStringValues(language, {
      FileDescription: productName,
      ProductName: productName,
      CompanyName: 'OrderBook',
      LegalCopyright: 'OrderBook',
      InternalName: fileName,
      OriginalFilename: fileName,
      FileVersion: version,
      ProductVersion: version,
    });
    const [major = 0, minor = 0, patch = 0] = version.split('.').map(Number);
    info.setFileVersion(major, minor, patch, 0, language.lang);
    info.setProductVersion(major, minor, patch, 0, language.lang);
    info.outputToResourceEntries(res.entries);
  }

  res.outputResource(exe);
  fs.writeFileSync(exePath, Buffer.from(exe.generate()));
  return icons.length;
}

/** What a test or a build log reads back: the main group's image sizes and the name strings. */
function readExe(exePath) {
  const res = ResEdit.NtExecutableResource.from(ResEdit.NtExecutable.from(fs.readFileSync(exePath)));
  const [group] = ResEdit.Resource.IconGroupEntry.fromEntries(res.entries);
  const [info] = ResEdit.Resource.VersionInfo.fromEntries(res.entries);
  const strings = info ? info.getStringValues(info.getAllLanguagesForStringValues()[0]) : {};
  // A width of 0 in an icon directory means 256.
  return { sizes: group ? group.icons.map((icon) => icon.width || 256) : [], strings };
}

module.exports = { stampExe, readExe };
