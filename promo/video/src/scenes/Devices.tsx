import React from 'react'
import { AbsoluteFill } from 'remotion'
import { Backdrop, Caption, Focus, ShotCard, Hl } from '../components'

export const Devices: React.FC = () => (
  <AbsoluteFill>
    <Backdrop glowY={60} />
    <Caption title={<>所有服务器，<Hl>一屏管</Hl></>} sub="Claude、Codex 都行，谁有新输出会亮" />
    <ShotCard src="shots/hero.png" from={{ x: 0, y: 300, w: 272, h: 460 }} to={{ x: 0, y: 330, w: 272, h: 440 }} t0={0} t1={120} x={220} y={640} width={640} enter={2}>
      {map => <Focus style={map({ x: 12, y: 572, w: 254, h: 72 })} from={40} />}
    </ShotCard>
  </AbsoluteFill>
)
