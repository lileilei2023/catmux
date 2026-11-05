import { Config } from '@remotion/cli/config'

// Use the installed Google Chrome instead of downloading a headless shell.
Config.setBrowserExecutable('/Applications/Google Chrome.app/Contents/MacOS/Google Chrome')
Config.setVideoImageFormat('jpeg')
Config.setJpegQuality(92)
Config.setOverwriteOutput(true)
// Standard limited-range 4:2:0 for phones / Douyin uploads.
Config.setPixelFormat('yuv420p')
// Screenshots are produced by ../capture.js into ../public.
Config.setPublicDir('../public')
