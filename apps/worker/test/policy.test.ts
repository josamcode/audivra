import { describe, expect, it } from 'vitest'
import type { ReviewResult } from '@audivra/contracts'
import { needsVerificationPass } from '../src/pipeline.ts'
import { classifyError } from '../src/stage-runner.ts'
import { CancelledError, RequiredCapabilityError } from '@audivra/audit-core'
import { AiStageError } from '@audivra/ai-runtime'

const review = (patch: Partial<ReviewResult>): ReviewResult => ({
  overallAssessment: '',
  approvedFindings: [],
  rejectedFindings: [],
  findingsNeedingVerification: [],
  severityAdjustments: [],
  duplicates: [],
  missingAreas: [],
  priorityProblems: [],
  materialGaps: false,
  journeyReview: [],
  ...patch,
})

describe('needsVerificationPass', () => {
  it('skips the pass when the reviewer has nothing to verify', () => {
    expect(needsVerificationPass(review({}))).toBe(false)
    expect(
      needsVerificationPass(
        review({ missingAreas: [{ area: 'blog', why: '', suggestedCheck: '', importance: 'low' }] }),
      ),
    ).toBe(false)
  })

  it('runs the pass for material gaps, verification requests or important missing areas', () => {
    expect(needsVerificationPass(review({ materialGaps: true }))).toBe(true)
    expect(
      needsVerificationPass(
        review({ findingsNeedingVerification: [{ findingId: 'D1', concern: '', suggestedCheck: '' }] }),
      ),
    ).toBe(true)
    expect(
      needsVerificationPass(
        review({ missingAreas: [{ area: 'checkout', why: '', suggestedCheck: '', importance: 'high' }] }),
      ),
    ).toBe(true)
  })
})

describe('classifyError', () => {
  it('distinguishes failure kinds for the UI', () => {
    expect(classifyError(new CancelledError(), 'baseline').kind).toBe('cancelled')
    expect(classifyError(new AiStageError('x', null), 'investigation').kind).toBe('ai')
    expect(classifyError(new RequiredCapabilityError('down'), 'baseline').kind).toBe('required-capability')
    expect(classifyError(new Error('browserType.launch: Chromium missing'), 'baseline').kind).toBe('browser')
    expect(classifyError(new Error('boom'), 'review')).toEqual({
      kind: 'internal',
      message: 'boom',
      stage: 'review',
    })
  })
})
