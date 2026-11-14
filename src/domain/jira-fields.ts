import type { StoryPointsFieldInfo } from './types'

const RESERVED_FIELD_KEYS: ReadonlySet<string> = new Set(['__proto__', 'constructor', 'prototype'])

const JSW_STORY_POINTS_CUSTOM_SCHEMA = 'com.pyxis.greenhopper.jira:jsw-story-points'

interface RankedFieldCandidate {
  readonly tier: 0 | 1 | 2
  readonly fieldId: string
  readonly fieldName: string
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return false
  }
  const proto: unknown = Object.getPrototypeOf(value)
  return proto === Object.prototype || proto === null
}

function matchFieldNameTier(
  rawName: unknown,
): { tier: 0 | 1; fieldName: 'Story Points' | 'Story point estimate' } | null {
  if (typeof rawName !== 'string') {
    return null
  }
  const normalized = rawName.trim().toLowerCase()
  if (normalized === 'story points') {
    return { tier: 0, fieldName: 'Story Points' }
  }
  if (normalized === 'story point estimate') {
    return { tier: 1, fieldName: 'Story point estimate' }
  }
  return null
}

export function detectStoryPointsField(editMeta: unknown): StoryPointsFieldInfo | null {
  if (!isPlainObject(editMeta)) {
    return null
  }

  const rawFields = Object.hasOwn(editMeta, 'fields') ? editMeta.fields : undefined
  if (!isPlainObject(rawFields)) {
    return null
  }

  const candidates: RankedFieldCandidate[] = []

  for (const [fieldId, fieldDef] of Object.entries(rawFields)) {
    if (fieldId.trim().length === 0 || RESERVED_FIELD_KEYS.has(fieldId)) {
      continue
    }
    if (!isPlainObject(fieldDef)) {
      continue
    }

    const rawSchema = Object.hasOwn(fieldDef, 'schema') ? fieldDef.schema : undefined
    let hasJswStoryPointsSchema = false
    if (rawSchema !== undefined && rawSchema !== null) {
      if (!isPlainObject(rawSchema)) {
        continue
      }
      const rawType = Object.hasOwn(rawSchema, 'type') ? rawSchema.type : undefined
      if (rawType !== undefined && rawType !== null && rawType !== 'number') {
        continue
      }
      const rawCustom = Object.hasOwn(rawSchema, 'custom') ? rawSchema.custom : undefined
      hasJswStoryPointsSchema = rawCustom === JSW_STORY_POINTS_CUSTOM_SCHEMA
    }

    const rawOperations = Object.hasOwn(fieldDef, 'operations') ? fieldDef.operations : undefined
    if (rawOperations !== undefined && rawOperations !== null) {
      if (!Array.isArray(rawOperations) || !rawOperations.includes('set')) {
        continue
      }
    }

    const rawName = Object.hasOwn(fieldDef, 'name') ? fieldDef.name : undefined
    const nameMatch = matchFieldNameTier(rawName)
    if (nameMatch !== null) {
      candidates.push({
        tier: nameMatch.tier,
        fieldId,
        fieldName: nameMatch.fieldName,
      })
      continue
    }

    if (hasJswStoryPointsSchema) {
      const fallbackName = typeof rawName === 'string' && rawName.trim().length > 0 ? rawName.trim() : 'Story Points'
      candidates.push({
        tier: 2,
        fieldId,
        fieldName: fallbackName,
      })
    }
  }

  if (candidates.length === 0) {
    return null
  }

  candidates.sort((a, b) => {
    if (a.tier !== b.tier) {
      return a.tier - b.tier
    }
    return a.fieldId < b.fieldId ? -1 : a.fieldId > b.fieldId ? 1 : 0
  })

  const winner = candidates[0]
  if (winner === undefined) {
    return null
  }

  return {
    fieldId: winner.fieldId,
    fieldName: winner.fieldName,
  }
}
