import React from 'react'
import { AbsoluteFill, Interactive, interpolate, useCurrentFrame } from 'remotion'
import { Backdrop, Caption, ShotCard, Hl, ease } from '../components'
import { C, FONT } from '../theme'

const clamp = { extrapolateLeft: 'clamp', extrapolateRight: 'clamp' } as const
const CHIPS = ['不闪屏', '⌥ 拖动即可复制', '粘贴截图自动传到远端']

export const Terminal: React.FC = () => {
  const frame = useCurrentFrame()
  // The agent's real terminal output, revealed step by step (6 captured frames).
  const step = Math.min(6, 1 + Math.floor(frame / 20))
  return (
    <AbsoluteFill>
      <Backdrop glowY={55} />
      <Caption title={<>真 <Hl>tmux</Hl> 终端</>} sub="断网、关窗口、刷新页面，会话都还在" />
      <ShotCard src={`shots/term-${step}.png`} from={{ x: 285, y: 110, w: 600, h: 421 }} to={{ x: 290, y: 130, w: 540, h: 379 }} t0={20} t1={150} y={660} width={960} enter={2} />
      <div style={{ position: 'absolute', left: 80, right: 80, top: 1410, display: 'flex', flexWrap: 'wrap', gap: 22, justifyContent: 'center', fontFamily: FONT }}>
        {CHIPS.map((t, i) => (
          <Interactive.Div
            key={t}
            name={`Chip ${i + 1}`}
            style={{
              padding: '18px 34px', borderRadius: 999, fontSize: 44, fontWeight: 700, color: C.fg,
              background: 'rgba(63,179,127,.14)', border: '2px solid rgba(63,179,127,.45)',
              opacity: interpolate(frame, [70 + i * 14, 80 + i * 14], [0, 1], { ...clamp, easing: ease }),
              translate: interpolate(frame, [70 + i * 14, 86 + i * 14], ['0px 30px', '0px 0px'], { ...clamp, easing: ease }),
            }}
          >
            ✓ {t}
          </Interactive.Div>
        ))}
      </div>
    </AbsoluteFill>
  )
}
