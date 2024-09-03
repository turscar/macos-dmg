import { promisify } from 'node:util'
import fs from 'node:fs/promises'

import * as core from '@actions/core'
import * as exec from '@actions/exec'
import * as io from '@actions/io'

import icns from 'icns-lib'
import baseGm from 'gm'
import { temporaryFile } from 'tempy'

const gm = baseGm.subClass({ imageMagick: true })
const filterMap = (map, filterFunction) =>
  Object.fromEntries(
    Object.entries(map)
      .filter(element => filterFunction(element))
      .map(([key, item]) => [key, item])
  )

const biggestPossibleIconType = 'ic10'

async function baseComposeIcon(type, appIcon, mountIcon, composedIcon) {
  mountIcon = gm(mountIcon)
  appIcon = gm(appIcon)

  const [appIconSize, mountIconSize] = await Promise.all([
    promisify(appIcon.size.bind(appIcon))(),
    promisify(appIcon.size.bind(mountIcon))()
  ])

  // Change the perspective of the app icon to match the mount drive icon
  appIcon = appIcon
    .out('-matte')
    .out('-virtual-pixel', 'transparent')
    .out(
      '-distort',
      'Perspective',
      `1,1  ${appIconSize.width * 0.08},1     ${appIconSize.width},1  ${appIconSize.width * 0.92},1     1,${appIconSize.height}  1,${appIconSize.height}     ${appIconSize.width},${appIconSize.height}  ${appIconSize.width},${appIconSize.height}`
    )

  // Resize the app icon to fit it inside the mount icon, aspect ratio should not be kept to create the perspective illusion
  appIcon = appIcon.resize(
    mountIconSize.width / 1.58,
    mountIconSize.height / 1.82,
    '!'
  )

  const temporaryAppIconPath = temporaryFile({ extension: 'png' })
  await promisify(appIcon.write.bind(appIcon))(temporaryAppIconPath)

  // Compose the two icons
  const iconGravityFactor = mountIconSize.height * 0.063
  mountIcon = mountIcon
    .composite(temporaryAppIconPath)
    .gravity('Center')
    .geometry(`+0-${iconGravityFactor}`)

  composedIcon[type] = await promisify(mountIcon.toBuffer.bind(mountIcon))()
}

const hasGm = async () => {
  const code = await exec.exec('gm', ['-version'])
  return code === 0
}

export default async function composeIcon(
  appIconPath,
  baseIconPath,
  destinationPath
) {
  if (!(await hasGm())) {
    core.info('installing GraphicsMagick')
    const code = await exec.exec('brew', ['install', 'graphicsmagick'])
    if (code !== 0) {
      core.warning('failed to install GraphicsMagick')
    }
  }
  if (!(await hasGm())) {
    core.warning('GraphicsMagick not found, using default dmg icon')
    await io.cp(baseIconPath, destinationPath)
    return
  }
  core.debug(
    `in composeIcon appIconPath=${appIconPath} baseIconPath=${baseIconPath} destinationPath=${destinationPath}`
  )
  const baseDiskIcons = filterMap(
    icns.parse(await fs.readFile(baseIconPath)),
    ([key]) => icns.isImageType(key)
  )
  const appIcon = filterMap(
    icns.parse(await fs.readFile(appIconPath)),
    ([key]) => icns.isImageType(key)
  )
  core.debug('dissected app and base icons')
  const composedIcon = {}
  await Promise.all(
    Object.entries(appIcon).map(async ([type, icon]) => {
      if (baseDiskIcons[type]) {
        return baseComposeIcon(type, icon, baseDiskIcons[type], composedIcon)
      }
      core.warning(`there is no base image for this type: ${type}`)
    })
  )
  core.debug('done all the composes')
  if (!composedIcon[biggestPossibleIconType]) {
    // Make sure the highest-resolution variant is generated
    const largestAppIcon = Object.values(appIcon).sort(
      (a, b) => Buffer.byteLength(b) - Buffer.byteLength(a)
    )[0]
    await baseComposeIcon(
      biggestPossibleIconType,
      largestAppIcon,
      baseDiskIcons[biggestPossibleIconType],
      composedIcon
    )
  }

  await fs.writeFile(destinationPath, icns.format(composedIcon))
}
