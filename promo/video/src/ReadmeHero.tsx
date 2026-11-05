import React from 'react'
import { AbsoluteFill, Img, interpolate, staticFile, useCurrentFrame } from 'remotion'
import { C } from './theme'

// Landscape loop for the README: full UI → terminal streaming → diff → PR → full UI.
type R = { x: number; y: number; w: number; h: number }
const FULL: R = { x: 0, y: 0, w: 1440, h: 900 }
const TERM: R = { x: 270, y: 70, w: 720, h: 450 }
const DIFF: R = { x: 940, y: 440, w: 500, h: 312 }
const KEYS: [number, R][] = [[0, FULL], [30, FULL], [60, TERM], [150, TERM], [180, DIFF], [225, DIFF], [255, FULL], [300, FULL]]
export const README_FRAMES = 300

export const ReadmeHero: React.FC = () => {
  const frame = useCurrentFrame()
  const at = (k: keyof R) => interpolate(frame, KEYS.map(([f]) => f), KEYS.map(([, r]) => r[k]), { extrapolateLeft: 'clamp', extrapolateRight: 'clamp' })
  const r = { x: at('x'), y: at('y'), w: at('w'), h: at('h') }
  const scale = 1280 / r.w
  const step = Math.min(6, 1 + Math.floor(Math.max(0, frame - 55) / 15))
  // Switch to the diff screenshot while the camera is still on the terminal (identical in both).
  const src = frame < 55 ? 'shots/term-6.png' : frame < 150 ? `shots/term-${step}.png` : 'shots/hero.png'
  return (
    <AbsoluteFill style={{ backgroundColor: C.bg, overflow: 'hidden' }}>
      <Img src={staticFile(src)} style={{ position: 'absolute', left: -r.x * scale, top: -r.y * scale, width: 1440 * scale, height: 900 * scale, maxWidth: 'none' }} />
    </AbsoluteFill>
  )
}
