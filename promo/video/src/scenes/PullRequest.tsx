import React from 'react'
import { AbsoluteFill } from 'remotion'
import { Backdrop, Caption, Focus, ShotCard, Hl } from '../components'

export const PullRequest: React.FC = () => (
  <AbsoluteFill>
    <Backdrop glowY={60} />
    <Caption title={<>收工：<Hl>一键开 PR</Hl></>} sub="合到 develop · 没合并的分支绝不删" />
    <ShotCard src="shots/end-task-pr.png" from={{ x: 380, y: 40, w: 440, h: 330 }} to={{ x: 380, y: 560, w: 440, h: 330 }} t0={25} t1={80} y={700} width={960} enter={2}>
      {map => <Focus style={map({ x: 484, y: 816, w: 226, h: 22 })} from={80} />}
    </ShotCard>
  </AbsoluteFill>
)
