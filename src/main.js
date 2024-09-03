// const core = require('@actions/core')
// const { wait } = require('./wait')

import fs from 'node:fs'
import path from 'node:path'

import * as core from '@actions/core'
import * as exec from '@actions/exec'
import { hashFiles } from '@actions/glob'
import * as cache from '@actions/cache'
import plist from 'plist'
import appdmg from 'appdmg'

import composeIcon from './compose-icon'

/**
 * The main function for the action.
 * @returns {Promise<void>} Resolves when the action is complete.
 */
export async function run() {
  try {
    const appPath = core.getInput('app')
    const title = core.getInput('title')
    const destinationPath = core.getInput('dmg')
    const dmgIcon = core.getInput('icon')
    let baseDiskIconPath = core.getInput('icon-template')
    let background = core.getInput('background')

    if (appPath === '') {
      throw new Error('app must be specified')
    }

    if (baseDiskIconPath === '') {
      baseDiskIconPath = `${__dirname}/../disk-icon.icns`

      if (background === '') {
        background = `${__dirname}/../dmg-background.png`
      }
    }

    const infoPlistPath = path.join(appPath, 'Contents/Info.plist')
    let infoPlist
    try {
      infoPlist = fs.readFileSync(infoPlistPath, 'utf8')
    } catch (err) {
      if (err.code === 'ENOENT') {
        throw Error(`Could not find ${path.relative(process.cwd(), appPath)}`)
      }
      throw err
    }
    let appInfo
    try {
      appInfo = plist.parse(infoPlist)
    } catch (err) {
      let stdout
      const options = {}
      options.listeners = {
        stdout: data => {
          stdout += data.toString()
        }
      }
      const code = await exec.exec(
        '/usr/bin/plutil',
        ['-convert', 'xml1', '-o', '-', infoPlistPath],
        options
      )
      if (code !== 0) {
        throw new Error('failed to read plist')
      }
      appInfo = plist.parse(stdout)
    }
    const appName = appInfo.CFBundleDisplayName ?? appInfo.CFBundleName
    if (!appName) {
      throw new Error(
        'The app must have `CFBundleDisplayName` or `CFBundleName` defined in its `Info.plist`.'
      )
    }

    const dmgTitle = title ?? appName
    if (!dmgTitle.length > 27) {
      throw new Error(
        'The disk image title cannot exceed 27 characters. This is a limitation in a dependency: https://github.com/LinusU/node-alias/issues/7'
      )
    }
    const dmgFilename = `${appName} ${appInfo.CFBundleShortVersionString}.dmg`
    const dmgPath = path.join(destinationPath, dmgFilename)

    const appIcon = appInfo.CFBundleIconFile

    core.debug(
      `appIcon=${appIcon} appPath=${appPath} infoPlistPath=${infoPlistPath}`
    )

    let composedIconPath = dmgIcon
    if (composedIconPath === '' && appIcon) {
      const appIconPath = path.join(appPath, 'Contents/Resources', appIcon)
      await getIcon(appIconPath, baseDiskIconPath, appPath)
      composedIconPath = 'dmg-icon.icns'
    }

    const dmgFormat = 'ULFO'
    const dmgFilesystem = 'APFS'

    const ee = appdmg({
      target: dmgPath,
      basepath: process.cwd(),
      specification: {
        title: dmgTitle,
        icon: composedIconPath,
        //
        // Use transparent background and `background-color` option when this is fixed:
        // https://github.com/LinusU/node-appdmg/issues/135
        background: background,
        'icon-size': 160,
        format: dmgFormat,
        filesystem: dmgFilesystem,
        window: {
          size: {
            width: 660,
            height: 400
          }
        },
        contents: [
          {
            x: 180,
            y: 170,
            type: 'file',
            path: appPath
          },
          {
            x: 480,
            y: 170,
            type: 'link',
            path: '/Applications'
          }
        ]
      }
    })
    ee.on('progress', info => {
      if (info.type === 'step-begin') {
        core.info(info.title)
      }
    })
    // ee.on('finish', async () => {
    //
    // })
    ee.on('error', error => {
      throw new Error(`Building the DMG failed. ${error}`)
    })
  } catch (error) {
    // Fail the workflow run if an error occurs
    core.setFailed(error.message)
  }
}

async function getIcon(appIcon, baseDiskIconPath, appPath) {
  const paths = ['dmg-icon.icns']
  const iconHash = await hashFiles(`${appIcon}\n${baseDiskIconPath}`)
  const hashKey = `dmg-icon-${iconHash}`
  const cacheKey = await cache.restoreCache(paths, hashKey)
  if (cacheKey) {
    core.debug('retrieved icon from cache')
    return paths[0]
  }
  core.info('generating icon')
  const appIconName = appIcon.replace(/\.icns/, '')
  return composeIcon(
    path.join(appPath, 'Contents/Resources', `${appIconName}.icns`),
    baseDiskIconPath,
    paths[0]
  )
}
